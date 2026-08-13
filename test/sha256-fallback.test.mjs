// The interactive-doc frame has an opaque origin where crypto.subtle is undefined,
// so sha256hex falls back to a pure-JS SHA-256. That fallback MUST byte-for-byte
// match WebCrypto — otherwise anchors computed in the frame won't match anchors
// computed server-side/in jsdom, and edits land on the wrong block (or nowhere).
import { webcrypto } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

// Reference SHA-256 via Node's WebCrypto (this is what the browser's crypto.subtle
// path produces too — same algorithm, same output).
async function ref(s) {
  const buf = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Force the fallback: import anchoring with crypto.subtle hidden, so sha256hex
// exercises the pure-JS path exactly as it does inside the frame.
const savedCrypto = globalThis.crypto;
Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: savedCrypto.getRandomValues?.bind(savedCrypto) }, configurable: true });
const { sha256hex } = await import('../public/anchoring.js?nofallbackprobe=' + Date.now());
// restore for anything else
Object.defineProperty(globalThis, 'crypto', { value: savedCrypto, configurable: true });

// Known-answer vectors (FIPS / standard) — independent of our reference impl.
ok(await sha256hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty string vector');
ok(await sha256hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', '"abc" vector');
ok(await sha256hex('The quick brown fox jumps over the lazy dog')
   === 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592', 'pangram vector');

// Cross-check the fallback against WebCrypto across many lengths / boundaries.
// SHA-256 processes 64-byte blocks; lengths around 55/56/63/64/119/120 stress the
// padding + length-append edge cases, which is where a hand-rolled impl breaks.
const cases = [
  'Model Overview', 'Validated by Red Hat', 'GLM-5.2-FP8', 'Intro paragraph.',
  'a', 'ab', 'abcd', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(57),
  'y'.repeat(63), 'y'.repeat(64), 'y'.repeat(65),
  'z'.repeat(119), 'z'.repeat(120), 'z'.repeat(128),
  'w'.repeat(1000),
  'unicode: café — “smart quotes” · 你好 · 🚀 émoji', // multibyte utf-8
  'line one\nline two\nline three', // grouped-text style (newline-joined)
];
let allMatch = true;
for (const c of cases) {
  const got = await sha256hex(c);
  const want = await ref(c);
  if (got !== want) { allMatch = false; console.error(`    len=${c.length} got=${got} want=${want}`); }
}
ok(allMatch, 'pure-JS SHA-256 matches WebCrypto for all length/boundary/unicode cases');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
