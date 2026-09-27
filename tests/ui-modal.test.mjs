// jsdom test for the shared dialog behavior in static/js/ui.js: ARIA, focus
// move/restore, Escape (top-most only, and deferred to a menu on top), backdrop
// dismissal, and the close/dismiss split.
//
// Run: node tests/ui-modal.test.mjs  (or `npm run test:uimodal`)
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

const { el, showModal, promptDialog, confirmDialog } = await import("../static/js/ui.js");

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

const doc = w.document;
const click = (node) => node.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const escape = () =>
  doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

console.log("ui-modal:");

await check("a modal is a labelled dialog and takes focus", () => {
  const opener = el("button", {}, "open");
  doc.body.append(opener);
  opener.focus();
  const input = el("input", {});
  const { modal, close } = showModal([el("h3", {}, "Title"), input]);
  assert.equal(modal.getAttribute("role"), "dialog");
  assert.equal(modal.getAttribute("aria-modal"), "true");
  assert.equal(modal.getAttribute("tabindex"), "-1");
  assert.equal(doc.activeElement, input, "focus moves to the first focusable");
  close();
  assert.equal(doc.querySelector(".modal-backdrop"), null, "close removes the overlay");
  assert.equal(doc.activeElement, opener, "focus returns to the opener");
  opener.remove();
});

await check("Escape dismisses the top-most dialog only", () => {
  const first = showModal([el("button", {}, "A")]);
  const second = showModal([el("button", {}, "B")]);
  escape();
  assert.equal(doc.querySelectorAll(".modal-backdrop").length, 1, "only the top closes");
  assert.ok(!second.backdrop.isConnected, "the top dialog is gone");
  assert.ok(first.backdrop.isConnected, "the first dialog stays");
  escape();
  assert.equal(doc.querySelectorAll(".modal-backdrop").length, 0, "the next Escape closes the first");
});

await check("backdrop click is a dismissal and runs onDismiss", () => {
  let dismissed = 0;
  const { backdrop } = showModal([el("button", {}, "ok")], { onDismiss: () => (dismissed += 1) });
  click(backdrop);
  assert.equal(dismissed, 1);
  assert.equal(doc.querySelector(".modal-backdrop"), null);
});

await check("programmatic close does not run onDismiss", () => {
  let dismissed = 0;
  const { close } = showModal([el("button", {}, "ok")], { onDismiss: () => (dismissed += 1) });
  close();
  assert.equal(dismissed, 0);
});

await check("a dialog removed directly stops owning Escape", () => {
  const stale = showModal([el("button", {}, "stale")]);
  stale.backdrop.remove(); // link/lookup/repetition reopen by removing the node
  const live = showModal([el("button", {}, "live")]);
  escape();
  assert.equal(doc.querySelectorAll(".modal-backdrop").length, 0, "Escape closed the live dialog");
  assert.ok(!live.backdrop.isConnected);
});

await check("Escape defers to a context menu on top", () => {
  const { backdrop } = showModal([el("button", {}, "ok")]);
  const menu = el("div", { class: "context-menu" });
  doc.body.append(menu);
  escape();
  assert.ok(backdrop.isConnected, "the dialog stays while a menu owns Escape");
  menu.remove();
  escape();
  assert.ok(!backdrop.isConnected, "once the menu is gone Escape closes the dialog");
});

await check("prompt resolves the value on Enter and null on Escape", async () => {
  const p = promptDialog({ title: "Name", label: "Name", value: "hi" });
  const input = doc.querySelector(".modal input");
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(await p, "hi");

  const q = promptDialog({ title: "Name", label: "Name" });
  escape();
  assert.equal(await q, null);
});

await check("confirm resolves false on Escape", async () => {
  const c = confirmDialog({ title: "Delete?", message: "Sure?" });
  escape();
  assert.equal(await c, false);
});

await check("the spelling dialog opts into the same behavior", async () => {
  const { renderDictionaryDialog } = await import("../static/js/dictionary-dialog.js");
  renderDictionaryDialog({ projectId: "p", words: ["wolf"], onChanged: () => {} });
  const dialog = doc.querySelector(".dict-dialog");
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  escape();
  assert.equal(doc.querySelector(".dict-modal"), null, "Escape closes the spelling dialog");
});

if (failures) {
  console.log(`ui-modal: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("ui-modal: ok");
