// jsdom test for the wiki's character table (the right-hand info box).
//
// Drives the real `static/dist/editor.bundle.js` (built from
// client/editor-entry.js) because the risky parts are the Markdown round trip
// and the structure of the box: its interior is raw HTML, so a picture inside
// it must never be written as `![alt](src)` (that would be literal text), the
// stored `src` must stay project-relative, and the text has to be editable,
// navigable and extensible without a dialog.
//
// Run: npm run build && node tests/editor-chartable.test.mjs  (or `npm run test:chartable`)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "static", "dist", "editor.bundle.js");
if (!fs.existsSync(bundlePath)) {
  console.error("editor-chartable: static/dist/editor.bundle.js is missing — run `npm run build` first");
  process.exit(1);
}

const dom = new JSDOM("<!DOCTYPE html><body><div id='m'></div></body>", { runScripts: "dangerously" });
dom.window.eval(fs.readFileSync(bundlePath, "utf8"));

const PID = "my-project";

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

function open(content, opts = {}) {
  const host = dom.window.document.getElementById("m");
  host.replaceChildren();
  const errors = [];
  const active = [];
  const uploaded = [];
  const picked = [];
  const ctrl = dom.window.LainEditor.create({
    element: host,
    content,
    placeholder: "Begin writing…",
    onChange: () => {},
    projectId: PID,
    uploadImage:
      opts.uploadImage ||
      (async (f) => {
        uploaded.push(f.name);
        return { path: "assets/new-portrait-abc123.png", width: 8, height: 6 };
      }),
    onImageError: (message) => errors.push(message),
    onUploadState: (busy) => active.push(busy),
    onOpenImage: () => {},
    onPickPortrait: (pos) => picked.push(pos),
  });
  return { host, ctrl, errors, active, uploaded, picked, close: () => ctrl.destroy() };
}

const file = (name = "Ubel Portrait.png", type = "image/png") =>
  new dom.window.File([new Uint8Array([137, 80, 78, 71])], name, { type });

const box = (host) => host.querySelector(".character-table");
const rows = (host) => host.querySelectorAll("tr.ct-row");

// Tiptap's keyboard shortcuts are plain functions on the extension; calling them
// directly is the jsdom-safe way to drive Enter/Tab/Backspace (real key events
// would depend on ProseMirror's DOM event plumbing for keydown).
function shortcut(ctrl, name) {
  const extension = ctrl.editor.extensionManager.extensions.find((e) => e.name === "characterTable");
  const shortcuts = extension.config.addKeyboardShortcuts.call({
    editor: ctrl.editor,
    options: extension.options,
    storage: extension.storage,
    name: extension.name,
  });
  return shortcuts[name];
}

const caret = (ctrl) => ctrl.editor.state.selection.from;

// The position of the first character-table's picture slot.
function portraitPos(ctrl) {
  let found = null;
  ctrl.editor.state.doc.descendants((node, pos) => {
    if (found == null && node.type.name === "ctPortrait") found = pos;
    return found == null;
  });
  return found;
}

function selectField(ctrl, label) {
  let found = null;
  ctrl.editor.state.doc.descendants((node, pos) => {
    if (found == null && node.type.name === "ctLabel" && node.textContent === label) found = pos + 1;
    return found == null;
  });
  assert.notEqual(found, null, `field "${label}" exists`);
  ctrl.editor.chain().setTextSelection(found).run();
  return found;
}

// The text position at the start of the value cell next to a label.
function valuePos(ctrl, label) {
  const start = selectField(ctrl, label);
  const labelNode = ctrl.editor.state.doc.nodeAt(start - 1);
  return start + labelNode.content.size + 2;
}

const STORED_BOX = [
  '<aside class="character-table" data-width="340">',
  '<table class="ct-rows">',
  '<tr class="ct-title"><th colspan="2">Übel</th></tr>',
  '<tr class="ct-subtitle"><th colspan="2">Anime • Manga • Young</th></tr>',
  '<tr class="ct-portrait"><td colspan="2"><p><img src="assets/ubel-a1b2c3d4e5.png" alt="Übel" width="240"></p></td></tr>',
  '<tr class="ct-section"><th colspan="2">Biographical Information</th></tr>',
  '<tr class="ct-row"><td class="ct-label">Gender</td><td class="ct-value">Female</td></tr>',
  '<tr class="ct-row"><td class="ct-label">Aliases</td><td class="ct-value">Miss <em>Übel</em></td></tr>',
  "</table>",
  "</aside>",
].join("\n");

/* ---------------- round trips ---------------- */

await check("a stored character table survives load → save byte for byte", () => {
  const s = open(STORED_BOX);
  assert.equal(s.ctrl.getMarkdown(), STORED_BOX);
  assert.ok(box(s.host), "the box rendered");
  assert.equal(rows(s.host).length, 2);
  assert.equal(s.host.querySelectorAll("tr.ct-section").length, 1);
  assert.equal(s.host.querySelector("img").getAttribute("src"), `/api/projects/${PID}/assets/ubel-a1b2c3d4e5.png`);
  s.close();
});

await check("an unsized portrait is still stored as an <img>, never as ![]()", () => {
  // The interior of the box is raw HTML: markdown is not parsed there, so the
  // `![alt](src)` form would be shown (and saved) as literal text.
  const source = [
    '<aside class="character-table">',
    '<table class="ct-rows">',
    '<tr class="ct-portrait"><td colspan="2"><p><img src="assets/x.png" alt="Mara"></p></td></tr>',
    "</table>",
    "</aside>",
  ].join("\n");
  const s = open(source);
  assert.equal(s.ctrl.getMarkdown(), source);
  assert.match(s.ctrl.getMarkdown(), /<img src="assets\/x\.png" alt="Mara">/);
  // One picture (ProseMirror's own separator <img> does not count).
  assert.equal(s.host.querySelectorAll("img.doc-image").length, 1);
  s.close();
});

await check("a hand-edited served URL inside the box is normalised back", () => {
  const served = [
    '<aside class="character-table">',
    '<table class="ct-rows">',
    `<tr class="ct-portrait"><td colspan="2"><p><img src="/api/projects/${PID}/assets/x.png" alt=""></p></td></tr>`,
    "</table>",
    "</aside>",
  ].join("\n");
  const s = open(served);
  const expected = served.replace(`/api/projects/${PID}/assets/x.png`, "assets/x.png").replace(' alt=""', "");
  assert.equal(s.ctrl.getMarkdown(), expected);
  s.close();
});

await check("saving never writes a served URL", () => {
  const s = open(STORED_BOX);
  assert.equal(s.ctrl.getMarkdown().includes("/api/projects/"), false);
  s.close();
});

await check("a box in the middle of prose keeps the surrounding paragraphs", () => {
  const source = `Before\n\n${STORED_BOX}\n\nAfter`;
  const s = open(source);
  assert.equal(s.ctrl.getMarkdown(), source);
  s.close();
});

await check("a foreign HTML table is not mistaken for a character table", () => {
  const s = open("<table><tr><td>plain</td><td>table</td></tr></table>");
  assert.equal(box(s.host), null, "it is not a character table");
  assert.equal(s.host.querySelectorAll("table").length, 1, "it is an ordinary table");
  assert.match(s.ctrl.getMarkdown(), /plain/);
  s.close();
});

/* ---------------- insertion ---------------- */

await check("insertCharacterTable builds the full info box at the caret", () => {
  const s = open("Prose before");
  assert.equal(s.ctrl.insertCharacterTable({ title: "Übel" }), true);
  const markdown = s.ctrl.getMarkdown();
  assert.match(markdown, /^Prose before\n\n<aside class="character-table">/);
  assert.match(markdown, /<tr class="ct-title"><th colspan="2">Übel<\/th><\/tr>/);
  assert.match(markdown, /<tr class="ct-subtitle"><th colspan="2"><\/th><\/tr>/);
  assert.match(markdown, /<tr class="ct-portrait"><td colspan="2"><\/td><\/tr>/);
  assert.equal((markdown.match(/<tr class="ct-section">/g) || []).length, 3);
  assert.equal(rows(s.host).length, 14);
  assert.match(markdown, /<td class="ct-label">Gender<\/td><td class="ct-value"><\/td>/);
  s.close();
});

await check("the caret starts in the title, with the box above the first line", () => {
  const s = open("");
  s.ctrl.insertCharacterTable({ title: "Übel" });
  const state = s.ctrl.editor.state;
  const $caret = state.doc.resolve(caret(s.ctrl));
  assert.equal($caret.parent.type.name, "ctHeading");
  assert.equal($caret.parent.attrs.kind, "title");
  assert.equal(state.doc.firstChild.type.name, "characterTable", "no blank line above the floating box");
  assert.equal(state.doc.lastChild.type.name, "paragraph", "writing can continue under the box");
  s.close();
});

await check("typing into a cell is saved", () => {
  const s = open("text");
  s.ctrl.insertCharacterTable({ title: "Übel" });
  const at = valuePos(s.ctrl, "Aliases");
  s.ctrl.editor.chain().setTextSelection(at).insertContent("Miss Übel").run();
  assert.match(s.ctrl.getMarkdown(), /<td class="ct-label">Aliases<\/td><td class="ct-value">Miss Übel<\/td>/);
  s.close();
});

await check("inserting a box while inside a box does not nest", () => {
  const s = open("");
  s.ctrl.insertCharacterTable({ title: "First" });
  selectField(s.ctrl, "Gender");
  s.ctrl.insertCharacterTable({ title: "Second" });
  assert.equal(s.host.querySelectorAll(".character-table").length, 2);
  assert.equal(s.host.querySelectorAll(".character-table .character-table").length, 0);
  s.close();
});

/* ---------------- keyboard behaviour ---------------- */

await check("Enter moves to the next field, and adds a row after the last", () => {
  const s = open("");
  s.ctrl.insertCharacterTable({ title: "Übel" });
  selectField(s.ctrl, "Gender");
  const start = caret(s.ctrl);
  assert.equal(shortcut(s.ctrl, "Enter")(), true);
  assert.ok(caret(s.ctrl) > start, "moved forward");
  const $cell = s.ctrl.editor.state.doc.resolve(caret(s.ctrl));
  assert.equal($cell.parent.type.name, "ctValue", "into the value cell");

  // Walk to the very last field, then one more Enter appends a row.
  const before = rows(s.host).length;
  for (let i = 0; i < 40 && rows(s.host).length === before; i += 1) {
    assert.equal(shortcut(s.ctrl, "Enter")(), true);
  }
  assert.equal(rows(s.host).length, before + 1);
  s.close();
});

await check("Tab walks forward too, and Shift-Tab walks back", () => {
  const s = open("");
  s.ctrl.insertCharacterTable({ title: "Übel" });
  selectField(s.ctrl, "Gender");
  assert.equal(shortcut(s.ctrl, "Tab")(), true);
  const forward = caret(s.ctrl);
  assert.equal(s.ctrl.editor.state.doc.resolve(forward).parent.type.name, "ctValue");
  assert.equal(shortcut(s.ctrl, "Shift-Tab")(), true);
  assert.ok(caret(s.ctrl) < forward, "back into the label");
  s.close();
});

await check("Backspace removes an empty row but never the last one", () => {
  const s = open("");
  s.ctrl.insertCharacterTable({ title: "Übel" });
  const before = rows(s.host).length;

  // A prefilled row still holds its label, so Backspace is swallowed there.
  selectField(s.ctrl, "Gender");
  assert.equal(shortcut(s.ctrl, "Backspace")(), true);
  assert.equal(rows(s.host).length, before, "a populated row is not deleted");
  assert.equal(s.ctrl.getMarkdown().includes(">Gender<"), true);

  // The new empty row the "+ Row" chip adds folds away again.
  chip(s.host, "+ Row").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(rows(s.host).length, before + 1);
  assert.equal(s.ctrl.editor.state.doc.resolve(caret(s.ctrl)).parent.type.name, "ctLabel");
  assert.equal(shortcut(s.ctrl, "Backspace")(), true);
  assert.equal(rows(s.host).length, before);
  s.close();
});

await check("the shortcuts decline outside a character table", () => {
  const s = open("plain text");
  s.ctrl.editor.chain().setTextSelection(1).run();
  assert.equal(shortcut(s.ctrl, "Enter")(), false);
  assert.equal(shortcut(s.ctrl, "Tab")(), false);
  assert.equal(shortcut(s.ctrl, "Backspace")(), false);
  s.close();
});

/* ---------------- the picture slot ---------------- */

await check("dropping a picture on the empty slot fills the portrait", async () => {
  const s = open("");
  s.ctrl.insertCharacterTable({ title: "Übel" });
  const slot = s.host.querySelector(".ct-portrait");
  const props = s.ctrl.editor.options.editorProps;
  let prevented = false;
  const handled = props.handleDrop(s.ctrl.editor.view, {
    target: slot,
    clientX: 0,
    clientY: 0,
    preventDefault: () => {
      prevented = true;
    },
    dataTransfer: { files: [file("Ubel Portrait.png")] },
  });
  assert.equal(handled, true);
  assert.equal(prevented, true);
  for (let i = 0; i < 100 && !s.host.querySelector(".ct-portrait img"); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.deepEqual(s.uploaded, ["Ubel Portrait.png"]);
  assert.ok(s.host.querySelector(".ct-portrait img"), "the portrait rendered");
  assert.match(s.ctrl.getMarkdown(), /<tr class="ct-portrait"><td colspan="2"><p><img src="assets\/new-portrait-abc123\.png"/);
  s.close();
});

await check("a second drop on the slot replaces the picture instead of stacking", async () => {
  const s = open("");
  s.ctrl.insertCharacterTable({ title: "Übel" });
  const pos = portraitPos(s.ctrl);
  await s.ctrl.setPortrait(pos, file("One.png"));
  await s.ctrl.setPortrait(pos, file("Two.png"));
  assert.equal(s.host.querySelectorAll(".ct-portrait img.doc-image").length, 1);
  assert.match(s.ctrl.getMarkdown(), /assets\/new-portrait-abc123\.png/);
  s.close();
});

await check("clicking the empty slot asks the host for a file", () => {
  const s = open("");
  s.ctrl.insertCharacterTable({ title: "Übel" });
  const slot = s.host.querySelector(".ct-portrait");
  slot.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(s.picked.length, 1);
  assert.equal(typeof s.picked[0], "number");
  s.close();
});

await check("a failed portrait upload inserts nothing", async () => {
  const s = open("", {
    uploadImage: async () => {
      throw new Error("Image exceeds the 10 MB limit");
    },
  });
  s.ctrl.insertCharacterTable({ title: "Übel" });
  await s.ctrl.setPortrait(portraitPos(s.ctrl), file());
  assert.equal(s.host.querySelector(".ct-portrait img"), null);
  assert.deepEqual(s.errors, ["Image exceeds the 10 MB limit"]);
  assert.equal(s.ctrl.getMarkdown().includes("<img"), false);
  s.close();
});

/* ---------------- chips and the resize handle ---------------- */

function chip(host, label) {
  return [...host.querySelectorAll(".ct-chip")].find((node) => node.textContent === label);
}

await check("the chips add a row, add a section and delete the box", () => {
  const s = open("");
  s.ctrl.insertCharacterTable({ title: "Übel" });
  selectField(s.ctrl, "Gender");
  const before = rows(s.host).length;

  chip(s.host, "+ Row").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(rows(s.host).length, before + 1);
  assert.equal(s.ctrl.editor.state.doc.resolve(caret(s.ctrl)).parent.type.name, "ctLabel");

  const sections = s.host.querySelectorAll("tr.ct-section").length;
  chip(s.host, "+ Section").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(s.host.querySelectorAll("tr.ct-section").length, sections + 1);

  chip(s.host, "− Row").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(s.host.querySelectorAll("tr.ct-section").length, sections);

  chip(s.host, "×").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(box(s.host), null);
  assert.equal(s.ctrl.getMarkdown().includes("character-table"), false);
  s.close();
});

await check("a new row added from the title row goes to the bottom", () => {
  // After inserting the box the caret sits in the title; "+ Row" must not
  // squeeze a row in between the title and the subtitle.
  const s = open("");
  s.ctrl.insertCharacterTable({ title: "Übel" });
  assert.equal(s.ctrl.editor.state.doc.resolve(caret(s.ctrl)).parent.attrs.kind, "title");
  chip(s.host, "+ Row").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const kinds = [...s.host.querySelectorAll(".ct-rows > tr")].map(
    (row) => [...row.classList].find((cls) => cls.startsWith("ct-"))
  );
  assert.equal(kinds[0], "ct-title");
  assert.equal(kinds[1], "ct-subtitle");
  assert.equal(kinds[2], "ct-portrait");
  assert.equal(kinds[kinds.length - 1], "ct-row", kinds.join(","));
  s.close();
});

await check("a chip acts on its own box, not on the box the caret is in", () => {
  const s = open("");
  s.ctrl.insertCharacterTable({ title: "First" });
  selectField(s.ctrl, "Gender");
  s.ctrl.insertCharacterTable({ title: "Second" });
  const wraps = s.host.querySelectorAll(".ct-wrap");
  assert.equal(wraps.length, 2);
  const before = wraps[0].querySelectorAll("tr.ct-row").length;

  // The caret is in the first box; the second box's chip still adds to the
  // second box (the chips belong to the box they are drawn on).
  [...wraps[1].querySelectorAll(".ct-chip")]
    .find((node) => node.textContent === "+ Row")
    .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  assert.equal(wraps[0].querySelectorAll("tr.ct-row").length, before, "untouched");
  assert.equal(wraps[1].querySelectorAll("tr.ct-row").length, before + 1);
  s.close();
});

await check("the corner handle stores the box width", () => {
  const s = open("");
  s.ctrl.insertCharacterTable({ title: "Übel" });
  const handle = s.host.querySelector(".ct-resize");
  assert.ok(handle, "the handle is rendered");
  handle.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100 }));
  handle.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 160 }));
  handle.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 160 }));
  assert.match(s.ctrl.getMarkdown(), /<aside class="character-table" data-width="400">/);

  // And the stored width comes back on reload.
  const reloaded = open(s.ctrl.getMarkdown());
  assert.equal(reloaded.host.querySelector(".character-table").style.width, "400px");
  assert.match(reloaded.ctrl.getMarkdown(), /<aside class="character-table" data-width="400">/);
  // Re-saving a reloaded document is a fixed point.
  const again = open(reloaded.ctrl.getMarkdown());
  assert.equal(again.ctrl.getMarkdown(), reloaded.ctrl.getMarkdown());
  again.close();
  reloaded.close();
  s.close();
});

await check("deleting the only box leaves a writable document", () => {
  const s = open("");
  s.ctrl.insertCharacterTable({ title: "Übel" });
  chip(s.host, "×").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(s.ctrl.editor.state.doc.childCount >= 1, true);
  assert.equal(s.ctrl.editor.state.doc.lastChild.type.name, "paragraph");
  s.close();
});

if (failures) {
  console.log(`editor-chartable: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("editor-chartable: all checks passed");
