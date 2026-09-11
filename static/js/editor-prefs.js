// Resolve the effective editor preferences for a document.
//
// Pure: a document's own overrides (frontmatter style), then the user's global
// settings, then the built-in default. Keeping this separate from the DOM and
// from `state` lets the resolution rules be unit tested directly, instead of
// pinned by regex against project.js.
import { DEFAULT_WIKI_ZOOM, DEFAULT_ZOOM } from "./zoom.js";

// Zoom is the one preference with a default *per tab* (see zoom.js). The key
// says which settings field stores that tab's default.
export function zoomKey(scope) {
  return scope === "wiki" ? "wikiZoom" : "editorZoom";
}

export function defaultZoomForScope(settings, wiki) {
  const s = settings || {};
  return (wiki ? s.wikiZoom : s.editorZoom) || (wiki ? DEFAULT_WIKI_ZOOM : DEFAULT_ZOOM);
}

export function effectiveFont(docStyle, settings) {
  return (docStyle || {}).font || (settings || {}).editorFont;
}

export function effectiveSize(docStyle, settings) {
  return (docStyle || {}).size || (settings || {}).editorSize;
}

export function effectiveAlign(docStyle, settings) {
  return (docStyle || {}).align || (settings || {}).editorAlign;
}

export function effectiveZoom(docStyle, settings, wiki) {
  return (docStyle || {}).zoom || defaultZoomForScope(settings, wiki);
}
