// Parent-side shape validation of messages the UNTRUSTED interactive frame posts.
// The frame runs the deliverable's own JavaScript, so a hostile doc could post a
// malformed `suggestTarget` to break popup positioning or smuggle an oversized
// anchor toward /api/suggest. parseSuggestTarget() is the gate — it must accept a
// well-formed target and reject everything else.
import { parseSuggestTarget, validAnchor, validRect } from '../public/frame-messages.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

const goodRect = { left: 12, top: 34, width: 56, height: 20 };
const good = { type: 'suggestTarget', anchor: 'c:abcdef#1', isText: false, snippet: 'button', quote: 'button', rect: goodRect };

// --- Accepts a well-formed target -------------------------------------------
const t = parseSuggestTarget(good);
ok(t, 'a well-formed suggestTarget parses');
ok(t.anchor === 'c:abcdef#1', 'anchor preserved');
ok(t.isText === false, 'isText coerced to boolean');
ok(t.snippet === 'button', 'snippet preserved');
ok(t.rect.left === 12 && t.rect.width === 56, 'rect fields preserved');

// isText is coerced from truthy/falsy, never trusted as-is.
ok(parseSuggestTarget({ ...good, isText: 'yes' }).isText === true, 'truthy isText -> true');
ok(parseSuggestTarget({ ...good, isText: undefined }).isText === false, 'missing isText -> false');

// snippet falls back to quote, then '' — and is length-capped.
ok(parseSuggestTarget({ ...good, snippet: undefined, quote: 'from quote' }).snippet === 'from quote', 'snippet falls back to quote');
ok(parseSuggestTarget({ ...good, snippet: undefined, quote: undefined }).snippet === '', 'snippet defaults to empty string');
ok(parseSuggestTarget({ ...good, snippet: 'x'.repeat(500) }).snippet.length === 200, 'snippet capped at 200 chars');

// --- Rejects malformed anchors ----------------------------------------------
ok(parseSuggestTarget({ ...good, anchor: '' }) === null, 'empty anchor rejected');
ok(parseSuggestTarget({ ...good, anchor: 123 }) === null, 'non-string anchor rejected');
ok(parseSuggestTarget({ ...good, anchor: 'x'.repeat(201) }) === null, 'oversized anchor (>200) rejected');
ok(parseSuggestTarget({ ...good, anchor: undefined }) === null, 'missing anchor rejected');

// --- Rejects malformed rects (would break popup positioning) ----------------
ok(parseSuggestTarget({ ...good, rect: undefined }) === null, 'missing rect rejected');
ok(parseSuggestTarget({ ...good, rect: { left: 0, top: 0, width: 0 } }) === null, 'rect missing a field rejected');
ok(parseSuggestTarget({ ...good, rect: { ...goodRect, top: NaN } }) === null, 'NaN rect field rejected');
ok(parseSuggestTarget({ ...good, rect: { ...goodRect, left: Infinity } }) === null, 'Infinity rect field rejected');
ok(parseSuggestTarget({ ...good, rect: { ...goodRect, width: -5 } }) === null, 'negative width rejected');
ok(parseSuggestTarget({ ...good, rect: { ...goodRect, height: 999999 } }) === null, 'absurd height rejected');
ok(parseSuggestTarget({ ...good, rect: { left: '1', top: 2, width: 3, height: 4 } }) === null, 'string rect field rejected');

// --- Rejects non-objects -----------------------------------------------------
ok(parseSuggestTarget(null) === null, 'null message rejected');
ok(parseSuggestTarget('suggestTarget') === null, 'string message rejected');
ok(parseSuggestTarget(undefined) === null, 'undefined message rejected');

// --- The helpers directly ----------------------------------------------------
ok(validAnchor('c:x#1') && !validAnchor('') && !validAnchor('y'.repeat(201)), 'validAnchor bounds');
ok(validRect(goodRect) && !validRect({}) && !validRect({ left: 1, top: 2, width: 3, height: NaN }), 'validRect bounds');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
