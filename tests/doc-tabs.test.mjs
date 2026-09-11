// Unit tests for the document tab strip / recent-list state. The module is
// deliberately DOM-free, so ordering, capping and MRU rules are pinned here
// instead of through the jsdom shell.
//
// Run: node tests/doc-tabs.test.mjs  (or `npm run test:tabs`)
import assert from "node:assert/strict";

import {
  createDocTabs,
  DEFAULT_TAB_LIMIT,
  DEFAULT_RECENT_LIMIT,
} from "../static/js/doc-tabs.js";

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

console.log("doc-tabs:");

check("open adds a tab, activates it, and records it as recent", () => {
  const t = createDocTabs({ max: 3, recentMax: 5 });
  assert.equal(t.open("a"), "a");
  assert.deepEqual(t.tabs, ["a"]);
  assert.equal(t.active, "a");
  assert.deepEqual(t.recent, ["a"]);
  t.open("b");
  assert.deepEqual(t.tabs, ["a", "b"]);
  assert.equal(t.active, "b");
  assert.deepEqual(t.recent, ["b", "a"]);
});

check("reopening an existing tab focuses it without duplicating", () => {
  const t = createDocTabs({ max: 3 });
  t.open("a");
  t.open("b");
  t.open("c");
  t.open("a");
  assert.deepEqual(t.tabs, ["a", "b", "c"]);
  assert.equal(t.active, "a");
  assert.deepEqual(t.recent, ["a", "c", "b"]);
});

check("overflow evicts the oldest inactive tab, keeping the active pinned", () => {
  const t = createDocTabs({ max: 2 });
  t.open("a");
  t.open("b");
  t.open("c"); // a is oldest and inactive
  assert.deepEqual(t.tabs, ["b", "c"]);
  assert.equal(t.active, "c");
});

check("a single active tab survives a zero cap", () => {
  const t = createDocTabs({ max: 0 });
  t.open("a");
  assert.deepEqual(t.tabs, ["a"]);
  assert.equal(t.active, "a");
});

check("close picks the right neighbour, then the left", () => {
  const t = createDocTabs({ max: 5 });
  t.open("a");
  t.open("b");
  t.open("c");
  t.open("b"); // active = b, strip [a,b,c]
  assert.deepEqual(t.close("b"), { active: "c", closed: "b", next: "c" });
  assert.deepEqual(t.tabs, ["a", "c"]);
  assert.deepEqual(t.close("c"), { active: "a", closed: "c", next: "a" });
  assert.deepEqual(t.close("a"), { active: null, closed: "a", next: null });
  assert.deepEqual(t.tabs, []);
});

check("closing an inactive tab leaves the active one alone", () => {
  const t = createDocTabs({ max: 5 });
  t.open("a");
  t.open("b");
  t.open("c");
  const res = t.close("a");
  assert.equal(res.closed, "a");
  assert.equal(res.next, "c");
  assert.equal(t.active, "c");
  assert.deepEqual(t.tabs, ["b", "c"]);
});

check("closing an unknown id is a no-op", () => {
  const t = createDocTabs({ max: 5 });
  t.open("a");
  assert.deepEqual(t.close("nope"), { active: "a", closed: null, next: "a" });
  assert.deepEqual(t.tabs, ["a"]);
});

check("recent is MRU, de-duplicated and capped", () => {
  const t = createDocTabs({ max: 5, recentMax: 3 });
  t.open("a");
  t.open("b");
  t.open("c");
  t.open("a"); // newest
  t.open("d");
  assert.deepEqual(t.recent, ["d", "a", "c"]);
});

check("forget removes a document from tabs and recent", () => {
  const t = createDocTabs({ max: 5 });
  t.open("a");
  t.open("b");
  t.open("c");
  t.forget("b");
  assert.deepEqual(t.tabs, ["a", "c"]);
  assert.deepEqual(t.recent, ["c", "a"]);
  assert.equal(t.active, "c");
  t.forget("c");
  assert.equal(t.active, "a");
});

check("rekey follows an id change in tabs, recent and active", () => {
  const t = createDocTabs({ max: 5 });
  t.open("a");
  t.open("b");
  t.rekey("a", "a/moved");
  assert.deepEqual(t.tabs, ["a/moved", "b"]);
  assert.deepEqual(t.recent, ["b", "a/moved"]);
  t.open("a/moved");
  assert.equal(t.active, "a/moved");
});

check("rekey de-duplicates when the new id is already a tab", () => {
  const t = createDocTabs({ max: 5 });
  t.open("a");
  t.open("b");
  t.rekey("a", "b");
  assert.deepEqual(t.tabs, ["b"]);
  assert.equal(t.active, "b");
});

check("cycle wraps in both directions", () => {
  const t = createDocTabs({ max: 5 });
  t.open("a");
  t.open("b");
  t.open("c");
  assert.equal(t.cycle(1), "a");
  assert.equal(t.cycle(1), "b");
  assert.equal(t.cycle(-1), "a");
  assert.equal(t.cycle(-1), "c");
});

check("cycle is a no-op with fewer than two tabs", () => {
  const t = createDocTabs({ max: 5 });
  t.open("a");
  assert.equal(t.cycle(1), "a");
});

check("restore enforces caps and picks a valid active tab", () => {
  const t = createDocTabs({ max: 2, recentMax: 2 });
  const res = t.restore({ tabs: ["a", "b", "c"], active: "b", recent: ["x", "y", "z"] });
  assert.deepEqual(res.tabs, ["b", "c"]);
  assert.equal(res.active, "b");
  assert.deepEqual(res.recent, ["x", "y"]);
});

check("restore falls back to the last tab for a stale active id", () => {
  const t = createDocTabs({ max: 5 });
  const res = t.restore({ tabs: ["a", "b"], active: "gone", recent: [] });
  assert.equal(res.active, "b");
});

check("clearRecent empties only the recent list", () => {
  const t = createDocTabs({ max: 5 });
  t.open("a");
  t.open("b");
  t.clearRecent();
  assert.deepEqual(t.recent, []);
  assert.deepEqual(t.tabs, ["a", "b"]);
});

check("serialize/restore round-trips", () => {
  const t = createDocTabs({ max: 5 });
  t.open("a");
  t.open("b");
  t.close("a");
  const other = createDocTabs({ max: 5 });
  other.restore(t.serialize());
  assert.deepEqual(other.tabs, t.tabs);
  assert.equal(other.active, t.active);
  assert.deepEqual(other.recent, t.recent);
});

check("default limits are 10 tabs / 15 recent", () => {
  assert.equal(DEFAULT_TAB_LIMIT, 10);
  assert.equal(DEFAULT_RECENT_LIMIT, 15);
});

if (failures) {
  console.log(`doc-tabs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("doc-tabs: ok");
