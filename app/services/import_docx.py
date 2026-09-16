"""DOCX import: a Word document as import-outline nodes.

A reader for :mod:`app.services.import_docs`. It turns one ``.docx`` (or, when
splitting, one Heading 1 per document) into the same plain dicts every other
reader produces, so the writer needs to know nothing about Word.

The document body is walked as **XML**, not through ``document.paragraphs``:
tables and pictures then keep their real position in the text, tracked
insertions (``w:ins``) can be kept while deletions (``w:del``) are skipped, and
hyperlinks — which python-docx has no API for — are readable as ``w:hyperlink``.

Markdown is the target, so anything the editor can represent round-trips:
bold/italic/strike, underline, super/subscript and highlight (the last four as
inline HTML, which the editor keeps), code spans, links, bulleted and numbered
lists, GFM tables and pictures, which are emitted as ``![alt](@@imgN@@)`` and
stored by the writer in the asset folder.

Honest limits, all documented in ``docs/import.md``: headings are clamped to
``###`` because the editor renders three levels; ``.doc`` (legacy binary) is not
readable; footnotes and endnotes, headers and footers, and text boxes are
skipped; WMF/EMF pictures are refused by the image store and dropped. Word also
loses information this app's own export relies on — it flattens blockquotes to
indented italic paragraphs and hyperlinks to coloured underline text — so those
cannot come back.
"""
from __future__ import annotations

import io
import re
from typing import Any

# Namespaces as Clark notation, spelled out so this module needs python-docx
# only inside the reader (Pillow is imported the same way by assets.py).
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_WP = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"
_V = "{urn:schemas-microsoft-com:vml}"

# The editor renders h1-h3 only (StyledHeading's levels); a deeper Word heading
# arrives as an h3 rather than silently losing its heading mark.
MAX_HEADING = 3

_HEADING_RE = re.compile(r"^heading\s*([1-9])$", re.IGNORECASE)
_HEADING_ID_RE = re.compile(r"^heading([1-9])$", re.IGNORECASE)

# A paragraph that merely *starts* like a list item or a heading would otherwise
# be re-read as one by the Markdown parser on the way back in.
_BLOCK_START_RE = re.compile(r"^(\s*)([#>]|[-+*]|\d+[.)])(\s)")

_MONO_FONTS = {
    "consolas",
    "courier",
    "courier new",
    "cascadia code",
    "cascadia mono",
    "dejavu sans mono",
    "lucida console",
    "menlo",
    "monaco",
    "source code pro",
}

_ORDERED_FORMATS = {
    "decimal",
    "decimalZero",
    "lowerLetter",
    "upperLetter",
    "lowerRoman",
    "upperRoman",
    "ordinal",
    "cardinalText",
    "ordinalText",
}

# Container elements whose content is inline text we want.
_DESCEND = ("ins", "smartTag", "sdtContent", "fldSimple")

# Separates the parts of a paragraph that a page break splits in two.
_PAGE_BREAK = "\x00"


class DocxError(ValueError):
    """A ``.docx`` that cannot be read."""


# --------------------------------------------------------------------------
# public entry point
# --------------------------------------------------------------------------


def read_docx(
    path: str,
    raw: bytes,
    *,
    split: bool = True,
    fallback_kind: str = "chapter",
    title: str = "",
) -> list[dict[str, Any]]:
    """Read one ``.docx`` into outline documents.

    ``title`` is the fallback name (the caller derives it from the file name):
    it names the single document when not splitting, and the section before the
    first Heading 1 when splitting.
    """
    from docx import Document

    try:
        document = Document(io.BytesIO(raw))
    except Exception as exc:  # PackageNotFoundError, BadZipFile, lxml errors
        raise DocxError(
            f"Could not read '{path.split('/')[-1]}' as a Word document — "
            "if it is an older .doc file, save it as .docx first"
        ) from exc

    fallback_title = title or "Untitled"
    blocks, images = _read_blocks(document)
    if not split:
        heading_title = _core_title(document) or fallback_title
        return [_node(heading_title, heading_title, blocks, images, fallback_kind)]

    sections = _split_at_heading(blocks, fallback_title)
    nodes = [
        _node(section_title, section_title, section_blocks, images, fallback_kind)
        for section_title, section_blocks in sections
    ]
    # A heading with nothing under it is not a document; if that leaves nothing
    # at all (a blank file, or headings only), the file still imports as one.
    kept = [node for node in nodes if node["body"].strip()]
    return kept or [_node(fallback_title, fallback_title, blocks, images, fallback_kind)]


# --------------------------------------------------------------------------
# body walking
# --------------------------------------------------------------------------


class _Lists:
    """Bullet/ordered markers, numbered per level like Word's own lists."""

    def __init__(self) -> None:
        self._counts: dict[int, int] = {}

    def marker(self, kind: str, level: int) -> str:
        # A shallower item starts a new run of the levels below it.
        for deeper in [depth for depth in self._counts if depth > level]:
            self._counts.pop(deeper, None)
        if kind == "ordered":
            self._counts[level] = self._counts.get(level, 0) + 1
            return f"{self._counts[level]}."
        return "-"

    def end(self) -> None:
        self._counts.clear()


def _read_blocks(document) -> tuple[list[tuple[int, str]], dict[str, dict[str, Any]]]:
    """The body as ``[(heading_level, markdown)]`` blocks (level 0 = body text)."""
    blocks: list[tuple[int, str]] = []
    images: dict[str, dict[str, Any]] = {}
    lists = _Lists()
    for item in document.element.body.iterchildren():
        if item.tag == f"{_W}p":
            blocks.extend(_paragraph_blocks(item, document, images, lists))
        elif item.tag == f"{_W}tbl":
            table = _table_md(item, document, images)
            if table:
                blocks.append((0, table))
            lists.end()
    return blocks, images


def _paragraph_blocks(p, document, images: dict, lists: _Lists) -> list[tuple[int, str]]:
    """One paragraph as (usually) one block: a page break inside it splits it."""
    text = _inline_md(p, document, images)
    level = _heading_level(p, document)
    listing = None if level else _list_info(p, document)
    if listing is None:
        lists.end()
    parts = text.split(_PAGE_BREAK)
    blocks: list[tuple[int, str]] = []
    for index, part in enumerate(parts):
        if index:
            blocks.append((0, "---"))
        stripped = part.strip()
        if not stripped:
            continue
        if level and index == 0:
            blocks.append((level, stripped))
        elif listing is not None:
            kind, depth = listing
            marker = lists.marker(kind, depth) if index == 0 else "1."
            blocks.append((0, f"{'  ' * depth}{marker} {stripped}"))
        else:
            blocks.append((0, _escape_block_start(stripped)))
    return blocks


def _heading_level(p, document) -> int:
    """The paragraph's heading level (1-3), or 0 when it is body text.

    Word's own ``Heading N`` styles are matched by name and by style id, and the
    base-style chain is walked so a custom style ("Chapter", based on "Heading
    1") counts too — with ``w:outlineLvl`` as a last resort for styles that
    carry their level only there.
    """
    style = _paragraph_style(p, document)
    seen = 0
    while style is not None and seen < 5:
        name = (style.name or "").strip()
        match = _HEADING_RE.match(name) or _HEADING_ID_RE.match((style.style_id or "").strip())
        if match:
            return min(int(match.group(1)), MAX_HEADING)
        lowered = name.lower()
        if lowered == "title":
            return 1
        if lowered == "subtitle":
            return 2
        style = style.base_style
        seen += 1
    ppr = p.find(f"{_W}pPr")
    outline = ppr.find(f"{_W}outlineLvl") if ppr is not None else None
    if outline is not None:
        try:
            return min(int(outline.get(f"{_W}val")) + 1, MAX_HEADING)
        except (TypeError, ValueError):
            return 0
    return 0


def _paragraph_style(p, document):
    """The paragraph's resolved style, or None when it cannot be resolved."""
    from docx.text.paragraph import Paragraph

    try:
        return Paragraph(p, document).style
    except (KeyError, ValueError):
        return None


def _list_info(p, document) -> tuple[str, int] | None:
    """``("bullet"|"ordered", level)`` when the paragraph is a list item."""
    ppr = p.find(f"{_W}pPr")
    numpr = ppr.find(f"{_W}numPr") if ppr is not None else None
    level = 0
    if numpr is not None:
        ilvl = numpr.find(f"{_W}ilvl")
        if ilvl is not None:
            try:
                level = max(0, int(ilvl.get(f"{_W}val") or 0))
            except (TypeError, ValueError):
                level = 0
        numid = numpr.find(f"{_W}numId")
        fmt = _number_format(document, numid.get(f"{_W}val") if numid is not None else None)
        if fmt in _ORDERED_FORMATS:
            return ("ordered", level)
        if fmt is not None and fmt != "none":
            return ("bullet", level)
        if fmt == "none":
            return None
    kind = _list_style_kind(p, document)
    return (kind, level) if kind else None


def _list_style_kind(p, document) -> str | None:
    """``"ordered"``/``"bullet"`` from the paragraph's style name, else None."""
    style = _paragraph_style(p, document)
    name = ((style.name or "") if style is not None else "").lower()
    if not name:
        return None
    if "number" in name:
        return "ordered"
    if "list" in name or "bullet" in name:
        return "bullet"
    return None


def _number_format(document, num_id: str | None) -> str | None:
    """The ``w:numFmt`` for a numbering id, or None when it cannot be read.

    Word keeps the level format in ``numbering.xml``: ``w:num`` maps the id a
    paragraph uses to an ``w:abstractNum``, whose first level says bullet or
    decimal. Missing or unreadable numbering is never an import failure — the
    style name is the fallback.
    """
    if not num_id:
        return None
    try:
        element = document.part.numbering_part.element
    except Exception:  # no numbering part, or an unreadable one
        return None
    abstract_id = None
    for num in element.iter(f"{_W}num"):
        if num.get(f"{_W}numId") == str(num_id):
            abstract = num.find(f"{_W}abstractNumId")
            abstract_id = abstract.get(f"{_W}val") if abstract is not None else None
            break
    if abstract_id is None:
        return None
    for abstract in element.iter(f"{_W}abstractNum"):
        if abstract.get(f"{_W}abstractNumId") != str(abstract_id):
            continue
        for lvl in abstract.iter(f"{_W}lvl"):
            if lvl.get(f"{_W}ilvl") not in (None, "0"):
                continue
            fmt = lvl.find(f"{_W}numFmt")
            return fmt.get(f"{_W}val") if fmt is not None else None
    return None


# --------------------------------------------------------------------------
# inline runs
# --------------------------------------------------------------------------


def _inline_md(container, document, images: dict) -> str:
    """The inline Markdown of a paragraph, hyperlink or cell."""
    parts: list[str] = []
    for child in container.iterchildren():
        tag = child.tag
        if tag == f"{_W}r":
            parts.append(_run_md(child, document, images))
        elif tag == f"{_W}hyperlink":
            text = _inline_md(child, document, images)
            target = _relationship_target(document, child.get(f"{_R}id"))
            if text and target:
                parts.append(_wrap(text, "[", f"]({target})"))
            else:
                parts.append(text)
        elif tag.split("}")[-1] in _DESCEND:
            # Tracked insertions are the author's prose; content controls and a
            # field's cached result carry visible text.
            parts.append(_inline_md(child, document, images))
        # w:del (tracked deletions) and everything else is skipped.
    return "".join(parts)


def _run_md(r, document, images: dict) -> str:
    """One run's text with its formatting, and any picture inside it."""
    text: list[str] = []
    for child in r.iterchildren():
        tag = child.tag
        if tag == f"{_W}t":
            text.append(child.text or "")
        elif tag == f"{_W}tab":
            text.append(" ")
        elif tag in (f"{_W}br", f"{_W}cr"):
            text.append(_PAGE_BREAK if child.get(f"{_W}type") == "page" else "\n")
        elif tag in (f"{_W}drawing", f"{_W}pict"):
            picture = _image_md(child, document, images)
            if picture:
                text.append(picture)
        elif tag == f"{_W}noBreakHyphen":
            text.append("-")
        # softHyphen, footnote/endnote references, field codes: dropped.
    return _format_run("".join(text), r.find(f"{_W}rPr"))


def _format_run(text: str, rpr) -> str:
    """A run's text wrapped in the marks its ``w:rPr`` asks for."""
    if not text:
        return text
    if rpr is None:
        return text
    if _is_code(rpr):
        return _wrap(text, "`", "`")
    if _is_on(rpr, "b") and _is_on(rpr, "i"):
        text = _wrap(text, "***", "***")
    elif _is_on(rpr, "b"):
        text = _wrap(text, "**", "**")
    elif _is_on(rpr, "i"):
        text = _wrap(text, "*", "*")
    if _is_on(rpr, "strike"):
        text = _wrap(text, "~~", "~~")
    if _is_on(rpr, "u"):
        text = _wrap(text, "<u>", "</u>")
    vert = rpr.find(f"{_W}vertAlign")
    align = vert.get(f"{_W}val") if vert is not None else None
    if align == "superscript":
        text = _wrap(text, "<sup>", "</sup>")
    elif align == "subscript":
        text = _wrap(text, "<sub>", "</sub>")
    highlight = rpr.find(f"{_W}highlight")
    if highlight is not None and (highlight.get(f"{_W}val") or "none") != "none":
        text = _wrap(text, "<mark>", "</mark>")
    return text


def _is_on(rpr, name: str) -> bool:
    """Whether a toggle property (``w:b``, ``w:i``, ``w:u``, …) is enabled."""
    element = rpr.find(f"{_W}{name}")
    if element is None:
        return False
    value = element.get(f"{_W}val")
    return value is None or value.lower() not in ("false", "0", "none", "off")


def _is_code(rpr) -> bool:
    fonts = rpr.find(f"{_W}rFonts")
    if fonts is None:
        return False
    return any(
        (fonts.get(attr) or "").strip().lower() in _MONO_FONTS
        for attr in (f"{_W}ascii", f"{_W}hAnsi")
    )


def _wrap(text: str, open_mark: str, close_mark: str) -> str:
    """Wrap the text's core, leaving surrounding whitespace outside the marks.

    ``**bold **`` is not emphasis to a Markdown parser, and Word runs routinely
    carry the following space — so the space has to stay outside the markers.
    """
    core = text.strip()
    if not core:
        return text
    lead = text[: len(text) - len(text.lstrip())]
    trail = text[len(text.rstrip()):]
    return f"{lead}{open_mark}{core}{close_mark}{trail}"


# --------------------------------------------------------------------------
# pictures
# --------------------------------------------------------------------------


def _image_md(element, document, images: dict) -> str:
    """``![alt](@@imgN@@)`` for a picture, registering its bytes for the writer."""
    blip = element.find(f".//{_A}blip")
    rid = blip.get(f"{_R}embed") if blip is not None else None
    if not rid:
        # Legacy VML pictures (``w:pict`` -> ``v:imagedata``) name their part too.
        imagedata = element.find(f".//{_V}imagedata")
        rid = imagedata.get(f"{_R}id") if imagedata is not None else None
    part = _related_part(document, rid)
    if part is None:
        return ""
    name = str(getattr(part, "partname", "") or "").split("/")[-1] or "image"
    # The token is the writer's contract: it swaps it for the stored asset path
    # (see import_docs._write_images).
    token = f"@@img{len(images)}@@"
    images[token] = {"key": token, "name": name, "bytes": part.blob}
    return f"![{_image_alt(element)}]({token})"


def _image_alt(element) -> str:
    """A picture's alt text: its description, else its Word-given name."""
    docpr = element.find(f".//{_WP}docPr")
    if docpr is None:
        return ""
    descr = (docpr.get("descr") or "").strip()
    if descr:
        return descr.replace("[", "(").replace("]", ")")
    name = (docpr.get("name") or "").strip()
    # Word names shapes "Picture 1" — no information, so no alt text.
    return "" if re.match(r"^picture\s*\d*$", name, re.IGNORECASE) else name


def _related_part(document, rid: str | None):
    if not rid:
        return None
    try:
        return document.part.related_parts[rid]
    except (KeyError, ValueError):
        return None


def _relationship_target(document, rid: str | None) -> str:
    if not rid:
        return ""
    try:
        rel = document.part.rels[rid]
    except KeyError:
        return ""
    return (rel.target_ref or "") if rel.is_external else ""


# --------------------------------------------------------------------------
# tables
# --------------------------------------------------------------------------


def _table_md(table, document, images: dict) -> str:
    """A GFM table; the first row becomes the header.

    Markdown tables need a header row, so a table with only body rows gets an
    empty one. Cell paragraphs are joined with a space — GFM has no line breaks
    inside a cell — and ``|`` is escaped so it cannot break the row.
    """
    rows: list[list[str]] = []
    for tr in table.iterchildren(f"{_W}tr"):
        cells = [_cell_md(tc, document, images) for tc in tr.iterchildren(f"{_W}tc")]
        if any(cell.strip() for cell in cells):
            rows.append(cells)
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    lines = [_table_row(rows[0]), _table_row(["---"] * width)]
    lines.extend(_table_row(row) for row in rows[1:])
    return "\n".join(lines)


def _cell_md(cell, document, images: dict) -> str:
    texts = [
        text
        for p in cell.iterchildren(f"{_W}p")
        if (text := _inline_md(p, document, images).strip())
    ]
    return " ".join(texts)


def _table_row(cells: list[str]) -> str:
    escaped = [" ".join(cell.split()).replace("|", "\\|") for cell in cells]
    return "| " + " | ".join(escaped) + " |"


# --------------------------------------------------------------------------
# splitting and nodes
# --------------------------------------------------------------------------


def _split_at_heading(blocks: list[tuple[int, str]], title: str) -> list[tuple[str, list]]:
    """Group blocks into ``(title, blocks)`` documents, one per Heading 1."""
    sections: list[tuple[str, list]] = []
    current_title = title
    current: list[tuple[int, str]] = []
    for level, text in blocks:
        if level == 1:
            if any(part.strip() for _, part in current):
                sections.append((current_title, current))
            current_title = text.strip() or current_title
            current = []
            continue
        current.append((level, text))
    if any(part.strip() for _, part in current):
        sections.append((current_title, current))
    return sections or [(title, blocks)]


def _core_title(document) -> str:
    """The document's Title property, when Word wrote one."""
    try:
        return str(document.core_properties.title or "").strip()
    except Exception:
        return ""


def _node(title: str, fallback_title: str, blocks: list[tuple[int, str]], images: dict, kind: str) -> dict:
    body = _join_blocks(blocks)
    return {
        "kind": "doc",
        "title": (title or fallback_title or "Untitled").strip(),
        "docKind": kind,
        "body": body,
        "children": [],
        # Only the pictures this document actually kept.
        "images": [image for token, image in images.items() if token in body],
    }


def _join_blocks(blocks: list[tuple[int, str]]) -> str:
    parts: list[str] = []
    for level, text in blocks:
        # Only the trailing whitespace goes: a nested list item's indent is
        # meaningful and must survive to the Markdown.
        text = text.rstrip()
        if not text.strip():
            continue
        parts.append(f"{'#' * level} {text}" if level else text)
    return "\n\n".join(parts)


def _escape_block_start(text: str) -> str:
    """Keep a paragraph that opens like a list or heading from being re-read as one.

    Only the delimiter is escaped (``1\\.``, not ``\\1.``), which is what a
    Markdown parser expects.
    """
    match = _BLOCK_START_RE.match(text)
    if not match:
        return text
    marker = match.group(2)
    marker = f"{marker[:-1]}\\{marker[-1]}" if marker[-1] in ".)" else f"\\{marker}"
    return f"{match.group(1)}{marker}{match.group(3)}{text[match.end():]}"
