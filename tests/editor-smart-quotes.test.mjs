// jsdom test for the smart-quote extension in the built editor bundle.
//
// ProseMirror routes characters the writer types through the `handleTextInput`
// view prop, which jsdom cannot fake from the DOM. The tests drive that exact
// hook via `view.someProp("handleTextInput", …)`, which is what a real keypress
// reaches — the same call the editor makes internally.
//
// Run: npm run build && node tests/editor-smart-quotes.test.mjs  (or `npm run test:smartquotes`)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "static", "dist", "editor.bundle.js");
if (!fs.existsSync(bundlePath)) {
  console.error("editor-smart-quotes: static/dist/editor.bundle.js is missing — run `npm run build` first");
  process.exit(1);
}

const dom = new JSDOM("<!DOCTYPE html><body><div id='m'></div></body>", { runScripts: "dangerously" });
dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.eval(fs.readFileSync(bundlePath, "utf8"));

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

function open(content) {
  const host = dom.window.document.getElementById("m");
  host.replaceChildren();
  const ctrl = dom.window.LainEditor.create({
    element: host,
    content,
    placeholder: "Begin writing…",
    onChange: () => {},
    projectId: "my-project",
    uploadImage: async () => ({ path: "assets/x.png" }),
    onImageError: () => {},
    onUploadState: () => {},
    onOpenImage: () => {},
  });
  return { host, ctrl, close: () => ctrl.destroy() };
}

// Type one character the way a keypress reaches ProseMirror: try the
// `handleTextInput` prop first, and fall back to a plain insert when no plugin
// claims it. Returns whether a plugin handled it.
function typeChar(ctrl, ch) {
  const view = ctrl.editor.view;
  const { from, to } = view.state.selection;
  const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch));
  if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  return Boolean(handled);
}

function caret(ctrl, pos) {
  ctrl.editor.commands.setTextSelection(pos);
}

await check("a double quote after a space opens", async () => {
  const s = open("Hello world");
  try {
    caret(s.ctrl, 7); // between the space and "world"
    assert.equal(typeChar(s.ctrl, '"'), true, "the plugin claimed the keypress");
    assert.equal(s.ctrl.getText(), "Hello \u201cworld", `got ${JSON.stringify(s.ctrl.getText())}`);
  } finally {
    s.close();
  }
});

await check("a double quote at the start of an empty document opens", async () => {
  const s = open("");
  try {
    caret(s.ctrl, 1);
    typeChar(s.ctrl, '"');
    assert.equal(s.ctrl.getText(), "\u201c", `got ${JSON.stringify(s.ctrl.getText())}`);
  } finally {
    s.close();
  }
});

await check("a double quote after a word closes", async () => {
  const s = open("Hello");
  try {
    caret(s.ctrl, 6);
    typeChar(s.ctrl, '"');
    assert.equal(s.ctrl.getText(), "Hello\u201d", `got ${JSON.stringify(s.ctrl.getText())}`);
  } finally {
    s.close();
  }
});

await check("an apostrophe in a contraction is a right single quote", async () => {
  const s = open("don");
  try {
    caret(s.ctrl, 4);
    typeChar(s.ctrl, "'");
    assert.equal(s.ctrl.getText(), "don\u2019", `got ${JSON.stringify(s.ctrl.getText())}`);
  } finally {
    s.close();
  }
});

await check("a single quote after a space opens", async () => {
  const s = open("say it");
  try {
    caret(s.ctrl, 5); // between the space and "it"
    typeChar(s.ctrl, "'");
    assert.equal(s.ctrl.getText(), "say \u2018it", `got ${JSON.stringify(s.ctrl.getText())}`);
  } finally {
    s.close();
  }
});

await check("plain text is not intercepted", async () => {
  const s = open("");
  try {
    caret(s.ctrl, 1);
    assert.equal(typeChar(s.ctrl, "a"), false, "the plugin left the keypress alone");
    assert.equal(s.ctrl.getText(), "a");
  } finally {
    s.close();
  }
});

await check("a quote inside inline code stays straight", async () => {
  const s = open("ab");
  try {
    s.ctrl.editor.chain().setTextSelection({ from: 1, to: 3 }).setMark("code").run();
    caret(s.ctrl, 2);
    typeChar(s.ctrl, '"');
    assert.equal(s.ctrl.getText(), 'a"b', `got ${JSON.stringify(s.ctrl.getText())}`);
  } finally {
    s.close();
  }
});

await check("a quote inside a code block stays straight", async () => {
  const s = open("<pre><code>ab</code></pre>");
  try {
    caret(s.ctrl, 2);
    typeChar(s.ctrl, '"');
    assert.equal(s.ctrl.getText(), 'a"b', `got ${JSON.stringify(s.ctrl.getText())}`);
  } finally {
    s.close();
  }
});

await check("a backslash-escaped quote stays straight", async () => {
  const s = open("x");
  try {
    caret(s.ctrl, 2);
    s.ctrl.editor.view.dispatch(s.ctrl.editor.state.tr.insertText("\\", 2));
    typeChar(s.ctrl, '"');
    assert.equal(s.ctrl.getText(), 'x\\"', `got ${JSON.stringify(s.ctrl.getText())}`);
  } finally {
    s.close();
  }
});

await check("a quote typed in italic text keeps the italic mark", async () => {
  const s = open("*ab*");
  try {
    caret(s.ctrl, 4); // just after "ab", still inside the italic run
    typeChar(s.ctrl, '"');
    const marks = [];
    s.ctrl.editor.state.doc.descendants((node) => {
      if (node.isText && node.text.includes("\u201d")) marks.push(node.marks.map((m) => m.type.name));
    });
    assert.equal(marks.length, 1, "the closing quote was inserted");
    assert.ok(marks[0].includes("italic"), `stayed italic, got ${JSON.stringify(marks[0])}`);
  } finally {
    s.close();
  }
});

if (failures) {
  console.error(`editor-smart-quotes: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("editor-smart-quotes: ok");
