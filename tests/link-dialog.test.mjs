// jsdom test for the link dialog: URL cleanup, prefill, apply and remove.
// Drives the leaf module directly with stubbed callbacks.
//
// Run: node tests/link-dialog.test.mjs  (or `npm run test:linkdialog`)
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

const { normalizeLinkHref, renderLinkDialog } = await import("../static/js/link-dialog.js");

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

function closeDialog() {
  document.querySelectorAll(".modal-backdrop.link-modal").forEach((node) => node.remove());
}

function click(node) {
  node.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
}

console.log("link-dialog:");

await check("normalizes what people type into an href", () => {
  assert.equal(normalizeLinkHref("https://example.com"), "https://example.com");
  assert.equal(normalizeLinkHref("http://example.com"), "http://example.com");
  assert.equal(normalizeLinkHref("mailto:a@b.test"), "mailto:a@b.test");
  assert.equal(normalizeLinkHref("example.com"), "https://example.com");
  assert.equal(normalizeLinkHref("www.example.com"), "https://www.example.com");
  assert.equal(normalizeLinkHref("/docs/page"), "/docs/page");
  assert.equal(normalizeLinkHref("#anchor"), "#anchor");
  assert.equal(normalizeLinkHref("  https://example.com  "), "https://example.com");
  assert.equal(normalizeLinkHref("javascript:alert(1)"), "");
  assert.equal(normalizeLinkHref("data:text/html,x"), "");
  assert.equal(normalizeLinkHref(""), "");
  assert.equal(normalizeLinkHref(null), "");
});

await check("prefills an existing link and offers Update/Remove", () => {
  closeDialog();
  renderLinkDialog({
    href: "https://example.com",
    selectionText: "click",
    onApply: () => {},
    onRemove: () => {},
  });
  const input = document.querySelector(".link-input");
  assert.equal(input.value, "https://example.com");
  assert.match(document.querySelector(".link-hint").textContent, /Links “click”/);
  assert.ok(document.querySelector(".icon-btn.link-remove"), "a Remove link button is shown");
  assert.equal(document.querySelector(".modal-actions .icon-btn.primary").textContent, "Update");
});

await check("applies a normalized URL and closes", () => {
  closeDialog();
  const applied = [];
  renderLinkDialog({ href: "", selectionText: "click", onApply: (url) => applied.push(url) });
  const input = document.querySelector(".link-input");
  input.value = "example.com";
  click(document.querySelector(".modal-actions .icon-btn.primary"));
  assert.deepEqual(applied, ["https://example.com"]);
  assert.equal(document.querySelector(".modal-backdrop.link-modal"), null, "the dialog closes");
});

await check("Enter in the URL field applies too", () => {
  closeDialog();
  const applied = [];
  renderLinkDialog({ href: "", selectionText: "", onApply: (url) => applied.push(url) });
  const input = document.querySelector(".link-input");
  input.value = "https://example.com";
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(applied, ["https://example.com"]);
});

await check("with no existing link there is no Remove and the hint says so", () => {
  closeDialog();
  renderLinkDialog({ href: "", selectionText: "", onApply: () => {} });
  assert.equal(document.querySelector(".icon-btn.link-remove"), null);
  assert.match(document.querySelector(".link-hint").textContent, /Nothing is selected/);
  assert.equal(document.querySelector(".modal-actions .icon-btn.primary").textContent, "Insert");
});

await check("Remove reports the removal", () => {
  closeDialog();
  let removed = 0;
  renderLinkDialog({ href: "https://example.com", onApply: () => {}, onRemove: () => (removed += 1) });
  click(document.querySelector(".icon-btn.link-remove"));
  assert.equal(removed, 1);
  assert.equal(document.querySelector(".modal-backdrop.link-modal"), null);
});

if (failures) {
  console.log(`link-dialog: ${failures} failure(s)`);
  process.exit(1);
}
console.log("link-dialog: ok");
