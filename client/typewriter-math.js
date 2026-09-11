// Pure scroll arithmetic for typewriter mode. Kept free of ProseMirror and DOM
// imports so it can be unit-tested on its own, the way `word-at.js` and
// `wikilink-suggest.js` are; the plugin in `typewriter.js` is a thin shell.

// Where the caret sits in the visible area, 0 = top, 1 = bottom. Halfway is
// the classic typewriter midpoint.
export const TYPEWRITER_RATIO = 0.5;

// How far to move `scrollTop` so the caret lands `ratio` of the way down the
// visible area. `caretTop` and the viewport values share a coordinate space;
// `zoomRatio` converts them into the scroller's scrollTop units when CSS `zoom`
// makes the two differ (see the note in `centerCaret`).
export function typewriterDelta({
  caretTop,
  viewportTop,
  viewportHeight,
  ratio = TYPEWRITER_RATIO,
  zoomRatio = 1,
}) {
  const offset = caretTop - viewportTop;
  const target = viewportHeight * ratio;
  const scale = zoomRatio || 1;
  return (offset - target) / scale;
}
