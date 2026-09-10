// Editor zoom numbers.
//
// A percentage is a *reading size*, not a CSS factor: 100% is the size the
// editor is comfortable at, which is `zoom: 2` in CSS (an 18px font renders
// at 36px). Values stored in settings.json (`editorZoom`) and in a document's
// frontmatter (`zoom`) are on this scale. The older numbering measured the
// CSS factor directly and was rebased exactly once — what it called 200% is
// 100% now.

export const ZOOM_SCALE = 2;

export const DEFAULT_ZOOM = 100;

export const ZOOM_PRESETS = [75, 90, 100, 110, 125, 150, 200];

/** CSS `zoom` factor for a stored percentage (blank or nonsense -> 100%). */
export function zoomFactor(percent) {
  const n = Number(percent);
  return ((Number.isFinite(n) && n > 0 ? n : DEFAULT_ZOOM) / 100) * ZOOM_SCALE;
}
