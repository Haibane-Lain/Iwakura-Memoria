"""Layout contracts for the Wiki tab's text column and Contents card.

The Wiki tab is deliberately not the Write tab's narrow reading column: a wiki
entry uses the window's width (up to a cap) so a wide window is not mostly
empty, and its Contents card is a compact Fandom-style box that widens only
when a heading needs the room. The JS tests run in jsdom, which has no layout
engine, so the rules themselves are asserted here.

Run from the workspace root:

    .venv\\Scripts\\python.exe -m pytest tests/ -q
"""
from __future__ import annotations

import re
from pathlib import Path

CSS_PATH = Path(__file__).resolve().parent.parent / "static" / "css" / "app.css"
WRITE_COLUMN = 760
WIKI_COLUMN_MIN = 1000
CONTENTS_MIN = 200


def _block(selector: str) -> str:
    """Declarations of the first rule whose selector starts a line.

    The ^ anchor matters: ``.wiki-host .ProseMirror`` is declared before the
    bare ``.ProseMirror`` rule, so an unanchored search would read the wrong
    block.
    """
    css = CSS_PATH.read_text(encoding="utf-8")
    match = re.search(r"(?m)^\s*" + re.escape(selector) + r"\s*\{([^}]*)\}", css)
    assert match, f"no rule found for {selector!r} in {CSS_PATH.name}"
    return match.group(1)


def _px(decls: str, prop: str, selector: str) -> int:
    """First px length in a declaration's value (e.g. min(280px, 100%))."""
    match = re.search(rf"(?<![\w-]){prop}\s*:\s*([^;]*)", decls)
    assert match, f"{selector!r} does not set {prop}: {decls.strip()!r}"
    value = match.group(1)
    number = re.search(r"(\d+)px", value)
    assert number, f"{selector!r} does not set {prop} in px: {value.strip()!r}"
    return int(number.group(1))


def test_wiki_column_uses_the_window_width():
    """The Wiki tab's cap must be far above the Write tab's reading column,
    otherwise a wide window is mostly empty to the right of the text."""
    decls = _block(".wiki-host .ProseMirror")
    assert _px(decls, "max-width", ".wiki-host .ProseMirror") >= WIKI_COLUMN_MIN


def test_write_tab_column_is_untouched():
    """The Write tab keeps its narrow centred reading column."""
    decls = _block(".ProseMirror")
    assert _px(decls, "max-width", ".ProseMirror") == WRITE_COLUMN
    assert re.search(r"margin\s*:\s*0\s+auto", decls)


def test_contents_box_is_compact_and_grows_with_its_content():
    """The Contents card is sized to its content, not stretched to the
    column, but it can still widen for a long heading."""
    decls = _block(".nav-box")
    assert not re.search(r"(?<![\w-])width\s*:\s*100%", decls)
    assert re.search(r"width\s*:\s*fit-content", decls)
    assert _px(decls, "min-width", ".nav-box") >= CONTENTS_MIN
    assert re.search(r"max-width\s*:\s*100%", decls)
