// Landing / add page. Lists existing files (GET /api/docs) and lets the author
// add one — pick a file or paste HTML — via POST /api/upload, then opens the
// viewer on it. No build step; plain module + fetch.
import { icon } from './icons.js';

const $ = (s) => document.querySelector(s);

// The owner presents ?key=… once; we keep it in the URL as we navigate so the
// tab stays "owner". (The server also sets a cookie, so the key mainly matters
// on first arrival / when sharing an owner link.)
const KEY = new URLSearchParams(location.search).get('key');
const withKey = (url) => (KEY ? url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY) : url);
const viewerUrl = (id) => withKey(`/viewer.html?doc=${encodeURIComponent(id)}`);

// ---- static icons ----
$('#file-ic').innerHTML = icon('document', { size: 18 });
$('#up-ic').innerHTML = icon('upload', { size: 15 });

let whoami = { isOwner: false, docLimit: 1 };

// ---- list existing docs ----
async function loadDocs() {
  const grid = $('#doc-grid');
  try {
    whoami = await fetch('/api/whoami').then((r) => r.json());
  } catch { /* non-fatal; treat as guest */ }

  let docs = [];
  try {
    docs = (await fetch('/api/docs').then((r) => r.json())).docs || [];
  } catch {
    grid.innerHTML = '<div class="doc-empty">Could not load files.</div>';
    return;
  }
  if (!docs.length) {
    grid.innerHTML = '<div class="doc-empty">No files yet — add one below.</div>';
    return;
  }
  grid.innerHTML = '';
  for (const id of docs) {
    const card = document.createElement('div');
    card.className = 'doc-card';

    const a = document.createElement('a');
    a.className = 'doc-open';
    a.href = viewerUrl(id);
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.innerHTML = icon('document', { size: 20 });
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = id; // textContent — never trust the filename into innerHTML
    a.append(ic, name);
    card.appendChild(a);

    // Delete affordance: the server authorizes (owner, or the guest who created
    // it), so we always show it and let a 403 explain if it isn't allowed.
    const del = document.createElement('button');
    del.className = 'doc-del';
    del.title = 'Delete this file';
    del.setAttribute('aria-label', `Delete ${id}`);
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.preventDefault(); deleteDoc(id); });
    card.appendChild(del);

    grid.appendChild(card);
  }
}

async function deleteDoc(id) {
  if (!confirm(`Delete “${id}”? This removes the file and all its review history.`)) return;
  try {
    const r = await fetch(withKey(`/api/doc/${encodeURIComponent(id)}`), { method: 'DELETE' });
    const data = await r.json().catch(() => ({}));
    if (r.ok) { loadDocs(); return; }
    const errs = {
      not_your_doc: 'That file belongs to someone else — you can’t delete it.',
      doc_not_found: 'That file no longer exists.',
      rate_limited: 'You’re doing that too fast — try again in a moment.',
    };
    showMsg('err', errs[data.error] || `Could not delete (${data.error || r.status}).`);
  } catch {
    showMsg('err', 'Network error — is the server running?');
  }
}

// ---- add a file ----
const msg = $('#msg');
function showMsg(kind, html) { msg.className = `msg show ${kind}`; msg.innerHTML = html; }
function clearMsg() { msg.className = 'msg'; msg.innerHTML = ''; }

// File picker: read the file into the textarea and, if the id is empty, seed it
// from the filename stem.
const fileInput = $('#doc-file');
$('#filepick').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', async () => {
  const f = fileInput.files && fileInput.files[0];
  if (!f) return;
  $('#file-name').textContent = f.name;
  const text = await f.text();
  $('#doc-html').value = text;
  const idField = $('#doc-id');
  if (!idField.value.trim()) {
    const stem = f.name.replace(/\.html?$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    idField.value = stem;
  }
  clearMsg();
});

const btn = $('#upload-btn');
btn.addEventListener('click', async () => {
  clearMsg();
  const id = $('#doc-id').value.trim();
  const html = $('#doc-html').value;
  const overwrite = $('#doc-overwrite').checked;

  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    showMsg('err', 'Enter a name using only letters, numbers, dot, dash, or underscore.');
    return;
  }
  if (!html.trim()) { showMsg('err', 'Choose a file or paste some HTML first.'); return; }

  btn.disabled = true;
  try {
    const r = await fetch(withKey('/api/upload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, html, overwrite }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      const url = viewerUrl(id);
      showMsg('ok', `Added. <a href="${url}">Opening “${id}”…</a>`);
      window.location.href = url;
      return;
    }
    const mb = data.maxBytes ? (data.maxBytes / 1_000_000).toFixed(1).replace(/\.0$/, '') : '2';
    const errs = {
      invalid_doc_id: 'That name has characters that aren’t allowed.',
      empty_html: 'The HTML is empty.',
      not_html: 'That doesn’t look like HTML.',
      too_large: `That file is too large (${mb} MB max).`,
      doc_exists: 'A file with that name already exists. Tick “Overwrite” to replace it.',
      write_failed: 'Could not save the file on the server.',
      guest_doc_limit: `You can have ${whoami.docLimit || 1} file open at a time — delete your existing one first to add another.`,
      not_your_doc: 'A file with that name belongs to someone else.',
      capacity_full: 'The demo is at capacity right now — please try again later.',
      rate_limited: 'You’re doing that too fast — try again in a moment.',
    };
    showMsg('err', errs[data.error] || `Add failed (${data.error || r.status}).`);
  } catch {
    showMsg('err', 'Network error — is the server running?');
  } finally {
    btn.disabled = false;
  }
});

loadDocs();
