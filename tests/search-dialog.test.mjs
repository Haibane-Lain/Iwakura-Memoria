// jsdom test for the find & replace panel's status line.
//
// The panel is a plain static/js module, so this drives it directly with a
// stubbed search API. Regression: a search that is superseded by the
// "no document is open" branch used to leave "Searching…" on screen for good,
// because the stale request refuses to touch the status and the new branch
// returned without clearing it.
//
// Run: node tests/search-dialog.test.mjs  (or `npm run test:searchdialog`)
import assert from "node:assert/strict";

import { JSDOM } from "jsdom";

function defineGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    globalThis[name] = value;
  }
}

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/" });
const w = dom.window;
for (const [name, value] of Object.entries({
  window: w,
  document: w.document,
  location: w.location,
  HTMLElement: w.HTMLElement,
  Element: w.Element,
  Node: w.Node,
  Event: w.Event,
  MouseEvent: w.MouseEvent,
  KeyboardEvent: w.KeyboardEvent,
  CustomEvent: w.CustomEvent,
})) {
  defineGlobal(name, value);
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "",
    headers: { get: () => null },
    async json() {
      return data;
    },
    async blob() {
      return new Blob([]);
    },
  };
}

const EMPTY_RESULT = {
  query: "x",
  scope: "all",
  documentsSearched: 1,
  documentsMatched: 0,
  totalMatches: 0,
  truncated: false,
  results: [],
};

// When set, the next search parks until the test calls its `.release()`.
let searchDelay = null;

globalThis.fetch = async (url, opts = {}) => {
  const pathname = new URL(String(url), "http://localhost").pathname;
  const method = (opts.method || "GET").toUpperCase();
  if (pathname === "/api/projects/p/search" && method === "POST") {
    if (searchDelay) {
      const gate = searchDelay;
      searchDelay = null;
      return new Promise((resolve) => {
        gate.release = () => resolve(jsonResponse(EMPTY_RESULT));
      });
    }
    return jsonResponse(EMPTY_RESULT);
  }
  return jsonResponse({}, 404);
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let currentDoc = "doc1";
const { renderSearchDialog } = await import("../static/js/search-dialog.js");

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}\n      ${err.message}`);
  }
}

renderSearchDialog({
  projectId: "p",
  currentDocId: () => currentDoc,
  flushSave: async () => {},
  refreshAfterReplace: async () => {},
  openDocument: async () => true,
  highlightMatches: () => ({ total: 0, active: 0 }),
  clearHighlights: () => {},
});

const panel = w.document.querySelector(".find-panel");
assert.ok(panel, "the find panel rendered");
const input = panel.querySelector(".search-input");
const scopeSelect = panel.querySelector(".search-scope");
const status = () => panel.querySelector(".find-status").textContent;

await check("a superseded search does not leave the panel on “Searching…”", async () => {
  currentDoc = "doc1";
  input.value = "x";
  const gate = {};
  searchDelay = gate;
  // Enter runs the search immediately, with no debounce.
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await tick();
  assert.equal(status(), "Searching…", "the in-flight search shows its status");
  assert.equal(typeof gate.release, "function", "the request is parked");

  // Switch to "Current document" with nothing open: this newer run supersedes
  // the first and has to clear the status itself.
  currentDoc = null;
  scopeSelect.value = "document";
  scopeSelect.dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.equal(status(), "", "the no-document branch clears the status");

  // The first (superseded) request then lands and must leave the status alone.
  gate.release();
  await tick();
  await tick();
  assert.equal(status(), "", "the stale reply does not resurrect the status");
});

if (failures) {
  console.log(`search-dialog: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("search-dialog: ok");
