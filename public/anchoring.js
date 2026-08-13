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

// SHA-256 hex. Prefer WebCrypto (browsers, Node 20+ globalThis.crypto), but fall
// back to a pure-JS SHA-256 when crypto.subtle is unavailable.
//
// Why the fallback is required: markmyword runs its interactive docs inside a
// sandbox="allow-scripts" iframe. That frame has an OPAQUE origin, and browsers
// only expose crypto.subtle in a *secure context*; an opaque-origin frame is not a
// secure context unless it was created with allow-same-origin — which we forbid on
// purpose (allow-same-origin would let hostile doc JS reach our cookies/APIs). So
// crypto.subtle.digest is `undefined` in the frame and threw, killing anchoring
// (and with it the whole editing path) before a single element was made editable.
//
// The fallback MUST produce identical hashes to WebCrypto (real SHA-256, same hex),
// so anchors computed in the frame match anchors computed server-side / in jsdom.
// A weaker/shorter hash (e.g. 32-bit FNV) would collide and land edits on the wrong
// block — the adversarial review flagged exactly that, so this stays full SHA-256.
export async function sha256hex(s) {
  const data = new TextEncoder().encode(s);
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    const buf = await subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256hexJS(data);
}

// Pure-JS SHA-256 (FIPS 180-4). Operates on a Uint8Array, returns lowercase hex.
// Only used when crypto.subtle is unavailable (the opaque-origin frame above).
function sha256hexJS(bytes) {
  const K = SHA256_K;
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  // Pre-processing: append 0x80, pad with zeros, then the 64-bit bit-length.
  const bitLen = bytes.length * 8;
  const withOne = bytes.length + 1;
  const total = withOne + ((56 - (withOne % 64) + 64) % 64) + 8; // multiple of 64
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  // 64-bit big-endian length. Bit lengths fit comfortably in 53-bit JS numbers
  // for any input we hash (normalized block text), so the high word is derived
  // via division rather than 64-bit ints.
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  msg[total - 8] = (hi >>> 24) & 0xff; msg[total - 7] = (hi >>> 16) & 0xff;
  msg[total - 6] = (hi >>> 8) & 0xff;  msg[total - 5] = hi & 0xff;
  msg[total - 4] = (lo >>> 24) & 0xff; msg[total - 3] = (lo >>> 16) & 0xff;
  msg[total - 2] = (lo >>> 8) & 0xff;  msg[total - 1] = lo & 0xff;

  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const hex = (x) => (x >>> 0).toString(16).padStart(8, '0');
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

// SHA-256 round constants (first 32 bits of the fractional parts of the cube roots
// of the first 64 primes).
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

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
