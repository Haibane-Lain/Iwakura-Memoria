// jsdom test for the critique picker: the pure filter, the current-document
// pre-check, the selection cap, and returning the picked ids. The dialog is a
// plain static/js leaf module, so it is driven directly.
//
// Run: node tests/critique-dialog.test.mjs  (or `npm run test:critiquedialog`)
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
defineGlobal("window", w);
defineGlobal("document", w.document);
defineGlobal("location", w.location);
defineGlobal("HTMLElement", w.HTMLElement);
defineGlobal("Element", w.Element);
defineGlobal("Node", w.Node);
defineGlobal("Event", w.Event);
defineGlobal("MouseEvent", w.MouseEvent);
defineGlobal("KeyboardEvent", w.KeyboardEvent);

const {
  renderCritiqueDialog,
  filterCritiqueEntries,
  MAX_CRITIQUE_ENTRIES,
} = await import("../static/js/critique-dialog.js");

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

function closeDialogs() {
  document.querySelectorAll(".modal-backdrop").forEach((node) => node.remove());
}

function click(node) {
  node.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
}

const ENTRIES = [
  { id: "a", title: "Mara", folder: "Part One", group: "Write" },
  { id: "b", title: "The Vault", folder: "worldbuilding", group: "Wiki" },
  { id: "c", title: "Chapter Two", folder: "Part One", group: "Write" },
];

await check("filterCritiqueEntries matches title, id, folder and group", () => {
  assert.deepEqual(filterCritiqueEntries(ENTRIES, "mar").map((e) => e.id), ["a"]);
  assert.deepEqual(filterCritiqueEntries(ENTRIES, "part one").map((e) => e.id), ["a", "c"]);
  assert.deepEqual(filterCritiqueEntries(ENTRIES, "wiki").map((e) => e.id), ["b"]);
  assert.equal(filterCritiqueEntries(ENTRIES, "").length, 3);
});

await check("the current document starts checked and Start returns the ids", async () => {
  closeDialogs();
  const picked = renderCritiqueDialog({ entries: ENTRIES, currentDocId: "b" });
  const checked = [...document.querySelectorAll(".critique-item input:checked")].map(
    (input) => input.closest("label").title
  );
  assert.deepEqual(checked, ["b"]);
  click(document.querySelector(".modal-actions .icon-btn.primary"));
  assert.deepEqual(await picked, ["b"]);
});

await check("ticking another entry adds it to the result", async () => {
  closeDialogs();
  const picked = renderCritiqueDialog({ entries: ENTRIES, currentDocId: "a" });
  const vault = [...document.querySelectorAll(".critique-item")].find(
    (item) => item.title === "b"
  );
  const box = vault.querySelector("input");
  box.checked = true;
  box.dispatchEvent(new w.Event("change", { bubbles: true }));
  click(document.querySelector(".modal-actions .icon-btn.primary"));
  assert.deepEqual((await picked).sort(), ["a", "b"]);
});

await check("the search box narrows the visible list", async () => {
  closeDialogs();
  renderCritiqueDialog({ entries: ENTRIES, currentDocId: null });
  const search = document.querySelector(".critique-search");
  search.value = "vault";
  search.dispatchEvent(new w.Event("input", { bubbles: true }));
  const titles = [...document.querySelectorAll(".critique-name")].map((n) => n.textContent);
  assert.deepEqual(titles, ["The Vault"]);
  closeDialogs();
});

await check("Cancel and Escape both resolve to null", async () => {
  closeDialogs();
  const first = renderCritiqueDialog({ entries: ENTRIES, currentDocId: "a" });
  click([...document.querySelectorAll(".modal-actions .icon-btn")].find((b) => b.textContent === "Cancel"));
  assert.equal(await first, null);

  closeDialogs();
  const second = renderCritiqueDialog({ entries: ENTRIES, currentDocId: "a" });
  document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(await second, null);
});

await check("selection caps at MAX_CRITIQUE_ENTRIES", async () => {
  closeDialogs();
  const many = Array.from({ length: MAX_CRITIQUE_ENTRIES + 5 }, (_, i) => ({
    id: `e${i}`,
    title: `Entry ${i}`,
    folder: "",
    group: "Write",
  }));
  const picked = renderCritiqueDialog({ entries: many, currentDocId: null });
  click([...document.querySelectorAll(".mini-btn")].find((b) => b.textContent === "Select all"));
  assert.match(document.querySelector(".critique-count").textContent, new RegExp(`^${MAX_CRITIQUE_ENTRIES} selected`));
  click(document.querySelector(".modal-actions .icon-btn.primary"));
  assert.equal((await picked).length, MAX_CRITIQUE_ENTRIES);
});

if (failures) {
  console.log(`critique-dialog: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("critique-dialog: all checks passed");
