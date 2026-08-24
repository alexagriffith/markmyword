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

// Rewrite one comma-separated selector list so each selector is confined to the
// container. A leading page-root token (html/body/:root, with optional qualifier
// like `body.dark`) becomes the container; any other selector is prefixed with
// the container as an ancestor.
export function scopeSelector(selectorText, scope = DOC_SCOPE) {
  return selectorText
    .split(',')
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
      } else {
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
