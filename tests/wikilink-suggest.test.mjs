// Unit tests for the `[[wikilink]]` autocomplete helpers. Pure text in, ranges
// and lists out — no DOM or ProseMirror, which is why they live on their own.
//
// Run: node tests/wikilink-suggest.test.mjs  (or `npm run test:wikilinksuggest`)
import assert from "node:assert/strict";

import {
  filterWikilinkItems,
  isInsideWikilink,
  matchWikilinkTrigger,
  wikilinkText,
} from "../client/wikilink-suggest.js";

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

console.log("wikilink-suggest:");

check("detects an open [[ and reports the query", () => {
  assert.deepEqual(matchWikilinkTrigger("See [[Ali"), { start: 4, query: "Ali" });
  assert.deepEqual(matchWikilinkTrigger("[["), { start: 0, query: "" });
  assert.deepEqual(matchWikilinkTrigger("[[Alice Sm"), { start: 0, query: "Alice Sm" });
});

check("uses the most recent [[ when a block holds several", () => {
  assert.deepEqual(matchWikilinkTrigger("[[Alice]] then [[Bo"), { start: 15, query: "Bo" });
});

check("ignores finished links, aliases and stray brackets", () => {
  assert.equal(matchWikilinkTrigger("[[Alice]]"), null);
  assert.equal(matchWikilinkTrigger("[[Alice|Al"), null);
  assert.equal(matchWikilinkTrigger("[[Alice]\n"), null);
  assert.equal(matchWikilinkTrigger("no link here"), null);
  assert.equal(matchWikilinkTrigger("[[[["), null);
});

check("spots a caret inside an already-closed link", () => {
  assert.equal(isInsideWikilink("ce]]"), true);
  assert.equal(isInsideWikilink("]] and [[more"), true);
  assert.equal(isInsideWikilink(""), false);
  assert.equal(isInsideWikilink("more text"), false);
  assert.equal(isInsideWikilink(" and [[Alice]]"), false);
});

const items = [
  { id: "w/1", title: "Mara" },
  { id: "w/2", title: "Alice" },
  { id: "w/3", title: "Albert" },
  { id: "w/4", title: "alchemy" },
  { id: "worldbuilding/warden", title: "Zeta" },
];

check("ranks prefix matches ahead of substring matches", () => {
  const titles = filterWikilinkItems(items, "al").map((i) => i.title);
  assert.deepEqual(titles, ["Alice", "Albert", "alchemy"]);
});

check("matches a substring anywhere in the title", () => {
  assert.deepEqual(filterWikilinkItems(items, "bert").map((i) => i.title), ["Albert"]);
  assert.deepEqual(filterWikilinkItems(items, "mar").map((i) => i.title), ["Mara"]);
});

check("matches on the document id too", () => {
  assert.deepEqual(filterWikilinkItems(items, "world").map((i) => i.title), ["Zeta"]);
});

check("an empty query lists everything, and the limit is honored", () => {
  assert.equal(filterWikilinkItems(items, "").length, 5);
  assert.equal(filterWikilinkItems(items, "", 2).length, 2);
  assert.deepEqual(filterWikilinkItems([], "x"), []);
});

check("builds the completed link text", () => {
  assert.equal(wikilinkText("Alice"), "[[Alice]]");
  assert.equal(wikilinkText("  Alice  "), "[[Alice]]");
  assert.equal(wikilinkText(null), "[[]]");
});

if (failures) {
  console.log(`wikilink-suggest: ${failures} failure(s)`);
  process.exit(1);
}
console.log("wikilink-suggest: ok");
