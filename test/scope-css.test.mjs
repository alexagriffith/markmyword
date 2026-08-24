// A reviewed deliverable is a full HTML page, so its CSS targets body/html/:root.
// Injected verbatim, those rules hijack the VIEWER's own <body> and squeeze the
// app chrome (the toolbar shrinks to the doc's column). scope-css.js confines a
// doc's CSS to #hs-doc-root so it can't reach the chrome. These tests pin that:
// page-root selectors map to the container, other selectors get it as an ancestor,
// grouping rules recurse, and unparseable/keyframe rules survive.
import { JSDOM } from 'jsdom';
import { scopeSelector, scopeCssText, DOC_SCOPE } from '../public/scope-css.js';

// scope-css.js uses the browser CSSOM (document/CSSRule). Provide them from jsdom.
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
globalThis.document = dom.window.document;
globalThis.CSSRule = dom.window.CSSRule;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };
const has = (css, frag, m) => ok(css.includes(frag), `${m} — expected to find:\n      ${frag}\n    in:\n      ${css.replace(/\n/g, '\n      ')}`);

// --- scopeSelector: the core selector rewrite --------------------------------
ok(scopeSelector('body') === DOC_SCOPE, 'bare body → container');
ok(scopeSelector('html') === DOC_SCOPE, 'bare html → container');
ok(scopeSelector(':root') === DOC_SCOPE, ':root → container');
ok(scopeSelector('body p') === `${DOC_SCOPE} p`, 'body descendant keeps its tail');
ok(scopeSelector('.card') === `${DOC_SCOPE} .card`, 'plain selector gets container ancestor');
ok(scopeSelector('h1, h2') === `${DOC_SCOPE} h1, ${DOC_SCOPE} h2`, 'selector list scoped per-part');
ok(scopeSelector('body.dark') === `${DOC_SCOPE}.dark`, 'qualified body keeps its qualifier on the container');
ok(scopeSelector('body > .x') === `${DOC_SCOPE} > .x`, 'child combinator after body preserved');
// A selector that merely CONTAINS "body" as a class/id must not be treated as the tag.
ok(scopeSelector('.body-copy') === `${DOC_SCOPE} .body-copy`, '.body-copy is not the body tag');

// --- scopeCssText: full stylesheet, the real bug ------------------------------
const leaky = 'body { max-width: 620px; margin: 48px auto; } h1 { color: red; } .stat { font-weight: 700; }';
const scoped = scopeCssText(leaky, dom.window.document);
has(scoped, `${DOC_SCOPE} { max-width: 620px`, 'the body{max-width} rule is confined to the container');
ok(!/(^|[^-])\bbody\s*\{/.test(scoped.replace(new RegExp(DOC_SCOPE, 'g'), 'X')),
   'no bare `body {` selector remains after scoping (the toolbar-squeeze bug)');
has(scoped, `${DOC_SCOPE} h1`, 'h1 rule scoped');
has(scoped, `${DOC_SCOPE} .stat`, '.stat rule scoped');

// --- @media recurses ----------------------------------------------------------
const media = '@media (max-width: 600px) { body { padding: 0; } .x { display: none; } }';
const mScoped = scopeCssText(media, dom.window.document);
has(mScoped, '@media', '@media block preserved');
has(mScoped, `${DOC_SCOPE} { padding: 0`, 'body inside @media is scoped to container');
has(mScoped, `${DOC_SCOPE} .x`, '.x inside @media is scoped');

// --- rules that don't select page elements pass through -----------------------
const kf = '@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }';
const kfScoped = scopeCssText(kf, dom.window.document);
has(kfScoped, '@keyframes spin', '@keyframes name preserved (not scoped)');
ok(!kfScoped.includes(DOC_SCOPE), '@keyframes body is not polluted with the container scope');

console.log(`scope-css: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
