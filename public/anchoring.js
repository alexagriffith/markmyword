// Content-hash anchoring — the correctness core of markmyword.
//
// Each editable "text-bearing leaf block" gets an anchor that is a hash of its
// NORMALIZED TEXT (not its DOM position). This survives edits to the base
// template: inserting/removing unrelated nodes does not shift anchors, so an
// overlay edit can never silently land on the wrong element. Identical text gets
// an occurrence-index suffix so repeats ("Read more") stay distinct.
//
// This module is imported both by the browser viewer and by the Node test suite
// (through jsdom), so it must not use anything browser-only beyond the DOM API.

// Block-level tags define an editable "unit". INLINE tags (a, span, strong, em,
// b, i, sup, sub, code…) are intentionally NOT here: a link or emphasis sits
// *inside* a sentence, so treating it as its own block would fragment the
// sentence and make only the link text editable. Keeping inline tags out means
// the whole sentence (link and all) is one editable unit.
export const BLOCK_TAGS = new Set([
  'p','h1','h2','h3','h4','h5','h6','li','blockquote','pre','figcaption',
  'td','th','div','caption','summary','dd','dt',
]);
export const SKIP_TAGS = new Set([
  'script','style','svg','canvas','img','br','hr','input','textarea','select',
  'button','iframe','object','embed','video','audio','head','meta','link','title',
]);

export function normalizeText(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// Attribute an author puts on a container to make its WHOLE inner text one
// editable section (edit/select across paragraphs) instead of one editable block
// per leaf. The inner paragraph elements are preserved as "shells" so styling and
// spacing survive; only the text inside them changes. Default (no attribute) =
// leaf-level editing, unchanged.
export const GROUP_ATTR = 'data-hs-group';

// The child elements of a grouped container that act as paragraph shells (direct
// element children that carry text). Returns them in document order.
export function groupShells(container) {
  return [...container.children].filter((c) => {
    const tag = c.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return false;
    return normalizeText(c.textContent) !== '';
  });
}

// Combined normalized text of a grouped container's shells, joined by a newline
// so paragraph boundaries are part of the content hash (moving text between
// paragraphs changes the anchor, which is correct).
export function groupText(container) {
  return groupShells(container).map((s) => normalizeText(s.textContent)).join('\n');
}

// SHA-256 hex via WebCrypto (available in browsers and Node 20+ globalThis.crypto).
export async function sha256hex(s) {
  const data = new TextEncoder().encode(s);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hasDirectText(el) {
  for (const n of el.childNodes) {
    if (n.nodeType === 3 && n.textContent.trim() !== '') return true;
  }
  return false;
}

function containsBlockCandidate(el) {
  for (const child of el.children) {
    const tag = child.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    if (BLOCK_TAGS.has(tag) && (hasDirectText(child) || containsBlockCandidate(child))) return true;
    if (containsBlockCandidate(child)) return true;
  }
  return false;
}

// A text-bearing leaf: has direct text AND contains no nested block candidate,
// so we edit the innermost element (not a whole nested-table region).
export function isEditableLeaf(el) {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag) || !BLOCK_TAGS.has(tag)) return false;
  if (!hasDirectText(el)) return false;
  if (containsBlockCandidate(el)) return false;
  return true;
}

// True if `el` is inside a data-hs-group container (but is not that container),
// so it must NOT be anchored on its own — the group owns it.
function insideGroup(el, container) {
  let p = el.parentElement;
  while (p && p !== container) {
    if (p.hasAttribute(GROUP_ATTR)) return true;
    p = p.parentElement;
  }
  return false;
}

// Collect the editable units under `container`, in document order. A unit is
// either a data-hs-group container (edited as one section) or a text-leaf block
// that is NOT inside a group. Groups short-circuit their descendants.
export function collectLeaves(container) {
  const out = [];
  const seen = new Set();
  // Grouped containers first (in document order via a combined query below).
  const all = container.querySelectorAll(`[${GROUP_ATTR}], ${[...BLOCK_TAGS].join(',')}`);
  for (const el of all) {
    if (el.hasAttribute(GROUP_ATTR)) {
      if (insideGroup(el, container)) continue; // nested groups: outer wins
      out.push(el);
      seen.add(el);
      continue;
    }
    if (insideGroup(el, container)) continue;   // leaf owned by a group
    if (isEditableLeaf(el) && !seen.has(el)) out.push(el);
  }
  return out;
}

// --- comment anchors (for NON-TEXT elements: images, charts, dividers) ---
//
// A reviewer can comment on anything, not just editable text. Non-text elements
// have no text to content-hash, so we anchor them by their TAG + identifying
// attributes (src/alt for images, the placeholder marker, an svg's own text) +
// an occurrence index. Comments never edit the element — they just pin to it.
// These anchors are namespaced ("c:") so they never collide with text anchors.

// Elements worth letting someone comment on even though they hold no editable text.
export const COMMENTABLE_TAGS = new Set([
  'img','svg','figure','picture','video','audio','hr','canvas','iframe',
]);

// A stable-ish signature string for a commentable element.
function commentSignature(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'img' || el.hasAttribute('data-hs-asset-missing')) {
    // Placeholders replace <img>; key off the recorded/original source or alt.
    const src = el.getAttribute('src') || el.getAttribute('data-hs-src') || '';
    const alt = el.getAttribute('alt') || normalizeText(el.textContent);
    return `img|${src}|${alt}`;
  }
  if (tag === 'svg') return `svg|${normalizeText(el.textContent).slice(0, 80)}`;
  const cls = (el.getAttribute('class') || '').trim();
  return `${tag}|${cls}`;
}

// Assign comment anchors to commentable non-text elements under `container`.
// Skips anything already inside/owning a text anchor's editable leaf is fine —
// an image can live inside an editable block and still be independently
// commentable. Sets data-hs-comment-anchor. Returns Map<anchor, Element>.
export async function assignCommentAnchors(container) {
  const map = new Map();
  const seen = new Map();
  const els = [];
  // Explicit commentable tags…
  for (const el of container.querySelectorAll([...COMMENTABLE_TAGS].join(','))) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue; // svg owns its innards
    els.push(el);
  }
  // …plus our own missing-image placeholders (spans that stood in for <img>).
  for (const el of container.querySelectorAll('[data-hs-asset-missing]')) {
    if (!els.includes(el)) els.push(el);
  }
  for (const el of els) {
    const base = 'c:' + (await sha256hex(commentSignature(el)));
    const occ = seen.has(base) ? seen.get(base) + 1 : 0;
    seen.set(base, occ);
    const anchor = occ === 0 ? base : `${base}#${occ}`;
    el.setAttribute('data-hs-comment-anchor', anchor);
    map.set(anchor, el);
  }
  return map;
}

// Find VISIBLE TEXT THE EDITOR CANNOT REACH, so the viewer can warn instead of
// silently pretending everything is editable. Two known-unreachable cases:
//   1. text baked into an <svg> (charts/labels) — svg is skipped entirely.
//   2. "stray" direct text in an element that also has a block child, so the
//      element is treated as a wrapper and its own text is never a leaf.
// Runs AFTER assignAnchors (reads data-hs-anchor to know what became editable).
// Returns [{ kind: 'svg' | 'stray', text }] with normalized snippets.
export function findUnreachableText(container) {
  const out = [];

  // 1. SVG text (<text>, <tspan>, <title> inside svg).
  for (const svg of container.querySelectorAll('svg')) {
    const t = normalizeText(svg.textContent);
    if (t) out.push({ kind: 'svg', text: t });
  }

  // 2. Stray direct text inside a wrapper (element with a block child AND its own
  //    non-whitespace direct text). That direct text is not an editable leaf.
  const candidates = container.querySelectorAll([...BLOCK_TAGS].join(','));
  for (const el of candidates) {
    if (el.closest('svg')) continue;                 // already covered above
    if (el.hasAttribute('data-hs-anchor')) continue; // it IS an editable leaf
    if (!hasDirectText(el)) continue;                // no stray text of its own
    if (!containsBlockCandidate(el)) continue;       // not a wrapper -> handled elsewhere
    // Collect only this element's OWN direct text nodes (not the child block's).
    let stray = '';
    for (const n of el.childNodes) if (n.nodeType === 3) stray += n.textContent;
    const t = normalizeText(stray);
    if (t) out.push({ kind: 'stray', text: t });
  }
  return out;
}

// Human-readable summary of unreachable text for the warning banner.
export function summarizeUnreachable(items) {
  if (!items.length) return '';
  const svg = items.filter((i) => i.kind === 'svg').length;
  const stray = items.filter((i) => i.kind === 'stray').length;
  const parts = [];
  if (svg) parts.push(`${svg} chart/SVG text block${svg > 1 ? 's' : ''}`);
  if (stray) parts.push(`${stray} stray text run${stray > 1 ? 's' : ''} inside a layout wrapper`);
  const sample = items.slice(0, 3).map((i) => `“${i.text.slice(0, 40)}”`).join(', ');
  return `${parts.join(' and ')} can't be edited or suggested here (${sample}${items.length > 3 ? ', …' : ''}). ` +
    `Text baked into SVG charts isn't editable; move stray text into its own paragraph to make it editable.`;
}

// Assign content-hash anchors to every editable leaf under `container`.
// Returns Map<anchor, Element>. Sets data-hs-anchor on each element.
// Anchor = sha256(normalizedText) + "#<occurrence>" when text repeats.
export async function assignAnchors(container) {
  const leaves = collectLeaves(container);
  const seen = new Map(); // baseHash -> count
  const map = new Map();
  for (const el of leaves) {
    const grouped = el.hasAttribute(GROUP_ATTR);
    // A group hashes its combined shell text (paragraph boundaries included);
    // a leaf hashes its own normalized text.
    const norm = grouped ? groupText(el) : normalizeText(el.textContent);
    if (!norm) continue;
    const base = await sha256hex(norm);
    const occ = seen.has(base) ? seen.get(base) + 1 : 0;
    seen.set(base, occ);
    const anchor = occ === 0 ? base : `${base}#${occ}`;
    el.setAttribute('data-hs-anchor', anchor);
    if (grouped) el.setAttribute('data-hs-grouped', '1');
    map.set(anchor, el);
  }
  return map;
}
