// Unit test for the latest-task token used by openDocument / switchTab.
//
// The point is that the newest start wins without dropping the newer run: the
// token marks older runs stale so they stop before mutating shared state.
//
// Run: node tests/latest-task.test.mjs  (or `npm run test:latest`)
import assert from "node:assert/strict";

import { createLatestTask } from "../static/js/latest-task.js";

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

console.log("latest-task:");

check("the first token is current", () => {
  const task = createLatestTask();
  const token = task.begin();
  assert.equal(task.isCurrent(token), true);
});

check("starting again supersedes the older token", () => {
  const task = createLatestTask();
  const first = task.begin();
  const second = task.begin();
  assert.equal(task.isCurrent(first), false, "the older run is stale");
  assert.equal(task.isCurrent(second), true, "the newest run is current");
});

check("tokens are monotonic", () => {
  const task = createLatestTask();
  assert.equal(task.begin(), 1);
  assert.equal(task.begin(), 2);
  assert.equal(task.begin(), 3);
});

check("instances are independent", () => {
  const a = createLatestTask();
  const b = createLatestTask();
  const aToken = a.begin();
  b.begin();
  assert.equal(a.isCurrent(aToken), true, "another task's start does not affect this one");
});

check("an unknown token is never current", () => {
  const task = createLatestTask();
  task.begin();
  assert.equal(task.isCurrent(999), false);
  assert.equal(task.isCurrent(0), false);
});

if (failures) {
  console.log(`latest-task: ${failures} failure(s)`);
  process.exit(1);
}
console.log("latest-task: ok");
