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

- [x] **Document tabs & split view** `P2` `L` — shipped: a tab strip over the
  warm-editor pool (`static/js/doc-tabs.js`, persisted per project in
  `static/js/editor-workspace.js`) and a two-pane split with a shared
  focus-following toolbar.

- [ ] **Per-project Recent documents list** `P3` `S`
  - A collapsible **Recent** list in the sidebar, persisted per project.
  - Originally bundled into the "Document tabs, recent documents, split view"
    item but never built — the `recent` field in the saved tabs payload was a
    no-op. Hooks: `static/js/doc-tabs.js`, `persistTabs` / `renderSidebar`.

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
  - Grammar is hard-coded to `en-US` (`client/editor-entry.js:354`); expose a
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
  - **Grouping shipped**: the landing page is now a worlds library — worlds,
    series and books (a book is a project), with create/rename/delete,
    drag-to-reorder, move between series, and uploaded covers. Stored in
    `worlds.json` at the data root (`app/services/worlds.py`,
    `app/services/covers.py`, `static/js/world.js`).
  - Still to come: cross-project reference (shared worldbuilding) and
    copying documents / `assets/` between projects (the README notes images do
    not travel today).

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
    `build_export_html` (`export.py:271`) already exists but is dead code and
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

- [ ] `CharacterCount` extension is loaded but unused (word counts recompute
  from `getText()` each edit).
- [ ] Dead `.wiki-view` / `.wiki-grid` / `.broken-item` CSS in
  `static/css/app.css`.
- [ ] `build_export_html` is dead code (`app/services/export.py:271`).
- [ ] `set_goal` clamps `wordsPerDay` to `>= 1`, so a goal cannot be 0 except
  via `enabled` (`app/services/projects.py:236`).
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
- [x] **`wordAt` mixes text and document offsets** `P2` `S` — shipped:
  `client/word-at.js` gained `inlineText`/`wordRangeAt`, which map a document
  offset (counting inline images) to a text index and back, using a placeholder
  so a word never spans an image; `wordAt` uses them. Tests:
  `tests/word-at.test.mjs`.
- [x] **Comment ranges over-merge** `P2` `S` — shipped: `collectCommentRanges`
  now reports one entry per contiguous run (adjacent runs merge, gaps split), so
  `revealComment` selects the first run instead of the text between two; the
  panel's `anchoredMap` takes the first run and dedupes orphan markers. Tests:
  `tests/editor-comments.test.mjs`.
- [x] **Find panel stuck on "Searching…"** `P3` `S` — shipped: the
  "no document is open" branch of `run()` clears the status, which the
  superseded in-flight request deliberately leaves alone. Test:
  `tests/search-dialog.test.mjs`.

### Accessibility & polish

- [x] **Modal Escape + focus management** `P2` `M` — shipped: `static/js/ui.js`
  gained a shared `presentDialog` (dialog stack, capture Escape that closes only
  the top-most and defers to a menu/palette on top, focus move + restore,
  `role="dialog"`/`aria-modal`, and a `close`/`dismiss` split with `onDismiss`).
  `showModal`, `promptDialog` and `confirmDialog` use it; `project.js`'s
  duplicate `showModalFromUI` is gone, the image lightbox and critique dialog
  drop their own Escape handlers, and the hand-rolled spelling dialog opts in.
  A backdrop click now also resolves a prompt/confirm instead of hanging. Test:
  `tests/ui-modal.test.mjs`.
- [x] **Library leaks project shortcuts** `P2` `S` — shipped:
  `router.onLeave(name, fn)` fires on a route-name change; `project.js` factors
  its reset block into `teardownProject()` (called at the top of `init` and on
  leaving the project), clearing `state.project` and friends so the global
  shortcuts go inert and a failed project load no longer keeps the old one.
  Covered in `tests/app-smoke.test.mjs`.
- [x] **Listener leaks** `P3` `S` — shipped: the context menu's deferred click
  listener and the color palette's outside-mousedown listener are now removed by
  their cleanup (and their timers cleared), so a popover dismissed before the
  0 ms timer cannot leave a stray listener behind. Covered in
  `tests/app-smoke.test.mjs`.
- [x] **`updateTopbar` throws after leaving a project** `P3` `S` — shipped:
  `updateTopbar` returns early with no `state.project`, null-checks `#tb-title`,
  and re-checks the project and `#tb-goal` after the stats fetch; the save path's
  `updateTreeWords` tolerates null trees and `refreshWiki` guards too. Covered in
  `tests/app-smoke.test.mjs`.
- [x] **Every autosave rebuilds the whole sidebar** `P2` `S` — shipped:
  `updateTreeWords` now calls a new `shell.updateDocRow` that repaints just the
  matching `.words` spans instead of `renderSidebar()`, so a save no longer
  rebuilds the tree or cancels a drag. Covered in `tests/app-smoke.test.mjs`.
- [x] **Heading serializer churns leading markers** `P3` `S` — shipped:
  `serializeStyledBlock` renders heading inline content with
  `fromBlockStart = false` (the `#` marker already consumed line start), so
  `# - dash` round-trips. `*` stays escaped (prosemirror-markdown escapes it
  everywhere). Covered in `tests/editor-markdown.test.mjs`.
- [x] **Wikilink alias whitespace** `P3` `S` — shipped: `wikilinkDecorations`
  measures the hidden span from the raw match groups and shows the trimmed
  label, so `[[ Target | alias ]]` displays `alias` (and `[[ Alice ]]`
  displays `Alice`). Covered in `tests/editor-primitives.test.mjs`.

### Security / defense-in-depth

- [x] **Add `PATCH` to the Origin-checked methods** `P2` `S` — shipped:
  `app/security.py` now lists PATCH in `_STATE_CHANGING_METHODS` (docstring and
  README updated), so the project/document/folder/session PATCH routes require a
  loopback `Origin` like the other mutating methods. Covered in
  `tests/test_security.py`.

### Docs / TODO hygiene

- [x] **README packaging claims contradict the installer section** `P2` `S` —
  shipped: the Electron dev-mode note no longer says packaging is "still open"
  (it points at **Distribution**), and the frozen-server smoke-test path is now
  `scripts\build\_bundle\server\Iwakura-Memoria-server.exe` (the `app.spec`
  docstring exe name was fixed too).
- [x] **Reserved paths not enforced** `P2` `S` — shipped: `templates/` and
  `dictionary.json` joined `config.RESERVED_FOLDER_NAMES` (so
  `_validate_folder_name` rejects them), and `is_safe_project_id` now rejects
  the data-root `ai-sessions` slug. `DICTIONARY_FILENAME` moved to `config`.
  Covered in `tests/test_ids.py`.
- [x] **`.comments/` missing from the data-layout diagram** `P3` `S` — shipped:
  the README diagram now lists `.comments/<project>/` beside the trash and
  snapshots.
- [x] **Stale TODO / review references** `P3` `S` — shipped: removed the
  duplicated Quick-win toolbar-buttons entry; split the "Recent list" out of the
  shipped tabs item (it was never built) into an open item and dropped the stale
  `recent` no-op, comments included; corrected the grammar/export/set_goal line
  refs in `TODO.md` and `_limit_body_size` → `BodySizeLimitMiddleware` in
  `docs/ai-review.md`.

### Tests

- [x] **Wiki resolution + backlinks** `P2` `M` — shipped: `tests/test_wiki.py`
  covers `resolve_wikilink` (id / title / normalized-id / missing) and `get_wiki`
  (links, backlinks, deduped pairs, `linkCounts`, per-doc broken targets,
  wiki-folder categories) plus the `GET /api/projects/{id}/wiki` route.
- [x] **Templates service + route** `P2` `S` — shipped: `tests/test_templates.py`
  covers default seeding, create/update/delete (slugging, duplicates, blank
  names, section cleanup, missing → 404) and the GET/POST/PUT/DELETE routes.
- [x] **Reserved-name enforcement** `P3` `S` — shipped with the "Reserved paths
  not enforced" fix: `tests/test_ids.py` covers `templates`/`dictionary.json` as
  user folder names and `ai-sessions` as a project id (pure + HTTP).
- [x] **Electron shell contract** `P3` `M` — shipped:
  `tests/test_electron_contract.py` pins `main.py::_WindowApi` ↔
  `electron/preload.js` methods and every preload→`ipcMain.handle` channel; the
  free-port scan and tree-kill moved to `electron/lifecycle.js` (added to the
  packaged files) and are covered by `tests/electron-lifecycle.test.mjs`.
- [x] **Grammar route** `P3` `S` — shipped: `tests/test_grammar.py` now covers
  `GET /api/grammar/status` and `POST /api/grammar/check` (200 with forwarded
  arguments, 503 when unavailable, 422 without `text`).

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
