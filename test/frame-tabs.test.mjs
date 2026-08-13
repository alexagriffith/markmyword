// Tab-heavy / dynamic-DOM editability for the interactive-doc frame.
//
// Real "standalone" docs (the AI Hub model overview) render most text via JS and
// hide big chunks behind TABS: clicking a tab injects new content the frame never
// saw at boot. Earlier the controller anchored ONCE at boot, so tab-2/3 text and
// loose "stray" text in flex wrappers stayed uneditable ("I can't edit this").
//
// This drives frame-controller.js in jsdom against a doc that:
//   • builds its whole UI in JS (nothing editable in the raw markup),
//   • has 3 tabs; only tab 1's panel exists until you click a tab (JS injects the rest),
//   • mixes inline <span>/<a>/<button>, table cells, deep nesting, repeated text,
//   • and has STRAY text directly inside a flex wrapper next to a child element.
// It asserts every visible run becomes editable AFTER the relevant tab is clicked,
// anchors stay unique/stable, repeats get occurrence suffixes, and each run is
// reported to the parent (anchors + origText) for the download source-patch.
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

const controller = await readFile(new URL('../public/frame-controller.js', import.meta.url), 'utf8');

// A JS-built, tabbed doc. The raw markup is nearly empty (#app + a script); the
// script wires tabs and injects each panel's content on click — exactly the shape
// the frame must cope with. Panel text is defined in a data table so we can assert
// coverage generically.
const raw = `<!doctype html><html><head><title>Model</title></head><body>
<div id="app"></div>
<script>
  var TABS = {
    overview: [
      { tag: 'h1', text: 'GLM-5.2-FP8' },
      { tag: 'span', text: 'Text generation' },
      { tag: 'span', text: 'Agentic' },
      { tag: 'a', text: 'Deployments' },
      { tag: 'button', text: 'Try in Playground' },
      { tag: 'stray', text: 'Provided by' , child: 'zai-org' },
      { tag: 'span', text: 'FP8' },
      { tag: 'span', text: 'FP8' }          /* repeated text -> occurrence suffix */
    ],
    quickstart: [
      { tag: 'p', text: 'export NAMESPACE=glm52' },
      { tag: 'p', text: 'oc new-project the-namespace' },
      { tag: 'li', text: 'Pin the revision.' },
      { tag: 'td', text: 'apiVersion: v1' },
      { tag: 'td', text: 'kind: PersistentVolumeClaim' }
    ],
    notes: [
      { tag: 'p', text: 'No MTP — unsupported under pipeline parallelism.' },
      { tag: 'p', text: 'Whole-group restarts.' },
      { tag: 'p', text: 'Weights download twice.' },
      { tag: 'span', text: 'Validate the CRD wiring.' }
    ]
  };
  function build(list) {
    var frag = document.createElement('div');
    list.forEach(function (item) {
      var el;
      if (item.tag === 'stray') {
        el = document.createElement('div');
        el.style.display = 'flex';
        el.appendChild(document.createTextNode(item.text + ' '));
        var a = document.createElement('a'); a.href = '#'; a.textContent = item.child;
        el.appendChild(a);
      } else if (item.tag === 'td') {
        var table = frag.querySelector('table');
        if (!table) { table = document.createElement('table'); var tb=document.createElement('tbody'); table.appendChild(tb); frag.appendChild(table); }
        var tr = document.createElement('tr'); el = document.createElement('td'); el.textContent = item.text; tr.appendChild(el);
        table.querySelector('tbody').appendChild(tr); return;
      } else {
        el = document.createElement(item.tag); el.textContent = item.text;
      }
      frag.appendChild(el);
    });
    return frag;
  }
  var app = document.getElementById('app');
  var panel = document.createElement('div'); panel.id = 'panel'; app.appendChild(panel);
  function show(name) {
    panel.innerHTML = '';
    panel.appendChild(build(TABS[name]));
  }
  // Tab bar
  var bar = document.createElement('div');
  ['overview','quickstart','notes'].forEach(function (name) {
    var b = document.createElement('button'); b.textContent = 'tab-' + name;
    b.setAttribute('data-tab', name);
    b.addEventListener('click', function () { show(name); });
    bar.appendChild(b);
  });
  app.insertBefore(bar, panel);
  show('overview'); // default tab
</script></body></html>`;

const dom = new JSDOM(raw, { runScripts: 'dangerously', pretendToBeVisual: true });
const win = dom.window;
// Mirror the opaque-origin frame: no crypto.subtle -> exercises pure-JS SHA-256.
Object.defineProperty(win, 'crypto', { value: {}, configurable: true });
win.__MMW_RAW__ = raw;
win.__MMW_DOC__ = 'zz-tabs';

const posted = [];
win.parent = { postMessage: (msg) => posted.push(msg) };
const latestReady = () => [...posted].reverse().find((m) => m && m.type === 'ready');

// Run the controller and let it boot (load + 300ms + async scan).
win.eval(controller);
win.dispatchEvent(new win.Event('load'));
await new Promise((r) => setTimeout(r, 700));

const editableTexts = () => [...win.document.querySelectorAll('[data-hs-editable]')]
  .map((el) => el.textContent.replace(/\s+/g, ' ').trim());

// --- Tab 1 (overview) is shown at boot ---
let texts = editableTexts();
ok(latestReady(), 'boot posts ready');
ok(texts.includes('GLM-5.2-FP8'), 'tab1 heading editable');
ok(texts.includes('Deployments'), 'tab1 inline <a> editable');
ok(texts.includes('Try in Playground'), 'tab1 button label editable');
ok(texts.includes('Provided by'), 'tab1 STRAY wrapper text editable (not swallowed)');
ok(texts.includes('zai-org'), 'tab1 the stray wrapper\'s child link is ALSO editable');
ok(texts.filter((t) => t === 'FP8').length === 2, 'repeated "FP8" -> two editable runs');

// tab2/tab3 content does NOT exist yet -> not editable yet (correct).
ok(!texts.includes('export NAMESPACE=glm52'), 'tab2 text absent before its tab is clicked');
ok(!texts.includes('No MTP — unsupported under pipeline parallelism.'), 'tab3 text absent before click');

// helper: click a tab button and wait for the MutationObserver-driven rescan.
async function clickTab(name) {
  const btn = [...win.document.querySelectorAll('button[data-tab]')].find((b) => b.getAttribute('data-tab') === name);
  btn.dispatchEvent(new win.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500)); // observer debounce (200) + async scan
}

// --- Click tab 2 (quickstart): its injected text must become editable ---
await clickTab('quickstart');
texts = editableTexts();
ok(texts.includes('export NAMESPACE=glm52'), 'tab2: shell command becomes editable after tab click');
ok(texts.includes('oc new-project the-namespace'), 'tab2: second command editable');
ok(texts.includes('Pin the revision.'), 'tab2: list item editable');
ok(texts.includes('apiVersion: v1') && texts.includes('kind: PersistentVolumeClaim'), 'tab2: table cells editable');

// --- Click tab 3 (notes) ---
await clickTab('notes');
texts = editableTexts();
ok(texts.includes('No MTP — unsupported under pipeline parallelism.'), 'tab3: note paragraph editable');
ok(texts.includes('Whole-group restarts.'), 'tab3: second note editable');
ok(texts.includes('Weights download twice.'), 'tab3: third note editable');
ok(texts.includes('Validate the CRD wiring.'), 'tab3: inline span note editable');

// --- Anchor integrity across all tabs seen so far ---
const ready = latestReady();
const anchors = ready.anchors;
ok(new Set(anchors).size === anchors.length, 'all anchors are unique (no collisions across tabs)');
ok(anchors.every((a) => typeof ready.origText[a] === 'string' && ready.origText[a].trim() !== ''),
   'every anchor has non-empty origText reported for source-patch download');
// The accumulated set must include runs from every tab (tabs 1+2+3), because the
// parent's download patches the payload for ALL edits regardless of active tab.
const allReported = Object.values(ready.origText).map((t) => t.replace(/\s+/g, ' ').trim());
ok(allReported.includes('GLM-5.2-FP8')
   && allReported.includes('export NAMESPACE=glm52')
   && allReported.includes('No MTP — unsupported under pipeline parallelism.'),
   'origText accumulates runs from ALL visited tabs (download can patch them all)');

// --- Editing a dynamically-shown run fires an edit to the parent ---
const editMsgs = [];
const origPost = win.parent.postMessage;
win.parent.postMessage = (m) => { if (m && m.type === 'edit') editMsgs.push(m); origPost(m); };
const noteEl = [...win.document.querySelectorAll('[data-hs-editable]')]
  .find((el) => el.textContent.trim() === 'Whole-group restarts.');
noteEl.textContent = 'Whole-group restarts (~12 min).';
noteEl.dispatchEvent(new win.Event('input', { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
ok(editMsgs.some((m) => m.text.includes('~12 min')), 'editing a tab-3 run posts an edit to the parent');

// --- Switching BACK to tab 1 re-anchors its (re-injected) content ---
await clickTab('overview');
texts = editableTexts();
ok(texts.includes('GLM-5.2-FP8'), 'returning to tab1 re-anchors its content (editable again)');

// --- Edit vs Use mode toggle ------------------------------------------------
// Editable text units are only contentEditable in 'edit' mode; switching to
// 'use' makes the doc fully interactive (nothing editable) so its own links/
// tabs/buttons work; switching back to 'edit' restores editability.
const ceCount = () => [...win.document.querySelectorAll('[data-hs-editable]')]
  .filter((el) => el.getAttribute('contenteditable') === 'true').length;
// The frame only accepts messages whose .source is its embedder (window.parent),
// so deliver mode changes exactly like the real viewer does: a MessageEvent
// whose source is our fake PARENT object.
const sendToFrame = async (data) => {
  win.dispatchEvent(new win.MessageEvent('message', { data, source: win.parent }));
  await new Promise((r) => setTimeout(r, 50));
};

const editableBefore = ceCount();
ok(editableBefore > 0, 'boot defaults to edit mode: editable units are contentEditable');

await sendToFrame({ type: 'setMode', mode: 'use' });
ok(ceCount() === 0, "setMode('use') removes contenteditable from every unit (doc fully interactive)");

await sendToFrame({ type: 'setMode', mode: 'edit' });
ok(ceCount() === editableBefore, "setMode('edit') restores contenteditable on every unit");

// Re-anchoring while in 'use' mode must NOT make freshly-injected text editable.
await sendToFrame({ type: 'setMode', mode: 'use' });
await clickTab('quickstart');
ok(ceCount() === 0, 'content injected while in use mode stays non-editable (no contenteditable)');
await sendToFrame({ type: 'setMode', mode: 'edit' });
ok(ceCount() > 0, "switching back to 'edit' after a use-mode tab click re-enables editing");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
