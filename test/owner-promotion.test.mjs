// Regression: owner promotion must happen on STATIC page loads, not just API calls.
//
// The owner becomes owner by opening a URL with `?key=…` — in practice that's a
// browser NAVIGATION to `/` or `/viewer.html?...&key=…`, both of which are served
// by express.static. If express.static is mounted BEFORE the identify middleware,
// those requests are answered by the static handler and terminate before identify
// runs, so the mmw_owner cookie is never set: the owner stays a guest forever and
// every owner-only action (e.g. changing link access) 403s with a vague error.
// This bit a real user. These tests pin identify → static ordering by asserting a
// key on a static route sets the owner cookie AND that the cookie alone then
// authenticates as owner on a following request.
import { openDb } from '../db.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.OWNER_KEY = 'promo-test-owner-key';
process.env.SESSION_SECRET = 'promo-test-secret';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

const tmp = await mkdtemp(path.join(tmpdir(), 'mmw-promo-'));
process.env.HS_DOCS_DIR = tmp;
const { createApp } = await import('../server.js');

const db = openDb(':memory:');
const server = await new Promise((res) => { const s = createApp(db).listen(0, () => res(s)); });
const base = `http://localhost:${server.address().port}`;
const KEY = 'promo-test-owner-key';

// Pull the mmw_owner cookie value (if any) out of a response's Set-Cookie headers.
function ownerCookie(res) {
  for (const sc of res.headers.getSetCookie?.() || []) {
    const [pair] = sc.split(';');
    if (pair.startsWith('mmw_owner=')) return pair.slice('mmw_owner='.length);
  }
  return null;
}

try {
  // 1. Navigating to the ROOT page with the key sets the owner cookie.
  let res = await fetch(`${base}/?key=${KEY}`);
  ok(res.ok, 'GET /?key= serves the page');
  const rootCookie = ownerCookie(res);
  ok(!!rootCookie, 'GET /?key= sets an mmw_owner cookie (identify runs before static)');

  // 2. Navigating to the VIEWER page with the key sets the owner cookie too
  //    (this is the link the user actually opens).
  res = await fetch(`${base}/viewer.html?doc=whatever&key=${KEY}`);
  ok(res.ok, 'GET /viewer.html?key= serves the page');
  ok(!!ownerCookie(res), 'GET /viewer.html?key= sets an mmw_owner cookie');

  // 3. The cookie alone (no key) then authenticates as owner on a later request.
  res = await fetch(`${base}/api/whoami`, { headers: { Cookie: `mmw_owner=${rootCookie}` } });
  ok((await res.json()).isOwner === true, 'the promoted cookie authenticates as owner on a later request');

  // 4. A WRONG key on a static route must NOT set an owner cookie.
  res = await fetch(`${base}/?key=not-the-key`);
  ok(ownerCookie(res) === null, 'a wrong key on / does not promote to owner');

  // 5. No key, no cookie → not owner (sanity: promotion is not accidental).
  res = await fetch(`${base}/api/whoami`);
  ok((await res.json()).isOwner === false, 'a bare visitor is not owner');
} finally {
  server.close();
}

console.log(`owner-promotion: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
