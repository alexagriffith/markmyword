// markmyword server — Express + SQLite, single always-on box.
//
// Serves the static viewer and a small JSON API. Base document HTML comes from
// docs/<id>.html (immutable, trusted). Editor edits + version history live in
// SQLite. No auth yet (phase 2 adds per-doc passwords).
import express from 'express';
import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb, getOverlay, setBlockAndSnapshot, listVersions, getVersion, restoreVersion,
  listSuggestions, addSuggestion, getSuggestion, setSuggestionStatus, acceptSuggestion,
  setDocOwner, getDocOwner, countDocsOwnedBy, countGuestOwners, deleteDocData,
} from './db.js';
import { makeGuardrails, LIMITS } from './guardrails.js';
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
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => e.name.slice(0, -'.html'.length))
    .filter((id) => isValidDocId(id))
    .sort();
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
  app.use(express.static(PUBLIC_DIR));

  const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

  // Guardrails: identify caller (owner vs guest) on every request, then apply
  // per-IP rate limits to the API route groups. `now` is injectable for tests.
  const { identify, readLimiter, writeLimiter, uploadLimiter } = makeGuardrails({ now: opts.now });
  app.use(identify);
  app.get('/api/whoami', (req, res) => {
    noStore(res);
    res.json({ isOwner: !!req.caller?.isOwner, docLimit: LIMITS.GUEST_DOC_LIMIT });
  });
  // Serve document assets (banner images, etc.) referenced by deliverable HTML.
  // Read-only static files under docs/assets — never the .html sources themselves
  // (those go through /api/doc so overlays apply).
  app.use('/docs/assets', express.static(path.join(DOCS_DIR, 'assets')));

  // GET /api/docs -> { docs: [id, ...] }  (for the landing page)
  app.get('/api/docs', async (_req, res) => {
    noStore(res);
    res.json({ docs: await listDocs() });
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

    try {
      await writeFile(file, stripActiveContent(html), 'utf8');
    } catch {
      return res.status(500).json({ error: 'write_failed' });
    }
    // Record ownership (owner docs use the shared 'owner' token).
    setDocOwner(db, id, isOwner ? 'owner' : token, new Date().toISOString());
    noStore(res);
    res.json({ ok: true, id });
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
    await rm(path.join(DOCS_DIR, `${id}.config.json`), { force: true }).catch(() => {});
    deleteDocData(db)(id);
    noStore(res);
    res.json({ ok: true, id });
  });

  // GET /api/doc/:id -> { id, baseHtml, overlay }
  app.get('/api/doc/:id', readLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    const baseHtml = await readDocHtml(id);
    if (baseHtml == null) return res.status(404).json({ error: 'doc_not_found' });
    const config = await readDocConfig(id);
    noStore(res);
    res.json({ id, baseHtml, overlay: getOverlay(db, id), config });
  });

  // POST /api/edit/:id { anchor, text } -> { ok, overlay }
  app.post('/api/edit/:id', writeLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    if (await readDocHtml(id) == null) return res.status(404).json({ error: 'doc_not_found' });
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
    const versionId = Number(req.body?.versionId);
    if (!Number.isInteger(versionId)) return res.status(400).json({ error: 'invalid_version_id' });
    const overlay = restoreVersion(db)(id, versionId, new Date().toISOString());
    if (overlay == null) return res.status(404).json({ error: 'version_not_found' });
    noStore(res);
    res.json({ ok: true, overlay });
  });

  // --- suggestions (tracked changes; owner can suggest + accept/reject) ---

  // GET /api/suggestions/:id -> { suggestions: [...] }  (open only)
  app.get('/api/suggestions/:id', readLimiter, (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    noStore(res);
    res.json({ suggestions: listSuggestions(db, id, 'open') });
  });

  // POST /api/suggest/:id { anchor, quote, body, kind, author } -> { ok, suggestion }
  app.post('/api/suggest/:id', writeLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isValidDocId(id)) return res.status(400).json({ error: 'invalid_doc_id' });
    if (await readDocHtml(id) == null) return res.status(404).json({ error: 'doc_not_found' });
    const { anchor, quote, body, kind, author, spanOcc, baseText } = req.body || {};
    if (kind !== 'rewrite' && kind !== 'comment') return res.status(400).json({ error: 'invalid_kind' });
    if (typeof anchor !== 'string' || !anchor || anchor.length > 200) return res.status(400).json({ error: 'invalid_anchor' });
    if (typeof body !== 'string' || body.length === 0 || body.length > MAX_TEXT) return res.status(400).json({ error: 'invalid_body' });
    // span_occ: -1 = whole block; >=0 = replace the Nth occurrence of `quote`.
    // A span-level rewrite MUST carry a non-empty quote to locate the phrase.
    let span_occ = -1;
    if (spanOcc != null) {
      if (!Number.isInteger(spanOcc) || spanOcc < -1) return res.status(400).json({ error: 'invalid_span' });
      span_occ = spanOcc;
    }
    if (span_occ >= 0 && kind === 'rewrite' && !(typeof quote === 'string' && quote.length > 0)) {
      return res.status(400).json({ error: 'span_requires_quote' });
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
    const s = getSuggestion(db, sid);
    if (!s || s.doc_id !== id) return res.status(404).json({ error: 'suggestion_not_found' });
    if (s.status !== 'open') return res.status(409).json({ error: 'already_resolved' });
    setSuggestionStatus(db, sid, 'rejected');
    noStore(res);
    res.json({ ok: true });
  });

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
