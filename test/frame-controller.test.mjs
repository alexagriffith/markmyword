// Regression guard for the "cannot edit any of the text" bug.
//
// The interactive-doc frame is sandbox="allow-scripts" (opaque origin), where
// crypto.subtle is UNAVAILABLE. The frame-controller previously called
// crypto.subtle.digest directly, threw, and made NOTHING editable. This test runs
// frame-controller.js in a jsdom window with crypto.subtle removed (mirroring the
// frame) and asserts: it boots, posts 'ready', marks text editable, and its anchors
// MATCH public/anchoring.js byte-for-byte (so downloads still line up).
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { assignAnchors } from '../public/anchoring.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

const controller = await readFile(new URL('../public/frame-controller.js', import.meta.url), 'utf8');

// A doc whose visible text lives in the MARKUP (so anchoring finds leaves). The
// controller reads window.__MMW_RAW__ for the original-anchor set.
const raw = '<!doctype html><html><head><title>t</title></head><body>'
  + '<h1>Model Overview</h1><p>Intro paragraph.</p>'
  + '<div><p>Nested para.</p></div></body></html>';

const dom = new JSDOM(raw, { runScripts: 'outside-only', pretendToBeVisual: true });
const win = dom.window;

// Mirror the frame, and go one worse: pretend a hostile doc grafted a poisoned
// crypto.subtle.digest into the realm (it shares the frame with our controller and
// runs before boot). The controller must IGNORE it and use its own vetted SHA-256,
// so anchors still match the parent. If it trusted this, anchors would diverge and
// the cross-check below would fail.
let poisonedCalled = 0;
Object.defineProperty(win, 'crypto', {
  value: { subtle: { digest: () => { poisonedCalled++; return Promise.resolve(new ArrayBuffer(32)); } } },
  configurable: true,
});
win.__MMW_RAW__ = raw;
win.__MMW_DOC__ = 'zz-test';

// Capture messages the controller posts to the parent.
const posted = [];
win.parent = { postMessage: (msg) => posted.push(msg) };

// Run the controller IIFE inside the window.
win.eval(controller);

// boot() is scheduled via load event + setTimeout(300). Fire load, then wait.
win.document.dispatchEvent && win.dispatchEvent(new win.Event('load'));
await new Promise((r) => setTimeout(r, 800));

const ready = posted.find((m) => m && m.type === 'ready');
ok(!!ready, "controller posts 'ready' even without crypto.subtle (no digest crash)");
ok(ready && ready.anchors.length >= 3, 'ready reports the markup anchors (>=3 leaves)');

const editable = win.document.querySelectorAll('[data-hs-editable]');
ok(editable.length >= 3, 'text elements are marked editable');
ok([...editable].every((el) => el.getAttribute('contenteditable') === 'true'),
   'editable elements are contenteditable');

// The controller's anchors MUST equal anchoring.js's anchors for the same markup —
// otherwise a download rebuilt by the parent (using anchoring.js) wouldn't match.
const refDom = new JSDOM(raw);
const refMap = await assignAnchors(refDom.window.document.body);
const refAnchors = new Set(refMap.keys());
const frameAnchors = new Set(ready ? ready.anchors : []);
const sameSize = refAnchors.size === frameAnchors.size;
const allMatch = [...frameAnchors].every((a) => refAnchors.has(a));
ok(sameSize && allMatch, 'frame anchors match anchoring.js anchors exactly (pure-JS SHA-256 == WebCrypto)');
ok(poisonedCalled === 0, 'controller IGNORES a hostile crypto.subtle.digest (uses its own SHA-256)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
