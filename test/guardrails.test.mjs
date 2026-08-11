// Guardrails against the REAL Express app: owner-key promotion, per-guest doc
// cap, global guest ceiling, rate limiting (with an injectable clock), file-size
// limit, and delete-frees-a-slot. Uses an in-memory DB and a throwaway docs dir
// so nothing touches the real repo docs/.
import { openDb } from '../db.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// server.js resolves DOCS_DIR from env at module load, so we set HS_DOCS_DIR (and
// the owner/secret env) BEFORE importing server.js — the import happens below,
// after the env is in place, so DOCS_DIR points at our throwaway dir.
process.env.OWNER_KEY = 'test-owner-key';
process.env.SESSION_SECRET = 'test-secret';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

// A controllable clock for rate-limit windows.
let clock = 1_000_000;
const now = () => clock;

const tmp = await mkdtemp(path.join(tmpdir(), 'mmw-guard-'));
process.env.HS_DOCS_DIR = tmp;

// Import server AFTER setting HS_DOCS_DIR so DOCS_DIR picks up the tmp dir.
const { createApp } = await import('../server.js');

const db = openDb(':memory:');
const server = await new Promise((res) => {
  const s = createApp(db, { now }).listen(0, () => res(s));
});
const base = `http://localhost:${server.address().port}`;

// Minimal cookie jar: capture Set-Cookie, replay as Cookie.
function makeClient() {
  const jar = {};
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const capture = (res) => {
    for (const sc of res.headers.getSetCookie?.() || []) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return res;
  };
  return {
    jar,
    async req(method, url, body, extraHeaders = {}) {
      const headers = { ...extraHeaders };
      const c = cookieHeader();
      if (c) headers['Cookie'] = c;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return capture(res);
    },
  };
}

const HTML = '<!doctype html><html><body><h1>Hi</h1><p>Body</p></body></html>';

try {
  // 1. whoami: a fresh visitor is a guest and gets a guest cookie.
  const guest = makeClient();
  let r = await guest.req('GET', '/api/whoami');
  let j = await r.json();
  ok(r.status === 200 && j.isOwner === false, 'fresh visitor is a guest');
  ok(guest.jar.mmw_guest, 'guest cookie was set');

  // 2. Guest can upload their ONE doc.
  r = await guest.req('POST', '/api/upload', { id: 'guest-doc-1', html: HTML });
  ok(r.status === 200, 'guest uploads first doc -> 200');

  // 3. Guest is capped at one doc (GUEST_DOC_LIMIT=1 by default).
  r = await guest.req('POST', '/api/upload', { id: 'guest-doc-2', html: HTML });
  j = await r.json().catch(() => ({}));
  ok(r.status === 403 && j.error === 'guest_doc_limit', 'guest blocked at doc cap');

  // 4. Guest can overwrite THEIR OWN doc without consuming a new slot.
  r = await guest.req('POST', '/api/upload', { id: 'guest-doc-1', html: HTML, overwrite: true });
  ok(r.status === 200, 'guest overwrites own doc -> 200');

  // 5. Deleting frees the slot -> can upload a different doc after.
  r = await guest.req('DELETE', '/api/doc/guest-doc-1');
  ok(r.status === 200, 'guest deletes own doc -> 200');
  r = await guest.req('POST', '/api/upload', { id: 'guest-doc-3', html: HTML });
  ok(r.status === 200, 'guest uploads again after freeing slot -> 200');

  // 6. Owner key promotes to owner (unlimited docs).
  const owner = makeClient();
  r = await owner.req('GET', '/api/whoami?key=test-owner-key');
  j = await r.json();
  ok(j.isOwner === true, 'owner key -> isOwner true');
  ok(owner.jar.mmw_owner, 'owner cookie was set');
  for (const id of ['owner-a', 'owner-b', 'owner-c']) {
    r = await owner.req('POST', '/api/upload', { id, html: HTML });
    ok(r.status === 200, `owner uploads ${id} -> 200 (no cap)`);
  }

  // 7. A guest cannot delete someone else's doc.
  const other = makeClient();
  await other.req('GET', '/api/whoami'); // mint cookie
  r = await other.req('DELETE', '/api/doc/owner-a');
  ok(r.status === 403, 'guest cannot delete a doc they do not own');

  // 8. File-size limit rejects an oversized upload (413).
  const owner2 = makeClient();
  await owner2.req('GET', '/api/whoami?key=test-owner-key');
  const big = '<!doctype html><body>' + 'x'.repeat(3_000_000) + '</body>';
  r = await owner2.req('POST', '/api/upload', { id: 'too-big', html: big });
  // owner is exempt from RATE limits but NOT from the size cap.
  ok(r.status === 413, 'oversized upload rejected with 413');

  // 9. Rate limiting: a guest exceeding the write limit gets 429. Owner exempt.
  const rl = makeClient();
  await rl.req('GET', '/api/whoami');
  await rl.req('POST', '/api/upload', { id: 'rl-doc', html: HTML }); // uses their slot
  // Hammer edits within one window (clock frozen). Default WRITE_PER_MIN=60.
  let got429 = false;
  for (let i = 0; i < 65; i++) {
    const rr = await rl.req('POST', '/api/edit/rl-doc', { anchor: 'a'.repeat(10), text: 'x' });
    if (rr.status === 429) { got429 = true; break; }
  }
  ok(got429, 'guest hits 429 after exceeding write rate limit');

  // 10. Advancing the clock past the window clears the limit.
  clock += 61_000;
  r = await rl.req('POST', '/api/edit/rl-doc', { anchor: 'a'.repeat(10), text: 'y' });
  ok(r.status !== 429, 'rate limit resets after the window elapses');

  // 11. Owner is exempt from rate limits (many writes, no 429).
  const ow = makeClient();
  await ow.req('GET', '/api/whoami?key=test-owner-key');
  await ow.req('POST', '/api/upload', { id: 'ow-doc', html: HTML });
  let ownerBlocked = false;
  for (let i = 0; i < 70; i++) {
    const rr = await ow.req('POST', '/api/edit/ow-doc', { anchor: 'b'.repeat(10), text: 'z' });
    if (rr.status === 429) { ownerBlocked = true; break; }
  }
  ok(!ownerBlocked, 'owner is exempt from write rate limiting');

  // 12. Per-viewer scoped listing: owner sees all docs; a guest sees only docs
  //     they own plus unowned/seed docs; two guests don't see each other's docs.
  clock += 120_000; // clear any lingering rate-limit windows
  // Seed a doc with NO owner row (simulates a repo seed doc like `example`) by
  // writing it straight to the docs dir.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(tmp, 'seed-demo.html'), HTML, 'utf8');

  const alice = makeClient(); await alice.req('GET', '/api/whoami');
  await alice.req('POST', '/api/upload', { id: 'alice-doc', html: HTML });
  const bob = makeClient(); await bob.req('GET', '/api/whoami');
  await bob.req('POST', '/api/upload', { id: 'bob-doc', html: HTML });

  const aliceDocs = (await (await alice.req('GET', '/api/docs')).json()).docs;
  ok(aliceDocs.includes('alice-doc'), 'guest sees their own doc');
  ok(aliceDocs.includes('seed-demo'), 'guest sees the unowned seed/demo doc');
  ok(!aliceDocs.includes('bob-doc'), 'guest does NOT see another guest\'s doc');
  ok(!aliceDocs.includes('owner-a'), 'guest does NOT see the owner\'s doc');

  const ownerAll = makeClient(); await ownerAll.req('GET', '/api/whoami?key=test-owner-key');
  const ownerDocs = (await (await ownerAll.req('GET', '/api/docs')).json()).docs;
  ok(['alice-doc', 'bob-doc', 'owner-a', 'seed-demo'].every((id) => ownerDocs.includes(id)),
     'owner sees every doc (own, both guests\', and seed)');

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  server.close();
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}

if (fail > 0) process.exit(1);
