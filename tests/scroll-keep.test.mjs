// Node test for keeping a list's scroll position across a re-render
// (static/js/scroll-keep.js).
// Run: node tests/scroll-keep.test.mjs  (or `npm run test:scrollkeep`)
//
// Chromium re-picks a scrolled container's scroll anchor when its children are
// replaced, and nudges the offset even though nothing in the list moved (see
// the measurements in the module header). jsdom has no layout engine, so the
// browser's nudge is stood in for here by a container that moves its own
// offset while it is being re-rendered.
import assert from "node:assert/strict";

import { keepScrollTop } from "../static/js/scroll-keep.js";

/**
 * A container that behaves like Chromium's: re-rendering it nudges the offset.
 * Writes are recorded so "the offset was restored" can be told apart from
 * "the offset never moved".
 */
function container({ top = 543, nudge = 21 } = {}) {
  let value = top;
  const c = {
    writes: [],
    renders: 0,
    get scrollTop() {
      return value;
    },
    set scrollTop(next) {
      value = next;
      c.writes.push(next);
    },
    replaceChildren() {
      c.renders += 1;
      value = top + nudge;
    },
  };
  return c;
}

// The reported case: the list is scrolled down, an entry is opened, the
// sidebar re-render nudges it — the offset comes back.
{
  const list = container({ top: 543, nudge: 21 });
  keepScrollTop(list, () => list.replaceChildren(), true);
  assert.equal(list.renders, 1, "the re-render ran");
  assert.equal(list.scrollTop, 543, "scrolled-down list keeps its offset");
  assert.deepEqual(list.writes, [543], "the offset was written back");
}

// A browser that leaves the offset alone must not be written to at all.
{
  const list = container({ top: 300, nudge: 0 });
  keepScrollTop(list, () => list.replaceChildren(), true);
  assert.equal(list.renders, 1);
  assert.equal(list.scrollTop, 300);
  assert.deepEqual(list.writes, [], "no write when nothing moved");
}

// Re-renders that really change the list keep the browser's own anchoring.
{
  const list = container({ top: 2000, nudge: 63 });
  keepScrollTop(list, () => list.replaceChildren(), false);
  assert.equal(list.scrollTop, 2063, "the browser's result is left alone");
  assert.deepEqual(list.writes, [], "no write when not keeping");
}

// Keeping is the default: the entry-open path calls it with two arguments.
{
  const list = container({ top: 1000, nudge: 21 });
  keepScrollTop(list, () => list.replaceChildren());
  assert.equal(list.scrollTop, 1000);
}

// A list that is not scrolled stays at the top; a longer nudge than the list
// allows is still handled by the caller's own clamping (nothing to do here).
{
  const list = container({ top: 0, nudge: 21 });
  keepScrollTop(list, () => list.replaceChildren(), true);
  assert.equal(list.scrollTop, 0);
}

console.log("scroll-keep: ok");
