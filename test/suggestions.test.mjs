// Suggestions API round-trip against Express + in-memory SQLite: suggest ->
// list -> accept applies to overlay + records a version; reject clears without
// applying. Untrusted suggestion text is escaped on store.
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { createApp } from '../server.js';

const db = openDb(':memory:');
const app = createApp(db);

// Start on an ephemeral port.
const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
const base = `http://localhost:${server.address().port}`;
const DOC = 'example'; // a real docs/<id>.html must exist for the route checks

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };
const post = (u, body) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const get = (u) => fetch(base + u).then((r) => r.json());

// 1. Create a rewrite suggestion.
let anchor = 'testanchor123';
let r = await post(`/api/suggest/${DOC}`, { anchor, quote: 'old words', body: 'new words here', kind: 'rewrite', author: 'owner' });
ok(r.status === 200, 'POST suggest (rewrite) 200');
const created = (await r.json()).suggestion;
ok(created && created.status === 'open', 'suggestion created as open');
ok(!/[<>]/.test(created.body) || created.body.includes('&'), 'suggestion body stored (escaping applied to untrusted text)');

// 2. It shows up in the open list; live overlay is still empty (not applied).
let list = (await get(`/api/suggestions/${DOC}`)).suggestions;
ok(list.length === 1, 'one open suggestion listed');
let doc = await get(`/api/doc/${DOC}`);
ok(!doc.overlay[anchor], 'live overlay unchanged before accept');

// 3. XSS attempt in suggestion body is escaped.
r = await post(`/api/suggest/${DOC}`, { anchor: 'xssanchor', body: '<script>alert(1)</script>', kind: 'comment' });
const xss = (await r.json()).suggestion;
ok(!xss.body.includes('<script>'), 'script tag in suggestion body is escaped');

// 4. Accept the rewrite -> overlay gets the text + a version is recorded.
r = await post(`/api/suggest/${DOC}/${created.id}/accept`);
ok(r.status === 200, 'accept 200');
const acc = await r.json();
ok(acc.overlay[anchor] && acc.overlay[anchor].text.includes('new words'), 'accepted text applied to overlay');
const versions = (await get(`/api/versions/${DOC}`)).versions;
ok(versions.length >= 1, 'accept recorded a version snapshot');

// 5. Accepting again fails (already resolved).
r = await post(`/api/suggest/${DOC}/${created.id}/accept`);
ok(r.status === 409, 'double-accept rejected (409)');

// 6. Reject the comment -> it leaves the open list, overlay unaffected.
r = await post(`/api/suggest/${DOC}/${xss.id}/reject`);
ok(r.status === 200, 'reject 200');
list = (await get(`/api/suggestions/${DOC}`)).suggestions;
ok(list.length === 0, 'no open suggestions after accept + reject');

// 7. Bad inputs.
ok((await post(`/api/suggest/${DOC}`, { anchor, body: 'x', kind: 'bogus' })).status === 400, 'invalid kind rejected');
ok((await post(`/api/suggest/${DOC}`, { anchor, body: '', kind: 'comment' })).status === 400, 'empty body rejected');
ok((await post(`/api/suggest/${DOC}/does-not-exist/accept`)).status === 404, 'accept unknown suggestion 404');
ok((await post(`/api/suggest/${DOC}`, { anchor, quote: 'x', body: 'y', kind: 'rewrite', spanOcc: 1.5 })).status === 400, 'non-integer span rejected');
ok((await post(`/api/suggest/${DOC}`, { anchor, body: 'y', kind: 'rewrite', spanOcc: 0 })).status === 400, 'span rewrite without quote rejected');

// 8. Span-level rewrite: replace only the Nth occurrence of a phrase in a block.
const spanAnchor = 'spanblock';
const blockBase = 'rate limiting then more rate limiting after that';
r = await post(`/api/suggest/${DOC}`, {
  anchor: spanAnchor, quote: 'rate limiting', body: 'throttling',
  kind: 'rewrite', spanOcc: 1, baseText: blockBase,
});
ok(r.status === 200, 'span suggest 200');
const spanS = (await r.json()).suggestion;
ok(spanS.span_occ === 1, 'span_occ persisted (1)');
ok(spanS.base_text === blockBase, 'base_text persisted');

r = await post(`/api/suggest/${DOC}/${spanS.id}/accept`);
ok(r.status === 200, 'span accept 200');
const spanOverlay = (await r.json()).overlay[spanAnchor];
// Only the SECOND "rate limiting" becomes "throttling"; the first is untouched.
ok(spanOverlay && spanOverlay.text === 'rate limiting then more throttling after that',
   `span replaced only the 2nd occurrence (got: ${spanOverlay && spanOverlay.text})`);

// 9. Span accept where the phrase no longer exists -> stale, nothing applied.
r = await post(`/api/suggest/${DOC}`, {
  anchor: 'goneblock', quote: 'vanished phrase', body: 'x',
  kind: 'rewrite', spanOcc: 0, baseText: 'this text does not contain it',
});
const goneS = (await r.json()).suggestion;
r = await post(`/api/suggest/${DOC}/${goneS.id}/accept`);
ok(r.status === 409, 'span accept with missing phrase -> 409 stale');
ok((await r.json()).error === 'span_stale', 'stale error surfaced');
doc = await get(`/api/doc/${DOC}`);
ok(!doc.overlay['goneblock'], 'stale span accept did not touch overlay');

// 10. Comment on a NON-TEXT element (image/chart) via a "c:" comment anchor.
const cAnchor = 'c:deadbeefimageanchor';
r = await post(`/api/suggest/${DOC}`, { anchor: cAnchor, quote: 'image', body: 'swap this banner for the Q3 one', kind: 'comment', author: 'owner' });
ok(r.status === 200, 'comment on non-text element (c: anchor) 200');
const cCreated = (await r.json()).suggestion;
ok(cCreated && cCreated.status === 'open', 'element comment created open');
list = (await get(`/api/suggestions/${DOC}`)).suggestions;
ok(list.some((s) => s.anchor === cAnchor), 'element comment appears in open list');
// Accepting a comment resolves it without touching the overlay.
r = await post(`/api/suggest/${DOC}/${cCreated.id}/accept`);
ok(r.status === 200, 'accept element comment 200');
doc = await get(`/api/doc/${DOC}`);
ok(!doc.overlay[cAnchor], 'accepting an element comment does not create an overlay entry');

// 11. MULTI-block rewrite: one suggestion across N paragraphs (span_occ -2).
// The anchor packs the blocks' anchors as "m:a1,a2,…"; the body is blank-line-
// separated paragraphs; accept writes each paragraph to its own anchor.
const mAnchor = 'm:blkone,blktwo,blkthree';
r = await post(`/api/suggest/${DOC}`, {
  anchor: mAnchor,
  quote: 'para one\n\npara two\n\npara three',
  body: 'new one\n\nnew two\n\nnew three',
  kind: 'rewrite', spanOcc: -2, baseText: 'para one\n\npara two\n\npara three', author: 'owner',
});
ok(r.status === 200, 'multi-block suggest 200');
const mS = (await r.json()).suggestion;
ok(mS.span_occ === -2, 'multi-block span_occ persisted (-2)');
ok(mS.anchor === mAnchor, 'multi-block packed anchor persisted');

r = await post(`/api/suggest/${DOC}/${mS.id}/accept`);
ok(r.status === 200, 'multi-block accept 200');
const mOv = (await r.json()).overlay;
ok(mOv.blkone && mOv.blkone.text === 'new one', 'first paragraph applied to first anchor');
ok(mOv.blktwo && mOv.blktwo.text === 'new two', 'second paragraph applied to second anchor');
ok(mOv.blkthree && mOv.blkthree.text === 'new three', 'third paragraph applied to third anchor');

// 12. Multi-block accept with a paragraph-count MISMATCH -> stale, nothing applied.
const mMismatch = 'm:mm1,mm2,mm3';
r = await post(`/api/suggest/${DOC}`, {
  anchor: mMismatch, quote: 'a\n\nb\n\nc', body: 'only two\n\nparagraphs here',
  kind: 'rewrite', spanOcc: -2, baseText: 'a\n\nb\n\nc',
});
const mmS = (await r.json()).suggestion;
r = await post(`/api/suggest/${DOC}/${mmS.id}/accept`);
ok(r.status === 409, 'multi-block paragraph-count mismatch -> 409 stale');
ok((await r.json()).error === 'span_stale', 'mismatch surfaces stale error');
doc = await get(`/api/doc/${DOC}`);
ok(!doc.overlay['mm1'] && !doc.overlay['mm3'], 'mismatched multi accept did not touch overlay');

// 13. span_occ -2 rewrite WITHOUT an m: anchor is rejected (must carry a list).
ok((await post(`/api/suggest/${DOC}`, { anchor: 'plain', quote: 'x', body: 'y', kind: 'rewrite', spanOcc: -2 })).status === 400,
   'multi rewrite without an m: anchor rejected');
// span_occ below -2 is out of range.
ok((await post(`/api/suggest/${DOC}`, { anchor: 'x', body: 'y', kind: 'comment', spanOcc: -3 })).status === 400,
   'span_occ < -2 rejected');
// A multi-block COMMENT (no rewrite) is fine at -1 with an m: anchor.
r = await post(`/api/suggest/${DOC}`, { anchor: 'm:cc1,cc2', quote: 'p1\n\np2', body: 'both of these need work', kind: 'comment' });
ok(r.status === 200, 'multi-block comment (m: anchor, kind comment) 200');

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
