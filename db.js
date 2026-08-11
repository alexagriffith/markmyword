// SQLite persistence for html-suggest.
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
