// Unit tests for the editor pool that keeps undo history across document
// switches. The pool is deliberately free of DOM/editor coupling, so a fake
// editor ctrl makes the LRU and lifecycle rules easy to pin down.
//
// Run: node tests/editor-pool.test.mjs  (or `npm run test:pool`)
import assert from "node:assert/strict";

import { createEditorPool, DEFAULT_EDITOR_POOL_LIMIT } from "../static/js/editor-pool.js";

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

function fakeCtrl(name) {
  return {
    name,
    destroyed: false,
    events: [],
    activate() {
      this.events.push("activate");
    },
    deactivate() {
      this.events.push("deactivate");
    },
    destroy() {
      this.destroyed = true;
      this.events.push("destroy");
    },
  };
}

console.log("editor-pool:");

check("add/activate track the current document", () => {
  const pool = createEditorPool({ max: 3 });
  const a = fakeCtrl("a");
  pool.add("a", a);
  assert.equal(pool.activeId, "a");
  assert.equal(pool.get("a"), a);
  assert.equal(pool.size, 1);

  const b = fakeCtrl("b");
  pool.add("b", b);
  assert.equal(pool.activeId, "b");
  assert.deepEqual(b.events, []);
});

check("activate touches LRU order and calls activate", () => {
  const pool = createEditorPool({ max: 3 });
  const a = fakeCtrl("a");
  const b = fakeCtrl("b");
  pool.add("a", a);
  pool.add("b", b);
  assert.equal(pool.activate("a"), a);
  assert.equal(pool.activeId, "a");
  assert.deepEqual(a.events, ["activate"]);
});

check("park deactivates but keeps the editor cached and current", () => {
  const pool = createEditorPool({ max: 3 });
  const a = fakeCtrl("a");
  pool.add("a", a);
  pool.park();
  assert.deepEqual(a.events, ["deactivate"]);
  assert.equal(pool.has("a"), true);
  assert.equal(pool.activeId, "a");
  assert.equal(a.destroyed, false);
});

check("overflow evicts and destroys the oldest inactive editor", () => {
  const pool = createEditorPool({ max: 2 });
  const a = fakeCtrl("a");
  const b = fakeCtrl("b");
  const c = fakeCtrl("c");
  pool.add("a", a);
  pool.add("b", b);
  pool.add("c", c); // a is oldest and not active
  assert.equal(pool.has("a"), false);
  assert.equal(a.destroyed, true);
  assert.deepEqual(a.events, ["deactivate", "destroy"]);
  assert.equal(pool.has("b"), true);
  assert.equal(pool.activeId, "c");
});

check("pins the current document even past the cap", () => {
  const pool = createEditorPool({ max: 0 });
  const a = fakeCtrl("a");
  pool.add("a", a);
  assert.equal(pool.size, 1);
  assert.equal(a.destroyed, false);
  assert.equal(pool.activeId, "a");
});

check("eviction order follows recent use", () => {
  const pool = createEditorPool({ max: 2 });
  const a = fakeCtrl("a");
  const b = fakeCtrl("b");
  const c = fakeCtrl("c");
  pool.add("a", a);
  pool.add("b", b);
  pool.activate("a"); // a now most recent
  pool.park();
  pool.add("c", c); // b is oldest
  assert.equal(pool.has("a"), true);
  assert.equal(pool.has("b"), false);
  assert.equal(b.destroyed, true);
});

check("rekey follows an id change", () => {
  const pool = createEditorPool({ max: 3 });
  const a = fakeCtrl("a");
  pool.add("a", a);
  pool.rekey("a", "a/moved");
  assert.equal(pool.has("a"), false);
  assert.equal(pool.get("a/moved"), a);
  assert.equal(pool.activeId, "a/moved");
});

check("forget removes without destroying; destroy destroys", () => {
  const pool = createEditorPool({ max: 3 });
  const a = fakeCtrl("a");
  const b = fakeCtrl("b");
  pool.add("a", a);
  pool.add("b", b);
  assert.equal(pool.forget("a"), a);
  assert.equal(a.destroyed, false);
  assert.equal(pool.get("b"), b);
  pool.destroy("b");
  assert.equal(b.destroyed, true);
  assert.equal(pool.size, 0);
});

check("destroyAll clears and destroys everything", () => {
  const pool = createEditorPool({ max: 3 });
  const a = fakeCtrl("a");
  const b = fakeCtrl("b");
  pool.add("a", a);
  pool.add("b", b);
  pool.park();
  pool.destroyAll();
  assert.equal(a.destroyed, true);
  assert.equal(b.destroyed, true);
  assert.equal(pool.size, 0);
  assert.equal(pool.activeId, null);
});

check("default limit is 10", () => {
  assert.equal(DEFAULT_EDITOR_POOL_LIMIT, 10);
});

if (failures) {
  console.log(`editor-pool: ${failures} failure(s)`);
  process.exit(1);
}
console.log("editor-pool: ok");
