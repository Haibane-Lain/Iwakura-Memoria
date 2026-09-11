# Roadmap / TODO

Gaps identified in the "what's missing for a robust writing editor" review.
Find & replace shipped, so it is not listed. Each item is `- [ ]`, tagged with a
rough priority (`P1` next, `P2` later, `P3` nice-to-have) and size
(`S` < a day, `M` a few days, `L` a week+).

Legend for hooks: where the work would plug into the current code.

---

## Tier 1 — core writing experience (remaining)

- [ ] **Focus / distraction-free mode + typewriter scrolling** `P1` `M`
  - Hide the sidebar, toolbar, doc header and status bar behind one toggle;
    optionally keep the caret vertically centered (typewriter mode).
  - Hooks: workspace grid in `static/css/app.css` (~355), `topbar()`/`sidebar()`
    in `static/js/project.js`; caret centering is a ProseMirror plugin in
    `client/editor-entry.js`. Persist the toggle in `settings.json`.

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

- [ ] **Editor primitives** `P2` `M`
  - Generic tables, task lists/checkboxes, footnotes/endnotes, text color and
    highlight, super/subscript, and a slash menu.
  - Hooks: extensions in `client/editor-entry.js`; a generic table must
    round-trip through `tiptap-markdown` and the exporters in
    `app/services/export.py`.

- [ ] **Link / inline-code / horizontal-rule toolbar buttons** `P1` `S`
  - The `link`, inline `code`, and `horizontalRule` capabilities exist in the
    editor but no ribbon button reaches them; add a link dialog
    (`setLink`/`unlink`). Hooks: `TOOLBAR` in `static/js/project.js`,
    `run(command)` in `client/editor-entry.js`.

- [ ] **Per-document language + native spellcheck control** `P2` `S`
  - Grammar is hard-coded to `en-US` (`client/editor-entry.js:240`); expose a
    language per document/project and a toggle for the browser spellchecker.

- [ ] **Wikilink autocomplete** `P2` `M`
  - Suggest existing titles while typing `[[`, instead of only the modal
    picker. Hooks: a ProseMirror suggestion plugin in `client/editor-entry.js`;
    titles are in `state.tree`/`state.wikiTree`.

---

## Tier 2 — fiction-craft tools

- [ ] **Comments / annotations / revision mode** `P2` `L`
  - Nothing exists — no model, storage, or UI. Needs a comment model anchored
    to a text range (marks in the Markdown or a sidecar per document), CRUD
    endpoints, an in-editor highlight + sidebar, and a critique/revision pass.
  - Hooks: new `app/services/comments.py` + route; editor extension in
    `client/editor-entry.js`; side panel like `backlinksPanel()`.

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

- [ ] **Thesaurus / dictionary lookup / readability / style linter** `P3` `M`
  - The "dictionary" is only a LanguageTool ignore list. Add a local thesaurus
    and a readability score (Flesch–Kincaid etc.) over the repetition/search
    prose cleanup.
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
- **Splitting `static/js/project.js`** — tripwire: > ~4,000 lines or recurring
  friction. Phase A moved the export, dictionary, repetition, document-history,
  and find & replace dialogs into their own leaf modules (each takes a small
  `ctx` instead of importing back into the shell). Phase B moved the pure halves
  of the shell into `doc-tree.js` (tree flatten/search helpers) and
  `editor-prefs.js` (document/global preference resolution), both with unit
  tests. `project.js` is now ~3,950 lines — just under the tripwire. What remains
  is the editor view/controller (`renderEditorView` / `renderPane` / the `panes`
  records and the per-pane save pipeline); it reaches deep into `state`, so it
  needs a designed context interface rather than a mechanical move.
- **Splitting `app/services/documents.py`** — tripwire: > ~1,800 lines or a
  size-traced bug.
