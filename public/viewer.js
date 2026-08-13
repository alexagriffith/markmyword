// markmyword viewer — edit-in-place + version history (MVP).
//
// Flow:
//   1. GET /api/doc/:id -> { baseHtml, overlay }
//   2. Render baseHtml faithfully into #hs-doc-root.
//   3. Assign CONTENT-HASH anchors to text-leaf blocks (see anchoring.js).
//   4. Apply overlay over matching anchors; overlay entries with no matching
//      anchor are STALE -> reported, never applied to the wrong element.
//   5. Editor: contenteditable, debounced save of textContent.
//   6. Version panel: list snapshots, preview, restore.
import { assignAnchors, assignCommentAnchors, normalizeText, GROUP_ATTR, groupShells, findUnreachableText, summarizeUnreachable } from './anchoring.js';
import { diffWords, renderDiffHtml } from './diff.js';
import { resolveAssets, forceRevealContent, summarizeMissing, healImageAssets } from './assets.js';
import { icon } from './icons.js';

const $ = (s) => document.querySelector(s);
const statusEl = $('#hs-status');
const statusTxt = statusEl.querySelector('.txt');
const warnEl = $('#hs-warn');
const root = $('#hs-doc-root');

let docId = null;
// Owner-facing mode, like Google Docs' Editing/Suggesting switch:
//   'edit'    -> changes apply directly to the live overlay (contenteditable)
//   'suggest' -> changes become tracked suggestions (accept/reject), live text untouched
let mode = 'edit';
const editMode = () => mode === 'edit';       // kept as a helper for existing call sites
let anchorMap = new Map();          // text anchor -> element (editable)
let commentMap = new Map();         // comment anchor -> element (non-text, commentable)
let baseText = new Map();            // anchor -> ORIGINAL template text (pre-overlay)
const pending = new Map();          // anchor -> latest text awaiting save
const saveTimers = new Map();
let inflight = 0;
let suggestions = [];               // open suggestions for this doc
let pollTimer = null;

// Interactive (JS) docs render inside a sandboxed iframe instead of inline. When
// set, `frame` is that iframe and `frameAnchors` is the set of editable anchors
// the in-frame controller reported (used to validate edit messages before we
// forward them to /api/edit — the frame runs untrusted JS, so we don't trust an
// anchor we didn't hand out).
let frame = null;
let frameAnchors = new Set();
let frameOrigText = {};   // anchor -> original rendered text (for source-patch)
let interactive = false;

function getDocId() {
  const p = new URLSearchParams(location.search);
  if (p.get('doc')) return p.get('doc');
  const m = location.pathname.match(/\/d\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function setStatus(kind, text) { statusEl.className = kind; statusTxt.textContent = text; }
function warn(msg) {
  if (!msg) { warnEl.className = ''; warnEl.textContent = ''; return; }
  warnEl.textContent = msg; warnEl.className = 'show';
}

// Overlay values are HTML-escaped text; decode to a plain string for textContent.
function decodeEntities(escaped) {
  const t = document.createElement('textarea');
  t.innerHTML = escaped;
  return t.value;
}

// Escape a plain string for safe interpolation into an innerHTML template.
// Server-stored reviewer text is escaped once at rest; anything we build into
// an HTML string here (rather than assigning via textContent) must be escaped
// so a decoded/plain value can never break out of its element.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- grouped-block (data-hs-group) serialization ---
// A grouped container is edited as ONE section but keeps its inner paragraph
// shells. We serialize it as the shells' text joined by newlines, and re-render
// that text back into shells (cloning a template shell to preserve styling) so
// paragraph structure + styling survive and inline styles are never touched.
const GROUP_SEP = '\n';

function isGroup(el) { return el.hasAttribute(GROUP_ATTR); }

// Mark elements matching config.groups selectors as grouped blocks (data-hs-group)
// before anchoring. Invalid selectors are skipped, not fatal.
function applyGroupConfig(config) {
  const selectors = (config && Array.isArray(config.groups)) ? config.groups : [];
  for (const sel of selectors) {
    let matches;
    try { matches = root.querySelectorAll(sel); } catch { continue; }
    for (const el of matches) el.setAttribute(GROUP_ATTR, '');
  }
}

// Read a grouped container's current text (one line per paragraph shell).
// While the user edits a contenteditable region, the browser may insert its own
// <div>/<br> for new lines instead of cloning our shells. So we read the visible
// paragraph structure: prefer our shells, but if editing produced other block
// children or <br>-separated text, fall back to the container's line structure.
function readGroupText(container) {
  const shells = groupShells(container);
  // If every direct child is a shell we recognize, read them directly.
  const directBlocks = [...container.children].filter((c) => c.nodeType === 1);
  if (shells.length > 0 && shells.length === directBlocks.length) {
    return shells.map((s) => normalizeText(s.textContent)).filter((t) => t !== '').join(GROUP_SEP);
  }
  // Fallback: reconstruct lines from mixed content (text nodes, <br>, blocks).
  const lines = [];
  let buf = '';
  const flush = () => { const t = normalizeText(buf); if (t) lines.push(t); buf = ''; };
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) buf += n.textContent;
      else if (n.nodeType === 1) {
        const tag = n.tagName.toLowerCase();
        if (tag === 'br') { flush(); }
        else if (['div', 'p'].includes(tag)) { flush(); walk(n); flush(); }
        else walk(n);
      }
    }
  };
  walk(container);
  flush();
  return lines.join(GROUP_SEP);
}

// Write `text` (newline-delimited paragraphs) back into `container`, reusing the
// existing shells as style templates. Grows/shrinks the shell count to match.
function writeGroupText(container, text) {
  const paras = String(text).split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  let shells = groupShells(container);
  if (shells.length === 0) return; // nothing to template from; leave as-is
  const template = shells[0];
  // Ensure exactly paras.length shells, cloning the template for new ones.
  while (shells.length < paras.length) {
    const clone = template.cloneNode(false); // empty clone keeps tag+style/attrs
    template.parentNode.insertBefore(clone, shells[shells.length - 1].nextSibling);
    shells = groupShells(container);
  }
  while (shells.length > paras.length && shells.length > 1) {
    shells[shells.length - 1].remove();
    shells = groupShells(container);
  }
  for (let i = 0; i < shells.length; i++) shells[i].textContent = paras[i] ?? '';
}

function renderBaseHtml(baseHtml) {
  const parsed = new DOMParser().parseFromString(baseHtml, 'text/html');
  // Preserve the deliverable's own styling (doc HTML is trusted).
  const headBits = parsed.head ? parsed.head.querySelectorAll('style, link[rel="stylesheet"]') : [];
  headBits.forEach((n) => document.head.appendChild(n.cloneNode(true)));
  root.innerHTML = '';
  const kids = parsed.body ? Array.from(parsed.body.childNodes) : [];
  for (const n of kids) root.appendChild(document.importNode(n, true));
}

// Apply overlay text onto matching anchors. Returns count of stale (unmatched)
// overlay entries so the editor knows some saved edits couldn't be placed.
function applyOverlay(overlay) {
  let stale = 0;
  for (const [anchor, entry] of Object.entries(overlay || {})) {
    const el = anchorMap.get(anchor);
    if (!el || !entry) { stale++; continue; }
    const text = decodeEntities(entry.text);
    if (isGroup(el)) writeGroupText(el, text);
    else el.textContent = text;
    el.setAttribute('data-hs-edited', '1');
  }
  return stale;
}

// Apply the current mode to the rendered doc:
//  - edit:    blocks are contenteditable (direct editing)
//  - suggest: blocks are NOT editable; clicking one opens a suggestion popup
function applyMode() {
  const editing = mode === 'edit';
  const suggesting = mode === 'suggest';
  document.body.classList.toggle('hs-edit', editing);
  document.body.classList.toggle('hs-suggest', suggesting);
  // Interactive docs live in the sandboxed frame; drive editability across the
  // bridge. (Suggest/comment parity in the frame is phase 2 — for now the frame
  // supports edit mode; suggesting simply disables in-frame editing.)
  if (interactive) {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: 'setMode', mode }, '*');
    return;
  }
  for (const el of anchorMap.values()) {
    if (editing) { el.setAttribute('contenteditable', 'true'); el.spellcheck = true; }
    else { el.removeAttribute('contenteditable'); el.spellcheck = false; }
  }
  if (!suggesting) { closeSuggestPopup(); closeSpanBar(); }
}

// Back-compat shim for the one remaining call in boot(); routes through applyMode.
function setEditable() { applyMode(); }

function scheduleSave(anchor, el) {
  pending.set(anchor, isGroup(el) ? readGroupText(el) : el.textContent);
  setStatus('dirty', 'Editing…');
  if (saveTimers.has(anchor)) clearTimeout(saveTimers.get(anchor));
  saveTimers.set(anchor, setTimeout(() => saveBlock(anchor), 800));
}

async function saveBlock(anchor) {
  if (!pending.has(anchor)) return;
  const text = pending.get(anchor);
  pending.delete(anchor);
  saveTimers.delete(anchor);
  inflight++;
  setStatus('dirty', 'Saving…');
  try {
    const res = await fetch(`/api/edit/${encodeURIComponent(docId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anchor, text }),
    });
    if (!res.ok) throw new Error(`save ${res.status}`);
    inflight--;
    if (inflight === 0 && pending.size === 0) setStatus('saved', 'All changes saved');
  } catch {
    inflight--;
    setStatus('error', 'Save failed — retrying');
    pending.set(anchor, text);
    setTimeout(() => saveBlock(anchor), 2500);
  }
}

// IMPORTANT: editing text changes the element's textContent, which would change
// its content-hash. We keep the ORIGINAL anchor pinned on the element via
// data-hs-anchor and always save under that, so a block keeps one stable id for
// its whole editing session regardless of typed content.
function wireEditing() {
  root.addEventListener('input', (e) => {
    const el = e.target.closest?.('[data-hs-anchor]');
    if (!el || !editMode()) return;
    scheduleSave(el.getAttribute('data-hs-anchor'), el);
  });
  root.addEventListener('blur', (e) => {
    const el = e.target.closest?.('[data-hs-anchor]');
    if (!el || !editMode()) return;
    const a = el.getAttribute('data-hs-anchor');
    if (saveTimers.has(a)) { clearTimeout(saveTimers.get(a)); saveTimers.delete(a); }
    saveBlock(a);
  }, true);
  window.addEventListener('beforeunload', () => {
    for (const [a, text] of pending.entries()) {
      try {
        navigator.sendBeacon(
          `/api/edit/${encodeURIComponent(docId)}`,
          new Blob([JSON.stringify({ anchor: a, text })], { type: 'application/json' })
        );
      } catch { /* ignore */ }
    }
  });
  // Suggesting mode: after a mouseup, decide between:
  //  - a span selection inside a text block -> floating "Suggest edit" bar
  //  - a plain click on a text block        -> whole-block suggest popup
  //  - a click on a non-text element        -> comment-only popup
  root.addEventListener('mouseup', (e) => {
    if (mode !== 'suggest') return;
    // Defer so the browser has finalized the selection from this mouseup.
    setTimeout(() => {
      const span = currentSpanSelection();
      if (span) { showSpanBar(span); return; }
      if (popupEl) return;
      const textEl = e.target.closest?.('[data-hs-anchor]');
      if (textEl) { openSuggestPopup(textEl); return; }
      // Non-text: comment on an image/chart/divider.
      const commentEl = e.target.closest?.('[data-hs-comment-anchor]');
      if (commentEl) openCommentPopup(commentEl);
    }, 0);
  });
}

// --- version history panel (with diffs) ---

// Overlay values are HTML-escaped text; decode for display/diffing.
function overlayText(entry) { return entry ? decodeEntities(entry.text) : undefined; }

// Compute what changed between an older overlay and a newer one. For each anchor
// whose text differs, produce { anchor, from, to }. `from` falls back to the
// block's original template text (baseText) when it's the first edit to a block.
function overlayChanges(prevOverlay, currOverlay) {
  const changes = [];
  const anchors = new Set([...Object.keys(prevOverlay || {}), ...Object.keys(currOverlay || {})]);
  for (const anchor of anchors) {
    const to = overlayText(currOverlay?.[anchor]);
    if (to === undefined) continue; // removed from overlay — ignore for display
    const from = overlayText(prevOverlay?.[anchor]) ?? baseText.get(anchor) ?? '';
    if (normalizeText(from) !== normalizeText(to)) changes.push({ anchor, from, to });
  }
  return changes;
}

async function loadVersions() {
  const panel = $('#hs-versions');
  panel.innerHTML = '<div class="hs-v-load">Loading history…</div>';
  try {
    const listRes = await fetch(`/api/versions/${encodeURIComponent(docId)}`);
    const { versions } = await listRes.json(); // newest first
    if (!versions.length) { panel.innerHTML = '<div class="hs-v-empty">No versions yet. Make an edit.</div>'; return; }

    // Fetch each version's full overlay so we can diff consecutive snapshots.
    // (Small histories; fine to fetch all. Could paginate later.)
    const full = await Promise.all(versions.map((v) =>
      fetch(`/api/version/${encodeURIComponent(docId)}/${v.id}`).then((r) => r.json())
    ));

    panel.innerHTML = '';
    for (let i = 0; i < full.length; i++) {
      const v = full[i];
      const prev = full[i + 1]; // next in list is older (newest-first order)
      const changes = overlayChanges(prev ? prev.overlay : {}, v.overlay);

      const row = document.createElement('div');
      row.className = 'hs-v-row';
      const when = new Date(v.ts).toLocaleString();
      const summary = v.label
        ? v.label
        : changes.length === 0 ? 'no text change'
        : changes.length === 1 ? '1 block changed'
        : `${changes.length} blocks changed`;

      row.innerHTML =
        `<button class="hs-v-toggle" title="Show changes">${icon('chevronRight')}</button>` +
        `<span class="hs-v-when">${escapeHtml(when)}</span>` +
        `<span class="hs-v-label">${escapeHtml(summary)}</span>`;
      const btn = document.createElement('button');
      btn.textContent = 'Restore';
      btn.className = 'hs-v-restore';
      btn.onclick = () => restore(v.id, when);
      row.appendChild(btn);
      panel.appendChild(row);

      // Collapsible diff detail.
      const detail = document.createElement('div');
      detail.className = 'hs-v-detail';
      if (changes.length === 0) {
        detail.innerHTML = '<div class="hs-v-nochange">No text changes in this version.</div>';
      } else {
        detail.innerHTML = changes.map((c) =>
          `<div class="hs-diff-block">${renderDiffHtml(diffWords(c.from, c.to))}</div>`
        ).join('');
      }
      panel.appendChild(detail);

      const toggle = row.querySelector('.hs-v-toggle');
      toggle.onclick = () => {
        const open = detail.classList.toggle('open');
        toggle.innerHTML = open ? icon('chevronDown') : icon('chevronRight');
      };
    }
  } catch {
    panel.innerHTML = '<div class="hs-v-empty">Failed to load history.</div>';
  }
}

async function restore(versionId, when) {
  if (!confirm(`Restore the version from ${when}? Current text will be replaced (a new version is saved so this is undoable).`)) return;
  setStatus('dirty', 'Restoring…');
  try {
    const res = await fetch(`/api/restore/${encodeURIComponent(docId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId }),
    });
    if (!res.ok) throw new Error();
    const { overlay } = await res.json();
    // Re-render clean base, re-anchor, re-apply restored overlay.
    await boot(overlay);
    setStatus('saved', 'Restored');
    loadVersions();
  } catch {
    setStatus('error', 'Restore failed');
  }
}

// --- suggestions (tracked changes) ---

// The current text of a block (edit-applied), used to pre-fill a rewrite and to
// store the "quote" a suggestion refers to.
function blockText(el) { return isGroup(el) ? readGroupText(el) : el.textContent; }

// Resolve any suggestion anchor to its element: comment anchors ("c:…") live in
// commentMap (non-text elements), text anchors in anchorMap.
function resolveAnchorEl(anchor) {
  return (anchor && anchor.startsWith('c:')) ? commentMap.get(anchor) : anchorMap.get(anchor);
}

// The occurrence index (0-based) of `phrase` within `haystack`, counting from the
// start up to `charOffset` — i.e. how many identical phrases precede this one.
// Lets a span-level suggestion target the exact repeat the user highlighted
// (e.g. the 2nd "rate limiting" in a paragraph). Returns 0 if not resolvable.
function occurrenceIndex(haystack, phrase, charOffset) {
  if (!phrase) return 0;
  let idx = 0, from = 0, n = 0;
  while ((idx = haystack.indexOf(phrase, from)) !== -1 && idx < charOffset) {
    n++; from = idx + phrase.length;
  }
  return n;
}

// Character offset of the start of a DOM Range within `blockEl`'s textContent.
// We measure by cloning the range from block-start to the selection start.
function rangeStartOffset(blockEl, range) {
  const pre = document.createRange();
  pre.selectNodeContents(blockEl);
  try { pre.setEnd(range.startContainer, range.startOffset); } catch { return 0; }
  return pre.toString().length;
}

// If there's a non-empty text selection inside a single anchored block (in
// Suggesting mode), describe the span so we can suggest a rewrite of just that
// phrase. Returns { el, anchor, phrase, spanOcc, rect } or null.
function currentSpanSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const phrase = normalizeText(sel.toString());
  if (!phrase) return null;
  const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const el = startEl?.closest?.('[data-hs-anchor]');
  // Selection must stay within one block (don't span across blocks).
  if (!el || !el.contains(range.endContainer)) return null;
  const full = blockText(el);
  const offset = rangeStartOffset(el, range);
  const spanOcc = occurrenceIndex(full, phrase, offset);
  return { el, anchor: el.getAttribute('data-hs-anchor'), phrase, spanOcc, rect: range.getBoundingClientRect() };
}

let popupEl = null;
function closeSuggestPopup() { if (popupEl) { popupEl.remove(); popupEl = null; } }

// Open the "suggest a change" popup.
//   - span mode (opts.span): rewrite/comment on just the highlighted phrase.
//   - block mode (default):  rewrite/comment on the whole block.
function openSuggestPopup(el, opts = {}) {
  closeSuggestPopup();
  const span = opts.span || null;
  const anchor = el.getAttribute('data-hs-anchor');
  const blockFull = blockText(el);
  const target = span ? span.phrase : blockFull.trim();
  const pop = document.createElement('div');
  pop.className = 'hs-suggest-pop';
  const scopeLabel = span
    ? `<div class="hs-sp-scope">on: “${target.slice(0, 90)}${target.length > 90 ? '…' : ''}”</div>`
    : '';
  pop.innerHTML = `
    <div class="hs-sp-tabs">
      <button data-kind="rewrite" class="active">Suggest rewrite</button>
      <button data-kind="comment">Comment</button>
    </div>
    ${scopeLabel}
    <textarea class="hs-sp-text" rows="4"></textarea>
    <div class="hs-sp-actions">
      <button class="hs-sp-cancel">Cancel</button>
      <button class="hs-sp-submit">Suggest</button>
    </div>`;
  const ta = pop.querySelector('.hs-sp-text');
  let kind = 'rewrite';
  const setKind = (k) => {
    kind = k;
    pop.querySelectorAll('.hs-sp-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.kind === k));
    if (k === 'rewrite') { ta.value = target; ta.placeholder = span ? 'Edit the highlighted phrase…' : 'Edit the text to propose a rewrite…'; }
    else { ta.value = ''; ta.placeholder = span ? 'Comment on the highlighted phrase…' : 'Leave a comment on this block…'; }
    ta.focus();
  };
  pop.querySelectorAll('.hs-sp-tabs button').forEach((b) => b.onclick = () => setKind(b.dataset.kind));
  pop.querySelector('.hs-sp-cancel').onclick = closeSuggestPopup;
  pop.querySelector('.hs-sp-submit').onclick = async () => {
    const body = ta.value.trim();
    if (!body) { ta.focus(); return; }
    await submitSuggestion({
      anchor,
      quote: target,
      body,
      kind,
      spanOcc: span ? span.spanOcc : -1,
      baseText: span ? blockFull : '',
    });
    closeSuggestPopup();
  };

  // Position near the block (block mode) or the selection (span mode).
  document.body.appendChild(pop);
  const r = span ? span.rect : el.getBoundingClientRect();
  pop.style.top = `${window.scrollY + r.bottom + 6}px`;
  pop.style.left = `${window.scrollX + Math.max(8, r.left)}px`;
  popupEl = pop;
  setKind('rewrite');
}

// Describe a non-text element for a comment card ("image", "chart", etc.).
function describeCommentTarget(el) {
  const tag = el.tagName.toLowerCase();
  if (el.hasAttribute('data-hs-asset-missing')) return 'missing image';
  if (tag === 'img' || tag === 'picture') return 'image' + (el.getAttribute('alt') ? ` (“${el.getAttribute('alt').slice(0, 40)}”)` : '');
  if (tag === 'svg' || tag === 'canvas') return 'chart / graphic';
  if (tag === 'hr') return 'divider';
  if (tag === 'video' || tag === 'audio') return tag;
  return tag;
}

// Open a comment-only popup for a NON-TEXT element (image, chart, divider…).
// No rewrite tab — you can't rewrite an image's text; you leave a note pinned
// to the element via its comment anchor.
function openCommentPopup(el) {
  closeSuggestPopup();
  const commentAnchor = el.getAttribute('data-hs-comment-anchor');
  const what = describeCommentTarget(el);
  const pop = document.createElement('div');
  pop.className = 'hs-suggest-pop';
  pop.innerHTML = `
    <div class="hs-sp-scope">Comment on this ${what}</div>
    <textarea class="hs-sp-text" rows="4" placeholder="Leave a comment on this ${what}…"></textarea>
    <div class="hs-sp-actions">
      <button class="hs-sp-cancel">Cancel</button>
      <button class="hs-sp-submit">Comment</button>
    </div>`;
  const ta = pop.querySelector('.hs-sp-text');
  pop.querySelector('.hs-sp-cancel').onclick = closeSuggestPopup;
  pop.querySelector('.hs-sp-submit').onclick = async () => {
    const body = ta.value.trim();
    if (!body) { ta.focus(); return; }
    await submitSuggestion({
      anchor: commentAnchor, quote: what, body, kind: 'comment', spanOcc: -1, baseText: '',
    });
    closeSuggestPopup();
  };
  document.body.appendChild(pop);
  const r = el.getBoundingClientRect();
  pop.style.top = `${window.scrollY + r.bottom + 6}px`;
  pop.style.left = `${window.scrollX + Math.max(8, r.left)}px`;
  popupEl = pop;
  ta.focus();
}

// Small floating "Suggest edit" toolbar that appears over a text selection in
// Suggesting mode (Google-Docs style). Clicking it opens the span popup.
let spanBarEl = null;
function closeSpanBar() { if (spanBarEl) { spanBarEl.remove(); spanBarEl = null; } }
function showSpanBar(span) {
  closeSpanBar();
  const bar = document.createElement('div');
  bar.className = 'hs-span-bar';
  bar.innerHTML = `<button class="hs-span-suggest">${icon('edit', { size: 14 })} Suggest edit</button>`;
  bar.querySelector('button').onmousedown = (e) => {
    // mousedown (not click) so we act before the selection is cleared.
    e.preventDefault();
    closeSpanBar();
    openSuggestPopup(span.el, { span });
  };
  document.body.appendChild(bar);
  const r = span.rect;
  bar.style.top = `${window.scrollY + Math.max(8, r.top) - 40}px`;
  bar.style.left = `${window.scrollX + r.left}px`;
  spanBarEl = bar;
}

async function submitSuggestion({ anchor, quote, body, kind, spanOcc = -1, baseText: bt = '' }) {
  setStatus('dirty', 'Sending suggestion…');
  try {
    const res = await fetch(`/api/suggest/${encodeURIComponent(docId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anchor, quote, body, kind, author: 'owner', spanOcc, baseText: bt }),
    });
    if (!res.ok) throw new Error();
    setStatus('saved', 'Suggestion added');
    await loadSuggestions();
    document.body.classList.add('hs-show-suggest');
  } catch {
    setStatus('error', 'Suggestion failed');
  }
}

async function loadSuggestions() {
  try {
    const res = await fetch(`/api/suggestions/${encodeURIComponent(docId)}`);
    const { suggestions: list } = await res.json();
    suggestions = list || [];
  } catch { /* keep last known */ }
  renderSuggestions();
  updateSuggestBadge();
}

function updateSuggestBadge() {
  const badge = $('#hs-suggest-count');
  if (badge) { badge.textContent = suggestions.length ? String(suggestions.length) : ''; badge.style.display = suggestions.length ? 'inline-block' : 'none'; }
}

function renderSuggestions() {
  const panel = $('#hs-suggestions');
  if (!panel) return;
  const head = '<h3>Suggestions</h3>';
  if (!suggestions.length) { panel.innerHTML = head + '<div class="hs-sg-empty">No open suggestions. In Suggesting mode, click a block to propose a change.</div>'; return; }
  panel.innerHTML = head + suggestions.map((s) => {
    const el = resolveAnchorEl(s.anchor);
    // quote/body are plain text here; renderDiffHtml re-escapes, and every other
    // interpolation below goes through escapeHtml — decoded text never hits
    // innerHTML raw (see the stored-XSS note on escapeHtml).
    const quote = decodeEntities(s.quote || '');
    const target = el ? quote : '(block not found — text changed)';
    const isRewrite = s.kind === 'rewrite';
    const isSpan = Number(s.span_occ) >= 0;
    const diff = isRewrite ? renderDiffHtml(diffWords(quote, decodeEntities(s.body))) : '';
    const scope = isSpan ? '<span class="hs-sg-span">phrase</span>' : '';
    return `
      <div class="hs-sg-card" data-sid="${s.id}">
        <div class="hs-sg-meta"><span class="hs-sg-kind ${s.kind}">${isRewrite ? 'Rewrite' : 'Comment'}</span> ${scope} <span class="hs-sg-author">${escapeHtml(s.author || 'reviewer')}</span></div>
        ${isRewrite
          ? `<div class="hs-sg-diff">${diff}</div>`
          : `<div class="hs-sg-quote">on: “${escapeHtml((target || '').slice(0, 80))}”</div><div class="hs-sg-body">${escapeHtml(decodeEntities(s.body))}</div>`}
        <div class="hs-sg-actions">
          ${isRewrite ? `<button class="hs-sg-accept">Accept</button>` : ''}
          <button class="hs-sg-reject">${isRewrite ? 'Reject' : 'Resolve'}</button>
          <button class="hs-sg-goto" title="Scroll to block">${icon('jump', { size: 15 })}</button>
        </div>
      </div>`;
  }).join('');
  // Wire card buttons.
  for (const card of panel.querySelectorAll('.hs-sg-card')) {
    const sid = card.getAttribute('data-sid');
    card.querySelector('.hs-sg-accept')?.addEventListener('click', () => resolveSuggestion(sid, 'accept'));
    card.querySelector('.hs-sg-reject')?.addEventListener('click', () => resolveSuggestion(sid, 'reject'));
    card.querySelector('.hs-sg-goto')?.addEventListener('click', () => {
      const s = suggestions.find((x) => x.id === sid);
      const el = s && resolveAnchorEl(s.anchor);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('hs-flash'); setTimeout(() => el.classList.remove('hs-flash'), 1200); }
    });
  }
}

async function resolveSuggestion(sid, action) {
  setStatus('dirty', action === 'accept' ? 'Accepting…' : 'Rejecting…');
  try {
    const res = await fetch(`/api/suggest/${encodeURIComponent(docId)}/${encodeURIComponent(sid)}/${action}`, { method: 'POST' });
    // A span-level accept whose phrase no longer exists (block edited since) is
    // marked stale server-side and NOT applied — surface that instead of failing.
    if (res.status === 409) {
      const err = await res.json().catch(() => ({}));
      if (err.error === 'span_stale') {
        setStatus('error', 'The highlighted phrase changed — suggestion is now stale, not applied.');
        await loadSuggestions();
        return;
      }
      throw new Error();
    }
    if (!res.ok) throw new Error();
    if (action === 'accept') {
      const { overlay } = await res.json();
      await boot(overlay);        // re-render with the accepted text applied
      loadVersions();
    }
    setStatus('saved', action === 'accept' ? 'Accepted' : 'Rejected');
    await loadSuggestions();
  } catch {
    setStatus('error', `Could not ${action}`);
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(loadSuggestions, 5000);
}

// --- interactive (sandboxed-iframe) render path ------------------------------
//
// An interactive doc (its own JS builds the page) can't be injected into our page
// DOM — that would run untrusted script at our origin. Instead we run it inside an
// <iframe sandbox="allow-scripts"> (opaque origin): the doc's JS runs but can't
// reach our cookies, APIs, or parent DOM. A trusted in-frame controller
// (frame-controller.js) makes the doc's ORIGINAL-markup text editable, marks
// JS-generated text read-only, and bridges edits back here via postMessage.

let frameControllerSrc = null; // cached controller source (fetched once)

async function getFrameControllerSrc() {
  if (frameControllerSrc != null) return frameControllerSrc;
  frameControllerSrc = await fetch('/frame-controller.js').then((r) => r.text());
  return frameControllerSrc;
}

// Build the srcdoc for the sandboxed frame: the doc's original HTML with our
// controller + its inputs inlined. We inline (not <script src>) so the opaque-
// origin frame is fully self-contained and needs nothing from our origin at runtime.
function buildSrcdoc(rawHtml, controllerSrc, id) {
  // JSON.stringify safely encodes the raw HTML + id as JS string literals for the
  // bootstrap globals the controller reads. </script> in the doc can't break out
  // of OUR injected <script> because it lives in string literals we control; but
  // to be safe against a literal `</script>` in rawHtml closing our tag, we escape
  // the sequence in the JSON we emit.
  const safe = (v) => JSON.stringify(v).replace(/<\/(script)/gi, '<\\/$1');
  const boot =
    `<script>window.__MMW_RAW__=${safe(rawHtml)};window.__MMW_DOC__=${safe(id)};</script>`;
  // Controller runs after the doc so the doc's own load handlers fire first.
  const controller = `<script>${controllerSrc}</script>`;
  // Prepend the bootstrap (globals must exist before the doc's scripts, harmless
  // there) and append the controller at end of body via string concat.
  return boot + String(rawHtml) + controller;
}

// Handle a message from the sandboxed frame. The frame runs untrusted JS next to
// our controller, so validate: it must come from OUR frame, be an object, and any
// edit must target an anchor the controller reported (no anchor-injection into a
// block we never surfaced).
function onFrameMessage(e) {
  if (!frame || e.source !== frame.contentWindow) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'ready') {
    frameAnchors = new Set(Array.isArray(m.anchors) ? m.anchors : []);
    // Remember each anchor's ORIGINAL rendered text so the download can source-patch
    // the compressed payload (find old text -> replace with the edit).
    frameOrigText = (m.origText && typeof m.origText === 'object') ? m.origText : {};
    // Push any existing overlay into the frame so saved edits show on load.
    if (currentOverlay) frame.contentWindow.postMessage({ type: 'applyOverlay', overlay: currentOverlay }, '*');
    frame.contentWindow.postMessage({ type: 'setMode', mode }, '*');
    setStatus('saved', 'Ready');
    return;
  }
  if (m.type === 'edit') {
    if (typeof m.anchor !== 'string' || !frameAnchors.has(m.anchor)) return; // reject unknown anchor
    if (typeof m.text !== 'string') return;
    frameEdit(m.anchor, m.text);
    return;
  }
  if (m.type === 'snapshot') {
    // Response to a serialize request. The string is UNTRUSTED (frame ran the doc's
    // JS); the resolver hands it to /api/snapshot for server-side sanitizing.
    if (typeof m.html === 'string' && snapshotResolve) { snapshotResolve(m.html); }
    return;
  }
}

// Ask the frame to serialize its live DOM; resolves with the (still untrusted) HTML.
let snapshotResolve = null;
function requestFrameSnapshot() {
  return new Promise((resolve, reject) => {
    if (!frame || !frame.contentWindow) return reject(new Error('no frame'));
    let done = false;
    snapshotResolve = (html) => { if (!done) { done = true; snapshotResolve = null; resolve(html); } };
    frame.contentWindow.postMessage({ type: 'serialize' }, '*');
    setTimeout(() => { if (!done) { done = true; snapshotResolve = null; reject(new Error('timeout')); } }, 8000);
  });
}

let currentOverlay = null; // last overlay fetched, so a late 'ready' can apply it

// Debounced save of a frame edit (mirrors scheduleSave, but text already in hand).
function frameEdit(anchor, text) {
  pending.set(anchor, text);
  setStatus('dirty', 'Editing…');
  if (saveTimers.has(anchor)) clearTimeout(saveTimers.get(anchor));
  saveTimers.set(anchor, setTimeout(() => saveBlock(anchor), 800));
}

// Render an interactive doc into a sandboxed iframe. Returns true on success.
async function bootInteractive(data) {
  interactive = true;
  currentOverlay = data.overlay || {};
  // Fetch the original bytes + controller in parallel.
  let raw, controllerSrc;
  try {
    [raw, controllerSrc] = await Promise.all([
      fetch(`/api/raw/${encodeURIComponent(docId)}`).then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then((j) => j.rawHtml),
      getFrameControllerSrc(),
    ]);
  } catch {
    root.innerHTML = '<div id="hs-empty">Failed to load interactive document.</div>';
    setStatus('error', 'Load failed');
    return false;
  }

  root.innerHTML = '';
  const f = document.createElement('iframe');
  // allow-scripts ONLY. NEVER add allow-same-origin (that would let the frame drop
  // its sandbox and reach our cookies/APIs). No popups/forms/downloads/top-nav.
  f.setAttribute('sandbox', 'allow-scripts');
  f.setAttribute('title', 'Reviewed document (sandboxed)');
  f.style.cssText = 'width:100%;height:calc(100vh - var(--hs-bar-h));border:0;display:block;background:#fff;';
  f.srcdoc = buildSrcdoc(raw, controllerSrc, docId);
  root.appendChild(f);
  frame = f;

  window.addEventListener('message', onFrameMessage);
  // Honest banner: interactive docs edit markup text only.
  warn('This document runs its own JavaScript, so it’s shown in a secure sandbox. '
    + 'You can edit text that’s part of the page; text the page generates with JavaScript is shown but not editable here. '
    + 'Download gives you the original interactive file with your text edits.');
  setStatus('', 'Rendering…');
  return true;
}

// (Re)render + anchor + apply a given overlay. Used on first load and after restore.
async function boot(overlayOverride) {
  let data;
  if (!overlayOverride) {
    const res = await fetch(`/api/doc/${encodeURIComponent(docId)}`);
    if (res.status === 404) { root.innerHTML = `<div id="hs-empty">Document <b>${escapeHtml(docId)}</b> not found.</div>`; setStatus('error', 'Not found'); return false; }
    if (!res.ok) { root.innerHTML = '<div id="hs-empty">Failed to load.</div>'; setStatus('error', 'Load failed'); return false; }
    data = await res.json();
  } else {
    // Need base html; fetch fresh but use the provided overlay.
    const res = await fetch(`/api/doc/${encodeURIComponent(docId)}`);
    data = await res.json();
    data.overlay = overlayOverride;
  }
  // Interactive (JS) doc -> sandboxed-iframe path (skips the inline pipeline).
  if (data.hasRaw) return bootInteractive(data);
  renderBaseHtml(data.baseHtml);
  // Apply block-grouping from per-doc config BEFORE anchoring, so grouped
  // containers are anchored as one unit. (Config lives in docs/<id>.config.json
  // so HTML formatters can't strip the marker.)
  applyGroupConfig(data.config);
  // Handle assets BEFORE anchoring: swap unresolved <img> for placeholders (so
  // they're never treated as editable text) and force-reveal JS-hidden content.
  // First, heal relative <img> to the copies we host under /docs/assets/ (uploaded
  // alongside the doc), so an image that IS on the server actually loads instead
  // of showing a placeholder. Only what's still missing after this is flagged.
  try {
    const avail = (await fetch('/api/assets').then((r) => r.json())).assets || [];
    healImageAssets(root, avail);
  } catch { /* non-fatal: fall through to placeholders for anything unresolved */ }
  const assetReport = resolveAssets(root, document);
  forceRevealContent(document);
  anchorMap = await assignAnchors(root);
  // Non-text elements (images, charts, dividers) get comment anchors so a
  // reviewer can comment on anything, not only editable text.
  commentMap = await assignCommentAnchors(root);
  // Capture original template text per anchor BEFORE applying edits, so version
  // diffs can show "original words -> edit" for the very first change to a block.
  baseText = new Map();
  for (const [anchor, el] of anchorMap) baseText.set(anchor, isGroup(el) ? readGroupText(el) : el.textContent);
  const stale = applyOverlay(data.overlay);
  setEditable(editMode);
  // Combine asset + stale + unreachable-text warnings into one banner line.
  const warnings = [];
  if (assetReport.count > 0) warnings.push(summarizeMissing(assetReport.missing));
  if (stale > 0) warnings.push(`${stale} saved edit(s) could not be re-anchored (the base template text changed) and were NOT applied, to avoid corrupting the layout.`);
  const unreachable = findUnreachableText(root);
  if (unreachable.length > 0) warnings.push(summarizeUnreachable(unreachable));
  warn(warnings.join('  •  '));
  // (Block count is asserted in tests, but not shown in the UI — it's noise for
  // the reviewer. See test/anchoring.test.mjs.)
  setStatus('saved', 'Ready');
  return true;
}

// Export the reviewed HTML: fetch the base + current overlay, apply the edits to
// a detached copy (same anchoring/grouping as the viewer), strip our internal
// data-hs-* attributes, and hand back a clean standalone file. This is the
// round-trip out — the reviewed document becomes a local file again (drop it in
// your repo, re-upload, whatever). Edits are applied; suggestions/comments are
// review-time metadata and are intentionally NOT baked into the exported file.
// Trigger a browser download of an HTML string.
function saveHtmlFile(out, suffix) {
  const blob = new Blob([out], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${docId}.${suffix}.html`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Static "edited snapshot" of an interactive doc: freeze the LIVE (post-JS) page
// with the reviewer's edits into inert HTML. The frame serializes its own DOM; the
// SERVER sanitizes it (stripActiveContent) so the downloaded file has no runnable
// JS. Not interactive by design — the JS is what made it interactive, and it's
// stripped so it can't re-render over your edits or execute on open.
async function downloadSnapshot() {
  setStatus('', 'Preparing snapshot…');
  try {
    const liveHtml = await requestFrameSnapshot();      // untrusted (frame ran doc JS)
    const res = await fetch(`/api/snapshot/${encodeURIComponent(docId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: liveHtml }),
    });
    if (!res.ok) throw new Error('snapshot failed');
    const { html } = await res.json();
    saveHtmlFile(html, 'snapshot');
    setStatus('saved', 'Ready');
  } catch {
    setStatus('error', 'Snapshot failed');
  }
}

// Interactive-doc dispatcher: two choices, since for a self-unpacking bundle you
// can't have both an interactive file AND baked-in edits at once.
async function downloadHtml() {
  const data0 = await fetch(`/api/doc/${encodeURIComponent(docId)}`).then((r) => r.ok ? r.json() : null).catch(() => null);
  if (data0 && data0.hasRaw) { openDownloadMenu(); return; }
  return downloadOriginal();
}

// Download the ORIGINAL file with edits applied — and still fully interactive.
// For interactive (self-unpacking) docs, the visible text is regenerated from
// gzip+base64 payload blobs on every open, so we source-patch those blobs: for each
// edit we swap the ORIGINAL rendered text (captured by the frame at load) for the
// new text inside the payload. The result runs exactly like the original and shows
// the edits. Static docs use the DOMParser rebuild path below.
async function downloadOriginal() {
  setStatus('', 'Preparing download…');
  let data;
  try {
    const res = await fetch(`/api/doc/${encodeURIComponent(docId)}`);
    if (!res.ok) throw new Error('fetch failed');
    data = await res.json();
  } catch {
    setStatus('error', 'Download failed');
    return;
  }

  // Interactive doc: source-patch the compressed payload so the edit survives the
  // doc's own JS re-render. Build {from,to} from the frame's original text + overlay.
  if (data.hasRaw) {
    const edits = [];
    for (const [anchor, entry] of Object.entries(data.overlay || {})) {
      const from = frameOrigText[anchor];
      if (typeof from !== 'string' || !from || !entry) continue;
      const to = decodeEntities(entry.text);
      if (to !== from) edits.push({ from, to });
    }
    try {
      const res = await fetch(`/api/patch-download/${encodeURIComponent(docId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits }),
      });
      if (!res.ok) throw new Error('patch failed');
      const out = await res.json();
      saveHtmlFile(out.html, 'reviewed');
      // Honest status: some edits may not have matched a payload string (e.g. text
      // the doc assembles from fragments). Those aren't in the interactive file.
      const missed = Array.isArray(out.unmatched) ? out.unmatched.length : 0;
      setStatus('saved', missed ? `Downloaded (${missed} edit(s) not in interactive file — use snapshot)` : 'Ready');
    } catch {
      setStatus('error', 'Download failed');
    }
    return;
  }

  // Static doc: parse the base HTML (full doc, so <head>/styles are preserved) and
  // apply overlay edits by anchor on a detached copy. (Interactive docs returned
  // above via source-patch.)
  const doc = new DOMParser().parseFromString(data.baseHtml, 'text/html');
  const body = doc.body;

  // Mirror load-time grouping so grouped passages get the same single anchor.
  for (const sel of (data.config?.groups || [])) {
    let matches; try { matches = body.querySelectorAll(sel); } catch { matches = []; }
    for (const el of matches) el.setAttribute(GROUP_ATTR, '');
  }
  const map = await assignAnchors(body);

  // Apply overlay text onto matching anchors (same rules as applyOverlay).
  for (const [anchor, entry] of Object.entries(data.overlay || {})) {
    const el = map.get(anchor);
    if (!el || !entry) continue;                 // stale edits are skipped, not misplaced
    const text = decodeEntities(entry.text);
    if (el.hasAttribute(GROUP_ATTR)) writeGroupText(el, text);
    else el.textContent = text;
  }

  // Strip every internal attribute we added so the file is clean.
  for (const el of body.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('data-hs-')) el.removeAttribute(attr.name);
    }
  }

  const out = '<!doctype html>\n' + doc.documentElement.outerHTML;
  saveHtmlFile(out, 'reviewed');
  setStatus('saved', 'Ready');
}

// Two-choice download menu for interactive docs. A self-unpacking bundle can't be
// both interactive AND carry baked-in edits (its JS regenerates text on open), so
// the reviewer picks per download.
let dlMenuEl = null;
function closeDownloadMenu() { if (dlMenuEl) { dlMenuEl.remove(); dlMenuEl = null; } }
function openDownloadMenu() {
  closeDownloadMenu();
  const btn = $('#hs-download-btn');
  const menu = document.createElement('div');
  menu.id = 'hs-dl-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML =
    '<button data-dl="original" role="menuitem">'
    + '<b>Interactive + edits</b><span>The fully working file with your text edits patched into it. Best of both — opens and behaves like the original, showing your changes.</span></button>'
    + '<button data-dl="snapshot" role="menuitem">'
    + '<b>Edited snapshot (static)</b><span>A frozen page with every edit baked in. No JavaScript — not interactive, but guaranteed to match exactly what you see.</span></button>';
  const r = btn.getBoundingClientRect();
  menu.style.cssText =
    'position:fixed;top:' + Math.round(r.bottom + 4) + 'px;right:' + Math.round(window.innerWidth - r.right)
    + 'px;z-index:1000;background:#fff;border:1px solid #ccc;border-radius:8px;'
    + 'box-shadow:0 4px 16px rgba(0,0,0,0.18);width:300px;overflow:hidden;';
  for (const b of menu.querySelectorAll('button')) {
    b.style.cssText = 'display:block;width:100%;text-align:left;border:0;border-bottom:1px solid #eee;'
      + 'background:#fff;padding:10px 12px;cursor:pointer;font:inherit;';
    b.querySelector('b').style.cssText = 'display:block;font-size:13px;color:#111;';
    b.querySelector('span').style.cssText = 'display:block;font-size:11.5px;color:#666;margin-top:2px;line-height:1.35;';
    b.addEventListener('mouseenter', () => { b.style.background = '#f5f5f5'; });
    b.addEventListener('mouseleave', () => { b.style.background = '#fff'; });
  }
  menu.addEventListener('click', (e) => {
    const choice = e.target.closest('button')?.getAttribute('data-dl');
    if (!choice) return;
    closeDownloadMenu();
    if (choice === 'original') downloadOriginal();
    else if (choice === 'snapshot') downloadSnapshot();
  });
  document.body.appendChild(menu);
  dlMenuEl = menu;
}

async function main() {
  docId = getDocId();
  if (!docId) { root.innerHTML = '<div id="hs-empty">No document. Use <code>?doc=&lt;id&gt;</code>.</div>'; setStatus('error', 'No doc'); return; }
  $('#hs-docname').textContent = docId;
  setStatus('', 'Loading…');

  const ok = await boot();
  if (!ok) return;
  wireEditing();

  // Paint the toolbar icons (vendored inline SVG; see icons.js).
  $('#hs-suggest-ic').innerHTML = icon('message', { size: 15 });
  $('#hs-history-ic').innerHTML = icon('clock', { size: 15 });
  $('#hs-download-ic').innerHTML = icon('download', { size: 15 });
  const modeIcon = $('#hs-mode-icon');
  const paintModeIcon = () => { modeIcon.innerHTML = icon(mode === 'suggest' ? 'message' : 'pencil', { size: 15 }); };

  // Mode selector (Editing / Suggesting), like Google Docs.
  const modeSel = $('#hs-mode');
  mode = modeSel.value || 'edit';
  applyMode();
  paintModeIcon();
  modeSel.addEventListener('change', () => {
    mode = modeSel.value;
    applyMode();
    paintModeIcon();
    if (mode === 'suggest') { document.body.classList.add('hs-show-suggest'); loadSuggestions(); }
  });

  $('#hs-history-btn').addEventListener('click', () => {
    document.body.classList.toggle('hs-show-history');
    if (document.body.classList.contains('hs-show-history')) loadVersions();
  });
  $('#hs-suggest-btn').addEventListener('click', () => {
    document.body.classList.toggle('hs-show-suggest');
    if (document.body.classList.contains('hs-show-suggest')) loadSuggestions();
  });
  $('#hs-download-btn').addEventListener('click', downloadHtml);

  // Dismiss the suggest popup / span bar / download menu on outside click / Escape.
  document.addEventListener('click', (e) => {
    if (dlMenuEl && !dlMenuEl.contains(e.target) && !e.target.closest('#hs-download-btn')) closeDownloadMenu();
    if (popupEl && !popupEl.contains(e.target) && !e.target.closest('[data-hs-anchor]')) closeSuggestPopup();
    if (spanBarEl && !spanBarEl.contains(e.target)) closeSpanBar();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSuggestPopup(); closeSpanBar(); closeDownloadMenu(); } });

  // Load suggestions once + poll (so accepted/new suggestions appear "live enough").
  await loadSuggestions();
  startPolling();
}

main();
