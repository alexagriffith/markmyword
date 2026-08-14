// Span-selection clamping for Suggesting mode (regression for "I highlighted a
// whole paragraph but nothing happened / it grabbed the neighbouring text").
//
// resolveSpanSelection must:
//   • return a span for a sub-phrase highlight (spanOcc tracks which repeat),
//   • treat a whole-block highlight as a block rewrite (wholeBlock:true, spanOcc -1),
//   • CLAMP a selection that overshoots past the block into a neighbour so only the
//     block's own text becomes the phrase (never leaks adjacent text),
//   • resolve the block even when the selection STARTS outside it (end inside),
//   • return null when the selection touches no anchored block at all.
import { JSDOM } from 'jsdom';
import { resolveSpanSelection, occurrenceIndex } from '../public/span-select.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

const dom = new JSDOM(`<!doctype html><body>
<h2 data-hs-anchor="h">SYSTEM PROMPT</h2>
<p id="a" data-hs-anchor="a">rate limiting then more rate limiting after that end</p>
<p id="b" data-hs-anchor="b">next paragraph distinct text</p>
<div id="plain">no anchor here at all</div>
</body>`, { pretendToBeVisual: true });
const win = dom.window;
const doc = win.document;
const blockTextOf = (el) => el.textContent;

// Helper: select from (startNode, startOff) to (endNode, endOff) and resolve.
function selectAndResolve(sc, so, ec, eo) {
  const r = doc.createRange();
  r.setStart(sc, so); r.setEnd(ec, eo);
  const sel = win.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  return resolveSpanSelection(win, blockTextOf);
}

const a = doc.getElementById('a').firstChild;   // text node of #a
const b = doc.getElementById('b').firstChild;   // text node of #b
const full = 'rate limiting then more rate limiting after that end';

// --- 1. Sub-phrase highlight: the FIRST "rate limiting" ----------------------
let s = selectAndResolve(a, 0, a, 13); // "rate limiting"
ok(s && s.phrase === 'rate limiting', `sub-phrase resolves ("${s && s.phrase}")`);
ok(s && s.anchor === 'a', 'sub-phrase reports the block anchor');
ok(s && s.spanOcc === 0, 'first occurrence -> spanOcc 0');
ok(s && !s.wholeBlock, 'sub-phrase is NOT flagged wholeBlock');

// --- 2. The SECOND "rate limiting" -> spanOcc 1 ------------------------------
const secondStart = full.indexOf('rate limiting', 5);
s = selectAndResolve(a, secondStart, a, secondStart + 13);
ok(s && s.phrase === 'rate limiting' && s.spanOcc === 1, `second occurrence -> spanOcc 1 (got ${s && s.spanOcc})`);

// --- 3. Whole-block highlight -> wholeBlock rewrite --------------------------
s = selectAndResolve(a, 0, a, full.length);
ok(s && s.wholeBlock === true, 'whole-block highlight flagged wholeBlock');
ok(s && s.spanOcc === -1, 'whole-block -> spanOcc -1 (block rewrite, not fragile span)');
ok(s && s.phrase === full, 'whole-block phrase is the entire block text');

// --- 4. OVERSHOOT past the block end into the next paragraph -----------------
// Start inside #a, end inside #b. Must clamp to #a and NOT include #b's text.
s = selectAndResolve(a, 5, b, 4);
ok(s && s.anchor === 'a', 'overshoot-forward clamps to the starting block (#a)');
ok(s && !/next paragraph/.test(s.phrase), 'overshoot phrase does NOT leak the next paragraph text');
ok(s && s.phrase.startsWith('limiting'), `overshoot phrase starts at the selection start ("${s && s.phrase.slice(0, 16)}…")`);
ok(s && s.phrase.endsWith('end'), 'overshoot phrase is clamped to the block END');

// --- 5. Selection STARTS outside the block (in the heading), ends inside #a --
s = selectAndResolve(doc.querySelector('h2').firstChild, 0, a, 13);
ok(s, 'a selection starting in the heading but ending in #a still resolves (start-block wins)');

// --- 6. No anchored block anywhere -> null -----------------------------------
const plain = doc.getElementById('plain').firstChild;
s = selectAndResolve(plain, 0, plain, 5);
ok(s === null, 'selection with no anchored block resolves to null');

// --- 7. Collapsed / empty selection -> null ----------------------------------
const sel = win.getSelection(); sel.removeAllRanges();
ok(resolveSpanSelection(win, blockTextOf) === null, 'no selection -> null');
const cr = doc.createRange(); cr.setStart(a, 4); cr.setEnd(a, 4); sel.addRange(cr);
ok(resolveSpanSelection(win, blockTextOf) === null, 'collapsed selection -> null');

// --- 8. occurrenceIndex unit ------------------------------------------------
ok(occurrenceIndex(full, 'rate limiting', 0) === 0, 'occurrenceIndex at offset 0 -> 0');
ok(occurrenceIndex(full, 'rate limiting', secondStart) === 1, 'occurrenceIndex before 2nd -> 1');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
