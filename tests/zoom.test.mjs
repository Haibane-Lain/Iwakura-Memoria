// Node test for the editor zoom scale (static/js/zoom.js).
// Run: node tests/zoom.test.mjs  (or `npm run test:zoom`)
//
// The whole point of this module is that 100% is a *reading* size: it must
// render at CSS `zoom: 2`, which is what the older numbering called 200%.
// These assertions pin that calibration, because nothing else in the suite
// would notice it drifting back to a bare `percent / 100`.
import assert from "node:assert/strict";

import { DEFAULT_ZOOM, ZOOM_PRESETS, ZOOM_SCALE, zoomFactor } from "../static/js/zoom.js";

// The baseline: 100% is twice the raw CSS factor the old numbering used.
assert.equal(ZOOM_SCALE, 2);
assert.equal(DEFAULT_ZOOM, 100);
assert.equal(zoomFactor(100), 2);
assert.equal(zoomFactor(DEFAULT_ZOOM), 2);

// The rest of the ladder stays relative to that baseline.
assert.equal(zoomFactor(200), 4);
assert.equal(zoomFactor(150), 3);
assert.equal(zoomFactor(125), 2.5);
assert.equal(zoomFactor(110), 2.2);
assert.equal(zoomFactor(90), 1.8);
assert.equal(zoomFactor(75), 1.5);
assert.equal(zoomFactor(50), 1);

// Blank, zero or nonsense falls back to the comfortable baseline rather than
// collapsing the editor to nothing.
for (const bad of [undefined, null, "", 0, -10, NaN, "abc", {}]) {
  assert.equal(zoomFactor(bad), 2, `zoomFactor(${String(bad)})`);
}

// Numeric strings are what the API and blurbs put in front of us.
assert.equal(zoomFactor("100"), 2);
assert.equal(zoomFactor("200"), 4);

// The presets are ascending and bracket the baseline (75% is the small size
// the older numbering showed as 150%).
assert.deepEqual([...ZOOM_PRESETS].sort((a, b) => a - b), ZOOM_PRESETS);
assert.ok(ZOOM_PRESETS.includes(100), "presets include the baseline");
assert.ok(ZOOM_PRESETS.includes(75), "presets include the small size");

console.log("zoom: ok");
