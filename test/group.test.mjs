// Grouped-block (data-hs-group) anchoring + serialization tests. Uses a small
// self-contained fixture (an intro card of three paragraphs marked as one group)
// so the grouping feature is tested independently of the shipped example doc.
import { JSDOM } from 'jsdom';
import {
  assignAnchors, collectLeaves, normalizeText, groupShells, groupText, GROUP_ATTR,
} from '../public/anchoring.js';

const html = `<!doctype html><html><body>
  <h1>Title</h1>
  <div class="intro">
    <p>This is a sample document used to show and test the reviewer.</p>
    <p>The three paragraphs in this section are marked as one grouped block.</p>
    <p>Grouping keeps a multi-paragraph passage as one unit from start to finish.</p>
  </div>
  <h2>After</h2>
  <p>A standalone paragraph outside the group.</p>
</body></html>`;
const config = { groups: ['.intro'] };
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

// Grouping now comes from the per-doc config (applied at load), not the static
// HTML — mirror the viewer: mark selector matches with data-hs-group first.
function applyGroups(doc, cfg) {
  for (const sel of (cfg.groups || [])) {
    for (const el of doc.querySelectorAll(sel)) el.setAttribute(GROUP_ATTR, '');
  }
}

const dom = new JSDOM(html);
const doc = dom.window.document;
applyGroups(doc, config);
const map = await assignAnchors(doc.body);

// 1. The SYSTEM PROMPT td is grouped and anchored as ONE unit.
const group = doc.querySelector(`[${GROUP_ATTR}]`);
ok(!!group, 'a data-hs-group container exists');
ok(group.hasAttribute('data-hs-anchor'), 'group container got an anchor');
ok(group.getAttribute('data-hs-grouped') === '1', 'group container marked data-hs-grouped');

// 2. Its inner paragraph <div>s are NOT separately anchored.
const innerAnchored = [...group.querySelectorAll('[data-hs-anchor]')].filter((e) => e !== group);
ok(innerAnchored.length === 0, 'inner paragraphs are not individually anchored (group owns them)');

// 3. The 3 paragraphs are all present in the group text.
const shells = groupShells(group);
ok(shells.length === 3, `group has 3 paragraph shells (got ${shells.length})`);
const gt = groupText(group);
ok(gt.includes('This is a sample document') && gt.includes('start to finish'), 'group text spans first..last paragraph');
ok(gt.split('\n').length === 3, 'group text has 3 newline-separated paragraphs');

// 4. collectLeaves returns the group once and does not descend into it.
const leaves = collectLeaves(doc.body);
ok(leaves.includes(group), 'collectLeaves includes the group container');
ok(leaves.filter((l) => group.contains(l) && l !== group).length === 0, 'no leaves collected inside the group');

// 5. Determinism: the group anchor is stable across renders.
const doc2 = new JSDOM(html).window.document;
applyGroups(doc2, config);
const map2 = await assignAnchors(doc2.body);
const gAnchor = group.getAttribute('data-hs-anchor');
ok([...map2.keys()].includes(gAnchor), 'group anchor is deterministic across renders');

console.log(`\ngroup blocks: ${leaves.filter((l) => l.hasAttribute(GROUP_ATTR)).length}, total editable units: ${map.size}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
