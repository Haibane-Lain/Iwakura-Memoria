"""Layout contracts for the Wiki tab's text column, Contents card and sidebar.

The Wiki tab is deliberately not the Write tab's narrow reading column: a wiki
entry uses the window's width (up to a cap) so a wide window is not mostly
empty, and its Contents card is a compact Fandom-style box that widens only
when a heading needs the room. The sidebar keeps its scroll position while a
document is opened, because Chromium nudges a scrolled container when its
children are replaced, and its search box is pinned outside the scroller so it
stays visible however long the tree gets. The JS tests run in jsdom, which has
no layout engine, so the rules themselves are asserted here.

Run from the workspace root:

    .venv\\Scripts\\python.exe -m pytest tests/ -q
"""
from __future__ import annotations

import re
from pathlib import Path

CSS_PATH = Path(__file__).resolve().parent.parent / "static" / "css" / "app.css"
PROJECT_JS = Path(__file__).resolve().parent.parent / "static" / "js" / "project.js"
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


def test_opening_a_document_keeps_the_sidebar_scroll_position():
    """The sidebar re-render that an entry click triggers only moves the
    ``.active`` highlight, so the list must not move with it.

    Chromium re-picks the scroll anchor of a scrolled container when its
    children are replaced and nudges the offset even though every row comes
    back identical: measured on a real 123-row wiki sidebar (621px tall,
    no layout change at all) the offset moved +21px from scrollTop 543 and
    from 1000, +63px from 2000, while a list short enough not to scroll —
    and a whole-library list scrolled to the top — stayed put. A plain
    ``replaceChildren`` of cloned nodes reproduced it with no app code
    involved, so the fix is to restore the offset around the re-render, on
    the entry-open path only. jsdom has no layout engine and cannot show the
    nudge, hence the wiring is pinned here.
    """
    js = PROJECT_JS.read_text(encoding="utf-8")

    assert re.search(r'import \{ keepScrollTop \} from "\./scroll-keep\.js"', js), (
        "project.js must import keepScrollTop from ./scroll-keep.js"
    )
    assert re.search(r"function renderTree\(sidebarEl, \{ keepScroll = false \} = \{\}\)", js), (
        "renderTree must accept the keepScroll option"
    )
    assert re.search(
        r"keepScrollTop\(scrollEl, \(\) => scrollEl\.replaceChildren\(frag\), keepScroll\)", js
    ), "renderTree must replace its children through keepScrollTop"
    assert not re.search(r"(?m)^\s*scrollEl\.replaceChildren\(frag\);", js), (
        "renderTree must not replace its children directly"
    )
    assert re.search(r"function renderSidebar\(\{ keepScroll = false \} = \{\}\)", js), (
        "renderSidebar must forward the option"
    )
    assert re.search(r"renderTree\(bar, \{ keepScroll \}\)", js), (
        "renderSidebar must pass the option on to renderTree"
    )
    assert js.count("keepScroll: true") == 1, (
        "exactly one caller — opening a document — may pin the list"
    )
    assert re.search(r"renderSidebar\(\{ keepScroll: true \}\)", js), (
        "openDocument is the caller that pins the list"
    )


def test_the_sidebar_search_box_is_pinned_outside_the_scroller():
    """The search box must stay visible however far the tree is scrolled.

    It is a sibling of the scroller, not its first child: inside, it would
    scroll away with the list (and Chromium would have something to reveal
    when the box is refocused after a re-render, which is what used to pull a
    long list back to the top).
    """
    js = PROJECT_JS.read_text(encoding="utf-8")

    assert re.search(r'const pin = el\("div", \{ class: "sidebar-pin" \}\)', js), (
        "sidebar() must build a pinned strip for the search box"
    )
    assert re.search(r"(?m)^\s*pin,\n\s*scroll\n\s*\);", js), (
        "the pinned strip must sit above the scroller"
    )
    assert re.search(r'pinEl\.replaceChildren\(treeSearchRow\(count\)\)', js), (
        "the search box must be rendered into the pinned strip"
    )
    assert not re.search(r"frag\.append\(treeSearchRow\(count\)\)", js), (
        "the search box must not be rendered into the scroller's contents"
    )
    assert re.search(
        r'const pinEl = sidebarEl\.querySelector\("\.sidebar-pin"\)', js
    ), "renderTree must find the pinned strip from the sidebar"

    # The strip keeps its natural height and cannot be squeezed by a long tree,
    # so it is the scroller below it — and only that — that gives.
    decls = _block(".sidebar-pin")
    assert re.search(r"flex\s*:\s*0\s+0\s+auto", decls), (
        ".sidebar-pin must not grow or shrink with the tree"
    )
    assert not re.search(r"overflow\s*:\s*(auto|scroll)", decls), (
        ".sidebar-pin must not be scrollable itself"
    )
