// markmyword server — Express + SQLite, single always-on box.
//
// Serves the static viewer and a small JSON API. Base document HTML comes from
// docs/<id>.html (immutable, trusted). Editor edits + version history live in
// SQLite. Identity is owner-vs-guest (HMAC-signed cookie, OWNER_KEY promotes):
// anyone may suggest, but editing/restoring/accepting is gated to the doc owner.
import express from 'express';
import { readFile, writeFile, readdir, access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb, getOverlay, setBlockAndSnapshot, listVersions, getVersion, restoreVersion,
  listSuggestions, addSuggestion, getSuggestion, setSuggestionStatus, acceptSuggestion,
  setDocOwner, getDocOwner, countDocsOwnedBy, countGuestOwners, deleteDocData, ownerMap,
  getDocAccess, setDocAccess, ACCESS_LEVELS,
} from './db.js';
import { makeGuardrails, LIMITS } from './guardrails.js';
import { makeFeedbackHandler } from './feedback-api.js';
import { patchSource } from './source-patch.js';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DOCS_DIR holds deliverable HTML (seed + uploads). On a host with an ephemeral
// image filesystem (Fly), point HS_DOCS_DIR at a persistent volume so uploads
// survive redeploys; the baked-in seed docs are copied in on first boot.
const SEED_DOCS_DIR = path.join(__dirname, 'docs');
const DOCS_DIR = process.env.HS_DOCS_DIR || SEED_DOCS_DIR;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3939;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_TEXT = 50_000;
const MAX_DOC_BYTES = LIMITS.MAX_DOC_BYTES; // per-file size cap (default 2 MB)

const SAFE_ID = /^[a-zA-Z0-9._-]+$/;
const isValidDocId = (id) =>
  typeof id === 'string' && id.length > 0 && id.length <= 128 && SAFE_ID.test(id) && id !== '.' && id !== '..';

// Editor edits are stored as plain text and re-inserted as textContent, so
// escaping here makes the stored overlay injection-proof even though the author
// is trusted. (Belt-and-suspenders for the one value that round-trips storage.)
const escapeText = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function readDocHtml(id) {
  if (!isValidDocId(id)) return null;
  const file = path.join(DOCS_DIR, `${id}.html`);
  if (!file.startsWith(DOCS_DIR + path.sep)) return null; // defense in depth
  try { return await readFile(file, 'utf8'); } catch { return null; }
}

// The un-stripped ORIGINAL bytes of an interactive doc, or null if this doc has
// no raw copy (it's a plain static deliverable). Only interactive uploads store a
// .raw.html. This is the source rendered in the sandboxed iframe AND the source
// the reviewed download is rebuilt from — never the live post-JS DOM.
async function readRawHtml(id) {
  if (!isValidDocId(id)) return null;
  const file = path.join(DOCS_DIR, `${id}.raw.html`);
  if (!file.startsWith(DOCS_DIR + path.sep)) return null; // defense in depth
  try { return await readFile(file, 'utf8'); } catch { return null; }
}

// Whether an interactive raw copy exists for this doc (drives the viewer's choice
// between the inert inline path and the sandboxed-iframe path).
async function docHasRaw(id) {
  if (!isValidDocId(id)) return false;
  const file = path.join(DOCS_DIR, `${id}.raw.html`);
  if (!file.startsWith(DOCS_DIR + path.sep)) return false;
  return access(file, fsConstants.F_OK).then(() => true).catch(() => false);
}

// Remove <script> elements (and their contents) and inline event-handler
// attributes from uploaded HTML. The viewer renders via DOMParser (which never
// executes scripts) AND strips scripts from the parsed DOM, but we also scrub at
// the upload boundary so the stored file itself is inert — if it's ever opened
// directly, served raw, or copied elsewhere, it can't run. Deliverables are
// styled documents, not apps; nothing legitimate is lost.
//   NOTE: this is a coarse regex scrub, deliberately conservative — it strips
//   whole <script>…</script> blocks and on*="" handlers and javascript: URLs.
//   The real render-time safety is that overlays/suggestions are text-only and
//   the DOM is built with DOMParser (which never executes and drops scripts);
//   this just keeps the on-disk file inert for the "opened raw" case. Because a
//   regex can't fully model HTML, the handler/URL rules below are hardened
//   against the known separator/encoding tricks (leading `/` instead of space,
//   entity-encoded `javascript:`) that a naive `\son…=` / literal-string scrub
//   would miss — see the upload test.
//
// Collapse the HTML entities an attribute value can hide a scheme behind
// (&#106;avascript:, &#x6a;…, &Tab;/&NewLine; inside the scheme) so the
// javascript:-URL check sees the string the browser would actually resolve.
function decodeAttrEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&Tab;/gi, '\t').replace(/&NewLine;/gi, '\n')
    .replace(/&colon;/gi, ':');
}

// Does this HTML contain active content (scripts / inline handlers / javascript:
// URLs)? Uses the SAME signals stripActiveContent scrubs, so "hasActiveContent"
// is exactly "stripActiveContent would change something". A doc that trips this
// is an INTERACTIVE doc: we keep its un-stripped original (docs/<id>.raw.html) and
// render it in a sandboxed iframe so its own JS can run, contained. A doc that
// doesn't is a plain styled deliverable and takes the existing inert render path.
function hasActiveContent(html) {
  const s = String(html);
  if (/<script\b/i.test(s)) return true;
  if (/[\s/"']on[a-z]+\s*=/i.test(s)) return true;
  // javascript: in href/src, entity-encoding included (mirror the scrub's decode).
  const jsUrl = /(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m;
  while ((m = jsUrl.exec(s)) !== null) {
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    if (/^\s*javascript:/i.test(decodeAttrEntities(val))) return true;
  }
  return false;
}

function stripActiveContent(html) {
  return String(html)
    // whole <script> … </script> blocks (incl. attributes, any casing)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    // self-closing / unterminated <script …> just in case
    .replace(/<script\b[^>]*\/?>/gi, '')
    // inline event handlers. The char before `on…` may be whitespace OR any of
    // the separators HTML treats as an attribute boundary (/, unclosed quote),
    // so match [\s/"'] not just \s — this catches `<img/onerror=…>`.
    .replace(/[\s/"']on[a-z]+\s*=\s*"[^"]*"/gi, ' ')
    .replace(/[\s/"']on[a-z]+\s*=\s*'[^']*'/gi, ' ')
    .replace(/[\s/"']on[a-z]+\s*=\s*[^\s>]+/gi, ' ')
    // javascript: URLs in href/src — decode entities in the value first so
    // `&#106;avascript:` and friends are caught, not just the literal scheme.
    .replace(/(href|src)\s*=\s*"([^"]*)"/gi, (m, attr, val) =>
      /^\s*javascript:/i.test(decodeAttrEntities(val)) ? `${attr}="#"` : m)
    .replace(/(href|src)\s*=\s*'([^']*)'/gi, (m, attr, val) =>
      /^\s*javascript:/i.test(decodeAttrEntities(val)) ? `${attr}='#'` : m)
    .replace(/(href|src)\s*=\s*([^\s"'>]+)/gi, (m, attr, val) =>
      /^\s*javascript:/i.test(decodeAttrEntities(val)) ? `${attr}="#"` : m);
}

// List the deliverables available in docs/ (their <id> stems). Config/asset files
// are ignored; only *.html with a valid id is returned, newest-first by name.
async function listDocs() {
  let entries;
  try { entries = await readdir(DOCS_DIR, { withFileTypes: true }); } catch { return []; }
  return entries
    // .raw.html is the interactive original that shadows <id>.html — not a doc of
    // its own, so exclude it (else it would list as a phantom "<id>.raw").
    .filter((e) => e.isFile() && e.name.endsWith('.html') && !e.name.endsWith('.raw.html'))
    .map((e) => e.name.slice(0, -'.html'.length))
    .filter((id) => isValidDocId(id))
    .sort();
}

// Assets that a deliverable references (banner images, etc.) are stored flat in
// docs/assets/ and served read-only from /docs/assets. An asset filename is a
// bare basename — no directory parts, no traversal, and an image extension only.
// We intentionally keep the namespace shared (not per-doc): filenames are global,
// which is simplest and matches how the doc's own <img src> basenames resolve.
const ASSET_NAME = /^[A-Za-z0-9._-]+\.(png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i;
const isValidAssetName = (name) =>
  typeof name === 'string' && name.length > 0 && name.length <= 128 &&
  ASSET_NAME.test(name) && !name.includes('/') && !name.includes('\\') &&
  name !== '.' && name !== '..';
const MAX_ASSET_BYTES = LIMITS.MAX_DOC_BYTES; // reuse the per-file cap for images

// The basenames already present in docs/assets/ — so the client only asks the
// user for images we don't already hold.
async function listAssets() {
  const dir = path.join(DOCS_DIR, 'assets');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && isValidAssetName(e.name)).map((e) => e.name);
  } catch { return []; }
}

// Optional per-doc config (docs/<id>.config.json). Kept out of the HTML so
// formatters can't strip block-grouping markers. Currently: { groups: [selector] }.
// Missing/invalid config is not an error — grouping just defaults to none.
async function readDocConfig(id) {
  if (!isValidDocId(id)) return {};
  const file = path.join(DOCS_DIR, `${id}.config.json`);
  if (!file.startsWith(DOCS_DIR + path.sep)) return {};
  try {
    const cfg = JSON.parse(await readFile(file, 'utf8'));
    const groups = Array.isArray(cfg.groups) ? cfg.groups.filter((s) => typeof s === 'string') : [];
    return { groups };
  } catch { return {}; }
}

export function createApp(db, opts = {}) {
  const app = express();
  app.set('trust proxy', true); // behind Fly's proxy; needed for correct client IP
  // Body limit tracks the file-size cap plus headroom for JSON overhead, so a
  // paste up to MAX_DOC_BYTES isn't rejected by the parser before our own check.
  app.use(express.json({ limit: MAX_DOC_BYTES + 256 * 1024 }));

  const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

  // Guardrails: identify caller (owner vs guest) on every request, then apply
  // per-IP rate limits to the API route groups. `now` is injectable for tests.
  //
  // identify() MUST run BEFORE express.static — owner promotion happens here:
  // opening `/?key=…` (or `/viewer.html?…&key=…`) sets the mmw_owner cookie. If
  // static served first, those navigations (they match index.html / viewer.html)
  // would terminate before identify ran, and the owner cookie would NEVER be set —
  // the visitor stays a guest and every owner-only action (e.g. changing link
  // access) 403s. So: json → identify → static.
  const { identify, readLimiter, writeLimiter, uploadLimiter } = makeGuardrails({ now: opts.now });
  app.use(identify);
  app.use(express.static(PUBLIC_DIR));
  app.get('/api/whoami', (req, res) => {
    noStore(res);
    res.json({ isOwner: !!req.caller?.isOwner, docLimit: LIMITS.GUEST_DOC_LIMIT });
  });
  // Serve document assets (banner images, etc.) referenced by deliverable HTML.
  // Read-only static files under docs/assets — never the .html sources themselves
  // (those go through /api/doc so overlays apply).
  app.use('/docs/assets', express.static(path.join(DOCS_DIR, 'assets')));

  // GET /api/assets -> { assets: [name, ...] }  (basenames already on the box, so
  // the landing page only asks the user for images we don't already have).
  app.get('/api/assets', readLimiter, async (_req, res) => {
    noStore(res);
    res.json({ assets: await listAssets() });
  });

  // POST /api/upload-asset { name, dataBase64 } -> { ok, name }
  // Stores an image the uploaded doc references into docs/assets/ (shared, flat).
  // Owner or guest may add assets (they're inert files, served static); we cap
  // size, allow only image extensions, and reject any non-basename to prevent
  // traversal. Not clobbered if it already exists — same name = same image here.
  app.post('/api/upload-asset', uploadLimiter, async (req, res) => {
    const { name, dataBase64 } = req.body || {};
    if (!isValidAssetName(name)) return res.status(400).json({ error: 'invalid_asset_name' });
    if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
      return res.status(400).json({ error: 'empty_asset' });
    }
    let buf;
    try { buf = Buffer.from(dataBase64, 'base64'); } catch { buf = null; }
    if (!buf || buf.length === 0) return res.status(400).json({ error: 'empty_asset' });
    if (buf.length > MAX_ASSET_BYTES) {
      return res.status(413).json({ error: 'too_large', maxBytes: MAX_ASSET_BYTES });
    }
    const dir = path.join(DOCS_DIR, 'assets');
    const file = path.join(dir, name);
    if (!file.startsWith(dir + path.sep)) return res.status(400).json({ error: 'invalid_asset_name' });
    // Already have it? Treat as success — the doc's <img> will resolve either way.
    if (await access(file, fsConstants.F_OK).then(() => true).catch(() => false)) {
      noStore(res);
      return res.json({ ok: true, name, existed: true });
    }
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, buf);
    } catch {
      return res.status(500).json({ error: 'write_failed' });
    }
    noStore(res);
    res.json({ ok: true, name });
  });

  // GET /api/docs -> { docs: [id, ...] }  (for the landing page)
  // Scoped per viewer: the owner sees every doc; a guest sees only docs they
  // created PLUS any doc with no owner row (the seed/demo docs, public to all).
  // This keeps the hosted site from being one shared bucket — a guest's uploads
  // aren't visible to other guests, and the owner's work isn't listed publicly.
  app.get('/api/docs', readLimiter, async (req, res) => {
    noStore(res);
    const all = await listDocs();
    const { token, isOwner } = req.caller;
    if (isOwner) return res.json({ docs: all });
    const owners = ownerMap(db);
    const visible = all.filter((id) => !(id in owners) || owners[id] === token);
    res.json({ docs: visible });
  });

  // POST /api/upload { id, html, overwrite? } -> { ok, id }
  // Writes a new document to docs/<id>.html. HTML is trusted styling but we
  // strip active content (scripts/handlers/js: URLs) so the stored file is inert.
  app.post('/api/upload', uploadLimiter, async (req, res) => {
    const { id, html, overwrite } = req.body || {};
    const { token, isOwner } = req.caller;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    if (typeof html !== 'string' || html.trim().length === 0) {
      return res.status(400).json({ error: 'empty_html' });
    }
    if (Buffer.byteLength(html, 'utf8') > MAX_DOC_BYTES) {
      return res.status(413).json({ error: 'too_large', maxBytes: MAX_DOC_BYTES });
    }
    // Must look like HTML (a tag somewhere) — guards against pasted plain text.
    if (!/<[a-z!][\s\S]*>/i.test(html)) return res.status(400).json({ error: 'not_html' });

    const file = path.join(DOCS_DIR, `${id}.html`);
    if (!file.startsWith(DOCS_DIR + path.sep)) return res.status(400).json({ error: 'invalid_doc_id' });

    const existsBefore = await access(file, fsConstants.F_OK).then(() => true).catch(() => false);

    // Refuse to clobber an existing doc unless the caller opts in — an accidental
    // re-upload would otherwise silently replace a reviewed document (its
    // overlay/suggestions/history in SQLite would then point at different text).
    if (existsBefore && !overwrite) return res.status(409).json({ error: 'doc_exists' });

    // Guardrails: guests are capped to GUEST_DOC_LIMIT docs, and the box holds at
    // most MAX_GUEST_OWNERS distinct guests. The owner (OWNER_KEY) is exempt.
    // Overwriting a doc you already own doesn't consume a new slot.
    if (!isOwner) {
      const ownsThis = getDocOwner(db, id) === token;
      const creatingNew = !existsBefore || !ownsThis;
      if (creatingNew) {
        // Overwriting someone else's doc is not allowed for guests.
        if (existsBefore && !ownsThis) return res.status(403).json({ error: 'not_your_doc' });
        if (countDocsOwnedBy(db, token) >= LIMITS.GUEST_DOC_LIMIT) {
          return res.status(403).json({ error: 'guest_doc_limit', limit: LIMITS.GUEST_DOC_LIMIT });
        }
        // New distinct guest? enforce the global ceiling.
        if (countDocsOwnedBy(db, token) === 0 && countGuestOwners(db) >= LIMITS.MAX_GUEST_OWNERS) {
          return res.status(503).json({ error: 'capacity_full' });
        }
      }
    }

    // Interactive doc? Keep the un-stripped ORIGINAL alongside the inert copy.
    // docs/<id>.html is always the scrubbed, safe-to-inline version (fallback +
    // anchoring base); docs/<id>.raw.html is the original with its JS intact,
    // rendered only inside a sandboxed iframe and used to rebuild the download.
    const interactive = hasActiveContent(html);
    const rawFile = path.join(DOCS_DIR, `${id}.raw.html`);
    if (!rawFile.startsWith(DOCS_DIR + path.sep)) return res.status(400).json({ error: 'invalid_doc_id' });
    try {
      await writeFile(file, stripActiveContent(html), 'utf8');
      if (interactive) {
        await writeFile(rawFile, html, 'utf8');
      } else {
        // Overwriting a previously-interactive doc with a static one: drop the
        // now-stale raw copy so it can't be served/rebuilt.
        await rm(rawFile, { force: true }).catch(() => {});
      }
    } catch {
      return res.status(500).json({ error: 'write_failed' });
    }
    // Record ownership (owner docs use the shared 'owner' token).
    setDocOwner(db, id, isOwner ? 'owner' : token, new Date().toISOString());
    noStore(res);
    res.json({ ok: true, id, interactive });
  });

  // DELETE /api/doc/:id — remove a document (file + all SQLite state). Allowed
  // for the owner, or the guest who created it (frees their one slot).
  app.delete('/api/doc/:id', writeLimiter, async (req, res) => {
    const { id } = req.params;
    const { token, isOwner } = req.caller;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    const file = path.join(DOCS_DIR, `${id}.html`);
    if (!file.startsWith(DOCS_DIR + path.sep)) return res.status(400).json({ error: 'invalid_doc_id' });
    const owner = getDocOwner(db, id);
    const exists = await access(file, fsConstants.F_OK).then(() => true).catch(() => false);
    if (!exists && owner == null) return res.status(404).json({ error: 'doc_not_found' });
    if (!isOwner && owner !== token) return res.status(403).json({ error: 'not_your_doc' });
    await rm(file, { force: true }).catch(() => {});
    await rm(path.join(DOCS_DIR, `${id}.raw.html`), { force: true }).catch(() => {});
    await rm(path.join(DOCS_DIR, `${id}.config.json`), { force: true }).catch(() => {});
    deleteDocData(db)(id);
    noStore(res);
    res.json({ ok: true, id });
  });

  // GET /api/doc/:id -> { id, baseHtml, overlay, config, hasRaw }
  // hasRaw=true means this is an INTERACTIVE doc with an original kept at
  // <id>.raw.html — the viewer then uses the sandboxed-iframe path (see /api/raw).
  app.get('/api/doc/:id', readLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    const baseHtml = await readDocHtml(id);
    if (baseHtml == null) return res.status(404).json({ error: 'doc_not_found' });
    const config = await readDocConfig(id);
    // access = the doc's link-access level; canEdit/canSuggest = what THIS caller
    // may do given that level (the owner/doc-owner always can, a guest per level).
    const access = getDocAccess(db, id);
    const mine = ownsDoc(req, id);
    noStore(res);
    res.json({
      id, baseHtml, overlay: getOverlay(db, id), config, hasRaw: await docHasRaw(id),
      access, isDocOwner: mine,
      canEdit: mine || access === 'edit',
      canSuggest: mine || access !== 'view',
    });
  });

  // GET /api/access/:id -> { access, isDocOwner }   PUT { level } -> { ok, access }
  // The link-access level (view/suggest/edit) is the owner's control over what a
  // guest with the link may do. Reading it is open (the viewer needs it to render
  // the right modes); changing it is restricted to the owner / the doc's owner.
  app.get('/api/access/:id', readLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    if (await readDocHtml(id) == null) return res.status(404).json({ error: 'doc_not_found' });
    noStore(res);
    res.json({ access: getDocAccess(db, id), isDocOwner: ownsDoc(req, id) });
  });

  app.put('/api/access/:id', writeLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    if (await readDocHtml(id) == null) return res.status(404).json({ error: 'doc_not_found' });
    if (!ownsDoc(req, id)) return res.status(403).json({ error: 'not_your_doc' });
    const level = String(req.body?.level || '');
    if (!ACCESS_LEVELS.includes(level)) return res.status(400).json({ error: 'invalid_access_level' });
    // A doc with no owner row (seed/demo) can't carry a per-doc level. Only the
    // global owner reaches here for those (ownsDoc → isOwner), so record ownership
    // under the shared 'owner' token first, then set the level.
    if (getDocOwner(db, id) == null) setDocOwner(db, id, 'owner', new Date().toISOString());
    setDocAccess(db, id, level);
    noStore(res);
    res.json({ ok: true, access: level });
  });

  // GET /api/raw/:id -> the un-stripped ORIGINAL bytes of an interactive doc, as
  // JSON { id, rawHtml }. This is the ONLY way the viewer gets the runnable HTML,
  // and it deliberately returns JSON (not a navigable text/html document): the raw
  // bytes are attacker-controlled, so we never let them be a top-level page on our
  // origin. The viewer drops them into a sandboxed <iframe srcdoc> (opaque origin),
  // where the doc's JS can run but can't reach our cookies/APIs.
  //   Defense in depth: even the JSON response is marked no-store + nosniff and
  //   carries a CSP sandbox directive, so a browser that somehow renders it as a
  //   document still gets an opaque, script-only-sandboxed context.
  app.get('/api/raw/:id', readLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    const rawHtml = await readRawHtml(id);
    if (rawHtml == null) return res.status(404).json({ error: 'no_raw' });
    noStore(res);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
    res.json({ id, rawHtml });
  });

  // POST /api/snapshot/:id { html } -> { ok, html }
  // The static "edited snapshot" download for interactive docs. The viewer asks the
  // sandboxed frame to serialize its LIVE (post-JS) DOM and posts that string here.
  // That string is ATTACKER-CONTROLLED (the frame ran untrusted JS and could have
  // planted a <script>/on*=/javascript: that would fire when the user later opens
  // the downloaded file OUTSIDE the sandbox). So we run it through the exact same
  // stripActiveContent used on upload before handing anything back — the download is
  // therefore inert. This never touches stored state; it's a pure sanitize service.
  app.post('/api/snapshot/:id', writeLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    // Only snapshot docs that exist and actually have a runnable original — a static
    // doc has no live frame to snapshot, so there's nothing to sanitize here.
    if (!(await docHasRaw(id))) return res.status(404).json({ error: 'no_raw' });
    const { html } = req.body || {};
    if (typeof html !== 'string' || html.length === 0) return res.status(400).json({ error: 'invalid_html' });
    if (Buffer.byteLength(html, 'utf8') > MAX_DOC_BYTES) {
      return res.status(413).json({ error: 'too_large', maxBytes: MAX_DOC_BYTES });
    }
    const clean = stripActiveContent(html);
    noStore(res);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.json({ ok: true, html: clean });
  });

  // POST /api/patch-download/:id { edits:[{from,to}] } -> { ok, html, applied, unmatched }
  // The "original interactive" download for a self-unpacking bundle. The bundle
  // renders its visible text from gzip+base64 payload blobs, so editing the DOM
  // doesn't change the file. This decodes those blobs, does an EXACT string swap
  // (from -> to) inside them, re-encodes, and returns the patched file — still fully
  // interactive, now carrying the reviewer's edits. Blobs without the target text
  // are left byte-for-byte untouched; edits whose `from` isn't found come back in
  // `unmatched` (the client can fall back or warn). We introduce no executable
  // content: only the doc's own payload text changes.
  app.post('/api/patch-download/:id', writeLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    const rawHtml = await readRawHtml(id);
    if (rawHtml == null) return res.status(404).json({ error: 'no_raw' });
    const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
    // Bound the request: cap edit count and per-string length (defense vs abuse).
    const safeEdits = edits
      .filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string')
      .slice(0, 5000)
      .map((e) => ({ from: e.from.slice(0, MAX_TEXT), to: e.to.slice(0, MAX_TEXT) }));
    let result;
    try { result = patchSource(rawHtml, safeEdits); }
    catch { return res.status(500).json({ error: 'patch_failed' }); }
    noStore(res);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.json({ ok: true, html: result.html, applied: result.applied, unmatched: result.unmatched });
  });

  // Owner-only gate for the review DECISIONS on a doc (direct edit, restore,
  // accept/reject). Suggesting stays open so any reviewer can propose changes;
  // applying them is the owner's call. The global owner (OWNER_KEY) may act on
  // any doc; a guest may act only on a doc they created (owner row === their
  // token). Docs with no owner row (seed/demo) are owner-only. Mirrors the
  // check already used by DELETE /api/doc/:id.
  function ownsDoc(req, id) {
    if (req.caller?.isOwner) return true;
    const owner = getDocOwner(db, id);
    return owner != null && owner === req.caller?.token;
  }

  // May THIS caller directly edit the doc's text? The owner/doc-owner always may;
  // a plain guest may only when the doc's link-access level is 'edit'.
  function canEditDoc(req, id) {
    return ownsDoc(req, id) || getDocAccess(db, id) === 'edit';
  }

  // May THIS caller propose suggestions? Everyone except a guest on a 'view'-only
  // doc (the owner/doc-owner is never blocked).
  function canSuggestDoc(req, id) {
    return ownsDoc(req, id) || getDocAccess(db, id) !== 'view';
  }

  // POST /api/edit/:id { anchor, text } -> { ok, overlay }
  app.post('/api/edit/:id', writeLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    if (await readDocHtml(id) == null) return res.status(404).json({ error: 'doc_not_found' });
    // Direct editing: the owner/doc-owner always, or a guest when access === 'edit'.
    if (!canEditDoc(req, id)) return res.status(403).json({ error: 'edit_not_allowed' });
    const { anchor, text } = req.body || {};
    if (typeof anchor !== 'string' || !anchor || anchor.length > 200) {
      return res.status(400).json({ error: 'invalid_anchor' });
    }
    if (typeof text !== 'string' || text.length > MAX_TEXT) {
      return res.status(400).json({ error: 'invalid_text' });
    }
    const ts = new Date().toISOString();
    const overlay = setBlockAndSnapshot(db)(id, anchor, escapeText(text), ts, null);
    noStore(res);
    res.json({ ok: true, overlay });
  });

  // GET /api/versions/:id -> { versions: [{id, ts, label}] }
  app.get('/api/versions/:id', readLimiter, (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    noStore(res);
    res.json({ versions: listVersions(db, id) });
  });

  // GET /api/version/:id/:versionId -> { id, ts, label, overlay }  (preview)
  app.get('/api/version/:id/:versionId', readLimiter, (req, res) => {
    const { id, versionId } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    const v = getVersion(db, id, Number(versionId));
    if (!v) return res.status(404).json({ error: 'version_not_found' });
    noStore(res);
    res.json({ id: v.id, ts: v.ts, label: v.label, overlay: v.overlay });
  });

  // POST /api/restore/:id { versionId } -> { ok, overlay }
  app.post('/api/restore/:id', writeLimiter, (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    if (!ownsDoc(req, id)) return res.status(403).json({ error: 'not_your_doc' });
    const versionId = Number(req.body?.versionId);
    if (!Number.isInteger(versionId)) return res.status(400).json({ error: 'invalid_version_id' });
    const overlay = restoreVersion(db)(id, versionId, new Date().toISOString());
    if (overlay == null) return res.status(404).json({ error: 'version_not_found' });
    noStore(res);
    res.json({ ok: true, overlay });
  });

  // --- suggestions (tracked changes; owner can suggest + accept/reject) ---

  // GET /api/suggestions/:id -> { suggestions: [...] }  (open only)
  app.get('/api/suggestions/:id', readLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    if (await readDocHtml(id) == null) return res.status(404).json({ error: 'doc_not_found' });
    // A view-only link hides change requests from guests: if the owner locked the
    // doc to 'view', a guest must not be able to read others' suggestions either
    // (they can't make them, and the owner may have chosen 'view' precisely to
    // keep a client from seeing pending edits). Owner/doc-owner always see them.
    if (!canSuggestDoc(req, id)) return res.status(403).json({ error: 'view_only' });
    noStore(res);
    res.json({ suggestions: listSuggestions(db, id, 'open') });
  });

  // POST /api/suggest/:id { anchor, quote, body, kind, author } -> { ok, suggestion }
  app.post('/api/suggest/:id', writeLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    if (await readDocHtml(id) == null) return res.status(404).json({ error: 'doc_not_found' });
    // Suggesting is open to any reviewer EXCEPT on a view-only doc (owner's choice).
    if (!canSuggestDoc(req, id)) return res.status(403).json({ error: 'suggest_not_allowed' });
    const { anchor, quote, body, kind, author, spanOcc, baseText } = req.body || {};
    if (kind !== 'rewrite' && kind !== 'comment') return res.status(400).json({ error: 'invalid_kind' });
    // A multi-block anchor ("m:a1,a2,…") packs several block anchors, so it needs a
    // larger cap than a single anchor. 1000 chars fits ~14 sha256 anchors — well
    // above the client's 8-block rewrite cap.
    if (typeof anchor !== 'string' || !anchor || anchor.length > 1000) return res.status(400).json({ error: 'invalid_anchor' });
    if (typeof body !== 'string' || body.length === 0 || body.length > MAX_TEXT) return res.status(400).json({ error: 'invalid_body' });
    // span_occ: -2 = multi-block whole-paragraph rewrite (anchor is an "m:" list;
    // body is blank-line-separated paragraphs re-split at accept). -1 = whole block.
    // >=0 = replace the Nth occurrence of `quote`. A span-level rewrite MUST carry a
    // non-empty quote to locate the phrase.
    let span_occ = -1;
    if (spanOcc != null) {
      if (!Number.isInteger(spanOcc) || spanOcc < -2) return res.status(400).json({ error: 'invalid_span' });
      span_occ = spanOcc;
    }
    if (span_occ >= 0 && kind === 'rewrite' && !(typeof quote === 'string' && quote.length > 0)) {
      return res.status(400).json({ error: 'span_requires_quote' });
    }
    // A multi-block rewrite must actually carry a packed anchor list to apply to.
    if (span_occ === -2 && kind === 'rewrite' && !anchor.startsWith('m:')) {
      return res.status(400).json({ error: 'multi_requires_list' });
    }
    // base_text/quote/body are UNTRUSTED (reviewers). We escape body+quote+author
    // for display. base_text must be escaped too because span replacement happens
    // against the escaped overlay text (overlay is stored escaped), so all three
    // sides — needle (quote), haystack (base_text), overlay — share one encoding.
    const suggestion = addSuggestion(db, {
      id: randomUUID(),
      doc_id: id,
      anchor,
      quote: escapeText(String(quote || '').slice(0, MAX_TEXT)),
      body: escapeText(body),
      kind,
      author: escapeText(String(author || 'reviewer').slice(0, 120)),
      created_at: new Date().toISOString(),
      span_occ,
      base_text: escapeText(String(baseText || '').slice(0, MAX_TEXT)),
    });
    noStore(res);
    res.json({ ok: true, suggestion });
  });

  // POST /api/suggest/:id/:sid/accept -> { ok, overlay }
  app.post('/api/suggest/:id/:sid/accept', writeLimiter, (req, res) => {
    const { id, sid } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    if (!ownsDoc(req, id)) return res.status(403).json({ error: 'not_your_doc' });
    const s = getSuggestion(db, sid);
    if (!s || s.doc_id !== id) return res.status(404).json({ error: 'suggestion_not_found' });
    if (s.status !== 'open') return res.status(409).json({ error: 'already_resolved' });
    // Body was stored escaped; it is applied via the overlay which is also stored
    // escaped and rendered as textContent, so decoding happens client-side. For a
    // span-level rewrite, acceptSuggestion ignores `text` and splices `body` into
    // the block's current text at the quote's Nth occurrence.
    const result = acceptSuggestion(db)(sid, s.body, new Date().toISOString());
    if (result == null) return res.status(409).json({ error: 'accept_failed' });
    // Span phrase drifted (block edited since the suggestion) -> marked stale,
    // nothing applied. Tell the client so it can surface why.
    if (result.stale) return res.status(409).json({ error: 'span_stale', overlay: result.overlay });
    noStore(res);
    res.json({ ok: true, overlay: result });
  });

  // POST /api/suggest/:id/:sid/reject -> { ok }
  app.post('/api/suggest/:id/:sid/reject', writeLimiter, (req, res) => {
    const { id, sid } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    if (!ownsDoc(req, id)) return res.status(403).json({ error: 'not_your_doc' });
    const s = getSuggestion(db, sid);
    if (!s || s.doc_id !== id) return res.status(404).json({ error: 'suggestion_not_found' });
    if (s.status !== 'open') return res.status(409).json({ error: 'already_resolved' });
    setSuggestionStatus(db, sid, 'rejected');
    noStore(res);
    res.json({ ok: true });
  });

  // In-app feedback → GitHub issue. Its own same-origin + honeypot + per-IP
  // limiter live in feedback-api.js; the GITHUB_TOKEN stays server-side.
  app.post('/api/feedback', makeFeedbackHandler({ now: opts.now }));

  // JSON error handler. Body-parser rejects an over-limit request BEFORE our own
  // size check with a PayloadTooLargeError (413); surface it as clean JSON with
  // the file-size limit, and turn any other error into a 500 without a stack.
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return res.status(413).json({ error: 'too_large', maxBytes: MAX_DOC_BYTES });
    }
    if (err?.status === 400 || err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'bad_request' });
    }
    return res.status(500).json({ error: 'server_error' });
  });

  return app;
}

// Copy the baked-in seed docs onto a persistent DOCS_DIR the first time we boot
// there (empty volume). Never overwrites an existing file, so real uploads and
// edited seeds are preserved across deploys.
async function seedDocs() {
  if (DOCS_DIR === SEED_DOCS_DIR) return; // running against the baked-in dir
  const { mkdir, copyFile, readdir: rd } = await import('node:fs/promises');
  await mkdir(path.join(DOCS_DIR, 'assets'), { recursive: true });
  const entries = await rd(SEED_DOCS_DIR, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isFile()) continue;
    const dest = path.join(DOCS_DIR, e.name);
    const exists = await access(dest, fsConstants.F_OK).then(() => true).catch(() => false);
    if (!exists) await copyFile(path.join(SEED_DOCS_DIR, e.name), dest);
  }
}

// Start only when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await seedDocs();
  const db = openDb();
  createApp(db).listen(PORT, HOST, () => {
    console.log(`markmyword on http://${HOST}:${PORT}  (open / to list + add files)`);
  });
}
