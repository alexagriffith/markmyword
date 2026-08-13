// Regression guard for the "cannot edit any of the text" bug (two parts).
//
// The interactive-doc frame is sandbox="allow-scripts" (opaque origin), where
// crypto.subtle is UNAVAILABLE. Two defects made text uneditable there:
//   (A) the controller called crypto.subtle.digest directly -> threw -> NOTHING
//       became editable; and
//   (B) even once anchoring ran, it only anchored BLOCK-TAG leaves, so the inline
//       <span>/<a>/<button> text that "standalone" JS-built docs render (~90% of the
//       page) stayed uneditable.
// This runs frame-controller.js in a jsdom window with crypto.subtle removed
// (mirroring the frame) and asserts it boots, marks BOTH block AND inline text
// editable, hashes identically to anchoring.js, and ignores a hostile digest.
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { sha256hex } from '../public/anchoring.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

const controller = await readFile(new URL('../public/frame-controller.js', import.meta.url), 'utf8');

// A doc that mixes block text (h1/p) with INLINE text (span/a/button) and a nested
// inline badge — the shapes real standalone docs use. The controller reads
// window.__MMW_RAW__ for the original-anchor set.
const raw = '<!doctype html><html><head><title>t</title></head><body>'
  + '<h1>Model Overview</h1>'
  + '<nav><a href="#">Deployments</a><a href="#">Playground</a></nav>'
  + '<div class="badge"><span>Validated by Red Hat</span></div>'
  + '<button>Try in Playground</button>'
  + '<p>Intro paragraph.</p></body></html>';

const dom = new JSDOM(raw, { runScripts: 'outside-only', pretendToBeVisual: true });
const win = dom.window;

// Mirror the frame, and go one worse: pretend a hostile doc grafted a poisoned
// crypto.subtle.digest into the realm (it shares the frame with our controller and
// runs before boot). The controller must IGNORE it and use its own vetted SHA-256.
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
win.dispatchEvent(new win.Event('load'));
await new Promise((r) => setTimeout(r, 800));

const ready = posted.find((m) => m && m.type === 'ready');
ok(!!ready, "controller posts 'ready' even without crypto.subtle (no digest crash)");
ok(poisonedCalled === 0, 'controller IGNORES a hostile crypto.subtle.digest (uses its own SHA-256)');

// --- (B) INLINE text is editable, not just block leaves ---
const editable = [...win.document.querySelectorAll('[data-hs-editable]')];
ok(editable.every((el) => el.getAttribute('contenteditable') === 'true'),
   'every editable element is contenteditable');
const textOf = (t) => editable.find((el) => el.textContent.replace(/\s+/g, ' ').trim() === t);
ok(!!textOf('Model Overview'), 'block heading is editable');
ok(!!textOf('Intro paragraph.'), 'block paragraph is editable');
ok(!!textOf('Deployments') && !!textOf('Playground'), 'inline <a> nav links are editable');
ok(!!textOf('Validated by Red Hat'), 'nested inline <span> badge is editable');
ok(!!textOf('Try in Playground'), 'button label text is editable');

// The wrapping <nav> and badge <div> must NOT themselves be editable — the inner
// text owner is the unit (else editing the wrapper would swallow its children).
const wrapEditable = editable.some((el) => ['NAV', 'BODY'].includes(el.tagName)
  || (el.tagName === 'DIV' && el.querySelector('[data-hs-editable]')));
ok(!wrapEditable, 'text wrappers are NOT editable units (innermost owner wins)');

// --- hashing matches anchoring.js for shared text (so downloads bind correctly) ---
// The frame's anchor for a run == sha256hex(normalized text) computed by the shared
// module. (The leaf SETS differ by design — the frame is broader — but the hashing
// must be identical or an edit couldn't be matched back to the original text.)
const badge = textOf('Validated by Red Hat');
const expected = await sha256hex('Validated by Red Hat');
ok(badge && badge.getAttribute('data-hs-anchor') === expected,
   'inline anchor == sha256hex(normalized text) from anchoring.js (hashing in sync)');

// The controller must have reported origText for the frame->parent download patch.
ok(ready && ready.origText && ready.origText[expected] &&
   ready.origText[expected].includes('Validated by Red Hat'),
   'ready.origText carries each editable run for source-patch on download');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
