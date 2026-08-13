// markmyword frame-controller — the TRUSTED agent that runs INSIDE the sandboxed
// iframe next to an interactive doc's own JavaScript.
//
// The iframe is sandbox="allow-scripts" (opaque origin): the doc's JS runs but
// can't reach our cookies, APIs, or parent DOM. This controller is OUR code; it:
//   • lets the reviewer edit text that exists in the doc's ORIGINAL markup
//     (including nested inline-styled spans like a "Validated by Red Hat" badge),
//   • marks text the doc's own JS GENERATES at runtime as read-only (editing it
//     is unreliable — the app re-renders and would wipe the edit — and it can't be
//     baked into a clean download), and
//   • bridges edits to the parent via postMessage.
//
// It is intentionally self-contained (no imports): an opaque-origin frame can't
// module-import from our origin. The anchoring below MUST stay byte-for-byte
// compatible with public/anchoring.js so an anchor computed here matches the one
// the parent computes when it rebuilds the download from the original bytes.
//
// The parent hands us the doc's ORIGINAL html string on window.__MMW_RAW__ and a
// document id on window.__MMW_DOC__ before this script runs.
(function () {
  'use strict';

  var PARENT = window.parent;

  // ---- anchoring (mirror of public/anchoring.js; keep in sync) ----------------
  var BLOCK_TAGS = new Set([
    'p','h1','h2','h3','h4','h5','h6','li','blockquote','pre','figcaption',
    'td','th','div','caption','summary','dd','dt',
  ]);
  var SKIP_TAGS = new Set([
    'script','style','svg','canvas','img','br','hr','input','textarea','select',
    'button','iframe','object','embed','video','audio','head','meta','link','title',
  ]);

  function normalizeText(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  // SHA-256 hex via WebCrypto. Available here: a sandboxed iframe on an HTTPS
  // parent is a secure context, so crypto.subtle exists. (Same impl as the parent.)
  async function sha256hex(s) {
    var data = new TextEncoder().encode(s);
    var buf = await crypto.subtle.digest('SHA-256', data);
    return Array.prototype.map.call(new Uint8Array(buf),
      function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function hasDirectText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.textContent.trim() !== '') return true;
    }
    return false;
  }
  function containsBlockCandidate(el) {
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      var tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (BLOCK_TAGS.has(tag) && (hasDirectText(child) || containsBlockCandidate(child))) return true;
      if (containsBlockCandidate(child)) return true;
    }
    return false;
  }
  // Same rule as anchoring.js isEditableLeaf: a BLOCK_TAG leaf with direct text and
  // no nested block. This is what the parent's download rebuild anchors, so the
  // anchor sets line up. (Editing nested inline badges is handled separately via
  // designMode-style broadening WITHOUT changing anchors — see below.)
  function isEditableLeaf(el) {
    var tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag) || !BLOCK_TAGS.has(tag)) return false;
    if (!hasDirectText(el)) return false;
    if (containsBlockCandidate(el)) return false;
    return true;
  }
  function collectLeaves(container) {
    var out = [];
    var all = container.querySelectorAll(Array.from(BLOCK_TAGS).join(','));
    for (var i = 0; i < all.length; i++) {
      if (isEditableLeaf(all[i])) out.push(all[i]);
    }
    return out;
  }
  // Assign content-hash anchors to editable leaves under container. Returns a Map
  // anchor->element and sets data-hs-anchor. Occurrence-suffixed on repeats.
  async function assignAnchors(container) {
    var leaves = collectLeaves(container);
    var seen = new Map();
    var map = new Map();
    for (var i = 0; i < leaves.length; i++) {
      var el = leaves[i];
      var norm = normalizeText(el.textContent);
      if (!norm) continue;
      var base = await sha256hex(norm);
      var occ = seen.has(base) ? seen.get(base) + 1 : 0;
      seen.set(base, occ);
      var anchor = occ === 0 ? base : base + '#' + occ;
      el.setAttribute('data-hs-anchor', anchor);
      map.set(anchor, el);
    }
    return map;
  }

  // ---- original-markup anchor set ---------------------------------------------
  // Parse the ORIGINAL html (no scripts run in DOMParser) to learn which anchors
  // belong to real markup text. After the doc's JS runs, any anchored element in
  // the LIVE dom whose anchor is in this set is editable; anything else is
  // JS-generated -> read-only.
  async function originalAnchorSet(rawHtml) {
    var doc = new DOMParser().parseFromString(String(rawHtml || ''), 'text/html');
    var map = await assignAnchors(doc.body); // sets attrs on the detached copy only
    return new Set(map.keys());
  }

  // ---- editability ------------------------------------------------------------
  // ALL anchored live text is editable (hybrid model). We still distinguish two
  // classes so downloads behave correctly:
  //   • markup anchors (present in the ORIGINAL bytes) — edits persist to the
  //     overlay AND bake into the "original interactive" download (rebuilt from raw).
  //   • generated anchors (produced by the doc's own JS) — edits persist to the
  //     overlay and show in the "edited snapshot (static)" download, but are absent
  //     from the original-download rebuild (those anchors don't exist in raw bytes),
  //     so they can't be silently mis-applied there.
  var anchorMap = new Map();     // live anchor -> element (all editable)
  var generated = new Set();     // anchors that are JS-generated (snapshot-only)
  var docId = window.__MMW_DOC__ || null;

  function markEditable(el, anchor, isGenerated) {
    el.setAttribute('data-hs-anchor', anchor);
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('data-hs-editable', '1');
    if (isGenerated) { el.setAttribute('data-hs-generated', '1'); generated.add(anchor); }
    el.spellcheck = true;
    anchorMap.set(anchor, el);
  }

  function wireEditing() {
    document.addEventListener('input', function (e) {
      var el = e.target && e.target.closest && e.target.closest('[data-hs-editable]');
      if (!el) return;
      var anchor = el.getAttribute('data-hs-anchor');
      post({ type: 'edit', anchor: anchor, text: el.textContent });
    });
  }

  // Serialize the LIVE (post-JS) DOM for the static snapshot download. We return raw
  // outerHTML — it may contain the doc's own <script> and whatever its JS injected —
  // because the PARENT does not trust this string: it POSTs it to /api/snapshot,
  // which runs the same stripActiveContent used on upload before download. We only
  // remove OUR bookkeeping so it doesn't leak into the file the user keeps.
  function serialize() {
    var clone = document.documentElement.cloneNode(true);
    var marked = clone.querySelectorAll('[data-hs-anchor],[data-hs-editable],[data-hs-generated],[data-hs-edited],[contenteditable],[spellcheck]');
    for (var i = 0; i < marked.length; i++) {
      var el = marked[i];
      el.removeAttribute('data-hs-anchor');
      el.removeAttribute('data-hs-editable');
      el.removeAttribute('data-hs-generated');
      el.removeAttribute('data-hs-edited');
      el.removeAttribute('contenteditable');
      el.removeAttribute('spellcheck');
    }
    return '<!doctype html>\n' + clone.outerHTML;
  }

  // ---- postMessage bridge -----------------------------------------------------
  function post(msg) {
    try { PARENT.postMessage(msg, '*'); } catch (_) { /* parent gone */ }
  }

  // Parent -> frame. We only accept messages from our embedder.
  window.addEventListener('message', function (e) {
    if (e.source !== PARENT) return;
    var m = e.data || {};
    if (m.type === 'applyOverlay') { applyOverlay(m.overlay || {}); }
    else if (m.type === 'setMode') { setMode(m.mode); }
    else if (m.type === 'serialize') { post({ type: 'snapshot', html: serialize() }); }
  });

  function applyOverlay(overlay) {
    var keys = Object.keys(overlay);
    for (var i = 0; i < keys.length; i++) {
      var el = anchorMap.get(keys[i]);
      var entry = overlay[keys[i]];
      if (!el || !entry) continue;
      // Overlay text is HTML-escaped at rest; decode to plain text for textContent.
      el.textContent = decodeEntities(entry.text);
      el.setAttribute('data-hs-edited', '1');
    }
  }
  function decodeEntities(escaped) {
    var t = document.createElement('textarea');
    t.innerHTML = String(escaped == null ? '' : escaped);
    return t.value;
  }
  function setMode(mode) {
    var editing = mode === 'edit';
    anchorMap.forEach(function (el) {
      if (editing) { el.setAttribute('contenteditable', 'true'); el.spellcheck = true; }
      else { el.removeAttribute('contenteditable'); el.spellcheck = false; }
    });
  }

  // ---- boot -------------------------------------------------------------------
  async function boot() {
    var raw = window.__MMW_RAW__ || '';
    var origSet;
    try { origSet = await originalAnchorSet(raw); }
    catch (_) { origSet = new Set(); }

    // Anchor the LIVE document (after the doc's own JS has built it) and split into
    // editable (in original markup) vs generated (JS-produced).
    var liveMap = await assignAnchors(document.body);
    anchorMap = new Map();
    generated = new Set();
    liveMap.forEach(function (el, anchor) {
      // All rendered text is editable; anchors NOT in the original markup are flagged
      // generated (snapshot-only) so downloads can treat them correctly.
      markEditable(el, anchor, !origSet.has(anchor));
    });

    wireEditing();
    post({
      type: 'ready',
      anchors: Array.from(anchorMap.keys()),
      generated: Array.from(generated),
    });
  }

  // The doc's own scripts may still be building the DOM. Give the load event (and
  // a short settle) a chance so anchoring sees the rendered content.
  if (document.readyState === 'complete') {
    setTimeout(boot, 300);
  } else {
    window.addEventListener('load', function () { setTimeout(boot, 300); });
  }
})();
