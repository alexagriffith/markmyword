// Reviewer identity (public/identity.js) — the "who suggested this" labels.
//
// Guarantees:
//   • Owner is always "Owner", regardless of any stored guest name.
//   • A guest with no stored name gets a stable "Anonymous <Animal>" that does NOT
//     change across calls (same browser -> same auto name).
//   • setReviewerName persists a chosen name; reviewerName then returns it.
//   • A blank/whitespace name clears the override and falls back to the auto name.
//   • Names are trimmed and capped at 40 chars (matches the server author cap).
import { JSDOM } from 'jsdom';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

// identity.js reads localStorage/crypto off the browser globals. Point globalThis
// at a jsdom window so the ESM import resolves them, exactly like in a browser.
const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.test/' });
globalThis.window = dom.window;
globalThis.localStorage = dom.window.localStorage;
// `crypto` is a read-only global in Node; identity.js reads it off globalThis and
// Node provides a real one, so no shim is needed (and reassigning throws).

const { reviewerName, setReviewerName } = await import('../public/identity.js');

// --- owner is always "Owner" -------------------------------------------------
localStorage.clear();
ok(reviewerName(true) === 'Owner', 'owner name is "Owner"');
setReviewerName('Sneaky'); // even with a stored guest name...
ok(reviewerName(true) === 'Owner', 'owner ignores any stored guest name');

// --- guest auto name is anonymous + stable -----------------------------------
localStorage.clear();
const auto1 = reviewerName(false);
const auto2 = reviewerName(false);
ok(/^Anonymous [A-Z][a-z]+$/.test(auto1), `guest auto name looks anonymous ("${auto1}")`);
ok(auto1 === auto2, 'guest auto name is stable across calls');

// --- rename persists ---------------------------------------------------------
const chosen = setReviewerName('  Priya  ');
ok(chosen === 'Priya', 'setReviewerName trims and returns the chosen name');
ok(reviewerName(false) === 'Priya', 'reviewerName returns the chosen name');

// --- blank clears back to the (same) auto name -------------------------------
const back = setReviewerName('   ');
ok(back === auto1, 'blank name falls back to the auto name');
ok(reviewerName(false) === auto1, 'cleared override -> auto name again (stable)');

// --- length cap --------------------------------------------------------------
const long = 'x'.repeat(60);
const capped = setReviewerName(long);
ok(capped.length === 40, `name capped to 40 chars (got ${capped.length})`);

console.log(`identity: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
