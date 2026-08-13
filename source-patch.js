// source-patch — apply text edits to the COMPRESSED payload of a self-contained
// interactive HTML bundle, so the edited file is still fully interactive.
//
// Many "standalone" HTML exports (dashboards, the AI Hub model overview, etc.)
// don't put their visible text in the markup: they carry it as gzip-compressed,
// base64-encoded blobs that the page's own JavaScript decodes at runtime
// (atob -> DecompressionStream('gzip') -> TextDecoder -> render). Editing the
// rendered DOM can't change the downloaded file, because the JS regenerates the
// text from those blobs every time the file opens.
//
// The blobs are encoded with STANDARD algorithms (base64 + gzip), so we don't need
// to understand the bundle's schema. We: find the large base64 string literals,
// decode+gunzip each, run an EXACT string substitution (old -> new) on the decoded
// text, re-gzip + re-base64, and splice the new literal back in at the same spot.
// A blob that doesn't contain the target text is left byte-for-byte untouched.
//
// Safety: gunzip is bounded (MAX_DECODED) to refuse zip bombs; the literal scan is
// linear (no backtracking regex); substitution is literal (no regex on user text).
import { gunzipSync, gzipSync } from 'node:zlib';

// Only consider string literals long enough to plausibly be a payload blob. Short
// base64-looking strings (hashes, tiny data URIs) are skipped — cheap and avoids
// touching things that aren't payloads.
const MIN_LITERAL = 200;
// Zip-bomb guards. Uploads are capped at ~2 MB, but gzip amplifies, so we bound
// BOTH the size of any single decoded blob AND the aggregate decoded bytes across
// all blobs in one request — a crafted doc can pack many small blobs that each
// inflate toward the per-blob limit and collectively exhaust a small box.
const MAX_DECODED = 16 * 1024 * 1024;        // per-blob ceiling (gunzip maxOutputLength)
const MAX_DECODED_TOTAL = 64 * 1024 * 1024;  // aggregate across all blobs per call

// A conservative base64 body: base64 chars, optional '=' padding, length >= MIN.
// Anchored per-literal by the surrounding quotes in scanLiterals (no backtracking).
const B64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;

// Find double-quoted string literals whose contents look like a long base64 blob.
// Returns [{ start, end, body }] with start/end being the indices of the body
// (exclusive of the surrounding quotes), in document order.
function scanLiterals(html) {
  const out = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const q = html.indexOf('"', i);
    if (q === -1) break;
    const close = html.indexOf('"', q + 1);
    if (close === -1) break;
    const body = html.slice(q + 1, close);
    if (body.length >= MIN_LITERAL && B64_BODY.test(body)) {
      out.push({ start: q + 1, end: close, body });
    }
    i = close + 1;
  }
  return out;
}

// Decode one base64 literal to text if it is gzip (or plain utf8); null if it isn't
// decodable text we can safely round-trip. `wasGzip` records how to re-encode.
// `budget` caps this blob's inflated size (defaults to the per-blob ceiling); the
// caller passes the REMAINING aggregate budget so no single blob is ever inflated
// beyond what's left — keeping strict peak memory at MAX_DECODED_TOTAL, not +1 blob.
function decodeBlob(body, budget = MAX_DECODED) {
  let buf;
  try { buf = Buffer.from(body, 'base64'); } catch { return null; }
  // Reject if the base64 didn't round-trip cleanly (garbage / not a real blob):
  // re-encoding must reproduce the exact original body, else splicing is unsafe.
  if (buf.toString('base64') !== body) return null;
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (isGzip) {
    const cap = Math.max(1, Math.min(MAX_DECODED, budget));
    let text;
    try { text = gunzipSync(buf, { maxOutputLength: cap }).toString('utf8'); }
    catch { return null; } // includes "output too large" — blob is refused, not fatal
    return { text, wasGzip: true };
  }
  return null; // only touch gzip blobs; leave opaque/binary literals alone
}

// Re-encode edited text the same way it came in (gzip -> base64).
function encodeBlob(text, wasGzip) {
  if (!wasGzip) return Buffer.from(text, 'utf8').toString('base64');
  return gzipSync(Buffer.from(text, 'utf8')).toString('base64');
}

// Apply edits ({ from, to } pairs) to the payload blobs of an interactive HTML
// string. Returns { html, applied, unmatched }:
//   • html: the patched document (blobs re-encoded); non-target blobs untouched.
//   • applied: edits whose `from` was found and replaced (with a count).
//   • unmatched: edits whose `from` was not found in ANY blob (nothing changed for
//     them) — the caller decides whether that's a soft miss or a hard error.
// An edit with empty/zero-length `from`, or from === to, is ignored.
export function patchSource(html, edits) {
  const clean = (edits || []).filter(
    (e) => e && typeof e.from === 'string' && typeof e.to === 'string' && e.from.length > 0 && e.from !== e.to
  );
  if (clean.length === 0) return { html: String(html), applied: [], unmatched: [] };

  const literals = scanLiterals(String(html));
  // Decode each candidate once; keep only real gzip-text blobs. Stop decoding once
  // the aggregate decoded size would exceed the total budget (zip-bomb guard): the
  // per-blob maxOutputLength alone can't stop many-blob amplification.
  const blobs = [];
  let totalDecoded = 0;
  for (const lit of literals) {
    const remaining = MAX_DECODED_TOTAL - totalDecoded;
    if (remaining <= 0) break;
    const dec = decodeBlob(lit.body, remaining); // never inflate past what's left
    if (!dec) continue;
    totalDecoded += dec.text.length;
    blobs.push({ ...lit, ...dec, editedText: dec.text, dirty: false });
  }

  // Edits apply sequentially: a later edit sees the output of earlier ones (so
  // A:"foo"->"foobar" then B:"foobar"->"baz" chains). This mirrors ordinary
  // find-and-replace; callers that need independence should pass disjoint `from`s.
  const applied = [];
  const matchedFrom = new Set();
  for (const e of clean) {
    let count = 0;
    for (const b of blobs) {
      if (b.editedText.includes(e.from)) {
        const before = b.editedText;
        b.editedText = before.split(e.from).join(e.to);
        const occ = before.split(e.from).length - 1;
        if (occ > 0) { b.dirty = true; count += occ; }
      }
    }
    if (count > 0) { applied.push({ from: e.from, to: e.to, count }); matchedFrom.add(e.from); }
  }
  const unmatched = clean.filter((e) => !matchedFrom.has(e.from)).map((e) => ({ from: e.from, to: e.to }));

  if (applied.length === 0) return { html: String(html), applied, unmatched };

  // Splice re-encoded literals back in from the END so earlier indices stay valid.
  let out = String(html);
  const dirty = blobs.filter((b) => b.dirty).sort((a, b) => b.start - a.start);
  for (const b of dirty) {
    const reB64 = encodeBlob(b.editedText, b.wasGzip);
    out = out.slice(0, b.start) + reB64 + out.slice(b.end);
  }
  return { html: out, applied, unmatched };
}

// Introspection helper (tests / debugging): how many gzip payload blobs a doc has
// and whether a given text appears in any of them.
export function findInSource(html, needle) {
  const blobs = scanLiterals(String(html)).map((l) => decodeBlob(l.body)).filter(Boolean);
  return {
    gzipBlobs: blobs.length,
    contains: typeof needle === 'string' && blobs.some((b) => b.text.includes(needle)),
  };
}
