// Pure scroll arithmetic shared by typewriter mode and "reveal this position"
// navigation (find results, comments, headings). Kept free of ProseMirror and
// DOM imports so it can be unit-tested on its own, the way `word-at.js` and
// `wikilink-suggest.js` are; the DOM shells live in `typewriter.js`.

// Where the caret sits in the visible area, 0 = top, 1 = bottom. Halfway is
// the classic typewriter midpoint.
export const TYPEWRITER_RATIO = 0.5;

// How far to move `scrollTop` so the target line lands `ratio` of the way down
// the visible area. `targetTop` (or `caretTop`, its typewriter-era name) and
// the viewport values share a coordinate space; `zoomRatio` converts them into
// the scroller's scrollTop units when CSS `zoom` makes the two differ (see the
// note in `scrollPosIntoView`).
export function scrollDelta({
  targetTop,
  caretTop,
  viewportTop,
  viewportHeight,
  ratio = TYPEWRITER_RATIO,
  zoomRatio = 1,
}) {
  const top = targetTop == null ? caretTop : targetTop;
  const offset = top - viewportTop;
  const target = viewportHeight * ratio;
  const scale = zoomRatio || 1;
  return (offset - target) / scale;
}

// The typewriter's original name for the same arithmetic; kept so the existing
// plugin, callers and tests read naturally.
export const typewriterDelta = scrollDelta;

// Keep the resulting `scrollTop` inside the scrollable range. Negative below 0
// and never past the last pixel a scroller can reach.
export function clampScrollTop(
  delta,
  scrollTop,
  scrollHeight,
  viewportHeight
) {
  const max = Math.max(0, scrollHeight - viewportHeight);
  const next = (Number(scrollTop) || 0) + (Number(delta) || 0);
  return Math.min(max, Math.max(0, next));
}
