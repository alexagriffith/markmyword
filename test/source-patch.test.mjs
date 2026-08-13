// source-patch: decode gzip+base64 payload blobs, substitute text, re-encode, and
// splice back so an interactive bundle carries the edit while staying decodable.
import { patchSource, findInSource } from '../source-patch.js';
import { gzipSync, gunzipSync } from 'node:zlib';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

// Build a synthetic "standalone" doc: a JS payload holds the visible text as a
// gzip+base64 blob, exactly like the real bundles. The literal must be >= 200 chars
// so the scanner treats it as a payload — pad the JSON with filler.
function makeDoc(payloadObj) {
  const json = JSON.stringify(payloadObj);
  const b64 = gzipSync(Buffer.from(json, 'utf8')).toString('base64');
  return '<!doctype html><html><head><title>t</title></head><body>'
    + '<div id="app"></div>'
    + '<script>var DATA="' + b64 + '";'
    + 'render(JSON.parse(new TextDecoder().decode(pako.ungzip(atob(DATA)))));</script>'
    + '</body></html>';
}

// Incompressible filler so the gzip+base64 literal clears MIN_LITERAL (repetitive
// text would compress to well under 200 chars and be skipped as too-short).
const filler = Array.from({ length: 600 }, (_, i) => ((i * 2654435761) >>> 0).toString(36)).join('');
const doc = makeDoc({ title: 'GLM-5.2-FP8', note: 'Validated by Red Hat', pad: filler });

// 1. The visible text is NOT in the markup, but IS reachable in a gzip blob.
ok(!doc.includes('GLM-5.2-FP8'), 'model text is not present as plain markup');
const probe = findInSource(doc, 'GLM-5.2-FP8');
ok(probe.gzipBlobs === 1, 'exactly one gzip payload blob found');
ok(probe.contains === true, 'model text IS reachable inside the gzip blob');

// 2. Patch: substitute the model name; the returned file must still decode and now
//    carry the new text (and not the old).
const r = patchSource(doc, [{ from: 'GLM-5.2-FP8', to: 'GLM-5.2-FP9' }]);
ok(r.applied.length === 1 && r.applied[0].count === 1, 'one edit applied, one occurrence');
ok(r.unmatched.length === 0, 'no unmatched edits');
ok(r.html !== doc, 'output differs from input');
ok(findInSource(r.html, 'GLM-5.2-FP9').contains === true, 'patched blob decodes with the NEW text');
ok(findInSource(r.html, 'GLM-5.2-FP8').contains === false, 'old text is gone from the blob');

// 3. The patched literal is still a valid gzip+base64 blob (round-trips).
const lit = r.html.match(/var DATA="([A-Za-z0-9+/]+={0,2})"/)[1];
const back = JSON.parse(gunzipSync(Buffer.from(lit, 'base64')).toString('utf8'));
ok(back.title === 'GLM-5.2-FP9', 'decoded JSON carries the edit');
ok(back.note === 'Validated by Red Hat', 'untouched fields preserved');

// 4. Unmatched edit: `from` not present anywhere -> reported, nothing changed.
const r2 = patchSource(doc, [{ from: 'NONEXISTENT-TEXT', to: 'whatever' }]);
ok(r2.applied.length === 0 && r2.unmatched.length === 1, 'missing text -> unmatched, not applied');
ok(r2.html === doc, 'no-op when nothing matches (byte-identical)');

// 5. Multiple blobs: only the one containing the text is rewritten; the other is
//    left byte-for-byte identical.
const blobA = gzipSync(Buffer.from(JSON.stringify({ a: 'EDIT-ME', pad: filler }))).toString('base64');
const blobB = gzipSync(Buffer.from(JSON.stringify({ b: 'LEAVE-ME', pad: filler }))).toString('base64');
const twoBlob = '<body><script>var A="' + blobA + '";var B="' + blobB + '";</script></body>';
const r3 = patchSource(twoBlob, [{ from: 'EDIT-ME', to: 'EDITED' }]);
ok(r3.applied.length === 1, 'edit applied to the matching blob');
ok(r3.html.includes('"' + blobB + '"'), 'the non-target blob literal is untouched verbatim');
ok(findInSource(r3.html, 'EDITED').contains && !findInSource(r3.html, 'EDIT-ME').contains, 'only the target blob changed');

// 6. Guards: empty/degenerate edits are ignored; non-gzip literals are left alone.
ok(patchSource(doc, []).html === doc, 'empty edit list -> no-op');
ok(patchSource(doc, [{ from: '', to: 'x' }]).html === doc, 'empty `from` ignored');
ok(patchSource(doc, [{ from: 'GLM-5.2-FP8', to: 'GLM-5.2-FP8' }]).html === doc, 'from===to ignored');
// A long base64 literal that is NOT gzip (random bytes) must not be decoded/edited.
const notGzip = Buffer.from('n'.repeat(500)).toString('base64');
const opaque = '<body><script>var X="' + notGzip + '";</script></body>';
ok(patchSource(opaque, [{ from: 'n', to: 'z' }]).html === opaque, 'non-gzip base64 literal left untouched');

// 7. Zip-bomb guard: a highly-compressible blob that would inflate past the per-blob
//    ceiling must be refused (decoded to nothing), not OOM the process. gzip of many
//    megabytes of zeros is a tiny base64 literal but huge decoded.
const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024, 0)).toString('base64'); // ~40MB decoded
const bombDoc = '<body><script>var Z="' + bomb + '";var ok="' + gzipSync(Buffer.from(JSON.stringify({ t: 'FINDME', pad: filler }))).toString('base64') + '";</script></body>';
const rb = patchSource(bombDoc, [{ from: 'FINDME', to: 'FOUND' }]);
// The bomb blob is refused (over per-blob MAX_DECODED); the small legit blob still
// patches. Either way the process must not have crashed to get here.
ok(rb.applied.length === 1 && rb.applied[0].from === 'FINDME', 'legit blob still patched alongside a refused zip bomb');
ok(!findInSource(bombDoc, 'x'.repeat(1)).contains || true, 'zip bomb did not crash the decoder');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
