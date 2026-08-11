// Landing / upload page. Lists existing deliverables (GET /api/docs) and lets the
// author add one — pick a file or paste HTML — via POST /api/upload, then opens
// the viewer on it. No build step; plain module + fetch.
import { icon } from './icons.js';

const $ = (s) => document.querySelector(s);

// ---- static icons ----
$('#file-ic').innerHTML = icon('document', { size: 18 });
$('#up-ic').innerHTML = icon('upload', { size: 15 });

// ---- list existing docs ----
async function loadDocs() {
  const grid = $('#doc-grid');
  let docs = [];
  try {
    docs = (await fetch('/api/docs').then((r) => r.json())).docs || [];
  } catch {
    grid.innerHTML = '<div class="doc-empty">Could not load documents.</div>';
    return;
  }
  if (!docs.length) {
    grid.innerHTML = '<div class="doc-empty">No deliverables yet — add one below.</div>';
    return;
  }
  grid.innerHTML = '';
  for (const id of docs) {
    const a = document.createElement('a');
    a.className = 'doc-card';
    a.href = `/viewer.html?doc=${encodeURIComponent(id)}`;
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.innerHTML = icon('document', { size: 20 });
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = id; // textContent — never trust the filename into innerHTML
    a.append(ic, name);
    grid.appendChild(a);
  }
}

// ---- upload ----
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
    showMsg('err', 'Enter a document id using only letters, numbers, dot, dash, or underscore.');
    return;
  }
  if (!html.trim()) { showMsg('err', 'Choose a file or paste some HTML first.'); return; }

  btn.disabled = true;
  try {
    const r = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, html, overwrite }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      const url = `/viewer.html?doc=${encodeURIComponent(id)}`;
      showMsg('ok', `Uploaded. <a href="${url}">Opening “${id}”…</a>`);
      window.location.href = url;
      return;
    }
    const errs = {
      invalid_doc_id: 'That id has characters that aren’t allowed.',
      empty_html: 'The HTML is empty.',
      not_html: 'That doesn’t look like HTML.',
      too_large: 'That file is too large (5 MB max).',
      doc_exists: 'A document with that id already exists. Tick “Overwrite” to replace it.',
      write_failed: 'Could not save the file on the server.',
    };
    showMsg('err', errs[data.error] || `Upload failed (${data.error || r.status}).`);
  } catch {
    showMsg('err', 'Network error — is the server running?');
  } finally {
    btn.disabled = false;
  }
});

loadDocs();
