"""Shared export utilities: markdown parsing, DOCX/HTML generation."""
from __future__ import annotations

import re
from collections.abc import Callable
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import markdown as md_lib
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Emu, Inches, Pt, RGBColor

from app import config
from app.services import documents as documents_service

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")

# Inline images in a document body. The editor writes plain Markdown for an
# unsized picture and inline HTML (``<img … width="300">``) for a resized one,
# but a hand-written body can contain either, in any attribute style — so the
# exporters parse the tags rather than assume a shape.
_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
_IMG_ATTR_RE = re.compile(
    r"""([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"""
)
IMAGE_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
# 96 CSS px per inch; 1 px = 0.75 pt = 9525 EMU.
_PX_PER_INCH = 96.0
_PT_PER_PX = 72.0 / _PX_PER_INCH
_EMU_PER_PX = 9525
# Widest a picture may be in a DOCX export (Letter/A4 body width).
_DOCX_MAX_WIDTH = Inches(6.5)


def _img_attrs(tag: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for match in _IMG_ATTR_RE.finditer(tag):
        value = match.group(2)
        if value is None:
            value = match.group(3)
        if value is None:
            value = match.group(4) or ""
        attrs[match.group(1).lower()] = value
    return attrs


def _attr_esc(value: Any) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def declared_width_px(attrs: dict[str, str]) -> int | None:
    """The ``width`` attribute in CSS px, when it carries a plain number."""
    raw = (attrs.get("width") or "").strip().lower().removesuffix("px").strip()
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def resolve_image_src(project_folder: Path, src: str) -> Path | None:
    """Map a document image ``src`` to a file inside the project, or None.

    Accepts the app's stored form (``assets/<name>``), the served form the
    editor renders (``/api/projects/<id>/assets/<name>``) and any other
    project-relative path that exists. Remote and ``data:`` sources are never
    fetched during an export, so they resolve to None and the picture is left
    out rather than producing a broken reference.
    """
    src = (src or "").strip()
    if not src or src.startswith(("http://", "https://", "data:", "//", "mailto:")):
        return None
    prefix = "/api/projects/"
    if src.startswith(prefix):
        parts = src[len(prefix):].split("/")
        if len(parts) < 3 or parts[1] != config.ASSETS_DIRNAME:
            return None
        src = "/".join([config.ASSETS_DIRNAME, *parts[2:]])
    src = unquote(src.split("?", 1)[0].split("#", 1)[0])
    base = project_folder.resolve()
    try:
        candidate = (project_folder / src).resolve()
    except (OSError, ValueError):
        return None
    if not candidate.is_relative_to(base) or not candidate.is_file():
        return None
    return candidate


def image_px(path: Path) -> tuple[int, int] | None:
    """Pixel size of an image, or None when it can't be read as one.

    Doubles as the exporters' readability check: an entry that fails here is
    dropped from the output instead of being handed to a converter that would
    raise on it (fpdf2, for one, raises on a file it cannot decode).
    """
    try:
        from PIL import Image
    except ImportError:  # pragma: no cover - Pillow ships with fpdf2
        return None
    try:
        with Image.open(path) as im:
            width, height = im.size
            im.verify()
    except Exception:
        return None
    if width < 1 or height < 1:
        return None
    return int(width), int(height)


def image_media_type(path: Path) -> str | None:
    return IMAGE_MEDIA_TYPES.get(path.suffix.lower())


def rewrite_images(
    html: str,
    project_folder: Path,
    transform: Callable[[dict[str, str], Path], dict[str, str] | None],
) -> str:
    """Rewrite every resolvable ``<img>`` in *html*; drop the rest.

    *transform* receives the tag's attributes and the resolved local file, and
    returns the attributes to emit (or None to leave the picture out). An image
    that does not resolve, or that can't be read as an image, is removed
    entirely — so no converter downstream can trip over it.
    """
    def repl(match: re.Match[str]) -> str:
        attrs = _img_attrs(match.group(0))
        path = resolve_image_src(project_folder, attrs.get("src") or "")
        if path is None or image_px(path) is None:
            return ""
        out = transform(attrs, path)
        if not out:
            return ""
        body = " ".join(
            f'{key}="{_attr_esc(value)}"'
            for key, value in out.items()
            if value not in (None, "")
        )
        return f"<img {body}>" if body else "<img>"

    return _IMG_TAG_RE.sub(repl, html)


def pdf_images_html(html: str, project_folder: Path, content_width_pt: float) -> str:
    """Point ``<img>`` tags at local files and give each an explicit point width.

    fpdf2 scales an image to its own pixel size when no width is given, so a
    normal photo would overflow the page; every picture is therefore clamped to
    the printable width here.
    """
    def transform(attrs: dict[str, str], path: Path) -> dict[str, str] | None:
        size = image_px(path)
        if size is None:
            return None
        natural_pt = size[0] * _PT_PER_PX
        declared = declared_width_px(attrs)
        width_pt = min(declared * _PT_PER_PX if declared else natural_pt, content_width_pt)
        out = {"src": path.as_posix(), "width": f"{width_pt:.1f}"}
        if attrs.get("alt"):
            out["alt"] = attrs["alt"]
        return out

    return rewrite_images(html, project_folder, transform)



def md_to_html(body: str) -> str:
    body = _WIKILINK_RE.sub(r"\1", body)
    return md_lib.markdown(
        body,
        extensions=["extra", "codehilite", "sane_lists"],
        output_format="html5",
    )


def build_export_html(project_title: str, documents: list[tuple[str, str, str]]) -> str:
    parts = []
    parts.append(f"<h1 class='project-title'>{_esc(project_title)}</h1>")

    current_folder = None
    for folder_name, doc_title, body in documents:
        if folder_name != current_folder:
            if current_folder is not None:
                parts.append('<div class="page-break"></div>')
            parts.append(f"<h2 class='folder-heading'>{_esc(folder_name)}</h2>")
            current_folder = folder_name
        parts.append(f"<h3 class='doc-title'>{_esc(doc_title)}</h3>")
        parts.append(md_to_html(body))

    return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<style>
  @page {{ size: A4; margin: 2cm 2.5cm; @bottom-center {{ content: counter(page); font-size: 9pt; color: #888; }} }}
  body {{ font-family: "Georgia", "Times New Roman", serif; font-size: 12pt; line-height: 1.6; color: #1a1a1a; }}
  h1.project-title {{ font-size: 22pt; text-align: center; margin-bottom: 1.5cm; }}
  h2.folder-heading {{ font-size: 16pt; margin-top: 2em; border-bottom: 1px solid #ccc; padding-bottom: 0.3em; }}
  h3.doc-title {{ font-size: 14pt; margin-top: 1.5em; }}
  h4 {{ font-size: 13pt; }}
  h5, h6 {{ font-size: 12pt; }}
  p {{ margin: 0.5em 0; text-align: justify; }}
  blockquote {{ margin: 1em 2em; font-style: italic; color: #444; border-left: 3px solid #bbb; padding-left: 1em; }}
  code {{ font-family: "Courier New", monospace; font-size: 10pt; background: #f5f5f5; padding: 1px 4px; }}
  pre {{ background: #f5f5f5; border: 1px solid #ddd; padding: 0.8em; font-size: 10pt; overflow-x: auto; }}
  pre code {{ background: none; padding: 0; }}
  hr {{ border: none; border-top: 1px solid #ccc; margin: 1.5em 0; }}
  ul, ol {{ margin: 0.5em 0; padding-left: 2em; }}
  li {{ margin: 0.2em 0; }}
  .page-break {{ page-break-before: always; }}
</style>
</head>
<body>
{body}
</body>
</html>""".format(title=_esc(project_title), body="\n".join(parts))


def _esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# ---------------------------------------------------------------------------
# Document collection
# ---------------------------------------------------------------------------

def _iter_md_files(project_folder: Path, folder_ids: list[str] | None) -> list[tuple[Path, str]]:
    selected = None
    root_docs = False
    if folder_ids:
        selected = set()
        for fid in folder_ids:
            fid = fid.strip()
            if fid == ".":
                root_docs = True
            elif fid:
                selected.add(fid.rstrip("/").replace("\\", "/"))

    result: list[tuple[Path, str]] = []
    for path in sorted(project_folder.rglob("*.md"), key=lambda p: _sort_path(p, project_folder)):
        rel = path.relative_to(project_folder)
        if ".reorder-tmp" in rel.parts or rel.name.startswith("."):
            continue
        if selected is not None:
            parents = list(rel.parent.parts) if rel.parent != Path(".") else []
            if not _path_matches(parents, selected) and not (root_docs and not parents):
                continue
        folder_name = "/".join(documents_service._display_name(p) for p in rel.parent.parts) if rel.parent != Path(".") else ""
        result.append((path, folder_name))
    return result


def _path_matches(parents: list[str], selected: set[str]) -> bool:
    if not parents:
        return False
    for i in range(1, len(parents) + 1):
        prefix = "/".join(parents[:i])
        if prefix in selected:
            return True
    return False


def _sort_path(path: Path, project_folder: Path) -> tuple:
    parts = path.relative_to(project_folder).parts
    return tuple(documents_service._sort_key(p) for p in parts)


def collect_documents(project_id: str, folder_ids: list[str] | None) -> list[tuple[str, str, str]]:
    """Return list of (folder_display_name, doc_title, body) sorted by order."""
    from app.services.projects import _safe_id, project_dir
    pid = _safe_id(project_id)
    folder = project_dir(pid)
    if not folder.exists():
        raise FileNotFoundError(f"Project '{project_id}' not found")

    result: list[tuple[str, str, str]] = []
    for path, folder_name in _iter_md_files(folder, folder_ids):
        raw = path.read_text(encoding="utf-8", errors="replace")
        meta, body = documents_service.parse_frontmatter(raw)
        title = meta.get("title") or documents_service._display_name(path.stem).replace("-", " ").title()
        title = str(title) if title is not None else "Untitled"
        result.append((folder_name, title, body.strip()))
    return result


# ---------------------------------------------------------------------------
# HTML -> DOCX converter
# ---------------------------------------------------------------------------

class _DocxBuilder(HTMLParser):
    """HTML -> Word. Paragraphs, inline formatting and pictures, plus real Word
    tables so a character table (or any HTML ``<table>``) keeps its rows."""

    TABLE_STRUCTURE = ("table", "thead", "tbody", "tfoot", "tr", "td", "th")
    INLINE_TAGS = ("strong", "b", "em", "i", "code", "a")

    def __init__(self, doc: Document, project_folder: Path | None = None):
        super().__init__()
        self.doc = doc
        self.project_folder = project_folder
        self._para = None
        self._run = None
        self._stack: list[dict] = []
        self._list_depth = 0
        self._ol_counters: list[int] = []
        # While inside a <table> the rows are buffered (the number of columns is
        # only known once every row has been seen) and emitted on </table>.
        self._table: dict | None = None

    def _picture_into(self, run, attrs: dict[str, str], max_width=_DOCX_MAX_WIDTH) -> None:
        """Insert one picture into *run*, scaled to the given maximum width."""
        if self.project_folder is None:
            return
        path = resolve_image_src(self.project_folder, attrs.get("src") or "")
        if path is None or image_px(path) is None:
            return
        declared = declared_width_px(attrs)
        try:
            shape = run.add_picture(
                str(path), width=Emu(declared * _EMU_PER_PX) if declared else None
            )
            if shape.width > max_width:
                shape.height = int(shape.height * max_width / shape.width)
                shape.width = max_width
        except Exception:  # never let one bad picture break an export
            return

    def _add_image(self, attrs: dict[str, str]) -> None:
        """Insert an inline picture at the current spot, in document order.

        Sizing mirrors the PDF export: an explicit Markdown width wins, and
        anything wider than the text column is scaled down with its aspect
        ratio preserved.
        """
        self._picture_into(self._get_run(), attrs)

    # -- table buffering ----------------------------------------------------

    def _table_ignore(self) -> bool:
        return self._table is not None

    def _open_table(self) -> None:
        self._para = None
        self._table = {"rows": [], "row": None, "depth": 1}

    def _open_row(self) -> None:
        if self._table is not None:
            self._table["row"] = []

    def _open_cell(self, tag: str, attrs: dict[str, str]) -> None:
        if self._table is None:
            return
        row = self._table.get("row")
        if row is None:
            row = self._table["row"] = []
        colspan = 1
        raw = (attrs.get("colspan") or "").strip()
        if raw.isdigit() and int(raw) > 1:
            colspan = min(int(raw), 8)
        row.append({"items": [], "bold": tag == "th", "colspan": colspan, "open": True})

    def _close_cell(self) -> None:
        row = self._table.get("row") if self._table else None
        if row:
            row[-1]["open"] = False

    def _close_row(self) -> None:
        if self._table is None:
            return
        row = self._table.get("row")
        if row:
            self._table["rows"].append(row)
        self._table["row"] = None

    def _cell_items(self) -> list | None:
        if self._table is None:
            return None
        row = self._table.get("row")
        if not row or not row[-1].get("open"):
            return None
        return row[-1]["items"]

    def _emit_table(self) -> None:
        table_state = self._table
        self._table = None
        self._para = None
        self._run = None
        if table_state is None:
            return
        rows = [row for row in table_state.get("rows", []) if row]
        if not rows:
            return
        cols = max(len(row) for row in rows)
        table = self.doc.add_table(rows=len(rows), cols=cols)
        try:
            table.style = "Table Grid"
        except Exception:  # a template without the style still gets the table
            pass
        cell_width = Emu(int(_DOCX_MAX_WIDTH) // max(1, cols))
        for r_index, row in enumerate(rows):
            for c_index, cell in enumerate(row):
                if c_index >= cols:
                    break
                target = table.cell(r_index, c_index)
                para = target.paragraphs[0]
                for kind, payload, fmt in cell["items"]:
                    if kind == "image":
                        self._picture_into(para.add_run(), payload, max_width=cell_width)
                        continue
                    run = para.add_run(payload)
                    run.bold = bool(cell["bold"] or "strong" in fmt)
                    run.italic = "em" in fmt
                    if "code" in fmt:
                        run.font.name = "Courier New"
                        run.font.size = Pt(9)
                # A one-cell row (a title/section/portrait row) spans the table.
                if len(row) == 1 and cols > 1:
                    try:
                        target.merge(table.cell(r_index, cols - 1))
                    except Exception:
                        pass

    def _push(self, tag: str, attrs):
        fmt = {}
        for k, v in attrs:
            if k == "class" and "codehilite" in (v or ""):
                fmt["code_block"] = True
        self._stack.append({"tag": tag, **fmt})

    def _pop(self):
        if self._stack:
            self._stack.pop()

    def _top_tag(self) -> str | None:
        return self._stack[-1]["tag"] if self._stack else None

    def handle_starttag(self, tag, attrs):
        attrs_dict = {k: v for k, v in attrs}
        tt = self._top_tag()

        if self._table_ignore():
            # Inside a <table> only the cell text, the marks around it and the
            # pictures are kept; every other tag is a transparent wrapper.
            if tag == "table":
                self._table["depth"] = self._table.get("depth", 1) + 1
                self._push(tag, attrs)
            elif tag == "tr":
                self._open_row()
            elif tag in ("td", "th"):
                self._open_cell(tag, attrs_dict)
            elif tag == "img":
                items = self._cell_items()
                if items is not None:
                    items.append(("image", attrs_dict, frozenset()))
            elif tag in self.INLINE_TAGS:
                self._push(tag, attrs)
            elif tag == "br":
                items = self._cell_items()
                if items is not None:
                    items.append(("text", "\n", frozenset()))
            return

        if tag == "table":
            self._open_table()
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6") or tag == "p":
            self._para = None
            self._push(tag, attrs)
        elif tag == "strong" or tag == "b" or tag == "em" or tag == "i":
            self._push(tag, attrs)
        elif tag == "code":
            if tt == "pre":
                pass
            else:
                self._push(tag, attrs)
        elif tag == "a":
            self._push(tag, attrs)
        elif tag == "img":
            self._add_image(attrs_dict)
        elif tag == "blockquote":
            self._para = None
            self._push(tag, attrs)
        elif tag == "pre":
            self._para = None
            self._push(tag, attrs)
            self._code_lines = []
        elif tag == "ul":
            self._list_depth += 1
            self._push(tag, attrs)
        elif tag == "ol":
            self._list_depth += 1
            self._ol_counters.append(0)
            self._push(tag, attrs)
        elif tag == "li":
            self._push(tag, attrs)
        elif tag == "hr":
            self.doc.add_paragraph("_" * 60)
            p = self.doc.paragraphs[-1]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for r in p.runs:
                r.font.color.rgb = RGBColor(0xBB, 0xBB, 0xBB)
            self._para = None
        elif tag == "br" and self._para is not None:
            self._run = self._para.add_run("\n")

    def handle_endtag(self, tag):
        if self._table_ignore():
            if tag == "table":
                self._pop()
                self._table["depth"] = self._table.get("depth", 1) - 1
                if self._table["depth"] <= 0:
                    self._emit_table()
            elif tag in ("td", "th"):
                self._close_cell()
            elif tag == "tr":
                self._close_row()
            elif tag in self.INLINE_TAGS:
                self._pop()
            return

        if tag in ("h1", "h2", "h3", "h4", "h5", "h6") or tag == "p":
            self._pop()
            self._para = None
        elif tag in ("strong", "b", "em", "i", "code", "a"):
            self._pop()
        elif tag == "blockquote":
            self._pop()
            self._para = None
        elif tag == "pre":
            self._pop()
            text = "".join(getattr(self, "_code_lines", []))
            p = self.doc.add_paragraph()
            run = p.add_run(text)
            run.font.name = "Courier New"
            run.font.size = Pt(10)
            pf = p.paragraph_format
            pf.left_indent = Inches(0.5)
            pf.space_before = Pt(6)
            pf.space_after = Pt(6)
            self._para = None
        elif tag == "ul":
            self._list_depth -= 1
            self._pop()
        elif tag == "ol":
            self._list_depth -= 1
            if self._ol_counters:
                self._ol_counters.pop()
            self._pop()

    def handle_data(self, data):
        if self._table_ignore():
            items = self._cell_items()
            if items is None:
                return
            if not items and not data.strip():
                return
            items.append(("text", data, self._cumulative_fmt()))
            return

        tt = self._top_tag()

        if tt is None or tt == "body":
            return

        if tt == "pre":
            self._code_lines.append(data)
            return

        if self._para is None:
            if tt in ("h1", "h2", "h3", "h4", "h5", "h6"):
                level = int(tt[1])
                self._para = self.doc.add_heading("", level=level)
                self._run = self._para.add_run(data)
            elif tt == "blockquote":
                self._para = self.doc.add_paragraph()
                pf = self._para.paragraph_format
                pf.left_indent = Inches(0.5)
                self._run = self._para.add_run(data)
                self._run.font.italic = True
            elif tt == "p":
                self._para = self.doc.add_paragraph()
                self._run = self._para.add_run(data)
            elif tt == "li":
                if self._list_depth > 0 and self._ol_counters and len(self._ol_counters) >= self._list_depth:
                    self._ol_counters[self._list_depth - 1] += 1
                    self._para = self.doc.add_paragraph(style="List Number")
                else:
                    self._para = self.doc.add_paragraph(style="List Bullet")
                self._run = self._para.add_run(data)
            else:
                return
        else:
            self._run = self._get_run()
            self._run.add_text(data)

    def _get_run(self):
        if self._para is None:
            self._para = self.doc.add_paragraph()
        run = self._para.add_run()
        attrs = self._cumulative_fmt()
        if "strong" in attrs:
            run.bold = True
        if "em" in attrs:
            run.italic = True
        if "code" in attrs:
            run.font.name = "Courier New"
            run.font.size = Pt(10)
        if "a" in attrs:
            run.underline = True
            run.font.color.rgb = RGBColor(0x00, 0x56, 0xB3)
        return run

    def _cumulative_fmt(self) -> set:
        fmt: set = set()
        for item in self._stack:
            tag = item["tag"]
            if tag == "strong" or tag == "b":
                fmt.add("strong")
            elif tag == "em" or tag == "i":
                fmt.add("em")
            elif tag == "code":
                fmt.add("code")
            elif tag == "a":
                fmt.add("a")
        return fmt


def html_to_docx(
    doc: Document,
    html: str,
    title: str | None = None,
    project_folder: Path | None = None,
) -> None:
    if title:
        doc.add_heading(str(title), level=1)
    parser = _DocxBuilder(doc, project_folder)
    parser.feed(html)
    parser.close()
