// SQLite persistence for markmyword.
//
// - documents:         live overlay per doc (one JSON blob, last-write-wins).
// - document_versions: append-only snapshots for Google-Docs-style history.
// - suggestions:       phase 2 (schema created now so migrations aren't needed).
//
// better-sqlite3 is synchronous (no async/await) and ACID — ideal for a single
// always-on box. The DB path is configurable so tests use a throwaway file and
// production uses a persistent volume.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path = process.env.HS_DB_PATH || './data/app.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      doc_id       TEXT PRIMARY KEY,
      overlay_json TEXT NOT NULL DEFAULT '{}',
      updated_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS document_versions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id       TEXT NOT NULL,
      ts           TEXT NOT NULL,
      overlay_json TEXT NOT NULL,
      label        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_versions_doc ON document_versions(doc_id, id DESC);
    CREATE TABLE IF NOT EXISTS suggestions (
      id         TEXT PRIMARY KEY,
      doc_id     TEXT NOT NULL,
      anchor     TEXT,
      quote      TEXT,
      body       TEXT,
      kind       TEXT,
      status     TEXT NOT NULL DEFAULT 'open',
      author     TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sugg_doc ON suggestions(doc_id);
    -- Who created each doc, so guests are held to one doc each and can delete
    -- their own. owner_token is the caller's stable id: 'owner' for the site
    -- owner (OWNER_KEY holder), else the guest's signed-cookie id.
    CREATE TABLE IF NOT EXISTS doc_owners (
      doc_id       TEXT PRIMARY KEY,
      owner_token  TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_owners_token ON doc_owners(owner_token);
  `);
  // Migrations. Both columns support span-level (highlight-a-phrase) suggestions:
  //   span_occ  = which occurrence of `quote` inside the block this suggestion
  //               targets (0-based). -1 means "whole block" (block-level/legacy).
  //   base_text = the block's full text at suggest time, so on accept we can
  //               compute the span replacement and detect drift even if the block
  //               has no overlay yet.
  const cols = db.prepare('PRAGMA table_info(suggestions)').all().map((c) => c.name);
  if (!cols.includes('span_occ')) db.exec('ALTER TABLE suggestions ADD COLUMN span_occ INTEGER NOT NULL DEFAULT -1');
  if (!cols.includes('base_text')) db.exec("ALTER TABLE suggestions ADD COLUMN base_text TEXT NOT NULL DEFAULT ''");

  // Link access control (Google-Docs "Anyone with the link can…"): a per-doc level
  // the owner sets, gating what a GUEST who has the link may do. Default 'suggest'
  // preserves prior behavior (suggesting was open to anyone). Existing rows migrate
  // to 'suggest' via the column default, so no doc silently locks or opens up.
  const ownerCols = db.prepare('PRAGMA table_info(doc_owners)').all().map((c) => c.name);
  if (!ownerCols.includes('access_level')) {
    db.exec("ALTER TABLE doc_owners ADD COLUMN access_level TEXT NOT NULL DEFAULT 'suggest'");
  }
  return db;
}

// --- overlay (live state) ---
export function getOverlay(db, docId) {
  const row = db.prepare('SELECT overlay_json FROM documents WHERE doc_id = ?').get(docId);
  return row ? JSON.parse(row.overlay_json) : {};
}

export function saveOverlay(db, docId, overlay, ts) {
  const json = JSON.stringify(overlay);
  db.prepare(`
    INSERT INTO documents (doc_id, overlay_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(doc_id) DO UPDATE SET overlay_json = excluded.overlay_json, updated_at = excluded.updated_at
  `).run(docId, json, ts);
}

// Set one block's edited text and append a version snapshot, atomically.
export const setBlockAndSnapshot = (db) => db.transaction((docId, anchor, text, ts, label) => {
  const overlay = getOverlay(db, docId);
  overlay[anchor] = { text, updatedAt: ts };
  saveOverlay(db, docId, overlay, ts);
  db.prepare('INSERT INTO document_versions (doc_id, ts, overlay_json, label) VALUES (?, ?, ?, ?)')
    .run(docId, ts, JSON.stringify(overlay), label || null);
  return overlay;
});

// --- versions (history) ---
export function listVersions(db, docId, limit = 100) {
  return db.prepare('SELECT id, ts, label FROM document_versions WHERE doc_id = ? ORDER BY id DESC LIMIT ?')
    .all(docId, limit);
}

export function getVersion(db, docId, versionId) {
  const row = db.prepare('SELECT id, ts, label, overlay_json FROM document_versions WHERE doc_id = ? AND id = ?')
    .get(docId, versionId);
  return row ? { ...row, overlay: JSON.parse(row.overlay_json) } : null;
}

// --- suggestions (tracked changes) ---
// A suggestion proposes replacing a block's text (kind='rewrite') or leaves a
// note (kind='comment'). It never touches the live overlay until accepted.
const SUGG_COLS = 'id, doc_id, anchor, quote, body, kind, status, author, created_at, span_occ, base_text';

export function listSuggestions(db, docId, status = 'open') {
  return db.prepare(
    `SELECT ${SUGG_COLS} FROM suggestions WHERE doc_id = ? AND status = ? ORDER BY created_at ASC`
  ).all(docId, status);
}

export function addSuggestion(db, s) {
  db.prepare(
    'INSERT INTO suggestions (id, doc_id, anchor, quote, body, kind, status, author, created_at, span_occ, base_text) VALUES (@id, @doc_id, @anchor, @quote, @body, @kind, @status, @author, @created_at, @span_occ, @base_text)'
  ).run({ status: 'open', span_occ: -1, base_text: '', ...s });
  return getSuggestion(db, s.id);
}

export function getSuggestion(db, id) {
  return db.prepare(`SELECT ${SUGG_COLS} FROM suggestions WHERE id = ?`).get(id);
}

export function setSuggestionStatus(db, id, status) {
  const r = db.prepare('UPDATE suggestions SET status = ? WHERE id = ?').run(status, id);
  return r.changes > 0;
}

// Replace the Nth (0-based) occurrence of `needle` in `hay` with `repl`.
// Returns null if that occurrence doesn't exist (caller decides the fallback).
export function replaceNthOccurrence(hay, needle, repl, n) {
  if (!needle) return null;
  let from = 0, idx = -1;
  for (let i = 0; i <= n; i++) {
    idx = hay.indexOf(needle, from);
    if (idx === -1) return null;
    from = idx + needle.length;
  }
  return hay.slice(0, idx) + repl + hay.slice(idx + needle.length);
}

// Accept a rewrite suggestion: apply its body to the live overlay (as an edit,
// with a version snapshot) AND mark the suggestion accepted — atomically.
//
// `text` is the caller-computed whole-block result used for BLOCK-level rewrites
// (span_occ < 0). For SPAN-level rewrites (span_occ >= 0) we instead surgically
// replace the Nth occurrence of the suggestion's `quote` inside the block's
// CURRENT text with `body`, so the rest of the block is untouched. "Current" is
// the live overlay text if the block has been edited, else the block's text at
// suggest time (stored on the suggestion as base_text).
export const acceptSuggestion = (db) => db.transaction((id, text, ts) => {
  const s = getSuggestion(db, id);
  if (!s || s.status !== 'open') return null;
  if (s.kind === 'rewrite') {
    const overlay = getOverlay(db, s.doc_id);
    let applied = text;
    // Multi-block whole-paragraph rewrite: the anchor is an "m:"-packed list and the
    // body is blank-line-separated paragraphs. Re-split the body, map each piece to
    // its block anchor in order, and write each as an independent overlay entry.
    // Drop-not-misplace: if the paragraph count doesn't match the block count we
    // refuse (mark stale) rather than guess which piece belongs where.
    if (s.span_occ === -2 && s.anchor.startsWith('m:')) {
      const anchors = s.anchor.slice(2).split(',').filter(Boolean);
      // body is stored escaped; split on a blank line (one or more), trim empties.
      const pieces = String(s.body).split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
      if (pieces.length !== anchors.length) {
        setSuggestionStatus(db, id, 'stale');
        return { overlay, stale: true };
      }
      for (let i = 0; i < anchors.length; i++) overlay[anchors[i]] = { text: pieces[i], updatedAt: ts };
      setSuggestionStatus(db, id, 'accepted');
      saveOverlay(db, s.doc_id, overlay, ts);
      db.prepare('INSERT INTO document_versions (doc_id, ts, overlay_json, label) VALUES (?, ?, ?, ?)')
        .run(s.doc_id, ts, JSON.stringify(overlay), `accept suggestion ${id.slice(0, 8)}`);
      return overlay;
    }
    if (s.span_occ >= 0) {
      const current = overlay[s.anchor]?.text ?? s.base_text ?? '';
      const next = replaceNthOccurrence(current, s.quote, s.body, s.span_occ);
      if (next === null) {
        // Phrase no longer present (block was edited since the suggestion) —
        // refuse to guess. Mark stale and leave the live doc untouched.
        setSuggestionStatus(db, id, 'stale');
        return { overlay, stale: true };
      }
      applied = next;
    }
    setSuggestionStatus(db, id, 'accepted');
    overlay[s.anchor] = { text: applied, updatedAt: ts };
    saveOverlay(db, s.doc_id, overlay, ts);
    db.prepare('INSERT INTO document_versions (doc_id, ts, overlay_json, label) VALUES (?, ?, ?, ?)')
      .run(s.doc_id, ts, JSON.stringify(overlay), `accept suggestion ${id.slice(0, 8)}`);
    return overlay;
  }
  setSuggestionStatus(db, id, 'accepted');
  return getOverlay(db, s.doc_id); // comment: nothing to apply
});

// --- doc ownership (guardrails: one doc per guest; owner unlimited) ---
// Record who created a doc. Called on successful upload.
export function setDocOwner(db, docId, ownerToken, ts) {
  db.prepare(`
    INSERT INTO doc_owners (doc_id, owner_token, created_at) VALUES (?, ?, ?)
    ON CONFLICT(doc_id) DO UPDATE SET owner_token = excluded.owner_token
  `).run(docId, ownerToken, ts);
}

export function getDocOwner(db, docId) {
  return db.prepare('SELECT owner_token FROM doc_owners WHERE doc_id = ?').get(docId)?.owner_token ?? null;
}

// --- link access control (per-doc guest capability) ---
// The levels a guest-with-the-link may be granted, least→most capable:
//   'view'    read only (no suggest, no edit)
//   'suggest' read + propose changes (owner accepts/rejects) — default
//   'edit'    read + suggest + directly edit the doc
// The owner (and the doc's guest-owner) always has full edit regardless of level;
// this only controls what OTHER guests may do.
export const ACCESS_LEVELS = ['view', 'suggest', 'edit'];
export const DEFAULT_ACCESS = 'suggest';

// Effective access level for a doc. Docs with no owner row (seed/demo) return the
// default so they behave exactly as before this feature existed.
export function getDocAccess(db, docId) {
  const row = db.prepare('SELECT access_level FROM doc_owners WHERE doc_id = ?').get(docId);
  const lvl = row?.access_level;
  return ACCESS_LEVELS.includes(lvl) ? lvl : DEFAULT_ACCESS;
}

// Set a doc's access level. Only updates an existing owner row (the caller has
// already checked the doc exists and the caller may set it). Returns true if a
// row was updated, false if the doc has no owner row to attach the level to.
export function setDocAccess(db, docId, level) {
  if (!ACCESS_LEVELS.includes(level)) throw new Error('invalid_access_level');
  const r = db.prepare('UPDATE doc_owners SET access_level = ? WHERE doc_id = ?').run(level, docId);
  return r.changes > 0;
}

// Ownership lookup for the whole owners table, as { docId: ownerToken }. Used to
// scope the landing-page list per viewer: a guest sees only docs they own, plus
// any doc with NO owner row (the seed/demo docs) which are public to everyone.
export function ownerMap(db) {
  const rows = db.prepare('SELECT doc_id, owner_token FROM doc_owners').all();
  const m = Object.create(null);
  for (const r of rows) m[r.doc_id] = r.owner_token;
  return m;
}

// How many docs this token currently owns (guest cap = 1; owner is exempt).
export function countDocsOwnedBy(db, ownerToken) {
  return db.prepare('SELECT COUNT(*) n FROM doc_owners WHERE owner_token = ?').get(ownerToken).n;
}

// How many distinct guest tokens own at least one doc (global guest ceiling).
export function countGuestOwners(db) {
  return db.prepare("SELECT COUNT(DISTINCT owner_token) n FROM doc_owners WHERE owner_token != 'owner'").get().n;
}

// Drop all SQLite state for a doc (overlay, versions, suggestions, ownership).
// The docs/<id>.html file is removed by the caller (filesystem side).
export const deleteDocData = (db) => db.transaction((docId) => {
  db.prepare('DELETE FROM documents WHERE doc_id = ?').run(docId);
  db.prepare('DELETE FROM document_versions WHERE doc_id = ?').run(docId);
  db.prepare('DELETE FROM suggestions WHERE doc_id = ?').run(docId);
  db.prepare('DELETE FROM doc_owners WHERE doc_id = ?').run(docId);
});

// Restore a version: copy its overlay to live AND record the restore as a new
// version (so the timeline is append-only and the restore itself is undoable).
export const restoreVersion = (db) => db.transaction((docId, versionId, ts) => {
  const v = getVersion(db, docId, versionId);
  if (!v) return null;
  saveOverlay(db, docId, v.overlay, ts);
  db.prepare('INSERT INTO document_versions (doc_id, ts, overlay_json, label) VALUES (?, ?, ?, ?)')
    .run(docId, ts, v.overlay_json, `restore of #${versionId}`);
  return v.overlay;
});
