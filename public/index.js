// Landing / add page. Lists existing files (GET /api/docs) and lets you add one
// by dropping or choosing an .html file — the file's name becomes the id, so
// there's no name field. (A paste-HTML box hides behind a link for markup you
// don't have as a file.) On a name clash we offer Keep both / Replace / Cancel,
// like saving a file with an existing name on the desktop. No build step.
import { icon } from './icons.js';

const $ = (s) => document.querySelector(s);

// The owner presents ?key=… once; keep it in the URL as we navigate so the tab
// stays "owner". (The server also sets a cookie, so the key mainly matters on
// first arrival / when sharing an owner link.)
const KEY = new URLSearchParams(location.search).get('key');
const withKey = (url) => (KEY ? url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY) : url);
const viewerUrl = (id) => withKey(`/viewer.html?doc=${encodeURIComponent(id)}`);

// ---- static icons ----
$('#drop-ic').innerHTML = icon('upload', { size: 22 });
$('#paste-ic').innerHTML = icon('upload', { size: 15 });

let whoami = { isOwner: false, docLimit: 1 };
let docSet = new Set(); // current ids, for clash detection / auto-suffix

// ---- list existing docs ----
async function loadDocs() {
  const list = $('#docs');
  try {
    whoami = await fetch('/api/whoami').then((r) => r.json());
  } catch { /* non-fatal; treat as guest */ }

  let docs = [];
  try {
    docs = (await fetch('/api/docs').then((r) => r.json())).docs || [];
  } catch {
    list.innerHTML = '<li class="empty">Could not load files.</li>';
    return;
  }
  docSet = new Set(docs);
  if (!docs.length) {
    list.innerHTML = '<li class="empty">No files yet — add one below.</li>';
    return;
  }
  list.innerHTML = '';
  for (const id of docs) {
    const li = document.createElement('li');

    const a = document.createElement('a');
    a.className = 'doc-open';
    a.href = viewerUrl(id);
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.innerHTML = icon('document', { size: 19 });
    const name = document.createElement('span');
    name.textContent = id; // textContent — never trust the id into innerHTML
    a.append(ic, name);
    li.appendChild(a);

    // Delete affordance: the server authorizes (owner, or the guest who created
    // it), so we always show it and let a 403 explain if it isn't allowed.
    const del = document.createElement('button');
    del.className = 'doc-del';
    del.title = 'Delete this file';
    del.setAttribute('aria-label', `Delete ${id}`);
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.preventDefault(); deleteDoc(id); });
    li.appendChild(del);

    list.appendChild(li);
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

// ---- messages ----
const msg = $('#msg');
function showMsg(kind, html) { msg.className = `msg show ${kind}`; msg.innerHTML = html; }
function clearMsg() { msg.className = 'msg'; msg.innerHTML = ''; }

// Turn a filename (or typed name) into a valid id: strip .html, keep only the
// allowed charset, trim stray dashes.
function toId(raw) {
  return String(raw || '')
    .replace(/\.html?$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Given a desired id that already exists, find the next free "-2", "-3", … .
function nextFreeId(base) {
  let n = 2;
  while (docSet.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Core add. Resolves a name clash the desktop way: Keep both / Replace / Cancel.
async function addDoc(id, html) {
  clearMsg();
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    showMsg('err', 'That file needs a name using letters, numbers, dot, dash, or underscore.');
    return;
  }
  if (!html.trim()) { showMsg('err', 'That file looks empty.'); return; }

  let overwrite = false;
  if (docSet.has(id)) {
    const choice = await nameClash(id);
    if (choice === 'cancel') { clearMsg(); return; }
    if (choice === 'keep') { id = nextFreeId(id); }
    if (choice === 'replace') { overwrite = true; }
  }
  await upload(id, html, overwrite);
}

// A tiny modal: "“x” already exists." → Keep both / Replace / Cancel.
function nameClash(id) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;z-index:50;background:rgba(28,27,25,.28);display:flex;align-items:center;justify-content:center;padding:20px';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fffdf8;border:1px solid #e9e5db;border-radius:14px;box-shadow:0 16px 48px rgba(28,27,25,.18);max-width:400px;width:100%;padding:22px 22px 18px;font-family:-apple-system,Segoe UI,sans-serif';
    box.innerHTML = `
      <div style="font-family:'Iowan Old Style',Georgia,serif;font-size:18px;font-weight:600;margin-bottom:6px">“${id}” already exists</div>
      <div style="color:#57534e;font-size:14px;line-height:1.5;margin-bottom:18px">Keep both saves it as “<b>${nextFreeId(id)}</b>”. Replace overwrites the existing file and its review history.</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
        <button data-c="cancel" style="border:1px solid #e9e5db;background:none;border-radius:8px;padding:8px 14px;font-size:13.5px;cursor:pointer;color:#57534e">Cancel</button>
        <button data-c="keep" style="border:1px solid #1c1b19;background:none;border-radius:8px;padding:8px 14px;font-size:13.5px;font-weight:600;cursor:pointer;color:#1c1b19">Keep both</button>
        <button data-c="replace" style="border:1px solid #c0392b;background:#c0392b;color:#fff;border-radius:8px;padding:8px 14px;font-size:13.5px;font-weight:600;cursor:pointer">Replace</button>
      </div>`;
    back.appendChild(box);
    document.body.appendChild(back);
    const done = (c) => { back.remove(); resolve(c); };
    box.querySelectorAll('button').forEach((b) => (b.onclick = () => done(b.dataset.c)));
    back.addEventListener('click', (e) => { if (e.target === back) done('cancel'); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); done('cancel'); }
    });
    box.querySelector('[data-c="keep"]').focus();
  });
}

async function upload(id, html, overwrite) {
  showMsg('ok', `Adding “${id}”…`);
  try {
    const r = await fetch(withKey('/api/upload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, html, overwrite }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) { window.location.href = viewerUrl(id); return; }
    const mb = data.maxBytes ? (data.maxBytes / 1_000_000).toFixed(1).replace(/\.0$/, '') : '2';
    const errs = {
      invalid_doc_id: 'That name has characters that aren’t allowed.',
      empty_html: 'The HTML is empty.',
      not_html: 'That doesn’t look like HTML.',
      too_large: `That file is too large (${mb} MB max).`,
      doc_exists: 'A file with that name already exists.',
      write_failed: 'Could not save the file on the server.',
      guest_doc_limit: `You can have ${whoami.docLimit || 1} file open at a time — delete your existing one first to add another.`,
      not_your_doc: 'A file with that name belongs to someone else.',
      capacity_full: 'The demo is at capacity right now — please try again later.',
      rate_limited: 'You’re doing that too fast — try again in a moment.',
    };
    showMsg('err', errs[data.error] || `Add failed (${data.error || r.status}).`);
  } catch {
    showMsg('err', 'Network error — is the server running?');
  }
}

async function addFromFile(file) {
  if (!file) return;
  const id = toId(file.name);
  const html = await file.text();
  await addDoc(id, html);
}

// ---- drop zone: click, keyboard, and drag/drop ----
const drop = $('#drop');
const fileInput = $('#file');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => addFromFile(fileInput.files && fileInput.files[0]));

['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files && e.dataTransfer.files[0];
  if (f) addFromFile(f);
});

// ---- paste HTML (behind the link) ----
$('#paste-toggle').addEventListener('click', () => {
  const p = $('#paste');
  const open = p.classList.toggle('show');
  $('#paste-toggle').textContent = open ? 'hide paste box' : 'or paste HTML instead';
  if (open) $('#paste-html').focus();
});
$('#paste-btn').addEventListener('click', async () => {
  const html = $('#paste-html').value;
  const id = toId($('#paste-id').value.trim());
  if (!id) { showMsg('err', 'Give the pasted HTML a name.'); $('#paste-id').focus(); return; }
  $('#paste-btn').disabled = true;
  try { await addDoc(id, html); } finally { $('#paste-btn').disabled = false; }
});

loadDocs();
