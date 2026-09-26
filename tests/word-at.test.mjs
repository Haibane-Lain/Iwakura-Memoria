// Unit tests for the right-click word finder. Pure text in, range out — no
// DOM or ProseMirror, which is exactly why it lives in its own module.
//
// Run: node tests/word-at.test.mjs  (or `npm run test:wordat`)
import assert from "node:assert/strict";

import { wordRange, wordRangeAt, inlineText } from "../client/word-at.js";

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

check("a word after an inline image maps document offsets", () => {
  // "The " + image (one position, no text) + "cat sat".
  const children = [
    { isText: true, text: "The ", size: 4 },
    { isText: false, text: "", size: 1 },
    { isText: true, text: "cat sat", size: 7 },
  ];
  // Document offsets: "The " 0..4, image 4..5, "cat" 5..8, " sat" 8..12.
  assert.deepEqual(wordRangeAt(children, 6), { word: "cat", from: 5, to: 8 });
  assert.deepEqual(wordRangeAt(children, 9), { word: "sat", from: 9, to: 12 });
});

check("a word never spans an inline image", () => {
  const children = [
    { isText: true, text: "ab", size: 2 },
    { isText: false, text: "", size: 1 },
    { isText: true, text: "cd", size: 2 },
  ];
  // Document offsets: "ab" 0..2, image 2..3, "cd" 3..5.
  assert.deepEqual(wordRangeAt(children, 1), { word: "ab", from: 0, to: 2 });
  assert.deepEqual(wordRangeAt(children, 3), { word: "cd", from: 3, to: 5 });
  assert.equal(wordRangeAt(children, 2), null, "the image itself has no word");
});

check("inlineText keeps a placeholder per non-text node", () => {
  const { text, docOffsets } = inlineText([
    { isText: true, text: "a", size: 1 },
    { isText: false, text: "", size: 1 },
    { isText: true, text: "b", size: 1 },
  ]);
  assert.equal(text.length, 3);
  assert.equal(text[1], "\uFFFC");
  assert.deepEqual(docOffsets, [0, 1, 2, 3]);
});

if (failures) {
  console.log(`word-at: ${failures} failure(s)`);
  process.exit(1);
}
console.log("word-at: ok");
