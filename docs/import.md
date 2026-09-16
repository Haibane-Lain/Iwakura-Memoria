# Import

Bring existing writing into a project. Markdown and plain text are supported
today; DOCX, EPUB, Obsidian vaults and Scrivener projects slot in behind the
same machinery (see *Adding a format*).

## Where it lives

| Entry point | What it does |
|---|---|
| **Library → Import…** | Creates a new project from the bundle, then opens it. |
| **Settings → Import & export → Import…** | Imports into the open project (target folder: *Place inside*). |

Both open the same dialog: pick files, or pick a folder (Chromium's folder
picker; the browser reads the files and their relative paths). A `.zip` can be
picked instead of a folder — the server unpacks it. Nothing already in the
project is ever modified: an import always creates a new, uniquely-named
folder, and re-importing the same bundle gives `Act One`, `Act One-2`, …

## What a bundle becomes

- Folders become folders, files become documents.
- Order follows the numeric `NN-` prefixes, then the file name — the same rule
  the tree itself uses.
- A document's title is its frontmatter `title`, else its file name
  (`03-the-old-house.md` → “The Old House”).
- Frontmatter `type: note|chapter` and `tags` are carried over; otherwise the
  dialog's **Import as** setting decides.
- A single picked file lands directly in the target folder (no wrapper); a
  picked folder or archive becomes one folder named after it.
- Tooling junk is skipped: `.obsidian/`, `.git/`, `__MACOSX/`, `node_modules/`,
  `.DS_Store`, hidden crash-staging folders.

## Safety rails

- **Never overwrites.** Every entry is created through the same unique-naming
  and validation rules the rest of the app uses.
- **Archive paths are labels, not paths.** A zip entry called `../../evil.md`
  becomes a document *inside* the project — it cannot walk out of it.
- **Images** go through the image store, so they are content-validated
  (a text file renamed `.png` is refused) and deduplicated by digest. A picture
  the store refuses is dropped from the body instead of failing the import.
- **Stats stay honest.** Imported words are recorded with a zero delta: they
  count towards the project's totals, but never as words written today.
- **Caps.** 25 MB per import and 5000 files (the request itself is capped at
  27 MB by the body-size middleware). Text scales far beyond this; an
  image-heavy archive or vault is what can hit it. Batching is not implemented
  — if you hit the cap, import in pieces.
- **Undo.** The completion toast offers *Undo*, which moves the imported folder
  (or the single imported document) to the Trash.

## Fidelity, by format

| Format | Reads | Notes |
|---|---|---|
| `.md`, `.markdown` | Body verbatim, frontmatter `title`/`type`/`tags` | Wikilinks are kept as-is; `[[Note]]` already resolves by title. |
| `.txt`, `.text` | Body verbatim, CRLF normalised | No frontmatter. |
| `.zip` | Unpacked, then handled as the files inside | The zip itself is never stored. |

## Adding a format

`app/services/import_docs.py` keeps readers and the writer apart:

1. A **reader** turns a bundle (a flat list of `(relative_path, bytes)`) into an
   *outline* — a tree of `{"kind": "folder"|"doc", "title", "docKind", "body",
   "children", "images"}`. Bodies are Markdown; an image is carried as
   `{"key", "name", "bytes"}` with the key written into the body as an ordinary
   Markdown target (`![cover](@@img1@@)`), which the writer swaps for the
   stored `assets/<name>` path.
2. **`detect()`** names the bundle kind, and `build_outline()` dispatches to the
   reader. `SOURCE_LABELS` (mirrored in `static/js/import-plan.js` for the
   dialog's summary) is the only other place to touch.

The writer needs no changes for a new format — it only ever sees an outline.
Its rules (unique names, images through the asset store, zero-delta history
entries) apply to every format automatically.
