# Lain's Writing Tools

A local, single-user web app for long-form fiction and worldbuilding.
Write in a WYSIWYG editor, keep an Obsidian-style wiki of notes per project,
track daily word counts and goals, and switch between color themes.

## Quick start

```
python -m venv .venv                     # if you don't already have it
.venv\Scripts\pip install -r requirements.txt
npm install && npm run build             # builds the editor bundle
python main.py                           # opens http://127.0.0.1:8000
```

## How data is stored

Everything lives in the `data/` directory. Each project is a free-form
scaffolding tree of **folders** and **documents**:

```
data/
  settings.json                    # global settings (theme, word count mode)
  <project>/
    project.json                   # title, daily goal, timestamps
    stats/history.jsonl            # append-only log of word-count deltas
    templates/*.json               # lore templates (Character, Location, …)
    worldbuilding/                 # the Wiki tab's scaffolding root
      characters/mara.md
    Part One/                      # any folder, nested as deep as you like
      chapter-one.md               # a chapter (type: chapter)
      character-notes.md           # a note (type: note)
    prologue.md                    # root-level documents are allowed
```

Folders are directories, documents are Markdown files. The document's kind
(chapter vs note) lives in YAML frontmatter (`type:`); `title` is the display
name. Within a folder, **folders and documents share one unified order**,
kept by an auto-managed numeric `NN-` filename prefix on each entry (folders
too — the prefix is hidden in the sidebar, exactly like document titles).

**Everything in the sidebar is draggable and reorderable.** Grab any chapter,
note, wiki entry, or folder row and drop it somewhere:
- drop on the **top/bottom edge** of a row to insert before/after it
  (a thin line shows where it will land) — this reorders within the same
  folder, or moves into another folder at that exact spot;
- drop on the **middle** of a folder row (or the space under it) to nest it
  inside that folder;
- drop on **empty sidebar space** to move it to the project root / wiki root.

Empty folders are **kept**, never deleted automatically when their last entry
is moved or deleted. The `worldbuilding/` wiki root itself is never renamed
by ordering; folders inside it are ordered like any others.

The **Write tab** shows everything except `worldbuilding/`; the **Wiki tab**
shows only `worldbuilding/`, so lore lives in its own separate scaffolding
with the same folder features. The `stats/`, `templates/` and `worldbuilding/`
paths (and `project.json`) are reserved. Legacy `chapters/` layouts are
migrated automatically the first time a project is opened.

## Editing notes

- `[[Note Title]]` links to other documents by title (type the brackets
  yourself or use the **[[  ]]** toolbar button). The brackets are hidden in
  the editor — only the colored link text shows; `[[Note Title|alias]]`
  displays just the alias. Click a wikilink to jump to that document, or to
  offer creating it as a worldbuilding entry if it doesn't exist yet.
- The **Wiki** tab is its own scaffolding tree for lore. Create an entry
  with a **template** (Character, Location, Organization, Nation, Lore
  Concept, or Blank) and its sections (`## Appearance`, `## History`, …) are
  pre-filled and separated by horizontal rules. Templates can be added,
  edited, or deleted from the **Templates** button in the wiki sidebar.
- Wiki pages get a **navigation box** (a small rounded card at the top of
  the editor, Fandom-style) listing the document title and its numbered
  headings; clicking one jumps to that section in the editor.
- Chapters, notes, wiki entries, and folders can all be moved by dragging
  them in the sidebar: drop on a folder to nest it inside, on a document to
  reorder within the same folder, or on empty space to move to the project
  root / wiki root. Use the `⋯` menu on a folder to add
  chapters/notes/subfolders, rename, or delete it.
- Word counts use auto mode by default: whitespace-separated words plus
  CJK characters (switchable in Settings).

## Backend layout

```
main.py                 # entry point (uvicorn + open browser)
app/
  main.py               # FastAPI app factory, static serving
  config.py             # paths + defaults
  routes/               # projects, documents, wiki/stats, settings, ai
  services/             # business logic (filesystem is the source of truth)
  ai/                   # Lain: DeepSeek provider, tools, agent loop, sessions
```

The API is documented at `/api/docs` while the server is running.

## Lain (AI assistant)

**Lain** is a sidebar assistant that helps *organize* a project — keeping
lore consistent, moving/creating/deleting entries, and suggesting
improvements. Lain is **not** a ghost-writer: it won't write your prose.

- Open it with the **Lain** button in the top bar. The panel is hidden by
  default and remembers the last session per project.
- Connect a **DeepSeek API key** in **Settings → AI assistant** (stored in
  `data/settings.json`; a **Test connection** button verifies it). Models:
  `deepseek-v4-flash` (default) or `deepseek-v4-pro`.
- **Access control**: under "Lain can access" pick which folders (Write
  and/or Wiki subtrees) Lain may read and change. The restriction is
  enforced by the server on every tool call, not just requested.
- **What Lain can do**: list trees, read entries, and create entries/folders
  immediately. Editing, renaming, moving, and deleting always pause for your
  confirmation first — the app computes the confirmation from the actual
  files (real before/after diff for edits, real from → to for moves), so the
  confirmation can never be hallucinated.
- **Sessions** are saved automatically after every message and survive
  restarts (stored under `data/ai-sessions/<project>/`). Use **+** to start
  a new one, the dropdown to switch, ✎ to rename, and ⟲ to **compress** the
  older part of a conversation into a summary to save context (the last 8
  messages are kept; originals are archived).
- After Lain changes anything, the sidebar tree, wiki backlinks, and the
  open document (if it was touched) refresh automatically.


## Frontend layout

```
static/
  index.html
  css/themes.css        # CSS-variable palettes (paper / ink / typewriter)
  css/app.css
  js/                   # api, router, ui, themes, library, project
  dist/editor.bundle.js # TipTap bundle (built from client/)
client/editor-entry.js  # TipTap source — edit, then `npm run build`
```

## Word counting

| Mode   | Behavior                                        |
| ------ | ----------------------------------------------- |
| auto   | whitespace words + CJK characters (recommended) |
| words  | whitespace-separated words only                 |
| chars  | all non-whitespace characters                   |

## Editor appearance & per-part styling

Text styling works at three levels — each falls back to the level above it:

1. **Global defaults** — edited in **Settings → Editor defaults**. These are
   the app-wide fallback for every document.
2. **Per document** — stored in the file's frontmatter (`font`, `size`,
   `align`, `zoom`). Sections you've never touched use this.
3. **Per section** — stored in the frontmatter `styles` map keyed by heading
   text, e.g. `styles: {"Appearance": {"size": 20, "align": "center"}}`.

The ribbon's **font / size / alignment** controls are context-aware:

- **Text selected** — font & size apply to exactly the selected text, kept
  as inline `<span style="…">` markup in the file. Alignment is a block
  property, so it applies to every paragraph/heading block the selection
  touches, stored as `<p style="text-align:…">` / `<h2 style="text-align:…">`.
- **Cursor inside a heading's section** — the controls style that section
  (a small label next to them shows which one).
- **Cursor outside any section** — the controls style the document's base.

**Zoom** is always document-level. The **Clear** button resets the current
selection / section / document back to inheriting the level above. Inline
font/size styling and block alignment are written into the Markdown body;
section and document styling live entirely in frontmatter.

## Known limitations

- Markdown round-trips cleanly for prose, headings, formatting, lists, and
  quotes. Complex HTML/tables will not survive the WYSIWYG conversion.
- Inline-styled text is stored as `<span style="…">` in the Markdown, and
  per-block aligned text as `<p style="text-align:…">` / `<h2 …>`. A
  hand-written span carrying *both* font-size and font-family keeps only
  font-size when reopened (the editor's own output uses nested spans, which
  round-trip cleanly).
- Wikilinks are inserted as literal `[[...]]` text; the Wiki tab and
  backlinks panel cover navigation.
