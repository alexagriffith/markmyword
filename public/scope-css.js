// Scope a deliverable's CSS to the review viewer's doc container.
//
// The document being reviewed is a FULL HTML page, so its stylesheet routinely
// targets `body` / `html` / `:root` (page width, background, base font). If those
// rules are injected into the viewer's own <head> verbatim, the doc's
// `body { max-width:620px }` hijacks the VIEWER's <body> and squeezes the entire
// app chrome down to the doc's column. So before injecting, we confine every rule
// under #hs-doc-root:
//   • page-root selectors (html/body/:root) map to the container itself
//   • every other selector gets the container as a required ancestor
// The deliverable renders identically inside its column; it just can't reach out
// and restyle the toolbar. Parsing is done with the browser CSSOM (no hand-rolled
// CSS parser); anything we can't parse is passed through untouched rather than
// dropped, so a doc never loses styling.

export const DOC_SCOPE = '#hs-doc-root';

// Split a selector list on TOP-LEVEL commas only. A functional pseudo-class such
// as `:is(h1, h2)`, `:not(.a, .b)`, `:has(> a, > b)` or `:nth-child(2n of .x, .y)`
// contains commas that are NOT list separators — naively splitting on every comma
// shreds those selectors into invalid fragments, and the browser drops the rule
// (the doc silently loses those styles). So we track (), [] and string nesting
// and only break at depth 0.
function splitTopLevel(selectorText) {
  const parts = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < selectorText.length; i++) {
    const c = selectorText[i];
    if (quote) {
      // Close the quote only if this quote char isn't escaped. A backslash escapes
      // the next char, so an ODD run of preceding backslashes means escaped; EVEN
      // (incl. zero) means the quote really closes. A single-char lookback would
      // wrongly treat `[attr='\\']` (a literal backslash value) as still-open and
      // let the string state bleed past the next comma, dropping a selector.
      if (c === quote) {
        let bs = 0;
        for (let j = i - 1; j >= 0 && selectorText[j] === '\\'; j--) bs++;
        if (bs % 2 === 0) quote = '';
      }
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) { parts.push(selectorText.slice(start, i)); start = i + 1; }
  }
  parts.push(selectorText.slice(start));
  return parts;
}

// Rewrite one comma-separated selector list so each selector is confined to the
// container. A leading page-root token (html/body/:root, with optional qualifier
// like `body.dark`) becomes the container; any other selector is prefixed with
// the container as an ancestor.
export function scopeSelector(selectorText, scope = DOC_SCOPE) {
  return splitTopLevel(selectorText)
    .map((sel) => {
      const s = sel.trim();
      if (!s) return s;
      const rootLead = /^(html|body|:root)\b([.#:\[][^\s>+~]*)?/i;
      if (rootLead.test(s)) {
        return s.replace(rootLead, (_m, _tag, qual) => scope + (qual || ''));
      }
      return `${scope} ${s}`;
    })
    .join(', ');
}

// Recursively scope the rules of a stylesheet or grouping rule (@media/@supports).
// Rules that don't select page elements (@keyframes, @font-face, @import) pass
// through unchanged. Returns scoped CSS text.
export function scopeCssRules(rules, scope = DOC_SCOPE) {
  let out = '';
  for (const rule of rules) {
    try {
      if (rule.type === CSSRule.STYLE_RULE) {
        out += `${scopeSelector(rule.selectorText, scope)} { ${rule.style.cssText} }\n`;
      } else if (rule.type === CSSRule.MEDIA_RULE) {
        out += `@media ${rule.media.mediaText} {\n${scopeCssRules(rule.cssRules, scope)}}\n`;
      } else if (rule.type === CSSRule.SUPPORTS_RULE) {
        out += `@supports ${rule.conditionText} {\n${scopeCssRules(rule.cssRules, scope)}}\n`;
      } else if (rule.cssRules && rule.cssRules.length && /^@(layer|container|scope)\b/i.test(rule.cssText)) {
        // @layer { … }, @container … { … }, @scope { … } are grouping rules that
        // hold nested style rules (which can target body/h1 and thus escape). The
        // CSSRule.*_RULE constants for these are newer/inconsistent across engines,
        // so we detect by prelude and recurse, re-emitting the prelude verbatim.
        const prelude = rule.cssText.slice(0, rule.cssText.indexOf('{')).trim();
        out += `${prelude} {\n${scopeCssRules(rule.cssRules, scope)}}\n`;
      } else {
        // @keyframes, @font-face, @import, bare @layer statements, etc. don't
        // select page elements, so they can't hijack the chrome — pass through.
        out += `${rule.cssText}\n`;
      }
    } catch {
      out += `${rule.cssText}\n`;
    }
  }
  return out;
}

// Parse raw CSS via a detached <style>, scope its rules, return scoped CSS text.
// The probe is attached (needed for .sheet to populate) but disabled via
// media="not all" so it never affects layout, and removed immediately after.
export function scopeCssText(rawCss, doc = document, scope = DOC_SCOPE) {
  const probe = doc.createElement('style');
  probe.textContent = rawCss;
  probe.media = 'not all';
  doc.head.appendChild(probe);
  let scoped;
  try {
    scoped = probe.sheet ? scopeCssRules(probe.sheet.cssRules, scope) : rawCss;
  } catch {
    scoped = rawCss;
  } finally {
    probe.remove();
  }
  return scoped;
}
