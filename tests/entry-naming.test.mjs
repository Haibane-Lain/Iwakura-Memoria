// Unit test for the inline entry-naming rules (static/js/entry-naming.js).
// Run: node tests/entry-naming.test.mjs  (or `npm run test:entrynaming`)
import assert from "node:assert/strict";

import { UNTITLED, renameTarget } from "../static/js/entry-naming.js";

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      ${err && err.message}`);
  }
}

check("the placeholder is a real title", () => {
  assert.equal(UNTITLED, "Untitled");
});

check("a typed name is trimmed and saved", () => {
  assert.equal(renameTarget("  Chapter One  ", UNTITLED), "Chapter One");
});

check("a blank name keeps the placeholder", () => {
  assert.equal(renameTarget("", UNTITLED), null);
  assert.equal(renameTarget("   ", UNTITLED), null);
  assert.equal(renameTarget(null, UNTITLED), null);
  assert.equal(renameTarget(undefined, UNTITLED), null);
});

check("an unchanged name is not saved", () => {
  assert.equal(renameTarget(UNTITLED, UNTITLED), null);
  assert.equal(renameTarget("Chapter One", "Chapter One"), null);
  // Trimming happens before the comparison, so padding does not count as a change.
  assert.equal(renameTarget("  Chapter One  ", "Chapter One"), null);
});

check("a name equal to the placeholder is treated as a change only when it differs", () => {
  assert.equal(renameTarget("Untitled ", "Untitled"), null);
  assert.equal(renameTarget("Untitled 2", "Untitled"), "Untitled 2");
});

if (failures) {
  console.log(`entry-naming: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("entry-naming: all checks passed");
