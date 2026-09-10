// Editor zoom numbers.
//
// A percentage is a *reading size*, not a CSS factor: 100% is the size the
// editor is comfortable at, which is `zoom: 2` in CSS (an 18px font renders
// at 36px). Values stored in settings.json (`editorZoom`, `wikiZoom`) and in a
// document's frontmatter (`zoom`) are on this scale. The older numbering
// measured the CSS factor directly and was rebased exactly once — what it
// called 200% is 100% now.
//
// Zoom is the one preference with a default per tab: the Write tab reads like
// a manuscript page (100%), the Wiki tab is a reference page meant to be
// scanned (75%). A document's own frontmatter `zoom` still beats either.

export const ZOOM_SCALE = 2;

export const DEFAULT_ZOOM = 100;

export const DEFAULT_WIKI_ZOOM = 75;

export const ZOOM_PRESETS = [75, 90, 100, 110, 125, 150, 200];

/** CSS `zoom` factor for a stored percentage (blank or nonsense -> 100%). */
export function zoomFactor(percent) {
  const n = Number(percent);
  return ((Number.isFinite(n) && n > 0 ? n : DEFAULT_ZOOM) / 100) * ZOOM_SCALE;
}
