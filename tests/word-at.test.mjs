// Unit tests for the right-click word finder. Pure text in, range out — no
// DOM or ProseMirror, which is exactly why it lives in its own module.
//
// Run: node tests/word-at.test.mjs  (or `npm run test:wordat`)
import assert from "node:assert/strict";

import { wordRange } from "../client/word-at.js";

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

console.log("word-at:");

check("finds the word around an offset inside it", () => {
  assert.deepEqual(wordRange("the quick brown fox", 6), { word: "quick", start: 4, end: 9 });
});

check("finds the word when the offset is on its first or last character", () => {
  assert.deepEqual(wordRange("the quick fox", 4), { word: "quick", start: 4, end: 9 });
  assert.deepEqual(wordRange("the quick fox", 8), { word: "quick", start: 4, end: 9 });
});

check("keeps internal apostrophes and hyphens", () => {
  assert.deepEqual(wordRange("don't look", 2), { word: "don't", start: 0, end: 5 });
  assert.deepEqual(wordRange("a well-known fact", 5), { word: "well-known", start: 2, end: 12 });
});

check("trims surrounding punctuation and quotes", () => {
  assert.deepEqual(wordRange('"hello," she said', 2), { word: "hello", start: 1, end: 6 });
  assert.deepEqual(wordRange("(running)", 3), { word: "running", start: 1, end: 8 });
});

check("returns null off a word", () => {
  assert.equal(wordRange("the  fox", 4), null); // between the two spaces
  assert.equal(wordRange("...", 1), null);
  assert.equal(wordRange("", 0), null);
});

check("ignores single letters", () => {
  assert.equal(wordRange("I am", 0), null);
  assert.equal(wordRange("a", 0), null);
});

check("handles unicode letters", () => {
  assert.deepEqual(wordRange("café déjà", 1), { word: "café", start: 0, end: 4 });
});

check("clamps an out-of-range offset", () => {
  assert.deepEqual(wordRange("alpha", 99), { word: "alpha", start: 0, end: 5 });
  assert.deepEqual(wordRange("alpha", -3), { word: "alpha", start: 0, end: 5 });
});

if (failures) {
  console.log(`word-at: ${failures} failure(s)`);
  process.exit(1);
}
console.log("word-at: ok");
