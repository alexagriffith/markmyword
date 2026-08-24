// Viewer toolbar contract — the static markup + icons that the viewer.js wiring
// depends on. These are cheap structural guards so an HTML/JS rename can't
// silently break the mode pill, Share button, or identity chip (all added for
// multi-reviewer support). Full click-through is covered by the live Playwright
// pass; this keeps the wiring honest without a browser.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { icon, ICON_NAMES } from '../public/icons.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

const html = readFileSync(new URL('../public/viewer.html', import.meta.url), 'utf8');
const doc = new JSDOM(html).window.document;

// --- mode pill (Google-Docs-style segmented control) -------------------------
const opts = Array.from(doc.querySelectorAll('.hs-mode-opt'));
const modes = opts.map((b) => b.dataset.mode);
ok(opts.length === 3, `mode pill has 3 options (got ${opts.length})`);
ok(['edit', 'suggest', 'use'].every((m) => modes.includes(m)), `pill covers edit/suggest/use (got ${modes.join(',')})`);
ok(doc.getElementById('hs-mode-use')?.hidden === true, '"Using" option starts hidden (revealed only for interactive docs)');
// The old <select id="hs-mode"> must be gone so viewer.js can't bind the wrong control.
ok(!doc.querySelector('select#hs-mode'), 'old mode <select> is removed');
ok(opts.every((b) => b.querySelector('.hs-mode-ic')), 'each pill option has an icon slot');

// --- Share button + popover (Google-Docs style) ------------------------------
ok(!!doc.getElementById('hs-share-btn'), 'Share button exists');
ok(/Share/.test(doc.getElementById('hs-share-btn')?.textContent || ''), 'Share button is labeled "Share" (not "Copy")');
ok(!!doc.getElementById('hs-share-ic'), 'Share button has an icon slot');
const pop = doc.getElementById('hs-share-pop');
ok(!!pop, 'Share popover exists');
ok(pop?.hidden === true, 'Share popover starts hidden (opens only on Share click)');
ok(!!doc.getElementById('hs-share-link'), 'popover has a copyable link field');
ok(!!doc.getElementById('hs-share-copy'), 'popover has a Copy-link button');

// --- identity chip + toast ---------------------------------------------------
ok(!!doc.getElementById('hs-whoami'), 'identity chip exists');
ok(!!doc.getElementById('hs-toast'), 'copy toast element exists');

// --- link access control (owner-only, lives INSIDE the Share popover) ---------
const accessRow = doc.getElementById('hs-access-row');
ok(!!accessRow, 'access row exists inside the popover');
ok(pop?.contains(accessRow), 'access control is inside the Share popover (not the toolbar)');
ok(accessRow?.hidden === true, 'access row starts hidden (revealed only for the doc owner)');
const accessSel = doc.getElementById('hs-access-sel');
ok(!!accessSel, 'access-level <select> exists');
const levels = Array.from(accessSel?.options || []).map((o) => o.value);
ok(['view', 'suggest', 'edit'].every((l) => levels.includes(l)),
   `access select covers view/suggest/edit (got ${levels.join(',')})`);
// The old always-visible toolbar picker must be gone.
ok(!doc.getElementById('hs-access'), 'old always-visible toolbar access picker is removed');

// --- icons the wiring references actually exist -------------------------------
ok(ICON_NAMES.includes('link'), 'a "link" icon is defined for Share');
ok(icon('link').startsWith('<svg'), 'icon("link") renders an svg');
ok(icon('pencil').startsWith('<svg'), 'icon("pencil") renders an svg (identity chip edit hint)');

console.log(`viewer-ui: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
