// jsdom test for undo history surviving a document switch.
//
// The app keeps each visited editor alive and swaps its DOM in and out, so
// ProseMirror's history stack survives. This drives the real bundle and
// reproduces that cycle (`deactivate` -> detach -> re-attach -> `activate`)
// to make sure undo/redo still walk the edits made before the switch.
//
// Run: npm run build && node tests/editor-history.test.mjs  (or `npm run test:history`)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "static", "dist", "editor.bundle.js");
if (!fs.existsSync(bundlePath)) {
  console.error("editor-history: static/dist/editor.bundle.js is missing — run `npm run build` first");
  process.exit(1);
}

const dom = new JSDOM("<!DOCTYPE html><body><div id='m'></div></body>", { runScripts: "dangerously" });
dom.window.eval(fs.readFileSync(bundlePath, "utf8"));
const doc = dom.window.document;

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

function open(content) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const ctrl = dom.window.LainEditor.create({
    element: host,
    content,
    placeholder: "Begin writing…",
    onChange: () => {},
    projectId: "pid",
    uploadImage: async () => ({ path: "assets/x.png" }),
    onImageError: () => {},
    onUploadState: () => {},
    onOpenImage: () => {},
    onPickPortrait: () => {},
  });
  // No network in jsdom; keep the grammar checker from scheduling a fetch.
  ctrl.setGrammarEnabled(false);
  return { host, ctrl, close: () => ctrl.destroy() };
}

function appendText(ctrl, text) {
  const view = ctrl.editor.view;
  const at = view.state.doc.content.size - 1;
  view.dispatch(view.state.tr.insertText(text, at));
}

// What the app does on a document switch: park the editor, pull its DOM out,
// then re-attach it to a fresh mount and reactivate it.
function remount(ctrl) {
  ctrl.deactivate();
  const viewDom = ctrl.editor.view.dom;
  if (viewDom.parentNode) viewDom.parentNode.removeChild(viewDom);
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  host.appendChild(viewDom);
  ctrl.activate();
  return host;
}

console.log("editor-history:");

check("undo history survives a park/remount/activate cycle", () => {
  const s = open("Start");
  appendText(s.ctrl, " hello");
  assert.match(s.ctrl.getText(), /hello/);

  remount(s.ctrl);
  assert.match(s.ctrl.getText(), /hello/, "content is unchanged by the remount");

  s.ctrl.editor.commands.undo();
  assert.doesNotMatch(s.ctrl.getText(), /hello/, "undo steps back to the pre-switch state");

  s.ctrl.editor.commands.redo();
  assert.match(s.ctrl.getText(), /hello/, "redo restores the edit");

  s.close();
});

check("each cached editor keeps its own history", () => {
  const a = open("A");
  const b = open("B");
  appendText(a.ctrl, " one");
  appendText(b.ctrl, " two");

  // Park both, bring b back, and undo only b's edit.
  a.ctrl.deactivate();
  b.ctrl.deactivate();
  remount(b.ctrl);
  b.ctrl.editor.commands.undo();
  assert.doesNotMatch(b.ctrl.getText(), /two/);
  assert.match(b.ctrl.getText(), /B/);

  remount(a.ctrl);
  assert.match(a.ctrl.getText(), /one/, "a's edit is untouched by b's undo");

  a.close();
  b.close();
});

check("destroying a parked editor leaves the active one usable", () => {
  const a = open("A");
  const b = open("B");
  appendText(a.ctrl, " keep");
  appendText(b.ctrl, " drop");

  a.ctrl.deactivate();
  b.ctrl.destroy();
  a.ctrl.activate();

  assert.match(a.ctrl.getText(), /keep/);
  a.ctrl.editor.commands.undo();
  assert.doesNotMatch(a.ctrl.getText(), /keep/, "a's history still works after b was destroyed");

  a.close();
});

if (failures) {
  console.log(`editor-history: ${failures} failure(s)`);
  process.exit(1);
}
console.log("editor-history: ok");
