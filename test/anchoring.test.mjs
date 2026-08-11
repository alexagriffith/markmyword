// Verifies content-hash anchoring against the synthetic example deliverable,
// importing the SAME module the browser uses (public/anchoring.js) via jsdom — so
// the test and production share one implementation (no drift).
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { assignAnchors } from '../public/anchoring.js';

const html = readFileSync(new URL('../docs/example.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

async function render() {
  const dom = new JSDOM(html);
  // anchoring.js uses globalThis.crypto.subtle + TextEncoder + DOMParser-free DOM.
  const doc = dom.window.document;
  const map = await assignAnchors(doc.body);
  return { dom, doc, map };
}

const a = await render();
console.log(`Assigned ${a.map.size} editable blocks`);
ok(a.map.size > 5, 'several editable blocks found');

// Determinism: same input -> same anchors.
const b = await render();
const idsA = [...a.map.keys()].sort();
const idsB = [...b.map.keys()].sort();
ok(JSON.stringify(idsA) === JSON.stringify(idsB), 'anchors deterministic across renders');
ok(new Set(idsA).size === idsA.length, 'anchors unique within a render');

// Content-addressed: anchor is derived from text, so the SAME text in a fresh
// standalone element produces the SAME base hash (position-independent).
{
  const dom = new JSDOM('<!doctype html><body><p>Hello world</p></body>');
  const m = await assignAnchors(dom.window.document.body);
  const dom2 = new JSDOM('<!doctype html><body><div><div><p>Hello world</p></div></div></body>');
  const m2 = await assignAnchors(dom2.window.document.body);
  const k1 = [...m.keys()][0], k2 = [...m2.keys()][0];
  ok(k1 === k2, 'same text -> same anchor regardless of DOM position (survives template restructure)');
}

// Occurrence indexing: identical repeated text gets distinct anchors.
// (Two block elements — <span> is inline now, so it wouldn't be its own unit.)
{
  const dom = new JSDOM('<!doctype html><body><p>Read more</p><li>Read more</li></body>');
  const m = await assignAnchors(dom.window.document.body);
  ok(m.size === 2, 'repeated identical text yields two distinct anchors');
  ok([...m.keys()].some((k) => k.includes('#1')), 'second occurrence carries #1 suffix');
}

// Edit isolation: changing one leaf's text doesn't affect siblings' text.
{
  const target = a.map.get(idsA.find((id) => a.map.get(id).textContent.trim().length > 10));
  const tag = target.tagName, attrs = target.getAttributeNames().filter((n) => n !== 'data-hs-anchor').sort().join(',');
  const before = a.doc.body.textContent.replace(target.textContent, '');
  target.textContent = 'EDITED';
  ok(target.tagName === tag, 'edit preserves tag');
  ok(target.getAttributeNames().filter((n) => n !== 'data-hs-anchor').sort().join(',') === attrs, 'edit preserves attributes/styles');
  ok(a.doc.body.textContent.replace('EDITED', '') === before, 'edit touches only the target block');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
