// Node test for the drag-to-reorder helper (static/js/drag-order.js).
// Run: node tests/drag-order.test.mjs  (or `npm run test:dragorder`)
import assert from "node:assert/strict";

import { reorderById } from "../static/js/drag-order.js";

// Moving forward
assert.deepEqual(reorderById(["a", "b", "c"], "a", "c", true), ["b", "c", "a"]);
assert.deepEqual(reorderById(["a", "b", "c"], "a", "b", true), ["b", "a", "c"]);
// Moving backward
assert.deepEqual(reorderById(["a", "b", "c"], "c", "a", false), ["c", "a", "b"]);
assert.deepEqual(reorderById(["a", "b", "c"], "c", "b", false), ["a", "c", "b"]);
// Dropping on itself is a no-op, and the original array identity is kept.
const ids = ["a", "b", "c"];
assert.equal(reorderById(ids, "b", "b", false), ids);
assert.equal(reorderById(ids, "z", "a", false), ids);
assert.equal(reorderById(ids, "a", "z", false), ids);
// The input is never mutated.
assert.deepEqual(ids, ["a", "b", "c"]);

console.log("drag-order: ok");
