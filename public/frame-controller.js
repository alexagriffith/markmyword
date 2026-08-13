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
  // Tags that never hold editable prose. NOTE: unlike anchoring.js this list does
  // NOT include 'button' — in the in-frame hybrid editor a button's LABEL is visible
  // text the reviewer expects to edit (e.g. "Try in Playground"). We still skip form
  // controls that hold VALUE not child text (input/textarea/select) and non-text
  // embeds (svg/img/canvas/media).
  var SKIP_TAGS = new Set([
    'script','style','svg','canvas','img','br','hr','input','textarea','select',
    'iframe','object','embed','video','audio','head','meta','link','title',
  ]);

  function normalizeText(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  // SHA-256 hex — ALWAYS the pure-JS implementation below. We deliberately do NOT
  // use crypto.subtle here, for two reasons:
  //
  //  1. It isn't available. This runs in a sandbox="allow-scripts" iframe, whose
  //     origin is OPAQUE. Browsers only expose crypto.subtle in a *secure context*,
  //     and an opaque-origin frame is not one unless created with allow-same-origin
  //     — which we forbid (it would let hostile doc JS reach our cookies/APIs). So
  //     crypto.subtle.digest was undefined and threw, killing anchoring and leaving
  //     NO text editable (the "can't edit anything" bug).
  //  2. Even if some future browser DID expose crypto.subtle in this frame, we must
  //     not trust it. The doc's OWN untrusted JS shares this realm and runs before
  //     boot(); it could monkeypatch crypto.subtle.digest to return bogus hashes,
  //     making our anchors diverge from the parent's (edits misapply / rebind to the
  //     wrong block on download). Using our own vetted SHA-256 removes that surface
  //     entirely. (The parent's anchoring.js, running on our trusted origin, may
  //     prefer WebCrypto — this hardening is specific to the untrusted frame.)
  //
  // The pure-JS impl produces hashes identical to WebCrypto (verified against it in
  // test/sha256-fallback.test.mjs), so frame anchors still match the parent's.
  async function sha256hex(s) {
    return sha256hexJS(new TextEncoder().encode(s));
  }

  // Pure-JS SHA-256 (FIPS 180-4) over a Uint8Array -> lowercase hex. Must match
  // WebCrypto byte-for-byte (verified in test/sha256-fallback.test.mjs); a weaker
  // hash would collide and land edits on the wrong block.
  var SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  function sha256hexJS(bytes) {
    var K = SHA256_K;
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var bitLen = bytes.length * 8;
    var withOne = bytes.length + 1;
    var total = withOne + ((56 - (withOne % 64) + 64) % 64) + 8;
    var msg = new Uint8Array(total);
    msg.set(bytes);
    msg[bytes.length] = 0x80;
    var hi = Math.floor(bitLen / 0x100000000);
    var lo = bitLen >>> 0;
    msg[total - 8] = (hi >>> 24) & 0xff; msg[total - 7] = (hi >>> 16) & 0xff;
    msg[total - 6] = (hi >>> 8) & 0xff;  msg[total - 5] = hi & 0xff;
    msg[total - 4] = (lo >>> 24) & 0xff; msg[total - 3] = (lo >>> 16) & 0xff;
    msg[total - 2] = (lo >>> 8) & 0xff;  msg[total - 1] = lo & 0xff;
    var w = new Uint32Array(64);
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (var off = 0; off < total; off += 64) {
      for (var i = 0; i < 16; i++) {
        var j = off + i * 4;
        w[i] = (msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3];
      }
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    function hex(x) { return (x >>> 0).toString(16).padStart(8, '0'); }
    return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
  }

  function hasDirectText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.textContent.trim() !== '') return true;
    }
    return false;
  }

  // Does this element (or any descendant) qualify as an editable text unit? Used to
  // pick the INNERMOST text holder: a <div> that only wraps a <span> of text is not
  // itself the unit — the <span> is.
  function containsEditableUnit(el) {
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue;
      if (isEditableLeaf(child) || containsEditableUnit(child)) return true;
    }
    return false;
  }

  // An editable text unit: ANY element (block OR inline — span, a, button, td, li,
  // p, h1…) that has its OWN direct visible text and contains no nested element that
  // is itself an editable unit. This is deliberately BROADER than anchoring.js's
  // block-only rule: standalone/JS-built docs (like the AI Hub overview) render
  // almost all their visible text inside inline <span>/<a>/<button> nodes, so a
  // block-only rule leaves ~90% of the page uneditable. Anchoring is still by
  // content hash of the element's normalized text, so edits bind to the right run.
  function isEditableLeaf(el) {
    var tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return false;
    if (!hasDirectText(el)) return false;      // no text of its own -> it's a wrapper
    if (containsEditableUnit(el)) return false; // a descendant owns the text instead
    return true;
  }

  // Some docs put loose text DIRECTLY inside a wrapper that ALSO has element
  // children — e.g. <div>Provided by · Red Hat AI Validated Models<a>zai-org</a></div>.
  // The wrapper isn't an editable unit (its child <a> owns text), so that loose
  // "Provided by …" run would be orphaned and uneditable. Wrap each such loose text
  // node in <span data-hs-straytext> so it becomes its own innermost text unit,
  // WITHOUT swallowing the sibling elements. Idempotent: skips nodes already wrapped.
  function wrapStrayText(container) {
    // Snapshot candidates first (we mutate the tree as we go).
    var wrappers = [];
    var all = container.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
      if (el.children.length === 0) continue;         // pure leaf: handled normally
      if (!hasDirectText(el)) continue;               // no loose text of its own
      if (el.hasAttribute('data-hs-straytext')) continue;
      wrappers.push(el);
    }
    for (var w = 0; w < wrappers.length; w++) {
      var parent = wrappers[w];
      var kids = Array.prototype.slice.call(parent.childNodes);
      for (var k = 0; k < kids.length; k++) {
        var n = kids[k];
        if (n.nodeType !== 3) continue;               // element/comment: leave
        if (n.textContent.trim() === '') continue;    // whitespace-only: leave
        var span = document.createElement('span');
        span.setAttribute('data-hs-straytext', '1');
        parent.replaceChild(span, n);
        span.appendChild(n);
      }
    }
  }

  // Collect innermost text-bearing elements anywhere under container, in document
  // order. querySelectorAll('*') then filter keeps document order and dedupes.
  function collectLeaves(container) {
    wrapStrayText(container);
    var out = [];
    var all = container.querySelectorAll('*');
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
    blockFrameNavigation();
  }

  // Standalone docs often carry top-nav links to COMPANION files that were never
  // uploaded (e.g. <a href="AI Hub Catalog.dc.html">) or dead <a href="#"> stubs.
  // Clicking one would navigate THIS frame to that URL. Because the frame is an
  // opaque-origin srcdoc, a relative href resolves against OUR origin and loads the
  // markmyword app INSIDE the frame — the confusing "duplicate bar + Loading
  // document…" the user saw. The other views simply aren't in this file, so there's
  // nothing to show; the honest behavior is to not navigate at all. We intercept in
  // the CAPTURE phase (before the doc's own handlers) and cancel any click on an <a>
  // that would leave the current srcdoc document. Same-document fragment links
  // (href="#id") and links the doc drives purely via JS are left untouched.
  function blockFrameNavigation() {
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      var raw = a.getAttribute('href') || '';
      // Pure in-page fragment or JS-scheme handler: let the doc do its thing.
      if (raw === '' || raw.charAt(0) === '#' || /^javascript:/i.test(raw)) return;
      var here, dest;
      try { here = document.location.href; dest = a.href; } catch (_) { return; }
      // Same document + only a fragment differs -> in-page anchor, allow it.
      var stripHash = function (u) { var i = u.indexOf('#'); return i === -1 ? u : u.slice(0, i); };
      if (stripHash(dest) === stripHash(here)) return;
      // Anything else navigates the frame away from the doc -> block it. There's no
      // companion view bundled here, so navigating only loads a phantom page.
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'navBlocked', href: raw });
    }, true); // capture: run before the doc's own click handlers
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
  function applyModeToAll(editing) {
    anchorMap.forEach(function (el) {
      if (editing) { el.setAttribute('contenteditable', 'true'); el.spellcheck = true; }
      else { el.removeAttribute('contenteditable'); el.spellcheck = false; }
    });
  }
  // 'edit' -> all text contenteditable (clicks on links/buttons are intercepted for
  // caret placement, so the doc's controls are inert while editing — expected).
  // Anything else ('use'/'view'/'suggest') -> NOT editable, so the doc's OWN links,
  // tabs and buttons work normally. 'use' is the viewer's "make it interactive" mode.
  function setMode(mode) {
    currentMode = mode === 'edit' ? 'edit' : 'view';
    applyModeToAll(currentMode === 'edit');
  }

  // ---- boot / rescan ----------------------------------------------------------
  var origSet = new Set();     // anchors present in the ORIGINAL markup bytes
  var origText = {};           // anchor -> original rendered text (for source-patch)
  var currentMode = 'edit';    // last mode the parent asked for
  var scanning = false;        // re-entrancy guard while (re)anchoring
  var rescanPending = false;   // a mutation arrived mid-scan; scan again after

  // Anchor everything currently in the live DOM and make it editable. Runs on boot
  // AND after the doc's own JS mutates the DOM (e.g. a tab/section is clicked and
  // new content is injected) — so text that only appears after interaction becomes
  // editable too. Idempotent: elements already anchored keep their anchor; only
  // newly-appeared runs are added. Posts an updated 'ready' with the full anchor set.
  async function scan(isBoot) {
    if (scanning) { rescanPending = true; return; }
    scanning = true;
    stopObserving(); // our own anchoring mutations (stray spans) must not re-trigger us
    try {
      var liveMap = await assignAnchors(document.body);
      // assignAnchors already set data-hs-anchor on every current leaf. Mark any that
      // aren't tracked yet as editable (respecting the current mode); refresh origText
      // for genuinely new anchors only (don't clobber a run the user is editing).
      liveMap.forEach(function (el, anchor) {
        var known = anchorMap.get(anchor);
        if (known !== el) {
          // New anchor, OR the doc's JS replaced the node for an existing anchor
          // (e.g. a tab re-injected the same content). Either way, (re)apply the
          // editable attributes to the CURRENT live element and track it. Only set
          // origText the first time we ever see an anchor, so re-showing a tab never
          // clobbers the original text we owe the download source-patch.
          markEditable(el, anchor, !origSet.has(anchor));
          if (!(anchor in origText)) origText[anchor] = el.textContent;
          if (currentMode !== 'edit') { el.removeAttribute('contenteditable'); el.spellcheck = false; }
        }
      });
      // Honor the mode: if we're not in edit mode, don't leave new nodes editable.
      if (currentMode !== 'edit') applyModeToAll(false);
      post({
        type: 'ready',
        anchors: Array.from(anchorMap.keys()),
        generated: Array.from(generated),
        origText: origText,
      });
    } finally {
      startObserving(); // resume watching for the doc's OWN future mutations
      scanning = false;
      if (rescanPending) { rescanPending = false; scan(false); }
    }
  }

  async function boot() {
    var raw = window.__MMW_RAW__ || '';
    try { origSet = await originalAnchorSet(raw); }
    catch (_) { origSet = new Set(); }

    anchorMap = new Map();
    generated = new Set();
    origText = {};
    wireEditing();
    await scan(true);
    observeMutations();
  }

  // Re-anchor when the doc's JS changes the DOM (tab clicks, lazy sections, etc.).
  // Debounced: a burst of mutations (a tab swapping many nodes) triggers ONE rescan.
  // We only react to added element subtrees, not to our own attribute writes.
  var mutationTimer = null;
  var domObserver = null;
  function startObserving() {
    if (!domObserver) return;
    domObserver.observe(document.body, { childList: true, subtree: true });
  }
  function stopObserving() {
    if (!domObserver) return;
    // Drain any queued records so re-connecting doesn't immediately re-fire on the
    // mutations WE just made (wrapStrayText spans, markEditable was attrs-only).
    domObserver.takeRecords();
    domObserver.disconnect();
  }
  function observeMutations() {
    domObserver = new MutationObserver(function (records) {
      var meaningful = false;
      for (var i = 0; i < records.length; i++) {
        if (records[i].type === 'childList' && records[i].addedNodes.length) { meaningful = true; break; }
      }
      if (!meaningful) return;
      if (mutationTimer) clearTimeout(mutationTimer);
      mutationTimer = setTimeout(function () { mutationTimer = null; scan(false); }, 200);
    });
    startObserving();
  }

  // The doc's own scripts may still be building the DOM. Give the load event (and
  // a short settle) a chance so anchoring sees the rendered content.
  if (document.readyState === 'complete') {
    setTimeout(boot, 300);
  } else {
    window.addEventListener('load', function () { setTimeout(boot, 300); });
  }
})();
