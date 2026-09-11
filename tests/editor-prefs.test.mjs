// Unit tests for the editor preference resolution. These are the rules the
// zoom-scope source pins used to guard by regex; here they are checked by
// behaviour, with the values passed in.
//
// Run: node tests/editor-prefs.test.mjs  (or `npm run test:editorprefs`)
import assert from "node:assert/strict";

import {
  zoomKey,
  defaultZoomForScope,
  effectiveFont,
  effectiveSize,
  effectiveAlign,
  effectiveZoom,
} from "../static/js/editor-prefs.js";
import { DEFAULT_ZOOM, DEFAULT_WIKI_ZOOM } from "../static/js/zoom.js";

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}\n      ${err.message}`);
  }
}

const SETTINGS = {
  editorFont: "serif",
  editorSize: 18,
  editorAlign: "left",
  editorZoom: 100,
  wikiZoom: 150,
};

console.log("editor-prefs:");

check("zoomKey maps the tab to its settings field", () => {
  assert.equal(zoomKey("wiki"), "wikiZoom");
  assert.equal(zoomKey("write"), "editorZoom");
  assert.equal(zoomKey(undefined), "editorZoom");
});

check("defaultZoomForScope reads the tab's saved default", () => {
  assert.equal(defaultZoomForScope(SETTINGS, false), 100);
  assert.equal(defaultZoomForScope(SETTINGS, true), 150);
});

check("defaultZoomForScope falls back to the built-in default", () => {
  assert.equal(defaultZoomForScope({}, false), DEFAULT_ZOOM);
  assert.equal(defaultZoomForScope({}, true), DEFAULT_WIKI_ZOOM);
  assert.equal(defaultZoomForScope(null, false), DEFAULT_ZOOM);
  assert.equal(defaultZoomForScope(null, true), DEFAULT_WIKI_ZOOM);
});

check("a document override beats the global setting, which beats the default", () => {
  assert.equal(effectiveFont({}, SETTINGS), "serif");
  assert.equal(effectiveFont({ font: "Charter" }, SETTINGS), "Charter");
  assert.equal(effectiveFont(null, SETTINGS), "serif");

  assert.equal(effectiveSize({}, SETTINGS), 18);
  assert.equal(effectiveSize({ size: 24 }, SETTINGS), 24);

  assert.equal(effectiveAlign({}, SETTINGS), "left");
  assert.equal(effectiveAlign({ align: "center" }, SETTINGS), "center");
});

check("effectiveZoom resolves the document override, then the tab default", () => {
  assert.equal(effectiveZoom({}, SETTINGS, false), 100);
  assert.equal(effectiveZoom({}, SETTINGS, true), 150);
  assert.equal(effectiveZoom({ zoom: 200 }, SETTINGS, false), 200);
  assert.equal(effectiveZoom({ zoom: 200 }, SETTINGS, true), 200);
  assert.equal(effectiveZoom(null, {}, false), DEFAULT_ZOOM);
});

if (failures) {
  console.log(`editor-prefs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("editor-prefs: ok");
