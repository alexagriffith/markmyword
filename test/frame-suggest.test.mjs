// Suggesting/commenting on ANY element inside the interactive (sandboxed) frame.
//
// For interactive docs the reviewer can't click a DOM node we own — the doc runs
// in an opaque-origin iframe. So Suggesting mode in the frame must:
//   • assign a `c:`-namespaced comment anchor to ANY element (button, heading,
//     JS-rendered card — not just media),
//   • on a suggest-mode click, PREVENT the doc's own control from firing and post
//     back a `suggestTarget` describing the element (anchor, isText, snippet, rect),
//   • report a text leaf's existing text anchor (isText:true) so a comment can sit
//     beside a possible rewrite,
//   • keep a comment anchor STABLE across a re-anchor (same element -> same anchor),
//   • resolve a `flashComment` goto, and reply `commentMissing` for an unknown one.
// This drives public/frame-controller.js in jsdom, exactly like frame-tabs does.
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

const controller = await readFile(new URL('../public/frame-controller.js', import.meta.url), 'utf8');

// A JS-built doc with the two element kinds a comment can target:
//   • a TEXT LEAF (the <h1>, and a button whose own label is direct text) —
//     these carry a text anchor, so clicking reports isText:true (rewrite avail);
//   • a NON-TEXT CONTROL (an icon-only button: its content is a child <svg>, no
//     direct text of its own) and a container card — these get a c: comment anchor
//     and report isText:false (comment-only, since there's no markup text to rewrite).
const raw = `<!doctype html><html><head><title>Model</title></head><body>
<div id="app"></div>
<script>
  var app = document.getElementById('app');
  var h = document.createElement('h1'); h.textContent = 'GLM-5.2-FP8'; app.appendChild(h);
  // Icon-only control: a button whose only child is an <svg> (NO direct text).
  var icon = document.createElement('button'); icon.id = 'iconbtn';
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.appendChild(svg);
  var fired = 0; icon.addEventListener('click', function () { fired++; window.__FIRED__ = fired; });
  app.appendChild(icon);
  var card = document.createElement('div'); card.className = 'card';
  var b = document.createElement('b'); b.textContent = 'Latency'; card.appendChild(b);
  app.appendChild(card);
</script></body></html>`;

const dom = new JSDOM(raw, { runScripts: 'dangerously', pretendToBeVisual: true });
const win = dom.window;
// Mirror the opaque-origin frame: no crypto.subtle -> exercises pure-JS SHA-256.
Object.defineProperty(win, 'crypto', { value: {}, configurable: true });
// jsdom doesn't implement getBoundingClientRect meaningfully; give a finite one so
// the frame reports a real rect (the parent shape-validates finiteness).
win.Element.prototype.getBoundingClientRect = function () { return { left: 12, top: 34, width: 56, height: 20, right: 68, bottom: 54 }; };
win.Element.prototype.scrollIntoView = function () {};
win.__MMW_RAW__ = raw;
win.__MMW_DOC__ = 'zz-suggest';

const posted = [];
win.parent = { postMessage: (msg) => posted.push(msg) };

win.eval(controller);
win.dispatchEvent(new win.Event('load'));
await new Promise((r) => setTimeout(r, 700));

// Deliver a parent->frame message exactly like the real viewer (source = parent).
const sendToFrame = async (data) => {
  win.dispatchEvent(new win.MessageEvent('message', { data, source: win.parent }));
  await new Promise((r) => setTimeout(r, 60));
};
const lastOfType = (t) => [...posted].reverse().find((m) => m && m.type === t);

// --- Enter Suggesting mode: arbitrary elements get comment anchors -----------
await sendToFrame({ type: 'setMode', mode: 'suggest' });
const iconBtn = win.document.getElementById('iconbtn');
const card = win.document.querySelector('.card');
const h1 = win.document.querySelector('h1');
ok(iconBtn.getAttribute('data-hs-comment-anchor'), 'an icon-only button (no text) gets a comment anchor in suggest mode');
ok(card.getAttribute('data-hs-comment-anchor'), 'a JS-rendered card div gets a comment anchor (not only media)');
ok((iconBtn.getAttribute('data-hs-comment-anchor') || '').startsWith('c:'), 'comment anchor is c:-namespaced (never collides with text anchors)');

// --- Suggest-mode click on a NON-TEXT CONTROL: doc control must NOT fire ------
const firedBefore = win.__FIRED__ || 0;
// Click the <svg> inside the icon button — target resolves up to the button.
const clickEvt = new win.MouseEvent('click', { bubbles: true, cancelable: true });
iconBtn.dispatchEvent(clickEvt);
await new Promise((r) => setTimeout(r, 30));
ok(clickEvt.defaultPrevented, "suggest-mode click on the icon button is prevented (its control does not fire)");
ok((win.__FIRED__ || 0) === firedBefore, "the doc's own button handler did not run");
const st = lastOfType('suggestTarget');
ok(st, 'a suggestTarget was posted for the control click');
ok(typeof st.anchor === 'string' && st.anchor.startsWith('c:'), 'suggestTarget carries the c: comment anchor');
ok(st.isText === false, 'clicking a non-text control reports isText:false (comment-only, no rewrite)');
ok(typeof st.snippet === 'string' && st.snippet.length > 0, 'suggestTarget carries a human snippet label');
ok(st.rect && ['left', 'top', 'width', 'height'].every((k) => Number.isFinite(st.rect[k])), 'suggestTarget rect numbers are all finite');

// --- Suggest-mode click on a TEXT LEAF: reports its text anchor, isText:true ---
// The heading's own text is an editable leaf, so clicking it should surface the
// text anchor (so a comment can sit beside a rewrite of the same words).
ok(h1.getAttribute('data-hs-anchor'), 'heading has a text anchor (editable leaf)');
const beforeText = posted.length;
h1.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
await new Promise((r) => setTimeout(r, 30));
const stText = lastOfType('suggestTarget');
ok(posted.length > beforeText && stText, 'clicking a text leaf posts a suggestTarget');
ok(stText.isText === true, 'text leaf reports isText:true (rewrite available)');
ok(stText.anchor === h1.getAttribute('data-hs-anchor'), 'text leaf reports its existing text anchor (not a new c: one)');

// --- Comment anchor STABILITY across a re-anchor -----------------------------
const cardAnchorBefore = card.getAttribute('data-hs-comment-anchor');
// Trigger a rescan the way the MutationObserver would (change unrelated DOM), then
// re-enter suggest so anchors get reassigned; the same element must keep its anchor.
win.document.getElementById('app').appendChild(win.document.createElement('hr'));
await new Promise((r) => setTimeout(r, 400));
await sendToFrame({ type: 'setMode', mode: 'suggest' });
ok(card.getAttribute('data-hs-comment-anchor') === cardAnchorBefore, 'a comment anchor is stable across a re-anchor (same element -> same c: anchor)');

// --- flashComment goto: known anchor resolves, unknown -> commentMissing ------
const missBefore = posted.filter((m) => m && m.type === 'commentMissing').length;
await sendToFrame({ type: 'flashComment', anchor: cardAnchorBefore });
ok(posted.filter((m) => m && m.type === 'commentMissing').length === missBefore,
   'flashComment for a KNOWN anchor resolves (no commentMissing reply)');
await sendToFrame({ type: 'flashComment', anchor: 'c:doesnotexistanchor#1' });
const miss = lastOfType('commentMissing');
ok(miss && miss.anchor === 'c:doesnotexistanchor#1', 'flashComment for an UNKNOWN anchor replies commentMissing with that anchor');

// --- Suggest clicks are inert OUTSIDE suggest mode ---------------------------
await sendToFrame({ type: 'setMode', mode: 'use' });
const firedBefore2 = win.__FIRED__ || 0;
const useClick = new win.MouseEvent('click', { bubbles: true, cancelable: true });
iconBtn.dispatchEvent(useClick);
await new Promise((r) => setTimeout(r, 20));
ok(!useClick.defaultPrevented, "in 'use' mode a button click is NOT intercepted (doc stays interactive)");
ok((win.__FIRED__ || 0) === firedBefore2 + 1, "the doc's button handler runs normally in use mode");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
