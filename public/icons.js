// Vendored inline SVG icons — no network, no npm dependency, so the tool stays
// self-contained and open-sources cleanly (respects the privacy model).
//
// Paths are from the Lucide icon set (https://lucide.dev, ISC license), hand-
// inlined. Each icon() returns an <svg> string sized 1em and inheriting the
// current text color via `stroke="currentColor"`, so it drops in anywhere text
// goes and matches surrounding color/size automatically.
//
// Usage: element.innerHTML = icon('pencil') + ' Editing';
//        or icon('pencil', { size: 16, class: 'hs-ic' })

const PATHS = {
  // ✍️  editing mode  (pencil)
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  // 💬  suggesting mode (message square)
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  // ✎  suggest-edit bar (pencil-line, compact)
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  // ↧  jump-to-block (arrow down to line)
  jump: '<path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M5 21h14"/>',
  // 🖱  using mode (mouse-pointer-click) — the doc is fully interactive/clickable
  cursor: '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>',
  // ▸  collapsed disclosure (chevron right)
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  // ▾  expanded disclosure (chevron down)
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  // ⚠  missing asset (alert triangle)
  warning: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  // history (clock, for the History button if wanted)
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  // comment on a thing (message-circle)
  comment: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  // a deliverable (file-text)
  document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  // upload (upload cloud / arrow up to tray)
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  // download (arrow down to tray) — export the reviewed HTML
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  // 🔗 share the doc link (link / chain) — copies the URL to the clipboard
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
};

// Return an inline SVG string for `name`. Options: size (px, default sizes to
// 1em), strokeWidth, class.
export function icon(name, opts = {}) {
  const d = PATHS[name];
  if (!d) return '';
  const size = opts.size ? `${opts.size}` : '1em';
  const sw = opts.strokeWidth || 2;
  const cls = opts.class ? ` class="${opts.class}"` : '';
  return `<svg${cls} xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `
    + `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" `
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" `
    + `style="display:inline-block;vertical-align:-0.14em;flex:none">${d}</svg>`;
}

// Icon names available (for tests / discoverability).
export const ICON_NAMES = Object.keys(PATHS);
