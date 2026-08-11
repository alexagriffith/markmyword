// Asset handling for arbitrary deliverable HTML.
//
// A deliverable can reference images/stylesheets that won't load on our host:
//   - relative paths   (src="banner.png")   -> the file isn't next to the served HTML
//   - empty src        (src="")             -> template placeholder never filled in
// Absolute URLs (https://…) and embedded data: URIs load fine and are left alone.
//
// This module (a) CLASSIFIES an asset reference and (b), in the viewer, swaps
// unresolved <img> for a labeled placeholder so layout doesn't collapse and the
// editor can see exactly what's missing. It also force-reveals content that a
// deliverable's own JavaScript would normally fade in on scroll — we strip doc
// scripts for safety, so [data-reveal]/opacity:0 blocks would otherwise stay
// invisible during review.
//
// Imported by the browser viewer and (for classifyAssetUrl) by the Node tests,
// so keep it dependency-free and DOM-API-only.

import { icon } from './icons.js';

// Classify a URL found in an asset attribute (src/href/srcset item/url()).
// Returns 'empty' | 'data' | 'absolute' | 'root' | 'relative'.
//   empty    -> "" or whitespace                        (won't load; flag)
//   data     -> data:… inline                           (loads)
//   absolute -> http(s)://… or protocol-relative //…    (loads from the internet)
//   root     -> /docs/assets/… etc. (served by us)      (loads if we host it)
//   relative -> banner.png, ./img/x.png, ../a.png       (won't load; flag)
export function classifyAssetUrl(url) {
  const u = String(url == null ? '' : url).trim();
  if (u === '') return 'empty';
  if (/^data:/i.test(u)) return 'data';
  if (/^(https?:)?\/\//i.test(u)) return 'absolute';
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return 'absolute'; // mailto:, tel:, other schemes — not our problem
  if (u.startsWith('/')) return 'root';
  return 'relative';
}

// True for the kinds that will NOT resolve on our host and should be surfaced.
export function isUnresolved(kind) {
  return kind === 'empty' || kind === 'relative';
}

// Build a placeholder element that stands in for a broken <img>, preserving the
// image's intended box size where known so surrounding layout is undisturbed.
function makePlaceholder(doc, img, label) {
  const ph = doc.createElement('span');
  ph.setAttribute('data-hs-asset-missing', '1');
  const w = img.getAttribute('width');
  const h = img.getAttribute('height');
  const styleW = w ? `${/^\d+$/.test(w) ? w + 'px' : w}` : '100%';
  const styleH = h ? `${/^\d+$/.test(h) ? h + 'px' : h}` : '120px';
  ph.style.cssText = [
    'display:inline-flex', 'align-items:center', 'justify-content:center',
    'box-sizing:border-box', `width:${styleW}`, `min-height:${styleH}`,
    'padding:10px 14px', 'background:repeating-linear-gradient(45deg,#f3f0ea,#f3f0ea 10px,#eae5da 10px,#eae5da 20px)',
    'border:1.5px dashed #b58100', 'border-radius:6px', 'color:#7a5b00',
    'font:600 12px/1.4 ui-sans-serif,system-ui,sans-serif', 'text-align:center',
    'vertical-align:middle', 'max-width:100%',
  ].join(';');
  // Icon + escaped label. label is a URL/alt from doc HTML — escape it before
  // it goes into innerHTML (icon() returns trusted static SVG markup).
  const safe = String(label).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  ph.innerHTML = `${icon('warning', { size: 14 })} <span style="margin-left:5px">missing image · ${safe}</span>`;
  return ph;
}

// Scan rendered `root` for asset references that won't load, replace broken
// <img> with placeholders, and return a report the viewer can surface.
// Returns { missing: [{ tag, url, kind }], count }.
export function resolveAssets(root, doc = document) {
  const missing = [];

  // <img src> — the common case; replace with a visible placeholder.
  for (const img of root.querySelectorAll('img')) {
    const kind = classifyAssetUrl(img.getAttribute('src'));
    if (!isUnresolved(kind)) continue;
    const url = (img.getAttribute('src') || '').trim();
    const label = url || img.getAttribute('alt') || 'no source';
    missing.push({ tag: 'img', url, kind });
    const ph = makePlaceholder(doc, img, label);
    img.replaceWith(ph);
  }

  // <link rel=stylesheet> and other src-bearing tags: report only (no visual
  // stand-in makes sense). Covers scripts/sources for completeness of the report.
  for (const el of root.querySelectorAll('link[rel~="stylesheet"][href], source[src], source[srcset], video[src], audio[src]')) {
    const attr = el.hasAttribute('href') ? 'href' : (el.hasAttribute('src') ? 'src' : 'srcset');
    const raw = el.getAttribute(attr) || '';
    // srcset holds multiple candidates; check the first url token of each.
    const urls = attr === 'srcset' ? raw.split(',').map((s) => s.trim().split(/\s+/)[0]) : [raw];
    for (const url of urls) {
      const kind = classifyAssetUrl(url);
      if (isUnresolved(kind)) missing.push({ tag: el.tagName.toLowerCase(), url: url.trim(), kind });
    }
  }

  return { missing, count: missing.length };
}

// Force content that the deliverable's own (stripped) JS would reveal on scroll
// to be visible. We inject a stylesheet rather than mutating each element so we
// don't disturb anchoring or the base DOM. Idempotent.
export function forceRevealContent(doc = document) {
  if (doc.getElementById('hs-reveal-fix')) return;
  const style = doc.createElement('style');
  style.id = 'hs-reveal-fix';
  // Common scroll-reveal patterns: opacity:0 with a data-reveal / .reveal hook
  // that JS flips. Override to fully visible & un-transformed for review.
  style.textContent = `
    #hs-doc-root [data-reveal],
    #hs-doc-root .reveal,
    #hs-doc-root .fade-in,
    #hs-doc-root [data-animate] {
      opacity: 1 !important;
      transform: none !important;
      visibility: visible !important;
      animation: none !important;
      transition: none !important;
    }`;
  doc.head.appendChild(style);
}

// Human-readable summary line for the warning banner.
export function summarizeMissing(missing) {
  if (!missing.length) return '';
  const labels = missing.map((m) => m.url || `(empty ${m.tag})`);
  const shown = labels.slice(0, 4).join(', ');
  const more = labels.length > 4 ? ` +${labels.length - 4} more` : '';
  return `${missing.length} asset${missing.length > 1 ? 's' : ''} won't load: ${shown}${more}. ` +
    `These are relative/empty paths — upload the file(s) with the doc, or use an absolute URL. See placeholders in the page.`;
}
