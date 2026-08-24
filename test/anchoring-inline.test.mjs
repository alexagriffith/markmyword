// Regression: text wrapped entirely in INLINE elements must still be editable.
//
// Real static docs (e.g. the ConfigIQ briefing) put a cell/card/diagram's whole
// text inside an inline tag with NO direct text on the block itself:
//   • <td><strong>Recommend / GPU sizer</strong></td>   (table cell, one bold run)
//   • <div class="stat"><strong>21 Aug</strong><span>…</span></div>  (KPI card)
//   • <pre><code>…ascii diagram…</code></pre>              (code block)
// Before the fix these were skipped (isEditableLeaf required *direct* text), so a
// reviewer couldn't edit or suggest on them even though every plain-text sibling
// cell worked. The fix: an element is a leaf if it has its OWN text (direct or in
// inline-only descendants) and contains no nested BLOCK. This test locks that in
// AND guards against the two ways it could go wrong: double-anchoring (both the
// wrapper and its inline child) and shifting existing anchors.
import { JSDOM } from 'jsdom';
import { assignAnchors, isEditableLeaf } from '../public/anchoring.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

const anchorOf = (el) => el.getAttribute('data-hs-anchor');

// --- 1. table cell whose text is wholly inside <strong> ----------------------
{
  const doc = new JSDOM(`<!doctype html><body><table><tbody>
    <tr><td>Plain cell</td><td><strong>Recommend / GPU sizer</strong></td></tr>
  </tbody></table></body>`).window.document;
  await assignAnchors(doc.body);
  const cells = doc.querySelectorAll('td');
  ok(!!anchorOf(cells[0]), 'plain-text cell is editable');
  ok(!!anchorOf(cells[1]), 'inline-wrapped (<strong>) cell is editable (regression)');
  ok(!anchorOf(cells[1].querySelector('strong')), 'the inner <strong> is NOT separately anchored (cell owns it)');
}

// --- 2. KPI card: <div> with only inline children (strong + span) ------------
{
  const doc = new JSDOM(`<!doctype html><body>
    <div class="stat"><strong>21 Aug</strong><span>Internal MVP / quiet launch</span></div>
  </body>`).window.document;
  await assignAnchors(doc.body);
  const card = doc.querySelector('.stat');
  ok(!!anchorOf(card), 'inline-only <div> card is one editable unit');
  ok(!anchorOf(card.querySelector('strong')) && !anchorOf(card.querySelector('span')),
    'card children are not separately anchored (no fragmenting)');
  // Whole card text is the unit -> both strings live under one anchor.
  ok(/21 Aug/.test(card.textContent) && /Internal MVP/.test(card.textContent), 'card holds both runs');
}

// --- 3. <pre><code> diagram --------------------------------------------------
{
  const doc = new JSDOM(`<!doctype html><body><pre><code>User
    |
    v
ConfigIQ UI</code></pre></body>`).window.document;
  await assignAnchors(doc.body);
  const pre = doc.querySelector('pre');
  ok(!!anchorOf(pre), '<pre><code> diagram is editable (regression)');
  ok(!anchorOf(pre.querySelector('code')), 'inner <code> not separately anchored');
}

// --- 4. a real wrapper of BLOCKS is still NOT a leaf (no over-broadening) ----
{
  const doc = new JSDOM(`<!doctype html><body>
    <div id="wrap"><p>one</p><p>two</p></div>
  </body>`).window.document;
  await assignAnchors(doc.body);
  ok(!anchorOf(doc.getElementById('wrap')), 'a div wrapping <p> blocks is NOT anchored (its children are)');
  ok(doc.querySelectorAll('p[data-hs-anchor]').length === 2, 'the two <p> children are the leaves');
}

// --- 5. inline-only leaf hashes the SAME as bare text (anchor stability) -----
{
  const bare = new JSDOM('<!doctype html><body><table><tbody><tr><td>Recommend / GPU sizer</td></tr></tbody></table></body>').window.document;
  const wrapped = new JSDOM('<!doctype html><body><table><tbody><tr><td><strong>Recommend / GPU sizer</strong></td></tr></tbody></table></body>').window.document;
  const mb = await assignAnchors(bare.body);
  const mw = await assignAnchors(wrapped.body);
  ok([...mb.keys()][0] === [...mw.keys()][0],
    'inline wrapping does not change the anchor (edits bind by text, not markup)');
}

// --- 6. isEditableLeaf is directly correct for the tricky cases --------------
{
  const d = new JSDOM(`<!doctype html><body>
    <table><tbody><tr><td id="c"><strong>x</strong></td></tr></tbody></table>
    <div id="empty"></div>
    <p><span id="inline">not a block</span></p>
  </body>`).window.document;
  ok(isEditableLeaf(d.getElementById('c')), 'inline-wrapped block cell is a leaf');
  ok(!isEditableLeaf(d.getElementById('empty')), 'empty block is not a leaf');
  ok(!isEditableLeaf(d.getElementById('inline')), 'a bare inline element is not a leaf (would fragment sentences)');
}

console.log(`anchoring-inline: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
