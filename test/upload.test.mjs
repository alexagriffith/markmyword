// Upload flow against the REAL Express app: list docs, upload a new document,
// confirm it (a) lands in docs/, (b) is script-stripped, (c) is then loadable via
// /api/doc, (d) refuses to clobber without overwrite, and (e) rejects bad input.
// Uploads go to a throwaway id under docs/ and are deleted at the end.
import { openDb } from '../db.js';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run this suite as the OWNER: it exercises upload/overwrite mechanics, which is
// the owner's job. Owner mode also bypasses the per-guest doc cap so repeated
// overwrites of the same test id aren't blocked by the guardrails. (Guardrail
// behavior itself is covered by test/guardrails.test.mjs.) OWNER_KEY is read by
// guardrails at module load, so set it BEFORE dynamically importing server.js.
process.env.OWNER_KEY = process.env.OWNER_KEY || 'upload-test-owner-key';
const KEY = process.env.OWNER_KEY;
const { createApp } = await import('../server.js');

const DOCS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const TMP_ID = 'zz-upload-test-doc'; // sorts last; unmistakably a test artifact
const TMP_FILE = path.join(DOCS_DIR, `${TMP_ID}.html`);
const TMP_RAW_FILE = path.join(DOCS_DIR, `${TMP_ID}.raw.html`);
const TMP_ASSET = 'zz-upload-test-asset.png'; // test image artifact
const TMP_ASSET_FILE = path.join(DOCS_DIR, 'assets', TMP_ASSET);

const db = openDb(':memory:');
const server = await new Promise((res) => { const s = createApp(db).listen(0, () => res(s)); });
const base = `http://localhost:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };
// The owner key promotes every request to owner (no cookie jar needed since we
// present the key each time), so ownership/cap checks don't interfere.
const withKey = (u) => u + (u.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY);
const post = (u, body) => fetch(base + withKey(u), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const get = (u) => fetch(base + withKey(u)).then((r) => r.json());

async function cleanup() { await unlink(TMP_FILE).catch(() => {}); await unlink(TMP_RAW_FILE).catch(() => {}); await unlink(TMP_ASSET_FILE).catch(() => {}); }
await cleanup(); // in case a prior aborted run left it behind

try {
  // 1. Listing includes the real seed docs and not config/asset files.
  let docs = (await get('/api/docs')).docs;
  ok(Array.isArray(docs) && docs.includes('example'), 'GET /api/docs lists real docs');
  ok(!docs.includes(TMP_ID), 'test doc not present before upload');

  // 2. Upload with an embedded <script> and an onclick handler -> stored inert.
  const dirty = '<!doctype html><html><head><style>.x{color:red}</style></head>'
    + '<body><h1 onclick="steal()">Hi</h1><p>Body text</p>'
    + '<script>fetch("//evil");</script>'
    + '<a href="javascript:evil()">x</a></body></html>';
  let r = await post('/api/upload', { id: TMP_ID, html: dirty });
  ok(r.status === 200, 'upload new doc -> 200');

  const onDisk = await readFile(TMP_FILE, 'utf8');
  ok(!/<script/i.test(onDisk), 'stored file has NO <script> tag');
  ok(!/onclick/i.test(onDisk), 'stored file has NO inline onclick handler');
  ok(!/javascript:/i.test(onDisk), 'javascript: URL neutralized');
  ok(onDisk.includes('Body text') && onDisk.includes('color:red'), 'legit content + CSS preserved');

  // 2b. Bypass-hardening: `/`-separated handler + entity-encoded javascript: URL.
  const sneaky = '<!doctype html><body>'
    + '<img src=x/onerror="steal()">'                          // no space before onerror
    + '<a href="&#106;avascript:evil()">a</a>'                 // entity-encoded scheme
    + '<a href=&#x6a;avascript:evil()>b</a>'                   // unquoted, hex entity
    + '<p>clean copy</p></body>';
  await post('/api/upload', { id: TMP_ID, html: sneaky, overwrite: true });
  const sneakyDisk = await readFile(TMP_FILE, 'utf8');
  ok(!/onerror/i.test(sneakyDisk), 'slash-separated onerror handler stripped');
  ok(!/javascript:/i.test(decodeURIComponent(sneakyDisk)) && !/&#106;avascript|&#x6a;avascript/i.test(sneakyDisk), 'entity-encoded javascript: URLs neutralized');
  ok(sneakyDisk.includes('clean copy'), 'legit content survives bypass-hardening scrub');
  // restore the plain dirty upload for the remaining assertions
  await post('/api/upload', { id: TMP_ID, html: dirty, overwrite: true });

  // 3. It now lists and loads through the normal doc pipeline.
  docs = (await get('/api/docs')).docs;
  ok(docs.includes(TMP_ID), 'uploaded doc appears in listing');
  r = await fetch(`${base}/api/doc/${TMP_ID}`);
  ok(r.status === 200 && (await r.json()).baseHtml.includes('Body text'), 'uploaded doc loads via /api/doc');

  // 4. Re-upload without overwrite -> 409; with overwrite -> 200.
  ok((await post('/api/upload', { id: TMP_ID, html: dirty })).status === 409, 're-upload without overwrite -> 409');
  ok((await post('/api/upload', { id: TMP_ID, html: '<p>replaced</p>', overwrite: true })).status === 200, 'overwrite=true -> 200');
  ok((await fetch(`${base}/api/doc/${TMP_ID}`).then((x) => x.json())).baseHtml.includes('replaced'), 'overwrite replaced content');

  // 5. Bad inputs.
  ok((await post('/api/upload', { id: '../evil', html: '<p>x</p>' })).status === 400, 'traversal id -> 400');
  ok((await post('/api/upload', { id: 'good-id', html: '' })).status === 400, 'empty html -> 400');
  ok((await post('/api/upload', { id: 'good-id', html: 'just plain text no tags' })).status === 400, 'non-HTML -> 400');

  // 5b. Interactive doc: an upload WITH scripts keeps an un-stripped .raw.html and
  //     reports hasRaw; the served base is still inert; /api/raw returns the
  //     original with its <script> intact and hardened headers; overwriting with a
  //     STATIC doc drops the raw copy; DELETE removes both files.
  const interactiveHtml = '<!doctype html><html><head><title>app</title></head>'
    + '<body><h1>Live heading</h1><p>Static copy</p>'
    + '<div id="app"></div>'
    + '<script>document.getElementById("app").textContent = "built by JS";</script>'
    + '</body></html>';
  let ir = await post('/api/upload', { id: TMP_ID, html: interactiveHtml, overwrite: true });
  const ij = await ir.json();
  ok(ir.status === 200 && ij.interactive === true, 'interactive upload -> 200 with interactive:true');
  const rawOnDisk = await readFile(TMP_RAW_FILE, 'utf8').catch(() => null);
  ok(rawOnDisk !== null && /<script/i.test(rawOnDisk), 'raw copy kept with <script> intact');
  const baseOnDisk = await readFile(TMP_FILE, 'utf8');
  ok(!/<script/i.test(baseOnDisk), 'inert base copy still has NO <script>');

  const docMeta = await get(`/api/doc/${TMP_ID}`);
  ok(docMeta.hasRaw === true, 'GET /api/doc reports hasRaw:true for interactive doc');

  const rawRes = await fetch(`${base}/api/raw/${TMP_ID}`);
  ok(rawRes.status === 200, 'GET /api/raw -> 200');
  ok(rawRes.headers.get('content-security-policy') === 'sandbox allow-scripts', '/api/raw sends CSP sandbox allow-scripts');
  ok(rawRes.headers.get('x-content-type-options') === 'nosniff', '/api/raw sends nosniff');
  const rawJson = await rawRes.json();
  ok(/<script/i.test(rawJson.rawHtml) && rawJson.rawHtml.includes('built by JS'), '/api/raw returns original bytes with JS');

  // Overwrite with a STATIC doc -> raw copy must be removed + hasRaw false.
  await post('/api/upload', { id: TMP_ID, html: '<!doctype html><body><p>now static</p></body>', overwrite: true });
  const stillRaw = await readFile(TMP_RAW_FILE, 'utf8').then(() => true).catch(() => false);
  ok(!stillRaw, 'overwriting interactive doc with static one drops the .raw.html');
  ok((await get(`/api/doc/${TMP_ID}`)).hasRaw === false, 'hasRaw false after static overwrite');
  ok((await fetch(`${base}/api/raw/${TMP_ID}`)).status === 404, '/api/raw -> 404 once raw copy is gone');

  // Re-upload interactive, then DELETE, and confirm both files removed.
  await post('/api/upload', { id: TMP_ID, html: interactiveHtml, overwrite: true });
  ok(await readFile(TMP_RAW_FILE, 'utf8').then(() => true).catch(() => false), 'raw copy present again before delete');
  // DELETE promotes to owner via the key query param (same as the other calls).
  const delRes = await fetch(base + withKey(`/api/doc/${TMP_ID}`), { method: 'DELETE' });
  ok(delRes.status === 200, 'DELETE interactive doc -> 200');
  ok(!(await readFile(TMP_FILE, 'utf8').then(() => true).catch(() => false)), 'DELETE removed base .html');
  ok(!(await readFile(TMP_RAW_FILE, 'utf8').then(() => true).catch(() => false)), 'DELETE removed .raw.html');
  // Non-interactive listing must not show a phantom "<id>.raw" entry.
  await post('/api/upload', { id: TMP_ID, html: interactiveHtml, overwrite: true });
  const listAfter = (await get('/api/docs')).docs;
  ok(!listAfter.includes(`${TMP_ID}.raw`), 'listing has no phantom <id>.raw entry');

  // 6. Asset upload: a doc's referenced image travels via /api/upload-asset.
  //    1x1 transparent PNG.
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const before = new Set((await get('/api/assets')).assets || []);
  ok(!before.has(TMP_ASSET), 'test asset not present before upload');

  r = await post('/api/upload-asset', { name: TMP_ASSET, dataBase64: PNG_B64 });
  ok(r.status === 200, 'upload-asset -> 200');
  const stored = await readFile(TMP_ASSET_FILE).then(() => true).catch(() => false);
  ok(stored, 'asset written to docs/assets/');
  ok(((await get('/api/assets')).assets || []).includes(TMP_ASSET), 'GET /api/assets lists the new image');

  // Re-upload of same name is a no-op success (existed:true), not a clobber error.
  ok((await (await post('/api/upload-asset', { name: TMP_ASSET, dataBase64: PNG_B64 })).json()).existed === true,
     'existing asset re-upload -> ok, existed:true');

  // It's served read-only at /docs/assets/<name>.
  ok((await fetch(`${base}/docs/assets/${TMP_ASSET}`)).status === 200, 'asset served at /docs/assets/');

  // Bad asset inputs.
  ok((await post('/api/upload-asset', { name: '../evil.png', dataBase64: PNG_B64 })).status === 400, 'traversal asset name -> 400');
  ok((await post('/api/upload-asset', { name: 'notanimage.txt', dataBase64: PNG_B64 })).status === 400, 'non-image extension -> 400');
  ok((await post('/api/upload-asset', { name: 'sub/dir.png', dataBase64: PNG_B64 })).status === 400, 'nested path asset name -> 400');
  ok((await post('/api/upload-asset', { name: 'ok.png', dataBase64: '' })).status === 400, 'empty asset data -> 400');
} finally {
  await cleanup();
  server.close();
}

// Confirm cleanup actually removed the artifact.
const stillThere = await readFile(TMP_FILE, 'utf8').then(() => true).catch(() => false);
ok(!stillThere, 'test doc cleaned up from docs/');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
