// Link access control (Google-Docs "Anyone with the link can…") against the REAL
// Express app. A per-doc level — view / suggest / edit — set by the owner gates
// what a GUEST who has the link may do:
//   • view    → read only: cannot suggest, cannot edit
//   • suggest → read + suggest (the default; matches pre-feature behavior)
//   • edit    → read + suggest + directly edit
// The owner (and a doc's guest-owner) is never blocked, whatever the level.
// Uses an in-memory DB + throwaway docs dir so the real repo docs/ are untouched.
import { openDb, getDocAccess } from '../db.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.OWNER_KEY = 'access-test-owner-key';
process.env.SESSION_SECRET = 'access-test-secret';
// Raise the guest doc cap so one client can own a doc while we also exercise a
// second, non-owning guest against it.
process.env.MMW_GUEST_DOC_LIMIT = '5';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

const tmp = await mkdtemp(path.join(tmpdir(), 'mmw-access-'));
process.env.HS_DOCS_DIR = tmp;
const { createApp } = await import('../server.js');

const db = openDb(':memory:');
const server = await new Promise((res) => { const s = createApp(db).listen(0, () => res(s)); });
const base = `http://localhost:${server.address().port}`;

// Minimal cookie jar so each client keeps its own identity (owner vs guests).
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
    async req(method, url, body, extra = {}) {
      const headers = { ...extra };
      const c = cookieHeader();
      if (c) headers['Cookie'] = c;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return capture(res);
    },
  };
}

const HTML = '<!doctype html><html><body><h1>Title</h1><p>A paragraph to edit.</p></body></html>';
const KEY = 'access-test-owner-key';

// Suggest body used repeatedly (a comment needs no quote/span).
const suggestBody = { anchor: 'x'.repeat(20), body: 'please reword', kind: 'comment' };

try {
  // Owner uploads a doc; a guest owns their own separate doc later.
  const owner = makeClient();
  let r = await owner.req('GET', `/api/whoami?key=${KEY}`);
  ok((await r.json()).isOwner === true, 'owner key promotes to owner');
  r = await owner.req('POST', '/api/upload', { id: 'doc-a', html: HTML });
  ok(r.status === 200, 'owner uploads doc-a');

  // A fresh guest (has the link, does not own doc-a).
  const guest = makeClient();
  r = await guest.req('GET', '/api/whoami');
  ok((await r.json()).isOwner === false, 'guest is not owner');

  // 1. Default level is 'suggest' (behavior preserved from before the feature).
  r = await owner.req('GET', '/api/access/doc-a');
  let j = await r.json();
  ok(r.status === 200 && j.access === 'suggest', `default access is 'suggest' (got '${j.access}')`);
  ok(j.isDocOwner === true, 'owner is reported as doc owner');
  ok(getDocAccess(db, 'doc-a') === 'suggest', 'db agrees default is suggest');

  // 2. On the default level, a guest CAN suggest but CANNOT directly edit.
  r = await guest.req('POST', '/api/suggest/doc-a', suggestBody);
  ok(r.status === 200, "guest can suggest at 'suggest' level");
  r = await guest.req('POST', '/api/edit/doc-a', { anchor: 'x'.repeat(20), text: 'hacked' });
  j = await r.json().catch(() => ({}));
  ok(r.status === 403 && j.error === 'edit_not_allowed', "guest cannot directly edit at 'suggest' level");

  // 3. Owner locks it to 'view' → guest can no longer suggest OR edit.
  r = await owner.req('PUT', '/api/access/doc-a', { level: 'view' });
  ok(r.status === 200 && (await r.json()).access === 'view', 'owner sets access to view');
  r = await guest.req('POST', '/api/suggest/doc-a', suggestBody);
  j = await r.json().catch(() => ({}));
  ok(r.status === 403 && j.error === 'suggest_not_allowed', "guest cannot suggest at 'view' level");
  r = await guest.req('POST', '/api/edit/doc-a', { anchor: 'x'.repeat(20), text: 'hacked' });
  ok(r.status === 403, "guest still cannot edit at 'view' level");
  // …but the guest can still READ a view-only doc.
  r = await guest.req('GET', '/api/doc/doc-a');
  j = await r.json();
  ok(r.status === 200 && j.access === 'view' && j.canSuggest === false && j.canEdit === false,
     'guest reads view-only doc; canSuggest/canEdit both false');

  // 4. Owner opens it to 'edit' → guest can now directly edit AND suggest.
  r = await owner.req('PUT', '/api/access/doc-a', { level: 'edit' });
  ok(r.status === 200 && (await r.json()).access === 'edit', 'owner sets access to edit');
  // Read the real anchor so the edit lands on the paragraph.
  r = await guest.req('GET', '/api/doc/doc-a');
  j = await r.json();
  ok(j.canEdit === true && j.canSuggest === true, "guest sees canEdit/canSuggest true at 'edit' level");
  // Any valid anchor is accepted by /api/edit (overlay is keyed by anchor); use a
  // plausible one — the point is the AUTH gate now passes.
  r = await guest.req('POST', '/api/edit/doc-a', { anchor: 'a'.repeat(20), text: 'guest edit' });
  ok(r.status === 200, "guest can directly edit at 'edit' level");
  r = await guest.req('POST', '/api/suggest/doc-a', suggestBody);
  ok(r.status === 200, "guest can still suggest at 'edit' level");

  // 5. A guest CANNOT change the access level (privilege check).
  r = await guest.req('PUT', '/api/access/doc-a', { level: 'view' });
  j = await r.json().catch(() => ({}));
  ok(r.status === 403 && j.error === 'not_your_doc', 'guest cannot change access level');
  ok(getDocAccess(db, 'doc-a') === 'edit', 'access level unchanged after guest attempt');

  // 6. Invalid level is rejected.
  r = await owner.req('PUT', '/api/access/doc-a', { level: 'admin' });
  j = await r.json().catch(() => ({}));
  ok(r.status === 400 && j.error === 'invalid_access_level', 'invalid level -> 400');

  // 7. Owner is NEVER blocked, even on a view-only doc: lock doc-a, owner still edits.
  r = await owner.req('PUT', '/api/access/doc-a', { level: 'view' });
  ok(r.status === 200, 'owner re-locks to view');
  r = await owner.req('POST', `/api/edit/doc-a?key=${KEY}`, { anchor: 'a'.repeat(20), text: 'owner edit' });
  ok(r.status === 200, 'owner edits a view-only doc (never blocked)');

  // 8. A doc's GUEST-OWNER controls ITS access and is never blocked on it.
  const g2 = makeClient();
  r = await g2.req('POST', '/api/upload', { id: 'guest-doc', html: HTML });
  ok(r.status === 200, 'second guest uploads their own doc');
  r = await g2.req('GET', '/api/access/guest-doc');
  ok((await r.json()).isDocOwner === true, 'guest owns their uploaded doc');
  r = await g2.req('PUT', '/api/access/guest-doc', { level: 'view' });
  ok(r.status === 200 && (await r.json()).access === 'view', 'guest-owner sets their doc to view');
  // The owner of guest-doc can still edit it despite view-only.
  r = await g2.req('POST', '/api/edit/guest-doc', { anchor: 'a'.repeat(20), text: 'owner-of-doc edit' });
  ok(r.status === 200, 'guest-owner edits their own view-only doc');
  // A DIFFERENT guest cannot edit guest-doc.
  r = await guest.req('POST', '/api/edit/guest-doc', { anchor: 'a'.repeat(20), text: 'nope' });
  ok(r.status === 403, 'a different guest cannot edit someone else’s view-only doc');

  // 9. Access endpoints validate the doc id and existence.
  r = await owner.req('GET', '/api/access/bad*id');
  ok(r.status === 400, 'GET /api/access invalid id -> 400');
  r = await owner.req('PUT', '/api/access/ghost', { level: 'edit' });
  ok(r.status === 404, 'PUT /api/access on missing doc -> 404');

  // 10. Level survives a re-upload (overwrite): setDocOwner must not reset it.
  r = await owner.req('PUT', '/api/access/doc-a', { level: 'edit' });
  ok(r.status === 200, 'set doc-a to edit before re-upload');
  r = await owner.req('POST', '/api/upload', { id: 'doc-a', html: HTML, overwrite: true });
  ok(r.status === 200, 'owner re-uploads doc-a');
  ok(getDocAccess(db, 'doc-a') === 'edit', 'access level preserved across overwrite');
} finally {
  server.close();
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`access: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
