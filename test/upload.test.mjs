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

async function cleanup() { await unlink(TMP_FILE).catch(() => {}); }
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
} finally {
  await cleanup();
  server.close();
}

// Confirm cleanup actually removed the artifact.
const stillThere = await readFile(TMP_FILE, 'utf8').then(() => true).catch(() => false);
ok(!stillThere, 'test doc cleaned up from docs/');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
