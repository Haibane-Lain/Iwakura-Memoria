# Iwakura Memoria

A desktop application for long-form fiction and worldbuilding. Write in a
WYSIWYG editor with real-time grammar checking, keep an Obsidian-style wiki,
track daily word counts, and switch between themed palettes. The default
launcher is the **Electron shell** (`run.bat`), which runs the Python server
as a child process and renders the frontend in a native frameless window. The
legacy pywebview path (`run.bat --pywebview`) and a plain-browser fallback
(`python main.py --browser`) still work.

## Quick start

```
python -m venv .venv                     # if you don't already have it
.venv\Scripts\pip install -r requirements.txt
npm install && npm run build             # builds the editor bundle
npm --prefix electron install            # installs the Electron shell once
run.bat                                  # recommended launcher: Electron shell window
run.bat --pywebview                      # legacy pywebview window
python main.py --browser                 # or open in a browser tab
python main.py --server-only --port 8000 # headless (no window) — used by the Electron shell
```

The frontend toolchain (`npm install`, the build, and the JS tests) needs
**Node 22.22.2+ or 24.15+** — `jsdom` 30 / `undici` 8 require it. CI uses Node 24.

To run the tests:

```
.venv\Scripts\pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m pytest tests/ -q
npm run test:js                          # frontend tests (node; unit + shell smoke; rebuilds the bundle first)
```

To lint (both must pass in CI alongside the tests):

```
.venv\Scripts\python.exe -m ruff check .   # Python (config in pyproject.toml)
npm run lint                               # JavaScript (eslint.config.mjs)
```

Grammar checking requires **Java 17+** and a LanguageTool server. See the
[Grammar](#grammar-checking) section below.

## Features

- **Native desktop window** — Electron shell (default): spawns the Python
  server as a child process, frameless with a custom-themed title bar,
  maximize/restore/fullscreen, and a single-instance lock. The legacy
  pywebview path is kept behind `run.bat --pywebview`.
- **WYSIWYG editor** — TipTap-based ProseMirror editor with markdown
  round-tripping, wikilinks (`[[Target]]` / `[[Target|alias]]`), per-document
  and per-section fonts/sizes/alignment, and a default zoom per tab (100% for
  **Write**, 75% for **Wiki**).
- **Grammar checking** — Bundled LanguageTool 6.9 Java server, with
  ProseMirror inline underlines, replacement corrections, and a per-project
  ignore dictionary.
- **Per-project dictionary** — Words you add to the dictionary are filtered
  from grammar results across the entire project.
- **Repetition check** — The **Repeat** toolbar button scans any combination of
  folders and chapters for overused words, words echoed close together,
  repeated phrases, and repeated sentences. Pick the scope from the
  folder/chapter tree, tune the thresholds under **Options**, and click a
  flagged phrase or sentence to open it in the editor.
- **Export** — Native save-as dialog for ZIP, DOCX, PDF, and EPUB. Select
  which folders to include.
- **AI assistant (Lain)** — DeepSeek-powered sidebar that helps organize your
  project: list, read, create, rename, move, edit, and delete entries, all
  server-enforced by scope. Destructive actions require user confirmation.
- **Wiki system** — Dedicated `worldbuilding/` tree with templates (Character,
  Location, Organization, Nation, Lore Concept), wikilink auto-resolution,
  backlinks, and a Fandom-style navigation box.
- **Themes** — Paper, Ink, Typewriter, Gothic, Horror, Fantasy, Sci-Fi. First
  launch starts on **Gothic**; whatever you pick is remembered.
- **Stats** — Daily word counts, streak tracking, and configurable goals with
  a progress bar, a 30-day bar chart, and an optional scrollable **full daily
  history** (every day back to the project's creation, zero days shown dimmed).
- **Drag-and-drop sidebar** — Reorder, nest, and move chapters, notes, wiki
  entries, and folders with visual drop zones.
- **Sidebar search** — A search box above the **Write** and **Wiki** sidebar
  buttons filters that tree by document title or folder name as you type:
  case-insensitive, hierarchy kept in place, the folders leading to a match
  opened for you, and a live result count beside the box. `Esc` clears it. The
  box is pinned below the tabs, so it stays in reach however far down a long
  tree you have scrolled.
- **Full-text search** — The **Find** toolbar button (or **Ctrl+F**) searches
  the *contents* of every document, not just titles. Case-insensitive by
  default, with **Case sensitive** and **Whole word** toggles and a scope
  selector (whole project, Write, Wiki, or the current document). Results are
  grouped by document with a highlighted snippet per hit; click one to open the
  document and select that exact match.
- **Inline images** — Drop one or more pictures onto the editor (or paste a
  screenshot, or use the 🖼 toolbar button) and they appear inline, in both the
  Write and Wiki tabs. Drag the corner handle to resize — the size is saved
  with the document — and double-click a picture to see it full size. Pictures
  are stored as real files in the project's `assets/` folder.
- **Character tables** — The **👤** button in the Wiki ribbon inserts a
  Fandom-style info box: a title, a subtitle, a portrait slot and label/value
  rows, floated to the right of the entry so the text wraps around it. Type
  straight into it (`Enter`/`Tab` jump to the next field), add rows and
  sections from the chips that appear on hover, and drag its corner to set the
  width. It is stored as plain HTML in the Markdown and carried into every
  export.
- **Link-safe rearranging** — Moving or reordering a document rewrites any
  `[[path]]` links that point to it; renaming a document rewrites links that
  point to it by title, so nothing silently breaks.
- **Trash / undo delete** — Deleting a chapter, note, wiki entry, or folder
  moves it to that project's **Trash** instead of erasing it. A delete shows an
  **Undo** action in the toast, and **Settings → Trash** lists everything with
  *restore*, *delete*, and *empty* — so a mis-click (or a bad Lain move) is
  recoverable. Trash is per project and is dropped when the project is.
- **Whole-library backups** — One click snapshots every project, settings,
  stats, and chat history into a timestamped zip; the 10 newest are kept.
- **Autosave** — Configurable debounce; last-ditch save on tab close.

## How data is stored

Everything lives in the user's local app-data directory, **not** next to the
code — so the app can be installed anywhere (even read-only folders) without
losing your work. On Windows the default is
`%LOCALAPPDATA%\IwakuraMemoria\data` (elsewhere it's `~/.iwakura/data`).
Set the `IWAKURA_DATA_DIR` environment variable to force a location (used by
tests and useful for portable setups).

**First-run migration**: the very first launch after an upgrade moves an
existing `data/` folder that sits next to the code into the new location. The
migration is idempotent and safe — it never deletes or overwrites anything,
and if it can't complete the app keeps using the old location.

Each project is a free-form scaffolding tree of **folders** and **documents**:

```
data/
  settings.json                    # global settings (theme, word count mode, zoom per tab, grammar toggle, AI config)
  .zoom-rebased                    # marker: stored zoom values use the current 100% scale
  ai-sessions/<project>/           # Lain chat session history
  .trash/<project>/                # deleted entries, restorable from Settings -> Trash
  <project>/
    project.json                   # title, daily goal, timestamps
    dictionary.json                # per-project grammar ignore list
    stats/history.jsonl            # word-count deltas (compacted on the fly to one summed line per day; all days kept)
    templates/*.json               # lore templates (Character, Location, …)
    worldbuilding/                 # the Wiki tab's scaffolding root
      characters/mara.md
    assets/                        # pictures inserted into documents
      mara-portrait-47896fe724.png
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
with the same folder features. Wiki entries are laid out as reference pages
rather than prose: the text uses the window's width up to 1200px, where the
Write tab keeps a narrow centred column, which leaves room for the character
tables floating on the right. The `stats/`, `templates/`, `ai-sessions/`,
`assets/` and `worldbuilding/` paths (and `project.json`, `dictionary.json`)
are reserved.

Pictures used by documents live in a visible `assets/` folder at the project
root and are referenced **project-root-relative** — `![alt](assets/mara.png)`
— because that path never changes when a chapter is moved, reordered or
renamed (document ids do). The folder is hidden from the sidebar and cannot be
created as a user folder. A picture that has been *resized* is stored as
inline HTML (`<img src="assets/mara.png" width="300">`, the same convention as
inline font styling), because the export path's Markdown parser understands
attribute lists but the editor's does not.

A **character table** is stored as one raw HTML block, because that is the only
shape *both* Markdown parsers agree on (the editor's markdown-it and the
exporters' python-markdown pass it through untouched):

```html
<aside class="character-table" data-width="340">
<table class="ct-rows">
<tr class="ct-title"><th colspan="2">Übel</th></tr>
<tr class="ct-section"><th colspan="2">Biographical Information</th></tr>
<tr class="ct-row"><td class="ct-label">Gender</td><td class="ct-value">Female</td></tr>
</table>
</aside>
```

Inside the block the text is not parsed as Markdown, so its class names are a
contract (they are what the editor matches when it reopens the file) and its
pictures are always `<img>` tags with a project-relative `src` — never the
`![alt](src)` form, which would be shown as literal text. `data-width` is
written only after a corner drag. Everything is still hand-editable.

**Backups** live *next to* the data folder at
`%LOCALAPPDATA%\IwakuraMemoria\backups\` (Settings → Export & backup → *Back
up everything now*). Each is a timestamped zip of the whole `data/` layout —
extracting one over the data folder restores everything. The 10 newest are
kept automatically; older ones are deleted.

## Grammar checking

A local LanguageTool 6.9 server runs on port 8081. Requires **Java 17+**.
The server starts automatically at launch and shuts down when the app closes.
If a LanguageTool is already answering on 8081 when the app starts (e.g. an
orphaned server left behind by a previous session), it is **reused** instead
of starting a second one — so grammar keeps working even after an unclean
exit, and restarts are instant.

- Enable or disable from the **toolbar toggle**; the choice is remembered
  across restarts (stored as `grammarEnabled` in `settings.json`).
- Underlines appear inline in the editor with a 1.5s debounce.
- Click an underline to see the error message and replacement suggestions.
- Apply a replacement to automatically correct the text.
- Click **Add to dictionary** to ignore a word across all documents in the
  project (stored in the project's `dictionary.json`).
- Open the **Dict** toolbar button to view, search, add, or remove dictionary
  words.

Toggling grammar off hides the underlines; the bundled server still starts
at boot (it's already running and shared, so there's nothing to save). You
can also set `"grammarEnabled": false` in `data/settings.json`.

## Export

The **Export** button in the top bar opens a dialog where you can:

- Select a format: **ZIP** (raw Markdown), **DOCX** (styled Word document),
  **PDF**, or **EPUB**.
- Choose which folders to include (deselect any you want to skip).
- In desktop mode, a native save-as dialog opens so you pick the destination.
- In browser mode, the file downloads directly.

PDF export uses platform-specific serif/mono fonts (Georgia on
Windows/macOS, DejaVu on Linux).

Inline pictures are embedded in DOCX, PDF, and EPUB (scaled to the page width
unless the document sets a width), and the `assets/` folder is included in the
ZIP. A picture that can't be found — a remote URL, a file you deleted by hand
— is simply left out of the export rather than breaking it. Pictures are only
accepted as PNG, JPEG, GIF or WebP (not SVG, which can carry script).

A **character table** is exported too: Word gets a real table (each row keeps
its label and value cells, the title/section rows span it, and the portrait is
embedded in its cell), PDF renders it as a two-column table, and EPUB keeps the
markup with its own stylesheet. In the exports the box sits in the normal text
flow rather than floating right, and a width set by dragging the corner is not
carried over. With fpdf2's built-in fallback fonts (a machine with no system
serif), characters outside latin-1 — a `•`, a typographic dash, CJK — degrade
to `?` instead of failing the export.

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
- The **Write** and **Wiki** sidebars each have a **search box** above their
  **+ Chapter** / **+ Note** / **+ Folder** and **+ Entry** / **+ Folder** /
  **Templates** buttons. Type part of a title or folder name and that tree
  narrows to matches in place — case-insensitive, with the folders leading to a
  match opened for you and a live result count beside the box. A folder whose
  own name matches keeps its whole subtree. Press **Esc** or use the box's
  clear button to show everything again; searching never changes which folders
  you had expanded, and leaving a tab clears its filter. Only titles and folder
  names are searched, not document text. The box itself sits outside the
  scrolling part of the sidebar — the buttons and the tree scroll under it —
  so it is always there, even at the bottom of a long tree.
- **Pictures** go straight into the document: drag an image file from Explorer
  onto the editor, paste a screenshot with **Ctrl+V**, or use the **🖼** toolbar
  button. The picture is uploaded into the project's `assets/` folder and
  shown inline at the drop point (or at the cursor for a paste). Drag the small
  handle at its bottom-right corner to resize it; the size is saved with the
  document, and the **↺** chip clears it back to natural size. Double-click a
  picture to view it full size (click anywhere or press **Esc** to dismiss).
- Wiki pages get a **navigation box** (a small rounded card at the top of
  the editor, Fandom-style) listing the document title and its numbered
  headings; clicking one jumps to that section in the editor. The card stays
  compact — it widens only as far as its longest entry needs, up to the width
  of the text column.
- **Character tables** are inserted from the **👤** button in the Wiki ribbon
  (the Write tab's ribbon does not show it, though a table pasted into a
  chapter still renders). The box arrives with the
  entry's title, an empty subtitle and portrait, and the fields of the
  reference infobox — Aliases, Gender, Species, Class, Rank, Affiliation,
  Relatives, Status, Hair Color, Eye Color, Manga/Anime Debut, Japanese/English
  VA — grouped under three section headings. Click any cell and type; **Enter**
  and **Tab** move to the next field and add a new row once you run past the
  last one, **Shift+Enter** makes a line break inside a cell, and **Backspace**
  at the start of an empty row folds that row away. The chips that appear when
  you hover the box add a row or a section, remove the row you are in, or
  delete the whole box. The portrait is set by clicking or dropping a picture
  on its slot, and it resizes and opens full size like any other picture.
  Grabbing the corner handle sets the box width (double-click it for the
  default); the width is saved with the document.
- Chapters, notes, wiki entries, and folders can all be moved by dragging
  them in the sidebar: drop on a folder to nest it inside, on a document to
  reorder within the same folder, or on empty space to move to the project
  root / wiki root. Use the `⋯` menu on a folder to add
  chapters/notes/subfolders, rename, or delete it.
- Word counts use auto mode by default: whitespace-separated words plus
  CJK characters (switchable in Settings).

## Electron shell (default launcher)

`run.bat` launches `electron/` — the default desktop shell. Electron spawns
the Python server (`python main.py --server-only` on a free port 8000–8009)
as a child process and renders the same unmodified frontend. Its preload
script exposes the exact `window.pywebview.api` contract the frontend already
feature-detects, so the web UI needed **zero functional changes** — window
controls and the export save dialog become native Electron calls.

```
npm --prefix electron install
npm --prefix electron start
```

Notes: it runs the venv Python in dev mode (no bundled runtime yet — the
portable/packaging decision is still open); the close button tree-kills the
Python process so the LanguageTool Java child is never orphaned; a
single-instance lock focuses the existing window instead of launching twice;
the renderer's edge resize handles are inert no-ops because frameless windows
resize natively. The legacy `run.bat --pywebview` path is kept for reference.

## Distribution (installer .exe)

The app ships as a **Windows installer** (electron-builder → NSIS) that bundles
the Electron shell, the Python server frozen with PyInstaller, LanguageTool,
and a JRE — so an end user needs **no** Node.js, Python, or Java installed.

```
scripts\build\build.bat
```

The script, in order:

1. Installs Python build deps (`pyinstaller` via `requirements-dev.txt`).
2. Builds the frontend bundle (`npm run build` → `static/dist/editor.bundle.js`).
3. Freezes the server with PyInstaller (`scripts\build\app.spec` → a single
   `Iwakura-Memoria-server.exe`; the **PyInstaller config is in
   `scripts/build/`** and the package manifest is in `electron/package.json`’s
   `build` block).
4. Runs electron-builder, bundling `server/`, `LanguageTool 6.9/` as
   `languagetool/`, and a JRE as `jre/` into the installer.

The installer lands at `dist/electron/Iwakura Memoria Setup*.exe`.

**Before you build**, drop a JRE folder at `_jre/` with `bin/java.exe` (e.g.
Adoptium Temurin 21; the app prefers it via `IWAKURA_JRE_DIR`, falling back to a
system Java). The first `electron-builder` run downloads its toolchain
(~100 MB, one-time). A real `electron/build/icon.ico` gives the installer/app an
icon — without one the default Electron icon is used. The installer is unsigned,
so Windows SmartScreen shows a *"unrecognized app"* prompt on first run; that's
expected without a code-signing certificate.

A frozen `--server-only` server can be smoked out on its own:

```
dist\app\Iwakura-Memoria-server.exe --server-only --port 8000
```

Installed apps store data the same way as dev (`%LOCALAPPDATA%\IwakuraMemoria`),
so upgrading from a dev install keeps your projects.

## Backend layout

```
main.py                    # entry point (uvicorn; --server-only powers the Electron shell)
app/
  main.py                  # FastAPI app factory, static serving
  config.py                # paths + defaults
  logging_filters.py       # access-log filters (external /health probes are hidden)
  routes/                  # projects, documents, wiki/stats, settings, ai, grammar, backups
  services/                # business logic (filesystem is the source of truth), incl. backup
  ai/                      # Lain: DeepSeek provider, tools, agent loop, sessions
```

The API is documented at `/api/docs` while the server is running.

## Server console

The terminal window shows uvicorn's access log. One deliberate exception:

- **Health probes are hidden.** Unknown local processes occasionally hit
  `GET /health` (the one we chased turned out to be an unrelated project's
  dev launcher); the app answers 404 but suppresses the log line so the
  console stays readable. The filter is `HealthProbeFilter` in
  `app/logging_filters.py`, wired in through `_logging_config()` in `main.py`.
  If you ever need to see those requests again while hunting a mystery
  poller, delete the filter and restart.

## Local API security

The API binds to `127.0.0.1` with no authentication — but every request is
checked against two headers a web page cannot spoof before it reaches a route:

- **Host** must be a loopback hostname (`127.0.0.1`, `localhost`, `[::1]`).
  This blocks DNS-rebinding attacks: a malicious page whose domain resolves
  to `127.0.0.1` still sends its own hostname in `Host` and is rejected.
- For **POST/PUT/DELETE**, an explicit `Origin` header must also be loopback
  (any port — the Electron shell uses dynamic ports). Read-only requests and
  requests with no `Origin` header at all (curl, the Electron main process)
  pass on the Host check alone.

AI keys live in `data/settings.json` but are **never sent back to the page**:
the settings API returns a `••••••••••••` sentinel instead, and the settings
dialog only shows a saved-key indicator (with a *clear saved key* button)
unless you type a new key.

Set `IWAKURA_INSECURE_LOCALHOST=1` to disable every check — for experiments
only; never for normal use.

## Lain (AI assistant)

**Lain** is a sidebar assistant that helps *organize* a project — keeping
lore consistent, moving/creating/deleting entries, and suggesting
improvements. Lain is **not** a ghost-writer: it won't write your prose.

- Open it with the **Lain** button in the top bar. The panel is hidden by
  default and remembers the last session per project.
- Providers: **OpenCode Go** (`https://opencode.ai/zen/go/v1`, default model
  `deepseek-v4-flash`; the model list changes over time and can be listed with
  `GET https://opencode.ai/zen/go/v1/models`), **DeepSeek**, **LM Studio**, or
  any **OpenAI-compatible** endpoint. Configure the key and model in
  **Settings → AI assistant** (stored in `data/settings.json`; a **Test
  connection** button verifies it).
  OpenCode Go routes each model to the API dialect the gateway serves it with
  (chat completions, OpenAI Responses, or Anthropic Messages) automatically.
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

A code review of the AI stack lives in [`docs/ai-review.md`](docs/ai-review.md)
(two bugs fixed so far: session-attachment cleanup on delete, and the 25 MB
attachment cap being unreachable; plus an HTML sanitizer for chat rendering).

## Frontend layout

```
static/
  index.html
  lib/marked.js            # Markdown renderer for Lain chat
  css/themes.css           # CSS-variable palettes (7 themes)
  css/app.css
  js/                      # api, router, ui, themes, library, project, lain,
                           # sanitize, tree-search, image-utils, fonts, zoom,
                           # scroll-keep
  dist/editor.bundle.js    # TipTap bundle (built from client/)
client/editor-entry.js     # TipTap source — edit, then `npm run build`
client/character-table.js  # the wiki info box's TipTap nodes + Markdown form
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
   the app-wide fallback for every document. Font, size and alignment are
   shared by both tabs; **zoom has a default per tab** — **Write** starts at
   100% and **Wiki** at 75%, because a lore entry is a page to scan rather than
   prose to read.
2. **Per document** — stored in the file's YAML frontmatter (`font`, `size`,
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

**Zoom** is always document-level, and its percentage is a *reading size*, not
a raw CSS factor: **100% is the comfortable baseline** (an 18px font renders at
36px), so 75% is a smaller comfortable size rather than an unusably tiny one.
The two tabs keep separate defaults (`editorZoom` and `wikiZoom` in
`settings.json`; 100% and 75% on a fresh install), and a document's own
frontmatter `zoom` overrides the default of the tab it lives in. An older
numbering measured the CSS factor directly, where this
size was called 200%; the app rebases those stored values once, on first
launch, and writes the `data/.zoom-rebased` marker so it never halves them
twice. The **Clear** button resets the current selection / section / document
back to inheriting the level above — with the cursor outside any heading
section that drops the document's saved `zoom`, so the entry follows its tab's
default again. Inline font/size styling and block
alignment are written into the Markdown body; section and document styling
live entirely in frontmatter.

## Known limitations

- Markdown round-trips cleanly for prose, headings, formatting, lists, and
  quotes, and for the editor's own raw-HTML markup (inline images, styled
  spans/paragraphs, character tables). Other hand-written HTML — a `<table>`
  from somewhere else, a `<div>` wrapper — is still flattened to its text by
  the WYSIWYG conversion.
- A character table is the editor's own shape, not an importer: an infobox
  copied from a Fandom page (a bare `<table class="infobox">`) comes in as
  flattened text. It holds one portrait, several boxes per entry are allowed,
  and the right-hand float is an app convenience — exports put the box in the
  normal text flow, where a dragged width is not carried over.
- Inline-styled text is stored as `<span style="…">` in the Markdown, and
  per-block aligned text as `<p style="text-align:…">` / `<h2 …>`. A
  hand-written span carrying *both* font-size and font-family keeps only
  font-size when reopened (the editor's own output uses nested spans, which
  round-trip cleanly).
- Wikilinks are inserted as literal `[[...]]` text; the Wiki tab and
  backlinks panel cover navigation.
- Pictures are referenced from the **project root** (`assets/<name>`), so a
  document nested inside a folder resolves them from the project root in an
  external Markdown editor — the app itself always resolves them correctly, and
  the reference survives every move, reorder and rename.
- Remote `https://` pictures display in the editor but are never downloaded, so
  they are left out of exports; SVG is refused entirely (it can carry script).
- Pictures are never deleted automatically. Deleting a document leaves its
  pictures in `assets/` (they may be used elsewhere), so an unused picture is
  pruned by hand from that folder. Copying content between projects does not
  copy the pictures with it — the reference stays but the image shows as
  missing.
- Uploaded pictures are stored byte-for-byte (identified and validated with
  Pillow); they are never re-encoded or compressed.
