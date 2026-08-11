// Format probes — run a spread of real-world HTML shapes through the ACTUAL
// anchoring logic (via jsdom) and report what becomes editable, what fragments,
// and what silently loses inline markup. This is a diagnostic map of "which HTML
// shapes does the tool handle well" — not all assertions are pass/fail; some just
// print the behavior so we can decide what (if anything) to fix.
import { JSDOM } from 'jsdom';
import { assignAnchors, assignCommentAnchors, normalizeText, findUnreachableText } from '../public/anchoring.js';
import { referencedImages, assetBasename, healImageAssets, resolveAssets } from '../public/assets.js';

let pass = 0, fail = 0, notes = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  ✗ ' + m); } };
const note = (m) => { notes++; console.log('  • ' + m); };

async function anchorsFor(html) {
  const doc = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  const map = await assignAnchors(doc.body);
  return { doc, map, units: [...map.values()], unreachable: findUnreachableText(doc.body) };
}
const texts = (units) => units.map((el) => normalizeText(el.textContent));

console.log('\n=== Format probes ===\n');

// 1. Clean semantic HTML — the happy path.
{
  console.log('1. Clean <p>/<h2> article:');
  const { units } = await anchorsFor('<h2>Title</h2><p>First para.</p><p>Second para.</p>');
  ok(units.length === 3, 'three separate editable blocks');
  note(`blocks: ${JSON.stringify(texts(units))}`);
}

// 2. Paragraph with an inline link. Inline tags (<a>) must NOT fragment the
//    sentence — the whole line stays one editable unit.
{
  console.log('\n2. <p> with an inline <a> link:');
  const { units } = await anchorsFor('<p>See the <a href="https://x.com">docs</a> for details.</p>');
  const t = texts(units);
  note(`editable units (${units.length}): ${JSON.stringify(t)}`);
  ok(units.length === 1 && t.includes('See the docs for details.'),
     'inline <a> does not fragment; the whole sentence is one editable unit');
  note('NOTE: editing saves textContent, so the <a> href is dropped on save '
    + '(the words stay; the link becomes plain text). Rich-text edit is a future decision.');
}

// 3. Inline emphasis inside a paragraph (<strong>, <em>).
{
  console.log('\n3. <p> with <strong>/<em>:');
  const { units } = await anchorsFor('<p>This is <strong>very</strong> <em>important</em> text.</p>');
  const t = texts(units);
  note(`editable units (${units.length}): ${JSON.stringify(t)}`);
  // strong/em are NOT in BLOCK_TAGS, so they should NOT fragment the paragraph.
  ok(t.includes('This is very important text.'), 'strong/em stay inline; paragraph is one unit');
  note('NOTE: editing stores textContent, so on save the <strong>/<em> bolding is lost.');
}

// 4. Nested email-style tables (the newsletter shape).
{
  console.log('\n4. Nested <table><tr><td> layout:');
  const { units } = await anchorsFor(
    '<table><tr><td><table><tr><td>Cell copy here</td></tr></table></td></tr></table>'
  );
  ok(units.length === 1, 'innermost <td> with text is the single editable unit');
  note(`blocks: ${JSON.stringify(texts(units))}`);
}

// 5. SVG chart with a text label (dashboards).
{
  console.log('\n5. Inline <svg> with a <text> label:');
  const { units, unreachable } = await anchorsFor('<div>Chart:</div><svg><text>42%</text></svg>');
  const t = texts(units);
  note(`editable units (${units.length}): ${JSON.stringify(t)}`);
  ok(!t.some((x) => x.includes('42%')), 'SVG text is NOT editable (svg is skipped) — expected');
  ok(unreachable.some((u) => u.kind === 'svg' && u.text.includes('42%')),
     'DETECTED: SVG text is flagged as unreachable (warn, not pretend-editable)');
}

// 6. List items.
{
  console.log('\n6. <ul><li> list:');
  const { units } = await anchorsFor('<ul><li>One</li><li>Two</li><li>Three</li></ul>');
  ok(units.length === 3, 'each <li> is its own editable block');
  note(`blocks: ${JSON.stringify(texts(units))}`);
}

// 7. Deeply nested wrapper divs around one paragraph.
{
  console.log('\n7. Wrapper <div><div><div><p>…:');
  const { units } = await anchorsFor('<div><div><div><p>Buried text</p></div></div></div>');
  ok(units.length === 1 && texts(units)[0] === 'Buried text', 'wrappers collapse; only the <p> is editable');
}

// 8. A <div> that is BOTH a wrapper and has its own stray text.
{
  console.log('\n8. <div> with direct text AND a child <p>:');
  const { units, unreachable } = await anchorsFor('<div>Lead-in text <p>Child paragraph</p></div>');
  const t = texts(units);
  note(`editable units (${units.length}): ${JSON.stringify(t)}`);
  const leadEditable = t.some((x) => x.includes('Lead-in text') && !x.includes('Child'));
  ok(!leadEditable, 'the div\'s own "Lead-in text" is not a separate editable leaf (div is a wrapper)');
  ok(unreachable.some((u) => u.kind === 'stray' && u.text.includes('Lead-in text')),
     'DETECTED: stray wrapper text is flagged as unreachable (warn instead of losing it silently)');
}

// 9. Pre-formatted / code block (whitespace matters).
{
  console.log('\n9. <pre> code block:');
  const { units } = await anchorsFor('<pre>line one\n  line two indented</pre>');
  note(`editable units (${units.length}): ${JSON.stringify(texts(units))}`);
  note('NOTE: normalizeText collapses whitespace for the ANCHOR, but editing a <pre> '
    + 'via textContent should preserve typed whitespace. Worth a browser check.');
}

// 10. Empty / whitespace-only elements.
{
  console.log('\n10. Empty and whitespace-only elements:');
  const { units } = await anchorsFor('<p></p><p>   </p><p>Real</p>');
  ok(units.length === 1 && texts(units)[0] === 'Real', 'empty/whitespace blocks are skipped');
}

// 11. Comment anchors: non-text elements (image, svg, hr) are commentable.
{
  console.log('\n11. Comment anchors on non-text elements:');
  const doc = new JSDOM('<!doctype html><body>'
    + '<p>Some text</p>'
    + '<img src="https://x.com/a.png" alt="banner">'
    + '<svg><text>chart</text></svg>'
    + '<hr>'
    + '</body>').window.document;
  await assignAnchors(doc.body);
  const cmap = await assignCommentAnchors(doc.body);
  const kinds = [...cmap.values()].map((el) => el.tagName.toLowerCase()).sort();
  note(`comment anchors: ${kinds.length} -> ${JSON.stringify(kinds)}`);
  ok(kinds.includes('img'), 'image gets a comment anchor');
  ok(kinds.includes('svg'), 'svg/chart gets a comment anchor');
  ok(kinds.includes('hr'), 'divider gets a comment anchor');
  ok([...cmap.keys()].every((k) => k.startsWith('c:')), 'comment anchors are namespaced "c:" (no collision with text)');
}

// 12. Two identical images get distinct comment anchors (occurrence index).
{
  console.log('\n12. Repeated identical images -> distinct comment anchors:');
  const doc = new JSDOM('<!doctype html><body>'
    + '<img src="/logo.png" alt="logo"><img src="/logo.png" alt="logo">'
    + '</body>').window.document;
  const cmap = await assignCommentAnchors(doc.body);
  ok(cmap.size === 2, 'two identical images yield two distinct comment anchors');
  ok([...cmap.keys()].some((k) => k.includes('#1')), 'second identical image carries #1 suffix');
}

// 13. referencedImages: which local images must travel with an uploaded doc.
{
  console.log('\n13. referencedImages(html) — local <img> the doc needs:');
  const html = `
    <img src="banner.png">
    <img src='img/logo.svg'>
    <img src=footer-sig.png>
    <img src="https://cdn.example.com/hosted.png">
    <img src="/docs/assets/served.png">
    <img src="data:image/png;base64,AAAA">
    <img src="">
    <img alt="no src at all">
    <img src="banner.png?v=2">`;
  const refs = referencedImages(html);
  const names = refs.map((r) => r.name);
  note(`needed: ${JSON.stringify(names)}`);
  ok(names.includes('banner.png'), 'plain relative src detected');
  ok(names.includes('logo.svg'), 'single-quoted, subfolder src detected (basename kept)');
  ok(names.includes('footer-sig.png'), 'unquoted src detected');
  ok(!names.includes('hosted.png'), 'absolute URL skipped (loads fine)');
  ok(!names.includes('served.png'), 'root /docs path skipped (we already serve it)');
  ok(refs.every((r) => r.name !== ''), 'empty src produces no fetchable name');
  ok(names.filter((n) => n === 'banner.png').length === 1, 'duplicate (?v=2) de-duped by basename');
  ok(assetBasename('a/b/c/thing.PNG?x=1#y') === 'thing.PNG', 'assetBasename strips path + query + hash');
}

// 14. healImageAssets: relative <img> we DO host get rewritten to /docs/assets/
//     so they load, instead of being flagged missing.
{
  console.log('\n14. healImageAssets(root, available) — point <img> at stored copies:');
  const doc = new JSDOM('<!doctype html><body>'
    + '<img src="banner.png">'                 // have it -> heal
    + '<img src="img/logo.svg">'               // have it (by basename) -> heal
    + '<img src="nope.png">'                    // not held -> stays missing
    + '<img src="https://cdn.x/hosted.png">'    // absolute -> untouched
    + '</body>').window.document;
  const root = doc.body;
  const healed = healImageAssets(root, ['banner.png', 'logo.svg']);
  ok(healed === 2, 'two held images healed');
  const srcs = [...root.querySelectorAll('img')].map((i) => i.getAttribute('src'));
  ok(srcs[0] === '/docs/assets/banner.png', 'relative basename rewritten to /docs/assets/');
  ok(srcs[1] === '/docs/assets/logo.svg', 'subfolder path healed by basename to /docs/assets/');
  ok(srcs[2] === 'nope.png', 'image we do not hold is left as-is (will be flagged missing)');
  ok(srcs[3] === 'https://cdn.x/hosted.png', 'absolute URL untouched');
  // After healing, resolveAssets should only flag the one we truly lack.
  const report = resolveAssets(root, doc);
  ok(report.count === 1 && report.missing[0].url === 'nope.png',
     'only the genuinely-missing image is reported after healing');
}

console.log(`\n${pass} passed, ${fail} failed, ${notes} notes`);
process.exit(fail ? 1 : 0);
