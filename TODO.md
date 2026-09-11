# Roadmap / TODO

Gaps identified in the "what's missing for a robust writing editor" review.
Find & replace shipped, so it is not listed. Each item is `- [ ]`, tagged with a
rough priority (`P1` next, `P2` later, `P3` nice-to-have) and size
(`S` < a day, `M` a few days, `L` a week+).

Legend for hooks: where the work would plug into the current code.

---

## Tier 1 — core writing experience (remaining)

- [x] **Focus / distraction-free mode + typewriter scrolling** `P1` `M` — shipped:
  the topbar **Focus** button (or **Ctrl+Shift+D**) hides the sidebar, toolbar,
  tab strip, doc header and status bar behind a `.focus-mode` class on `#app`;
  the topbar stays so the button flips to **Exit focus**. **Typewriter** keeps
  the caret near the middle of the editor's scroll area (pure arithmetic in
  `client/typewriter-math.js`, the ProseMirror plugin in `client/typewriter.js`).
  Both persist as `focusMode` / `typewriterMode` in `settings.json`.

- [x] **Document tabs, recent documents, split view** `P2` `L` — shipped:
  a tab strip over the warm-editor pool, a per-project collapsible **Recent**
  list, and a two-pane split with a shared focus-following toolbar. (Was:
  A tab strip over the already-existing warm-editor pool
  (`static/js/editor-pool.js`), a recent list persisted per project, and
  optionally two side-by-side editors.
  Hooks: `renderEditorTab` / `openDocument` / `switchTab` in `project.js`.)

- [ ] **In-editor writing targets & session pacing** `P1` `M`
  - Per-document/session word target with a live progress bar, and a sprint
    timer. Today only a project-wide *daily* goal exists.
  - Hooks: `app/services/stats.py`, `stats/history.jsonl`, `renderSettingsTab`
    / `renderStatsTab` and the header word count in `project.js`; frontmatter
    for a per-document target.

- [x] **Editor primitives** `P2` `M` — shipped: generic GFM tables, task lists,
  highlight, text color, super/subscript, and a hand-rolled slash menu
  (`client/editor-primitives.js`, `client/slash-menu.js`, wired from
  `client/editor-entry.js`). Tables and task lists round-trip through
  `tiptap-markdown`; the inline marks have no Markdown spelling and are written
  as inline HTML, which all three exporters carry (`app/services/export.py` —
  DOCX/PDF keep the text, EPUB the markup). Footnotes were split out below.

- [ ] **Footnotes / endnotes** `P2` `L`
  - A body footnote needs a custom inline node, a definitions block the
    serializer moves to the end of the document, and a matching render path in
    the exporters — the half of "Editor primitives" deliberately deferred.
  - Hooks: a new `client/footnotes.js` wired into `client/editor-entry.js`;
    the exporters in `app/services/export.py`.

- [x] **Link / inline-code / horizontal-rule toolbar buttons** `P1` `S` — shipped:
  the **Format** group gained an inline-code button and a **🔗** link button, and
  the **Blocks** group a **—** divider button. The link dialog lives in
  `static/js/link-dialog.js` (pure `normalizeLinkHref`, prefills an existing
  link, offers **Remove link**); the editor bundle exposes
  `setLink`/`unlink`/`insertLink` plus `run("code")`.

- [ ] **Per-document language + native spellcheck control** `P2` `S`
  - Grammar is hard-coded to `en-US` (`client/editor-entry.js:240`); expose a
    language per document/project and a toggle for the browser spellchecker.

- [x] **Wikilink autocomplete** `P2` `M` — shipped: typing `[[` in the editor
  opens a filterable title popup that completes to `[[Title]]`, and offers a
  literal `[[query]]` when nothing matches. Popup in
  `client/wikilink-menu.js`, pure trigger/filter rules in
  `client/wikilink-suggest.js`; titles come from `allDocs()` (Write + Wiki)
  through a `getWikilinkItems` supplier.

---

## Tier 2 — fiction-craft tools

- [x] **Comments / annotations / revision mode** `P2` `L` — shipped: text is
  anchored with a bare inline `<span data-cid="…">` mark (`client/comments.js`),
  while the note body lives in a per-document sidecar at
  `.comments/<project>/<doc-key>.json` (`app/services/comments.py`,
  `app/routes/comments.py`). A **Comments** panel with a composer,
  resolve/edit/delete and unlinked-anchor cleanup (`static/js/comments-panel.js`),
  plus a **Revise** pass that hides grammar underlines and steps through the open
  notes. Bodies are kept in backups; exports strip the anchors. Deferred pieces
  are tracked separately below.

- [ ] **Suggested edits / track changes** `P3` `M`
  - Extend a comment with a proposed replacement for its anchored range and an
    Accept (replace range, resolve, unwrap) / Reject flow in the comments panel.
  - Hooks: a `suggestion` field in `app/services/comments.py`; the accept
    command in `client/comments.js` / `static/js/comments-panel.js`.

- [ ] **Lain critique pass** `P3` `M`
  - Let Lain review a scene and propose comments (quotes + notes) that the
    editor anchors; keep it opt-in and reversible.
  - Hooks: a structured critique prompt over `app/ai/agent.py`; anchoring in
    `static/js/comments-panel.js`.

- [ ] **Cross-document comment index** `P3` `M`
  - The panel is per-document; add a project-wide review queue gathering open
    notes from every document.
  - Hooks: a list-all in `app/services/comments.py`; a workspace view.

- [ ] **Scene / document metadata** `P2` `M`
  - Frontmatter `tags` is read by `get_document` but there is **no way to set,
    filter, or index tags**, and no status / POV / synopsis / word-target /
    custom fields.
  - Hooks: `parse_frontmatter` / `build_frontmatter` / `get_document` /
    `update_style` in `app/services/documents.py`; a metadata editor in
    `docHeader` and sidebar filters in `project.js`.

- [ ] **Outline / corkboard / beat board** `P2` `L`
  - Scrivener-style planning view: cards for scenes with synopsis/status/POV,
    reorderable, mapped back onto the real tree.
  - Hooks: build on the metadata above + `get_tree`
    (`app/services/projects.py`); new tab in `project.js`.

- [ ] **Series / books, cross-project lore, copying between projects** `P3` `L`
  - No grouping or ordering of projects; no shared worldbuilding; documents and
    `assets/` cannot be copied between projects.
  - Hooks: a `series.json` at the data root, `app/services/projects.py`, and a
    "move/copy" path that also carries referenced assets (the README notes
    images do not travel today).

- [x] **Thesaurus / dictionary lookup** `P3` `M` — shipped: offline WordNet
  (`app/services/lookup.py`, `app/routes/lookup.py`) behind a **🔎 Lookup**
  dialog (`static/js/lookup-dialog.js`) with click-to-replace, reachable from
  the ribbon, an editor right-click, and the grammar tooltip. The project
  "dictionary" was renamed **Spelling** so the two are not confused. The
  readability half is tracked separately below.

- [ ] **Readability / style linter** `P3` `M`
  - Flesch–Kincaid and similar scores over the repetition/search prose cleanup,
    plus a passive-voice / adverb pass.
  - Hooks: new service beside `app/services/repetition.py`; toolbar dialog.

---

## Tier 3 — data safety & portability

- [ ] **Import** `P2` `L`
  - None exists: no Markdown, DOCX, TXT, EPUB, Scrivener, or Obsidian import.
    AI attachments only extract read-only text (`app/ai/attachments.py`).
  - Hooks: new `app/services/import_docs.py` + route; reuse `python-docx`,
    `pypdf`, `ebooklib` (already deps for export/attachments); images land in
    `assets/` via `app/services/assets.py`.

- [ ] **In-app backup restore** `P2` `M`
  - Backups can be created, listed, and deleted, but restoring means manually
    unzipping over the data folder.
  - Hooks: `app/services/backup.py` (safe unzip with path traversal guards) +
    `app/routes/backups.py`; button in the Settings "Export & backup" section.

- [ ] **Version compare / diff, named versions, project-wide history** `P2` `M`
  - Snapshots show a single raw-Markdown preview; no side-by-side diff, no
    labels, no whole-project history.
  - Hooks: `app/services/snapshots.py` (add a diff helper + labels) and
    `renderSnapshotsDialog` in `static/js/project.js`.

- [ ] **Asset management** `P2` `S`
  - No way to list or delete images; deleting a document orphans its pictures.
  - Hooks: add `list_assets` / `delete_asset` to `app/services/assets.py` +
    routes; scan document bodies to flag unused files; a manager dialog.

- [ ] **Export breadth** `P3` `M`
  - No single-document / selection export; no Markdown / HTML / plain-text
    export; no page setup or cover options.
  - Hooks: `app/services/projects.py` + `app/services/export.py`;
    `build_export_html` (`export.py:194`) already exists but is dead code and
    can power an HTML export.

- [ ] **Autosave recovery UI** `P2` `S`
  - Last-ditch save exists, but no crash-recovery prompt, and `autosaveMs` is
    API-only (not in Settings).
  - Hooks: `onEditorUpdate` / `flushSave` / `_beforeUnload` in
    `static/js/project.js`; expose `autosaveMs` in `renderSettingsTab`.

---

## Tier 4 — platform

- [ ] **Accessibility** `P2` `M`
  - Essentially no ARIA, no modal focus trapping, no keyboard navigation for
    the tree or context menu; Escape closes only some modals; state is
    color-only.
  - Hooks: `static/index.html`, `static/css/app.css`, `static/js/ui.js`
    (`showModal`/`promptDialog`/`confirmDialog`), sidebar tree in `project.js`.

- [ ] **Sync / collaboration / mobile** `P3` `L` *(intentionally out of scope)*
  - The app is local-first and single-user by design; revisit only if the
    product direction changes.

---

## Quick wins / loose ends

- [ ] Toolbar buttons for `horizontalRule`, `link`, and inline `code`
  (capabilities exist, unreachable from the ribbon).
- [ ] `CharacterCount` extension is loaded but unused (word counts recompute
  from `getText()` each edit).
- [ ] Dead `.wiki-view` / `.wiki-grid` / `.broken-item` CSS in
  `static/css/app.css`.
- [ ] `build_export_html` is dead code (`app/services/export.py:194`).
- [ ] `set_goal` clamps `wordsPerDay` to `>= 1`, so a goal cannot be 0 except
  via `enabled` (`app/services/projects.py:221`).
- [ ] No asset list/delete endpoint (see Asset management above).

---

## Also tracked elsewhere

- **Tiptap v2 → v3 upgrade** — deferred; see GitHub issue #1
  (`@tiptap/core` GHSA-cp6q-959q-f8rh is patched only in 3.30.4). Markdown-only
  storage means the known advisory is not practically reachable.
- **Splitting `static/js/project.js`** — tripwire: > ~4,000 raw lines (`wc -l`,
  blank lines included) or recurring friction. Phase A moved the export,
  dictionary, repetition, document-history, and find & replace dialogs into their
  own leaf modules (each takes a small `ctx`). Phase B moved the pure halves into
  `doc-tree.js` and `editor-prefs.js`. Phase C1 moved the editing surface —
  panes, document tabs, the per-pane save pipeline, and the editor view render —
  into `editor-workspace.js`, with the shared state and the shell-service
  boundary in `project-context.js` (the workspace calls the shell back through a
  registered `shell` object, so there is no import cycle). `project.js` is now
  ~3,000 lines, well under the tripwire. What remains in the shell is the
  sidebar/tree, drag & drop, document actions, settings/stats, and the editor
  chrome (toolbar, style controls, doc header/backlinks, inline images); Phase C2
  folds that chrome into the workspace, and is deferred until a feature needs it.
- **Splitting `app/services/documents.py`** — tripwire: > ~1,800 lines or a
  size-traced bug.
