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

- [x] **Lain critique pass** `P3` `M` — shipped: the **Review → Critique**
  button reviews the entry on screen in one click; **Review → Entries…** opens
  the multi-entry picker (`static/js/critique-dialog.js`, current document
  pre-checked) and runs the same pass over those entries. Neither opens the Lain
  panel: `runCritique` (`static/js/lain.js`, loop in
  `static/js/critique-run.js`) uses a dedicated session and the non-streaming
  `POST /ai/chat`, then auto-accepts every proposal with `confirm_all`, so Lain
  proposes anchored notes with the `add_comment` tool (`app/ai/tools.py`)
  without a confirmation card per note. The brief is a line edit — grammar,
  sentence structure and flow — and the **annotate** tool class makes
  `add_comment` available in Plan access (read + annotate) without permitting
  prose edits. Accepting writes the note to the comments sidecar and wraps the
  quote in the usual `<span data-cid>` marker
  (`comments_service.wrap_quote`). Reversible via the comments panel's
  **Clear AI notes** (author filter) and the pre-change document snapshot.
- [x] **Hide/display comment highlights** `P2` `S` — shipped: the
  **Review → Marks** ribbon button toggles `commentHighlights` (persisted in
  `settings.json`), applying `#app.comments-hidden` so the anchor paint is
  suppressed while the decorations (and panel reveal) stay live.

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
  - Markdown / plain text / Word (.docx) / zip import is in (Settings → Import
    & export, and the library's *Import…*): folders become folders, frontmatter
    and ordering are kept, Word documents split at Heading 1 with their runs,
    lists, tables, links and pictures converted, images go through the asset
    store, and every import is undoable. See `docs/import.md`.
  - Still to come, behind the same outline contract in
    `app/services/import_docs.py`: EPUB (spine → chapters, needs an `html_to_md`
    reader), Obsidian vaults (`![[embed]]` → assets, `[[note#h|alias]]`
    normalised) and Scrivener (`Binder` XML + RTF → text via a small
    `rtf_to_md`).

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

## Code review findings (2026-09)

A focused review of the shipped features. The data-loss / corruption items were
fixed straight away and are not listed here: reorder staging no longer deletes
documents on a failed move, `createMissingNote` no longer discards unsaved
edits, grammar offsets/replacements are mapped correctly, aligned blocks keep
project-relative image `src`s, `confirm_all` re-applies Access/Mode, and a
project rename carries its snapshots/comments/trash.

### Robustness / races

- [x] **Re-entrancy guards don't guard** `P1` `S` — shipped: `openDocument`
  (`static/js/editor-workspace.js`) and `switchTab` (`static/js/project.js`) take
  a newest-wins token (`static/js/latest-task.js`) and re-check it after every
  `await`, so a superseded run stops before mutating; `newDocument` now refuses a
  repeat click with a real early return. `openDocument` returns whether it opened
  the requested document, and the search/repetition jumps skip their highlight
  when superseded.
- [x] **Missing documents answer 503, not 404** `P2` `S` — shipped:
  `_http_error` in `app/routes/documents.py` now checks `FileNotFoundError`
  (404) before `OSError` (503), matching `comments.py`/`snapshots.py`. Test:
  `tests/test_documents.py::test_missing_document_is_404_not_503`.
- [x] **One bad byte breaks the tree and library** `P1` `S` — shipped: the
  read-only paths `_doc_summary`, `get_document` and `project_word_stats` in
  `app/services/documents.py` now read with `errors="replace"` (like
  `iter_documents`). The read-modify-write paths stay strict on purpose, so a
  save never rewrites a bad byte as U+FFFD. Test:
  `tests/test_documents.py::test_tree_and_stats_tolerate_non_utf8`.
- [x] **Word-stats document count inflates** `P2` `S` — shipped:
  `_word_stats_update` increments `doc_count` only for a document the cache has
  never seen (not on the 0-word → words transition), so the count matches the
  full scan of every chapter/note; `_word_stats_remove_doc` was made consistent.
  Tests: `test_word_stats_doc_count_stable_after_first_save`,
  `test_word_stats_counts_a_document_new_to_the_cache`.
- [x] **Comment-panel + style-control async races** `P2` `M` — shipped:
  `comments-panel.js` reload takes a `latest-task` token and drops a reply whose
  document is no longer current (`reload`, plus a `docId` guard on the
  post-await `ctrl()` mutations); every `api.docs.style` call in `project.js`
  captures `state.currentDocId` and ignores its reply if the writer has since
  switched documents.
- [x] **h4–h6 headings flatten to paragraphs** `P2` `S` — shipped:
  `StyledHeading` now renders levels `[1..6]` with matching CSS; the DOCX
  importer keeps `Heading 4`…`Heading 6` (clamping only 7–9 to `######`) and
  `docs/import.md` says so. `####`…`######` round-trip on load → save.
- [x] **Stale position after an await** `P2` `S` — shipped: a shared
  `client/pending-pos.js` state field maps the insertion point through the edits
  made while an upload is in flight; `insertImageFiles` and
  `setPortraitFromFiles` hold/read it instead of a captured offset.
- [ ] **`wordAt` mixes text and document offsets** `P2` `S` —
  `client/editor-entry.js:130` compares `textContent` offsets with document
  positions, so right-click → Lookup on a word after an inline image selects the
  wrong span and replace lands in the wrong place.
- [ ] **Comment ranges over-merge** `P2` `S` — `client/comments.js:128` joins
  every run sharing a cid, even non-adjacent ones, so reveal selects unrelated
  text between them.
- [ ] **Find panel stuck on "Searching…"** `P3` `S` —
  `static/js/search-dialog.js:171` returns before resetting the status when a
  request is superseded.

### Accessibility & polish

- [ ] **Modal Escape + focus management** `P2` `M` — `static/js/ui.js:46`
  (`showModal`) wires only a backdrop click: no Escape, no focus move/restore,
  no `role="dialog"`. Most dialogs (export, import, repetition, link, lookup,
  dictionary) inherit the gap.
- [ ] **Library leaks project shortcuts** `P2` `S` —
  `static/js/project.js:3599-3645`; `state.project` is never reset, so
  `Ctrl+F`/`Ctrl+W`/`Ctrl+\`/`Ctrl+Shift+D` stay bound on the library screen.
- [ ] **Listener leaks** `P3` `S` — the context menu
  (`static/js/project.js:1214`) can attach a permanent document click handler
  when dismissed before its 0 ms timer, and the color popover (`:2405`) only
  removes its outside-mousedown listener when it fires.
- [ ] **`updateTopbar` throws after leaving a project** `P3` `S` —
  `static/js/project.js:615` dereferences a null `#tb-title`; an in-flight save
  that lands on the library screen surfaces a spurious toast.
- [ ] **Every autosave rebuilds the whole sidebar** `P2` `S` —
  `static/js/editor-workspace.js:1239` calls `renderSidebar()` on each save (up
  to every 800 ms) and can abort an in-progress drag; update just the row.
- [ ] **Heading serializer churns leading markers** `P3` `S` —
  `client/editor-entry.js:520` re-escapes a heading's first `-`/`*`/`+`/`1.`,
  so `# - dash` becomes `# \- dash` on first save.
- [ ] **Wikilink alias whitespace** `P3` `S` —
  `client/editor-entry.js:81` computes the hidden span from the trimmed target,
  so `[[ Target | alias ]]` displays the alias with stray spaces.

### Security / defense-in-depth

- [ ] **Add `PATCH` to the Origin-checked methods** `P2` `S` —
  `app/security.py:37`; the app mutates via PATCH (rename document/folder,
  project update, session rename) but only POST/PUT/DELETE require an Origin.

### Docs / TODO hygiene

- [ ] **README packaging claims contradict the installer section** `P2` `S` —
  `README.md:500` says packaging is "still open" while `:507` documents a shipped
  installer; `:543`'s frozen-server path is wrong (real output is
  `scripts\build\_bundle\server\`).
- [ ] **Reserved paths not enforced** `P2` `S` — `README.md:251` calls
  `templates/` and `dictionary.json` reserved, but `_validate_folder_name` does
  not reject them; a project named "AI Sessions" collides with
  `data/ai-sessions/`.
- [ ] **`.comments/` missing from the data-layout diagram** `P3` `S` —
  `README.md:205-225` omits it even though it holds comment bodies.
- [ ] **Stale TODO / review references** `P3` `S` — Quick-win #1
  (link/code/divider buttons) is already shipped; the "Recent list" marked
  shipped never existed; `TODO.md:60,219-221` and `docs/ai-review.md:23` point at
  the wrong lines/symbols.

### Tests

- [ ] **Wiki resolution + backlinks** `P2` `M` — `app/services/wiki.py` /
  `app/routes/wiki.py` have no real coverage.
- [ ] **Templates service + route** `P2` `S` — zero tests.
- [ ] **Reserved-name enforcement** `P3` `S` — mirror
  `tests/test_assets.py:162` for `templates`/`dictionary.json`, and reject
  `ai-sessions` as a project id.
- [ ] **Electron shell contract** `P3` `M` — `electron/preload.js` vs
  `main.py::_WindowApi`, plus port selection / tree-kill.
- [ ] **Grammar route** `P3` `S` — `POST /api/grammar/check` has no HTTP test.

### Dead code

- [ ] Unused `CharacterCount` extension (`client/editor-entry.js`),
  `.wiki-view` / `.wiki-grid` / `.broken-item` CSS (`static/css/app.css`), and
  dead `build_export_html` (`app/services/export.py`).

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
