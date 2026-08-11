<div align="center">

# 📝 markmyword

**A Google-Docs-style review layer for your already-styled HTML.**

Newsletters, dashboards, one-pagers — rendered *exactly as authored*, with
edit-in-place, tracked suggestions, comments on anything, and automatic version
history layered on top. Your markup is never rewritten.

### 🔗 [**Try the live demo → markmyword.fly.dev**](https://markmyword.fly.dev/)

</div>

---

## The problem

You built a beautiful HTML deliverable — custom CSS, a table-based email layout,
inline SVG charts. Now you need review.

- **Paste it into Google Docs** → the layout is flattened. Your design is gone.
- **Comment-on-live-page SaaS** → you get sticky-note comments, but no editable
  text and no history.
- **Email a diff / screenshots** → no one can actually *make* the change.

**markmyword** renders your artifact **as-is** and layers Google-Docs-style
review on top — without touching a single tag.

---

## 📖 User stories

markmyword is built around a simple split: **one owner edits, everyone else
suggests.** Here's how each person experiences it.

### 1. The owner — *"I want feedback on my HTML, fast."*

> *As the author of a styled HTML page, I upload it (or paste the markup), open
> it, and it renders exactly like the real thing. I can **edit text in place**
> like a doc — headings, paragraphs, links — and every change autosaves with
> **version history** I can restore. When I'm done, I **download the reviewed
> HTML** with all my edits baked back into the original markup.*

`Upload → edit in place → history is kept → download the clean result.`

### 2. The reviewer — *"I want to give feedback without an account."*

> *As a coworker, I click the link the owner shared. No login, no setup. I switch
> to **Suggesting** mode, highlight a phrase, and propose a rewrite — or leave a
> **comment on any element**, even an image or a chart. My suggestions show up as
> tracked changes the owner can accept or reject.*

`Open link → Suggesting mode → highlight & suggest, or comment → owner decides.`

### 3. The GitHub-connected owner — *"I want my repo to be the source of truth."* &nbsp;🔜 *coming next*

> *As the author, I connect my private GitHub repo. markmyword **imports** a
> document straight from the repo, keeps live review in the workspace, and when I
> accept changes it **commits them back** to the repo. GitHub stays the source of
> truth for the text; markmyword is the review surface on top of it.*

`Connect GitHub → import doc → review → auto-commit accepted edits back.`
*(Today: upload/paste in, download out. GitHub sign-in + import + push-back is
the next milestone.)*

---

## 🎬 Storyboard

**1 · Your files.** The home page lists everything you're reviewing. Add a file
by picking an `.html` or pasting markup.

![Landing page](docs/screenshots/01-landing.png)

**2 · It renders faithfully.** Open a file and it looks exactly as authored —
markmyword never restyles the document itself.

![Viewer](docs/screenshots/02-viewer.png)

**3 · Edit in place.** In Editing mode, click any block and type. Changes
autosave; the dot shows saved / unsaved.

![Editing](docs/screenshots/03-edit.png)

**4 · Suggest, don't just edit.** Switch to Suggesting mode, highlight a phrase,
and propose a rewrite — or leave a comment on any element.

![Suggesting](docs/screenshots/04-suggest.png)

**5 · Suggestions panel.** Every proposal lands here as a tracked change the
owner can accept or reject.

![Suggestions panel](docs/screenshots/05-suggestions.png)

**6 · Version history.** Every save is a restorable snapshot — see what changed
and roll back with one click.

![Version history](docs/screenshots/06-history.png)

**7 · Download the result.** Export the reviewed HTML with your edits baked back
into the original markup — no markmyword attributes leak.

![Toolbar with Download](docs/screenshots/07-toolbar.png)

---

## 🔒 Why it's safe to point at any HTML

- **Your document markup is never rewritten.** Edits are stored as plain text and
  re-applied as `textContent`, so tags, inline styles, and layout are untouched —
  and text injection is impossible.
- **Content-hash anchoring:** each editable block is addressed by a hash of its
  normalized text (+ an occurrence index), so edits and suggestions survive the
  template being restructured. If a block can't be re-anchored, its overlay is
  flagged **stale** and *not* applied — never mis-placed.
- **Uploads are script-stripped** server-side (`<script>`, `on*=` handlers,
  `javascript:` URLs) so a stored file is inert.
- **Reviewer text is untrusted:** suggestions and comments are escaped on store
  and rendered as text.
- **Doc ids** are restricted to `[A-Za-z0-9._-]` (no path traversal).

---

## 🚀 Run it locally

```bash
npm install
npm start           # http://localhost:3939
# home (list + add):   http://localhost:3939/
# a specific file:     http://localhost:3939/viewer.html?doc=example
```

An `example` document ships in `docs/` so it works out of the box.

### Add a file

- **Home page (`/`)** lists every file in `docs/` and has an add form: name it,
  pick an `.html` file or paste markup, hit **Add & open**.
- Or drop `docs/<id>.html` in directly and open `/viewer.html?doc=<id>`.
- Optional grouping: `docs/<id>.config.json` `{ "groups": ["<css selector>"] }`
  edits a multi-element section as one block.

---

## 🧭 How it works

```
Browser  (viewer.html + viewer.js + anchoring.js)
  render base HTML faithfully · content-hash anchor each text leaf · apply overlay
  editor: contenteditable, debounced save · reviewer: select → suggest / comment
  download: re-apply overlay to base markup, strip markmyword attrs, save file
        │  GET /api/doc/:id  POST /api/edit/:id  POST /api/suggest/:id  …
        ▼
Node (Express)  — one always-on process
  strip active content on upload · escape reviewer text · anchor hydration
        │  better-sqlite3 (synchronous, ACID)
        ▼
SQLite  app.db  — overlay (live text) · document_versions (history) · suggestions
docs/<id>.html  — immutable base templates (git versions the templates)
```

**Two storage systems, on purpose:** the base HTML lives as a file (the source of
truth for markup); the live review state — edits, suggestions, history — lives in
SQLite. That's why review data survives across sessions and why GitHub can later
own the documents while the workspace owns the in-flight review.

---

## 🧪 Test

```bash
npm test    # anchoring (jsdom) + format probes + grouping
            # + API / suggestions / upload round-trips (Express + SQLite)
```

---

## ☁️ Deploy

markmyword is a **stateful** app: a long-running Node process plus a SQLite file
it writes to continuously. It needs an **always-on host with a persistent disk**
(Fly.io, Render, Railway, or any VM) — *not* a static host (GitHub Pages) or a
serverless platform with an ephemeral filesystem (Vercel), where writes are lost.

This repo ships a `Dockerfile` and `fly.toml`; the live demo runs on Fly.io with a
persistent volume. Backup = copy `data/app.db` off the volume. Add a file = commit
`docs/<id>.html`.

---

## License

MIT — see [LICENSE](LICENSE).
