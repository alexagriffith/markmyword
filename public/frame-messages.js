// Shape-validators for messages the sandboxed interactive frame posts to the
// parent. The frame runs the deliverable's UNTRUSTED JavaScript next to our
// controller, so every field a frame message carries must be validated before the
// parent acts on it — a hostile doc could post a malformed `suggestTarget` to try
// to break popup positioning or smuggle an oversized anchor into /api/suggest.
//
// Kept as a side-effect-free module so it can be imported by both viewer.js and
// the tests without booting the viewer.

// A comment/text anchor the parent will hand to /api/suggest (which itself caps
// anchors at 200). Must be a non-empty, bounded string.
export function validAnchor(a) {
  return typeof a === 'string' && a.length > 0 && a.length <= 200;
}

// A getBoundingClientRect-style rect the frame reports so the parent can position
// the popup over the iframe. Every field must be a finite number and the size
// must be sane (guards against NaN/Infinity or absurd values from a hostile doc).
export function validRect(rect) {
  if (!rect || typeof rect !== 'object') return false;
  const nums = [rect.left, rect.top, rect.width, rect.height];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  if (rect.width < 0 || rect.height < 0) return false;
  if (rect.width > 100000 || rect.height > 100000) return false;
  return true;
}

// Validate a `suggestTarget` message (frame -> parent, "reviewer clicked this
// element in Suggesting mode"). Returns a normalized payload, or null if invalid.
export function parseSuggestTarget(m) {
  if (!m || typeof m !== 'object') return null;
  if (!validAnchor(m.anchor)) return null;
  if (!validRect(m.rect)) return null;
  const snippet = typeof m.snippet === 'string' ? m.snippet.slice(0, 200)
    : (typeof m.quote === 'string' ? m.quote.slice(0, 200) : '');
  return {
    anchor: m.anchor,
    isText: !!m.isText,
    snippet,
    rect: { left: m.rect.left, top: m.rect.top, width: m.rect.width, height: m.rect.height },
  };
}
