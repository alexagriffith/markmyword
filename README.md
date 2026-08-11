# markmyword

A Google-Docs-style **review layer over your already-styled HTML deliverables** —
newsletters, dashboards, one-pagers. One person edits in place; everyone else
leaves tracked **suggestions** and **comments on any element** (text, images,
charts, dividers). **Version history** is kept automatically, with restore.

Unlike converting to Google Docs (which flattens your custom CSS/table/SVG
layout) or comment-on-live-page SaaS (which only anchors comments), markmyword
renders your artifact **exactly as-is** and layers review on top — without ever
rewriting your markup.

## Why it's safe to point at any HTML

- **Your document markup is never rewritten.** Edits are stored as plain text and
  re-applied as `textContent`, so tags, inline styles, and layout are untouched —
  and text injection is impossible.
- **Content-hash anchoring:** each editable block is addressed by a hash of its
  normalized text (+ an occurrence index), so edits/suggestions survive the
  template being restructured. If a block can't be re-anchored, its overlay is
  flagged **stale** and *not* applied — never mis-placed.
- **Uploads are script-stripped** server-side (`<script>`, `on*=` handlers,
  `javascript:` URLs) so a stored deliverable is inert.
- Reviewer-supplied text (suggestions/comments) is escaped on store and rendered
  as text.

## Run it

```bash
npm install
npm start           # http://localhost:3939
# landing page (list + upload):  http://localhost:3939/
# a specific doc:                http://localhost:3939/viewer.html?doc=example
```

An `example` deliverable ships in `docs/` so it works out of the box.

## Add a deliverable

- **Landing page (`/`)** lists every doc in `docs/` and has an upload form: give
  it an id, pick an `.html` file or paste markup, hit **Upload & open**.
- Or drop `docs/<id>.html` in directly and open `/viewer.html?doc=<id>`.
- Doc ids are restricted to `[A-Za-z0-9._-]` (they become the URL; no traversal).
- Optional grouping: `docs/<id>.config.json` `{ "groups": ["<css selector>"] }`
  edits a multi-element section as one block.

## How it works

```
Browser  (viewer.html + viewer.js + anchoring.js)
  render base HTML faithfully · content-hash anchor each text leaf · apply overlay
  editor: contenteditable, debounced save · reviewer: select → suggest / comment
        │  GET /api/doc/:id  POST /api/edit/:id  POST /api/suggest/:id  …
        ▼
Node (Express)  — one always-on process
  strip active content on upload · escape reviewer text · anchor hydration
        │  better-sqlite3 (synchronous, ACID)
        ▼
SQLite  app.db  — overlay (live text) · document_versions (history) · suggestions
docs/<id>.html  — immutable base templates (git versions the templates)
```

## Test

```bash
npm test    # anchoring (jsdom) + format probes + grouping + API/suggestions/upload round-trips (Express + SQLite)
```

## Deploy

markmyword is a **stateful** app: a long-running Node process plus a SQLite file
it writes to continuously. It needs an **always-on host with a persistent disk**
(Fly.io, Render, Railway, or any VM) — *not* a static host (GitHub Pages) or a
serverless platform with an ephemeral filesystem (Vercel), where writes are lost.

Backup = copy `data/app.db` off the volume. Add a deliverable = commit
`docs/<id>.html`.

## License

MIT — see [LICENSE](LICENSE).
