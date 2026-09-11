// Unit tests for the typewriter-mode scroll arithmetic. Pure numbers in,
// numbers out — no DOM or ProseMirror, which is why it lives on its own.
//
// Run: node tests/typewriter.test.mjs  (or `npm run test:typewriter`)
import assert from "node:assert/strict";

import { TYPEWRITER_RATIO, typewriterDelta } from "../client/typewriter-math.js";

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

console.log("typewriter:");

check("a caret already at the midpoint needs no scroll", () => {
  assert.equal(
    typewriterDelta({ caretTop: 300, viewportTop: 0, viewportHeight: 600 }),
    0
  );
});

check("a caret below the midpoint scrolls down", () => {
  assert.equal(
    typewriterDelta({ caretTop: 450, viewportTop: 0, viewportHeight: 600 }),
    150
  );
});

check("a caret above the midpoint scrolls up", () => {
  assert.equal(
    typewriterDelta({ caretTop: 100, viewportTop: 0, viewportHeight: 600 }),
    -200
  );
});

check("the viewport top is subtracted, not assumed to be zero", () => {
  assert.equal(
    typewriterDelta({ caretTop: 850, viewportTop: 500, viewportHeight: 600 }),
    50
  );
});

check("the ratio controls the resting line", () => {
  assert.equal(
    typewriterDelta({ caretTop: 100, viewportTop: 0, viewportHeight: 600, ratio: 0.25 }),
    -50
  );
  assert.equal(TYPEWRITER_RATIO, 0.5);
});

check("zoomRatio converts scaled coordinates into scrollTop units", () => {
  // rect (caret/viewport) at CSS zoom 2, scrollTop unzoomed: halve the move.
  assert.equal(
    typewriterDelta({
      caretTop: 1200,
      viewportTop: 0,
      viewportHeight: 1200,
      zoomRatio: 2,
    }),
    300
  );
});

check("a zero zoomRatio falls back to 1 instead of dividing by zero", () => {
  assert.equal(
    typewriterDelta({ caretTop: 450, viewportTop: 0, viewportHeight: 600, zoomRatio: 0 }),
    150
  );
});

if (failures) {
  console.log(`typewriter: ${failures} failure(s)`);
  process.exit(1);
}
console.log("typewriter: ok");
