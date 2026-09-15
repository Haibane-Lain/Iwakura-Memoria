// Unit test for the per-document editor scroll memory (see
// static/js/editor-scroll.js). Pure: no DOM, no editor.
//
// Run: node tests/editor-scroll.test.mjs  (or `npm run test:editorscroll`)
import assert from "node:assert/strict";

import { createScrollMemory } from "../static/js/editor-scroll.js";

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

check("recall is 0 until something is remembered", () => {
  const memory = createScrollMemory();
  assert.equal(memory.recall("a.md"), 0);
  assert.equal(memory.size, 0);
});

check("remember then recall round-trips per document", () => {
  const memory = createScrollMemory();
  memory.remember("a.md", 321);
  memory.remember("b.md", 12);
  assert.equal(memory.recall("a.md"), 321);
  assert.equal(memory.recall("b.md"), 12);
  assert.equal(memory.size, 2);
});

check("invalid offsets clamp to 0 and empty ids are ignored", () => {
  const memory = createScrollMemory();
  memory.remember("a.md", -5);
  memory.remember("b.md", Number.NaN);
  memory.remember("c.md", null);
  memory.remember("", 999);
  assert.equal(memory.recall("a.md"), 0);
  assert.equal(memory.recall("b.md"), 0);
  assert.equal(memory.recall("c.md"), 0);
  assert.equal(memory.size, 3);
});

check("rekey carries an offset to the new id", () => {
  const memory = createScrollMemory();
  memory.remember("Part/01-a.md", 480);
  memory.rekey("Part/01-a.md", "Part Two/01-a.md");
  assert.equal(memory.recall("Part/01-a.md"), 0);
  assert.equal(memory.recall("Part Two/01-a.md"), 480);

  // No-ops: same id, empty ids, or an id we never remembered.
  memory.rekey("Part Two/01-a.md", "Part Two/01-a.md");
  memory.rekey("", "x");
  memory.rekey("missing.md", "y.md");
  assert.equal(memory.recall("Part Two/01-a.md"), 480);
  assert.equal(memory.size, 1);
});

check("forget and clear", () => {
  const memory = createScrollMemory();
  memory.remember("a.md", 100);
  memory.remember("b.md", 200);
  memory.forget("a.md");
  assert.equal(memory.recall("a.md"), 0);
  assert.equal(memory.recall("b.md"), 200);
  memory.clear();
  assert.equal(memory.size, 0);
  assert.equal(memory.recall("b.md"), 0);
});

if (failures) {
  console.log(`editor-scroll: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("editor-scroll: all checks passed");
