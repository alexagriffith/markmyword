// Full-stack round-trip against the REAL Express app + SQLite (in-memory DB).
// Proves: doc load, edit persistence, version snapshot on edit, and restore.
import { openDb } from '../db.js';
import { createApp } from '../server.js';

const db = openDb(':memory:');
const app = createApp(db);

// Boot on an ephemeral port.
const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const base = `http://localhost:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };
const j = (r) => r.json();

// 1. GET existing doc
let r = await fetch(`${base}/api/doc/example`);
ok(r.status === 200, 'GET doc -> 200');
let d = await j(r);
ok(typeof d.baseHtml === 'string' && d.baseHtml.includes('Example Newsletter'), 'baseHtml present');
ok(d.overlay && Object.keys(d.overlay).length === 0, 'overlay empty initially');

// 2. GET missing doc / traversal
ok((await fetch(`${base}/api/doc/nope`)).status === 404, 'missing doc -> 404');
ok((await fetch(`${base}/api/doc/${encodeURIComponent('../db')}`)).status === 400, 'traversal id -> 400');

// 3. POST edit persists + escapes
r = await fetch(`${base}/api/edit/example`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ anchor: 'abc', text: 'Hi <b>x</b> & y' }),
});
ok(r.status === 200, 'edit -> 200');
d = await j(r);
ok(d.overlay.abc.text === 'Hi &lt;b&gt;x&lt;/b&gt; &amp; y', 'edit text stored HTML-escaped');

// 4. GET again -> overlay round-trips (THIS is what failed on Vercel in-mem)
d = await j(await fetch(`${base}/api/doc/example`));
ok(d.overlay.abc && d.overlay.abc.text.startsWith('Hi &lt;b&gt;'), 'overlay persists across requests');

// 5. A second edit creates a second version
await fetch(`${base}/api/edit/example`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ anchor: 'abc', text: 'second' }),
});
const { versions } = await j(await fetch(`${base}/api/versions/example`));
ok(versions.length === 2, 'two versions recorded after two edits');

// 6. Restore the first version -> live text reverts, and a restore version is added
const firstVersionId = versions[versions.length - 1].id; // oldest
r = await fetch(`${base}/api/restore/example`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ versionId: firstVersionId }),
});
ok(r.status === 200, 'restore -> 200');
d = await j(await fetch(`${base}/api/doc/example`));
ok(d.overlay.abc.text === 'Hi &lt;b&gt;x&lt;/b&gt; &amp; y', 'restore reverted live text to v1');
const after = await j(await fetch(`${base}/api/versions/example`));
ok(after.versions.length === 3, 'restore appended a new version (undoable)');

// 7. Validation
ok((await fetch(`${base}/api/edit/example`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anchor: 'x', text: 'a'.repeat(60000) }) })).status === 400, 'oversized text -> 400');
ok((await fetch(`${base}/api/restore/example`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: 'nope' }) })).status === 400, 'bad versionId -> 400');

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
