# Import

Bring existing writing into a project. Markdown, plain text and Word (`.docx`)
are supported today; EPUB, Obsidian vaults and Scrivener projects slot in
behind the same machinery (see *Adding a format*).

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
- Word documents are split at **Heading 1** by default, so a manuscript arrives
  as chapters; the dialog's checkbox turns that off, and a file with no Heading 1
  is unaffected either way.

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
| `.docx` | Headings, paragraphs, runs, lists, tables, pictures, links | See below. |
| `.zip` | Unpacked, then handled as the files inside | The zip itself is never stored. |

### Word (`.docx`)

The body is walked as XML (tables and pictures keep their place in the text,
tracked insertions are kept and deletions skipped, hyperlinks are readable),
and python-docx is loaded only when a Word document is actually imported.

| Word | Becomes |
|---|---|
| `Heading 1`…`Heading 9`, `Title`, `Subtitle`, or an outline level | `#`…`###` — the editor renders three heading levels, so deeper ones arrive as `###` |
| bold / italic / strikethrough | `**bold**`, `*italic*`, `~~struck~~` |
| underline, superscript, subscript, highlight | `<u>`, `<sup>`, `<sub>`, `<mark>` (inline HTML the editor keeps) |
| a monospaced run | `` `code` `` |
| a hyperlink | `[text](url)` |
| bulleted / numbered lists (from the numbering definition, or the style name) | `- ` / `1. `, indented per level |
| a table | a GFM table, first row as the header; `|` in a cell is escaped |
| a picture | `![alt](assets/…)` — through the image store, so it is validated and deduplicated |
| a page break | `---` |

Known limits, all deliberate:

- **Headings deeper than three levels** flatten to `###`.
- **Blockquotes and hyperlinks cannot round-trip through this app's own DOCX
  export**: it writes a blockquote as an indented italic paragraph and a link as
  coloured underlined text, and neither carries a marker to read back. A Word
  document with real styles keeps both.
- **`.doc`** (the legacy binary format) is refused — save it as `.docx`.
- **Footnotes, endnotes, headers, footers, comments and text boxes** are skipped.
- **WMF/EMF pictures** (common in copy-pasted diagrams) are refused by the image
  store and dropped, like any file that is not a real image.
- Merged table cells are read as separate cells; a multi-paragraph cell is
  joined with a space (GFM has no line break inside one).

The `Split Word documents at Heading 1` option defaults to on: each Heading 1
becomes a document of its own, named after that heading, and anything before the
first one becomes a document named from the file. With no Heading 1 in the file
nothing is split, so the default is harmless for a document that has none.

## Adding a format

`app/services/import_docs.py` keeps readers and the writer apart:

1. A **reader** turns one file into *outline* documents — plain dicts shaped
   `{"kind": "doc", "title", "docKind", "body", "children", "images"}`. Bodies
   are Markdown; an image is carried as `{"key", "name", "bytes"}` with the key
   written into the body as an ordinary Markdown target
   (`![cover](@@img1@@)`), which the writer swaps for the stored
   `assets/<name>` path. A reader may return several documents for one file
   (`.docx` does, when it splits at Heading 1) — see
   `app/services/import_docx.py` for a worked example.
2. **`detect()`** names the bundle kind and adds it to `SUPPORTED_SOURCES`;
   `build_outline()` picks the reader **per file** from its extension, so a
   bundle mixing Markdown and Word imports both. `SOURCE_LABELS` (mirrored in
   `static/js/import-plan.js`, which also owns the dialog's accept list and
   summary) is the only other place to touch.

The writer needs no changes for a new format — it only ever sees an outline.
Its rules (unique names, images through the asset store, zero-delta history
entries) apply to every format automatically.
