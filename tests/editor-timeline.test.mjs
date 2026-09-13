// jsdom test for the vertical timeline (the dated event list available in both
// the Write and Wiki tabs).
//
// Drives the real `static/dist/editor.bundle.js` (built from
// client/editor-entry.js) because the risky parts are the Markdown round trip
// and the block's structure: its interior is raw HTML, so the generic GFM table
// rules must step aside for `.timeline` (or the block is torn into an ordinary
// table on load), and the text has to be editable, navigable and extensible
// without a dialog.
//
// Run: npm run build && node tests/editor-timeline.test.mjs  (or `npm run test:timeline`)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "static", "dist", "editor.bundle.js");
if (!fs.existsSync(bundlePath)) {
  console.error("editor-timeline: static/dist/editor.bundle.js is missing — run `npm run build` first");
  process.exit(1);
}

const dom = new JSDOM("<!DOCTYPE html><body><div id='m'></div></body>", { runScripts: "dangerously" });
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
  });
  return { host, ctrl, close: () => ctrl.destroy() };
}

const timeline = (host) => host.querySelector(".timeline");
const events = (host) => host.querySelectorAll("tr.tl-event");
const sections = (host) => host.querySelectorAll("tr.tl-section");

// Tiptap's keyboard shortcuts are plain functions on the extension; calling them
// directly is the jsdom-safe way to drive Enter/Tab/Backspace (real key events
// would depend on ProseMirror's DOM event plumbing for keydown).
function shortcut(ctrl, name) {
  const extension = ctrl.editor.extensionManager.extensions.find((e) => e.name === "timeline");
  const shortcuts = extension.config.addKeyboardShortcuts.call({
    editor: ctrl.editor,
    options: extension.options,
    storage: extension.storage,
    name: extension.name,
  });
  return shortcuts[name];
}

function chip(host, label) {
  return [...host.querySelectorAll(".tl-chip")].find((node) => node.textContent === label);
}

const caret = (ctrl) => ctrl.editor.state.selection.from;

// Every text position at the start of a node of the given type, in order.
function positions(ctrl, typeName) {
  const out = [];
  ctrl.editor.state.doc.descendants((node, pos) => {
    if (node.type.name === typeName) out.push(pos + 1);
  });
  return out;
}

const STORED = [
  '<aside class="timeline">',
  '<table class="tl-rows">',
  '<tr class="tl-title"><th colspan="2">Timeline of the War</th></tr>',
  '<tr class="tl-section"><th colspan="2">Early Era</th></tr>',
  '<tr class="tl-event"><td class="tl-date">1066</td><td class="tl-body">Norman <em>Conquest</em></td></tr>',
  '<tr class="tl-event"><td class="tl-date">1215</td><td class="tl-body">Magna Carta</td></tr>',
  "</table>",
  "</aside>",
].join("\n");

/* ---------------- round trips ---------------- */

await check("a stored timeline survives load → save byte for byte", () => {
  const s = open(STORED);
  assert.equal(s.ctrl.getMarkdown(), STORED);
  assert.ok(timeline(s.host), "the timeline rendered");
  assert.equal(events(s.host).length, 2);
  assert.equal(sections(s.host).length, 1);
  assert.equal(s.host.querySelectorAll("table.tl-rows").length, 1, "kept as the block's own table");
  assert.equal(s.host.querySelectorAll(".tl-rows tr").length, 4);
  s.close();
});

await check("a timeline in the middle of prose keeps the surrounding paragraphs", () => {
  const source = `Before\n\n${STORED}\n\nAfter`;
  const s = open(source);
  assert.equal(s.ctrl.getMarkdown(), source);
  s.close();
});

await check("re-saving a loaded timeline is a fixed point", () => {
  const first = open(STORED);
  const second = open(first.ctrl.getMarkdown());
  assert.equal(second.ctrl.getMarkdown(), first.ctrl.getMarkdown());
  first.close();
  second.close();
});

await check("a foreign HTML table is not mistaken for a timeline", () => {
  const s = open("<table><tr><td>plain</td><td>table</td></tr></table>");
  assert.equal(timeline(s.host), null, "it is not a timeline");
  assert.equal(s.host.querySelectorAll("table").length, 1, "it is an ordinary table");
  assert.match(s.ctrl.getMarkdown(), /plain/);
  s.close();
});

/* ---------------- insertion ---------------- */

await check("insertTimeline builds the timeline at the caret", () => {
  const s = open("Prose before");
  assert.equal(s.ctrl.insertTimeline(), true);
  const markdown = s.ctrl.getMarkdown();
  assert.match(markdown, /^Prose before\n\n<aside class="timeline">/);
  assert.match(markdown, /<tr class="tl-title"><th colspan="2">Timeline<\/th><\/tr>/);
  assert.equal(events(s.host).length, 3);
  assert.match(markdown, /<tr class="tl-event"><td class="tl-date"><\/td><td class="tl-body"><\/td><\/tr>/);
  s.close();
});

await check("the caret starts in the title, with the timeline above the first line", () => {
  const s = open("");
  s.ctrl.insertTimeline();
  const state = s.ctrl.editor.state;
  const $caret = state.doc.resolve(caret(s.ctrl));
  assert.equal($caret.parent.type.name, "tlHeading");
  assert.equal($caret.parent.attrs.kind, "title");
  assert.equal(state.doc.firstChild.type.name, "timeline", "no blank line above the timeline");
  assert.equal(state.doc.lastChild.type.name, "paragraph", "writing can continue under it");
  s.close();
});

await check("a title and a custom event count are honoured", () => {
  const s = open("");
  s.ctrl.insertTimeline({ title: "Age of Sail", events: 2 });
  assert.match(s.ctrl.getMarkdown(), /<tr class="tl-title"><th colspan="2">Age of Sail<\/th><\/tr>/);
  assert.equal(events(s.host).length, 2);
  s.close();
});

await check("typing into a date and a body is saved", () => {
  const s = open("");
  s.ctrl.insertTimeline();
  const dates = positions(s.ctrl, "tlDate");
  const bodies = positions(s.ctrl, "tlBody");
  s.ctrl.editor.chain().setTextSelection(dates[0]).insertContent("1066").run();
  const afterDate = positions(s.ctrl, "tlBody")[0];
  s.ctrl.editor.chain().setTextSelection(afterDate).insertContent("Norman Conquest").run();
  assert.match(
    s.ctrl.getMarkdown(),
    /<tr class="tl-event"><td class="tl-date">1066<\/td><td class="tl-body">Norman Conquest<\/td><\/tr>/
  );
  assert.equal(bodies.length, dates.length);
  s.close();
});

await check("inserting a timeline while inside one does not nest", () => {
  const s = open("");
  s.ctrl.insertTimeline();
  s.ctrl.insertTimeline();
  assert.equal(s.host.querySelectorAll(".timeline").length, 2);
  assert.equal(s.host.querySelectorAll(".timeline .timeline").length, 0);
  s.close();
});

/* ---------------- keyboard behaviour ---------------- */

await check("Enter moves to the next field, and adds an event after the last", () => {
  const s = open("");
  s.ctrl.insertTimeline();
  const dates = positions(s.ctrl, "tlDate");
  s.ctrl.editor.chain().setTextSelection(dates[0]).run();
  const start = caret(s.ctrl);
  assert.equal(shortcut(s.ctrl, "Enter")(), true);
  assert.ok(caret(s.ctrl) > start, "moved forward");
  assert.equal(s.ctrl.editor.state.doc.resolve(caret(s.ctrl)).parent.type.name, "tlBody", "into the body");

  // Walk to the very last field, then one more Enter appends an event.
  const before = events(s.host).length;
  for (let i = 0; i < 60 && events(s.host).length === before; i += 1) {
    assert.equal(shortcut(s.ctrl, "Enter")(), true);
  }
  assert.equal(events(s.host).length, before + 1);
  s.close();
});

await check("Tab walks forward too, and Shift-Tab walks back", () => {
  const s = open("");
  s.ctrl.insertTimeline();
  const dates = positions(s.ctrl, "tlDate");
  s.ctrl.editor.chain().setTextSelection(dates[0]).run();
  assert.equal(shortcut(s.ctrl, "Tab")(), true);
  const forward = caret(s.ctrl);
  assert.equal(s.ctrl.editor.state.doc.resolve(forward).parent.type.name, "tlBody");
  assert.equal(shortcut(s.ctrl, "Shift-Tab")(), true);
  assert.ok(caret(s.ctrl) < forward, "back into the date");
  s.close();
});

await check("Backspace removes an empty event but never the last one", () => {
  const s = open("");
  s.ctrl.insertTimeline();
  const before = events(s.host).length;
  const dates = positions(s.ctrl, "tlDate");
  s.ctrl.editor.chain().setTextSelection(dates[0]).insertContent("1066").run();

  // A populated event still holds its date, so Backspace is swallowed there.
  s.ctrl.editor.chain().setTextSelection(positions(s.ctrl, "tlDate")[0]).run();
  assert.equal(shortcut(s.ctrl, "Backspace")(), true);
  assert.equal(events(s.host).length, before, "a populated event is not deleted");

  // The new empty event the "+ Event" chip adds folds away again.
  chip(s.host, "+ Event").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(events(s.host).length, before + 1);
  assert.equal(s.ctrl.editor.state.doc.resolve(caret(s.ctrl)).parent.type.name, "tlDate");
  assert.equal(shortcut(s.ctrl, "Backspace")(), true);
  assert.equal(events(s.host).length, before);
  s.close();
});

await check("the shortcuts decline outside a timeline", () => {
  const s = open("plain text");
  s.ctrl.editor.chain().setTextSelection(1).run();
  assert.equal(shortcut(s.ctrl, "Enter")(), false);
  assert.equal(shortcut(s.ctrl, "Tab")(), false);
  assert.equal(shortcut(s.ctrl, "Backspace")(), false);
  s.close();
});

/* ---------------- chips ---------------- */

await check("the chips add an event, add an era and delete the timeline", () => {
  const s = open("");
  s.ctrl.insertTimeline();
  s.ctrl.editor.chain().setTextSelection(positions(s.ctrl, "tlDate")[0]).run();
  const before = events(s.host).length;

  chip(s.host, "+ Event").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(events(s.host).length, before + 1);
  assert.equal(s.ctrl.editor.state.doc.resolve(caret(s.ctrl)).parent.type.name, "tlDate");

  const eras = sections(s.host).length;
  chip(s.host, "+ Era").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(sections(s.host).length, eras + 1);

  chip(s.host, "− Event").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(sections(s.host).length, eras);

  chip(s.host, "×").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(timeline(s.host), null);
  assert.equal(s.ctrl.getMarkdown().includes("timeline"), false);
  s.close();
});

await check("a chip acts on its own timeline, not the one the caret is in", () => {
  const s = open("");
  s.ctrl.insertTimeline();
  s.ctrl.insertTimeline();
  const wraps = s.host.querySelectorAll(".tl-wrap");
  assert.equal(wraps.length, 2);
  const before = wraps[0].querySelectorAll("tr.tl-event").length;

  [...wraps[1].querySelectorAll(".tl-chip")]
    .find((node) => node.textContent === "+ Event")
    .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  assert.equal(wraps[0].querySelectorAll("tr.tl-event").length, before, "untouched");
  assert.equal(wraps[1].querySelectorAll("tr.tl-event").length, before + 1);
  s.close();
});

await check("deleting the only timeline leaves a writable document", () => {
  const s = open("");
  s.ctrl.insertTimeline();
  chip(s.host, "×").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(s.ctrl.editor.state.doc.childCount >= 1, true);
  assert.equal(s.ctrl.editor.state.doc.lastChild.type.name, "paragraph");
  s.close();
});

if (failures) {
  console.log(`editor-timeline: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("editor-timeline: all checks passed");
