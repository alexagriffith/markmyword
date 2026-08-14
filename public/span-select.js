// Span-selection resolution for Suggesting mode, extracted so it can be unit-
// tested without booting the viewer. Given a live Selection, it decides whether
// the reviewer highlighted a sub-phrase (span rewrite) or effectively the whole
// block, CLAMPING a selection that spills past the block boundary back into the
// one anchored block it belongs to.
//
// Why clamp: a drag-select routinely overshoots a few characters into adjacent
// whitespace or a neighbouring element. The old code required the selection to be
// fully inside one block and otherwise returned null — so an overshooting or
// whole-paragraph highlight did NOTHING. Clamping makes those highlights work.
import { normalizeText } from './anchoring.js';

// Resolve the anchored block a node belongs to (element or its parent).
export function anchoredBlockOf(node) {
  if (!node) return null;
  const startEl = node.nodeType === 1 ? node : node.parentElement;
  return startEl && startEl.closest ? startEl.closest('[data-hs-anchor]') : null;
}

// 0-based count of identical `phrase` occurrences in `haystack` before `charOffset`.
export function occurrenceIndex(haystack, phrase, charOffset) {
  if (!phrase) return 0;
  let idx = 0, from = 0, n = 0;
  while ((idx = haystack.indexOf(phrase, from)) !== -1 && idx < charOffset) {
    n++; from = idx + phrase.length;
  }
  return n;
}

// Char offset of a range's start within `blockEl`'s textContent.
export function rangeStartOffset(doc, blockEl, range) {
  const pre = doc.createRange();
  pre.selectNodeContents(blockEl);
  try { pre.setEnd(range.startContainer, range.startOffset); } catch { return 0; }
  return pre.toString().length;
}

function rangeRect(range) {
  try { return range.getBoundingClientRect ? range.getBoundingClientRect() : null; } catch { return null; }
}

// Every anchored block that the given range intersects, in document order.
// This is what turns a drag across paragraphs into a MULTI-block selection: we
// stop clamping to one block and instead collect all blocks the selection
// touches. A block counts as touched if the range overlaps it at all (even by a
// single character), so a mid-P1 → mid-P3 drag returns [P1, P2, P3] — each pulled
// in WHOLE (whole-paragraph granularity; the caller warns the reviewer of scope).
export function blocksInRange(doc, range) {
  const all = doc.querySelectorAll('[data-hs-anchor]');
  const hit = [];
  for (const el of all) {
    // intersectsNode isn't in jsdom; compute overlap via boundary-point compares:
    // block is touched unless it ends before the range starts or starts after it ends.
    const br = doc.createRange();
    br.selectNodeContents(el);
    const RangeCtor = (doc.defaultView && doc.defaultView.Range) || Range;
    let endsBeforeStart, startsAfterEnd;
    try {
      endsBeforeStart = range.compareBoundaryPoints(RangeCtor.START_TO_END, br) <= 0; // block end <= range start
      startsAfterEnd = range.compareBoundaryPoints(RangeCtor.END_TO_START, br) >= 0;  // block start >= range end
    } catch { continue; }
    if (!endsBeforeStart && !startsAfterEnd) hit.push(el);
  }
  return hit;
}

// Resolve the current Selection (in window `win`) to a span descriptor, or null.
//   blockTextOf(el) -> the block's effective text (lets the caller handle grouping)
// Returns one of:
//   { multi:true, blocks:[{el,anchor,text}], anchor:"m:a1,a2,…", phrase, rect }  (spans >1 block)
//   { el, anchor, phrase, spanOcc, rect, wholeBlock? }                            (single block)
//   null
export function resolveSpanSelection(win, blockTextOf) {
  const doc = win.document;
  const sel = win.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);

  // Multi-block: the selection touches more than one anchored block. Pull each
  // touched block in WHOLE (whole-paragraph granularity) and pack their existing
  // anchors into an "m:"-namespaced list. No new hashing — every block already
  // has a stable content-hash anchor from assignAnchors.
  const touched = blocksInRange(doc, range);
  if (touched.length > 1) {
    const blocks = touched.map((el) => ({
      el,
      anchor: el.getAttribute('data-hs-anchor'),
      text: blockTextOf(el),
    })).filter((b) => b.anchor);
    if (blocks.length > 1) {
      const phrase = blocks.map((b) => normalizeText(b.text)).filter(Boolean).join('\n\n');
      return {
        multi: true,
        blocks,
        anchor: 'm:' + blocks.map((b) => b.anchor).join(','),
        phrase,
        rect: rangeRect(range),
      };
    }
  }

  const el = anchoredBlockOf(range.startContainer)
    || anchoredBlockOf(range.endContainer)
    || anchoredBlockOf(range.commonAncestorContainer);
  if (!el) return null;
  const RangeCtor = win.Range || Range;
  // Clamp: intersect the raw selection with the block's own contents range.
  const clamp = doc.createRange();
  clamp.selectNodeContents(el);
  const eff = doc.createRange();
  try {
    if (range.compareBoundaryPoints(RangeCtor.START_TO_START, clamp) < 0) eff.setStart(clamp.startContainer, clamp.startOffset);
    else eff.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(RangeCtor.END_TO_END, clamp) > 0) eff.setEnd(clamp.endContainer, clamp.endOffset);
    else eff.setEnd(range.endContainer, range.endOffset);
  } catch { return null; }
  if (eff.collapsed) return null;
  const phrase = normalizeText(eff.toString());
  if (!phrase) return null;
  const full = blockTextOf(el);
  const anchor = el.getAttribute('data-hs-anchor');
  if (normalizeText(full) === phrase) {
    return { el, anchor, phrase, spanOcc: -1, rect: rangeRect(eff), wholeBlock: true };
  }
  const offset = rangeStartOffset(doc, el, eff);
  const spanOcc = occurrenceIndex(full, phrase, offset);
  return { el, anchor, phrase, spanOcc, rect: rangeRect(eff) };
}
