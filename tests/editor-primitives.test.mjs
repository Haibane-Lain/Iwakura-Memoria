// jsdom test for the generic editor primitives (tables, task lists, inline
// marks) driven through the real built bundle.
//
// The risky part is always the Markdown round trip: a primitive that the editor
// cannot serialize back to the same file silently corrupts a document on the
// next save. The character table has its own suite (editor-chartable); this one
// starts with generic tables and grows as the other primitives land.
//
// Run: npm run build && node tests/editor-primitives.test.mjs  (or `npm run test:primitives`)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "static", "dist", "editor.bundle.js");
if (!fs.existsSync(bundlePath)) {
  console.error("editor-primitives: static/dist/editor.bundle.js is missing — run `npm run build` first");
  process.exit(1);
}

const dom = new JSDOM("<!DOCTYPE html><body><div id='m'></div></body>", { runScripts: "dangerously" });
// The toolbar's insert commands call `.focus()`, which schedules a frame.
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

function open(content, items) {
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
    getWikilinkItems: () => items || [],
  });
  return { host, ctrl, close: () => ctrl.destroy() };
}

const tables = (host) => host.querySelectorAll("table");
const cells = (host) => [...host.querySelectorAll("th, td")].map((el) => el.textContent.trim());

// The slash menu is a document-level singleton; close whatever is open between
// checks by clicking outside it.
function dismissMenu() {
  dom.window.document.body.dispatchEvent(
    new dom.window.MouseEvent("mousedown", { bubbles: true })
  );
}
const slashMenu = () => dom.window.document.querySelector(".slash-menu");

/* ---------------- generic tables ---------------- */

await check("a GFM table survives load → save and is a fixed point", () => {
  const source = "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |";
  const s = open(source);
  const first = s.ctrl.getMarkdown();
  assert.equal(first.trimEnd(), source, "the pipe table round-trips");
  assert.equal(tables(s.host).length, 1, "one editable table rendered");
  assert.deepEqual(cells(s.host), ["Name", "Age", "Alice", "30", "Bob", "25"]);

  // Re-opening the saved form is stable: no drift on repeated saves.
  const again = open(first);
  assert.equal(again.ctrl.getMarkdown(), first);
  again.close();
  s.close();
});

await check("inserting a table writes a 3×3 GFM table with a header row", () => {
  const s = open("");
  s.ctrl.run("table");
  const markdown = s.ctrl.getMarkdown();
  assert.equal(
    markdown,
    "|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n"
  );
  assert.equal(s.host.querySelectorAll("table").length, 1);
  assert.equal(s.host.querySelectorAll("th").length, 3, "the header row is made of th cells");
  s.close();
});

await check("editing a cell is saved", () => {
  const s = open("| A | B |\n| --- | --- |\n| x | y |");
  // Find the "x" text node in the body row and replace it.
  let pos = null;
  s.ctrl.editor.state.doc.descendants((node, p) => {
    if (pos == null && node.isText && node.text === "x") pos = p;
    return pos == null;
  });
  assert.notEqual(pos, null, "the body cell text exists");
  s.ctrl.editor.chain().setTextSelection({ from: pos, to: pos + 1 }).insertContent("hello").run();
  assert.equal(s.ctrl.getMarkdown().trimEnd(), "| A | B |\n| --- | --- |\n| hello | y |");
  s.close();
});

await check("a table with a merged header falls back to HTML but still saves", () => {
  const source =
    '<table><tr><th colspan="2">Wide</th></tr><tr><td>a</td><td>b</td></tr></table>';
  const s = open(source);
  assert.equal(tables(s.host).length, 1);
  assert.equal(s.host.querySelector("th").getAttribute("colspan"), "2");
  const first = s.ctrl.getMarkdown();
  assert.match(first, /Wide/);
  // Whatever HTML the fallback writes must itself be a fixed point.
  const again = open(first);
  assert.equal(again.ctrl.getMarkdown(), first);
  again.close();
  s.close();
});

await check("a generic table and a character table coexist", () => {
  const box = [
    '<aside class="character-table">',
    '<table class="ct-rows">',
    '<tr class="ct-title"><th colspan="2">Übel</th></tr>',
    '<tr class="ct-row"><td class="ct-label">Gender</td><td class="ct-value">Female</td></tr>',
    "</table>",
    "</aside>",
  ].join("\n");
  const source = `| A | B |\n| --- | --- |\n| 1 | 2 |\n\n${box}`;
  const s = open(source);
  assert.equal(s.host.querySelectorAll(".character-table").length, 1, "the box is a box");
  assert.equal(tables(s.host).length, 2, "a generic table and the box's table");
  const markdown = s.ctrl.getMarkdown();
  assert.ok(markdown.includes(box), "the box is written back byte for byte");
  assert.match(markdown, /^\| A \| B \|/m);
  s.close();
});

await check("a task list round-trips tightly and its checkboxes toggle", () => {
  const source = "- [ ] one\n- [x] two\n- [ ] three";
  const s = open(source);
  assert.equal(s.ctrl.getMarkdown(), source, "no blank lines are inserted between items");
  const boxes = s.host.querySelectorAll('input[type="checkbox"]');
  assert.equal(boxes.length, 3);

  // Check the first item the way the node view does (a change event).
  const first = boxes[0];
  first.checked = true;
  first.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(
    s.ctrl.getMarkdown(),
    "- [x] one\n- [x] two\n- [ ] three",
    "ticking a box is saved as [x]"
  );

  // And untick the second.
  const second = s.host.querySelectorAll('input[type="checkbox"]')[1];
  second.checked = false;
  second.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(s.ctrl.getMarkdown(), "- [x] one\n- [ ] two\n- [ ] three");
  s.close();
});

await check("inserting a task list starts an item", () => {
  const s = open("");
  s.ctrl.run("taskList");
  assert.equal(s.ctrl.getMarkdown().trimEnd(), "- [ ]");
  assert.equal(s.host.querySelectorAll('ul[data-type="taskList"]').length, 1);
  s.close();
});

/* ---------------- inline marks ---------------- */

await check("inline marks survive load → save", () => {
  const source =
    'plain <mark>hi</mark> a<sub>2</sub> b<sup>x</sup> <span style="color:#c00">red</span> end';
  const s = open(source);
  assert.equal(s.ctrl.getMarkdown(), source);
  s.close();
});

await check("highlight and super/subscript apply from run()", () => {
  const s = open("alpha beta gamma");
  s.ctrl.editor.chain().setTextSelection({ from: 1, to: 6 }).run();
  s.ctrl.run("highlight");
  s.ctrl.editor.chain().setTextSelection({ from: 7, to: 11 }).run();
  s.ctrl.run("superscript");
  s.ctrl.editor.chain().setTextSelection({ from: 12, to: 17 }).run();
  s.ctrl.run("subscript");
  assert.equal(s.ctrl.getMarkdown(), "<mark>alpha</mark> <sup>beta</sup> <sub>gamma</sub>");
  s.close();
});

await check("text color sets, round-trips and clears", () => {
  const s = open("red blue");
  s.ctrl.editor.chain().setTextSelection({ from: 1, to: 4 }).run();
  s.ctrl.setTextColor("#c0392b");
  assert.equal(s.ctrl.getMarkdown(), '<span style="color:#c0392b">red</span> blue');

  const again = open(s.ctrl.getMarkdown());
  assert.equal(again.ctrl.getMarkdown(), s.ctrl.getMarkdown());
  again.close();

  s.ctrl.editor.chain().setTextSelection({ from: 1, to: 4 }).run();
  s.ctrl.setTextColor(null);
  assert.equal(s.ctrl.getMarkdown(), "red blue");
  s.close();
});

await check("a color chosen at the caret applies to everything typed next", () => {
  const s = open("");
  s.ctrl.setTextColor("#8a2be2");
  // One transaction per character, the way a keyboard types.
  for (const ch of "asdasd") s.ctrl.editor.chain().insertContent(ch).run();
  assert.equal(s.ctrl.getMarkdown(), '<span style="color:#8a2be2">asdasd</span>');
  s.close();
});

await check("a size chosen at the caret applies to everything typed next", () => {
  const s = open("");
  s.ctrl.editor.chain().focus().setMark("fontSize", { size: "24" }).run();
  for (const ch of "big") s.ctrl.editor.chain().insertContent(ch).run();
  assert.equal(s.ctrl.getMarkdown(), '<span style="font-size: 24px;">big</span>');
  s.close();
});

await check("inline marks inside a character-table cell survive", () => {
  const box = [
    '<aside class="character-table">',
    '<table class="ct-rows">',
    '<tr class="ct-row"><td class="ct-label">A</td><td class="ct-value"><mark>hi</mark> <span style="color:#c00">red</span> <sub>2</sub></td></tr>',
    "</table>",
    "</aside>",
  ].join("\n");
  const s = open(box);
  assert.equal(s.ctrl.getMarkdown(), box);
  s.close();
});

await check("inline code applies from run() and round-trips", () => {
  const s = open("alpha beta");
  s.ctrl.editor.chain().setTextSelection({ from: 1, to: 6 }).run();
  s.ctrl.run("code");
  assert.equal(s.ctrl.getMarkdown(), "`alpha` beta");

  const again = open(s.ctrl.getMarkdown());
  assert.equal(again.ctrl.getMarkdown(), "`alpha` beta");
  again.close();
  s.close();
});

await check("the horizontal-rule command inserts a divider", () => {
  const s = open("above below");
  s.ctrl.editor.chain().setTextSelection(s.ctrl.editor.state.doc.content.size - 1).run();
  s.ctrl.run("horizontalRule");
  assert.match(s.ctrl.getMarkdown(), /---/);
  s.close();
});

await check("links set, report and clear from the ctrl API", () => {
  const s = open("click here");
  s.ctrl.editor.chain().setTextSelection({ from: 1, to: 6 }).run();
  s.ctrl.setLink("https://example.com");
  assert.equal(s.ctrl.getMarkdown(), "[click](https://example.com) here");
  assert.equal(s.ctrl.getLinkHref(), "https://example.com");

  // A caret inside the link reports it too, so the dialog can edit it.
  s.ctrl.editor.chain().setTextSelection(2).run();
  assert.equal(s.ctrl.getLinkHref(), "https://example.com");

  s.ctrl.unlink();
  assert.equal(s.ctrl.getMarkdown(), "click here");
  assert.equal(s.ctrl.getLinkHref(), "");
  s.close();
});

await check("editing a link with the caret inside updates the whole link", () => {
  const s = open("[click](https://old.test) here");
  s.ctrl.editor.chain().setTextSelection(2).run();
  assert.equal(s.ctrl.getLinkHref(), "https://old.test");
  s.ctrl.setLink("https://new.test");
  assert.equal(s.ctrl.getMarkdown(), "[click](https://new.test) here");
  s.close();
});

await check("a link with nothing selected inserts the URL as its text", () => {
  const s = open("");
  s.ctrl.insertLink("https://example.com", "https://example.com");
  // A lone URL as its own link text is written as a Markdown autolink.
  assert.equal(s.ctrl.getMarkdown(), "<https://example.com>");
  s.close();
});

await check("getSelectionText reports the selected range", () => {
  const s = open("alpha beta");
  assert.equal(s.ctrl.getSelectionText(), "");
  s.ctrl.editor.chain().setTextSelection({ from: 1, to: 6 }).run();
  assert.equal(s.ctrl.getSelectionText(), "alpha");
  s.close();
});

await check("typewriter mode toggles without a layout engine", () => {
  const s = open("alpha beta");
  // jsdom has no geometry, so the recenter must quietly no-op rather than throw.
  s.ctrl.setTypewriterMode(true);
  s.ctrl.editor.chain().setTextSelection(6).run();
  assert.equal(s.ctrl.getMarkdown(), "alpha beta");
  s.ctrl.setTypewriterMode(false);
  s.close();
});

/* ---------------- slash menu ---------------- */

await check("typing / opens the slash menu and filters it", () => {
  dismissMenu();
  const s = open("");
  s.ctrl.editor.chain().insertContent("/").run();
  const menu = slashMenu();
  assert.ok(menu, "the menu opens on /");
  assert.equal(menu.querySelectorAll(".slash-item").length, 14);

  s.ctrl.editor.chain().insertContent("tab").run();
  const labels = [...slashMenu().querySelectorAll(".slash-item-label")].map((n) => n.textContent);
  assert.deepEqual(labels, ["Table"]);
  s.close();
  dismissMenu();
});

await check("choosing a slash command inserts it and closes the menu", () => {
  dismissMenu();
  const s = open("");
  s.ctrl.editor.chain().insertContent("/table").run();
  const item = slashMenu().querySelector(".slash-item");
  assert.ok(item);
  item.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(slashMenu(), null, "the menu closes");
  assert.equal(
    s.ctrl.getMarkdown(),
    "|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n"
  );
  s.close();
});

await check("the slash color palette colors the next text", () => {
  dismissMenu();
  const s = open("");
  s.ctrl.editor.chain().insertContent("/color").run();
  const colorItem = [...slashMenu().querySelectorAll(".slash-item")].find((n) =>
    n.textContent.includes("Text color")
  );
  assert.ok(colorItem, "the color command is offered");
  colorItem.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  const swatches = dom.window.document.querySelectorAll(".slash-swatch");
  assert.equal(swatches.length, 7);
  dom.window.document
    .querySelector('.slash-swatch[data-color="#c0392b"]')
    .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(slashMenu(), null, "the palette closes after a choice");

  s.ctrl.editor.chain().insertContent("hi").run();
  assert.equal(s.ctrl.getMarkdown(), '<span style="color:#c0392b">hi</span>');
  s.close();
});

await check("the slash menu closes when its trigger is deleted", () => {
  dismissMenu();
  const s = open("");
  s.ctrl.editor.chain().insertContent("/").run();
  assert.ok(slashMenu());
  s.ctrl.editor.chain().deleteRange({ from: 1, to: 2 }).run();
  assert.equal(slashMenu(), null);
  s.close();
});

/* ---------------- wikilink autocomplete ---------------- */

const wikiMenu = () => dom.window.document.querySelector(".wikilink-menu");

await check("typing [[ opens the title list and filters it", () => {
  dismissMenu();
  const s = open("", [
    { id: "a", title: "Alice", hint: "Chars" },
    { id: "b", title: "Albert", hint: "" },
    { id: "c", title: "Mara", hint: "" },
  ]);
  s.ctrl.editor.chain().insertContent("See [[").run();
  const menu = wikiMenu();
  assert.ok(menu, "the menu opens on [[");
  assert.equal(menu.querySelectorAll(".wikilink-item").length, 3);

  s.ctrl.editor.chain().insertContent("al").run();
  const labels = [...wikiMenu().querySelectorAll(".wikilink-item-label")].map((n) => n.textContent);
  assert.deepEqual(labels, ["Alice", "Albert"], "only matches remain, prefix-ranked");
  s.close();
  dismissMenu();
});

await check("choosing a title completes the link", () => {
  dismissMenu();
  const s = open("", [{ id: "a", title: "Alice", hint: "" }]);
  s.ctrl.editor.chain().insertContent("See [[Al").run();
  const item = wikiMenu().querySelector(".wikilink-item");
  assert.ok(item, "a match is offered");
  item.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(wikiMenu(), null, "the menu closes");
  assert.equal(s.ctrl.getMarkdown(), "See [[Alice]]");
  s.close();
});

await check("offers a literal link when no title matches", () => {
  dismissMenu();
  const s = open("", [{ id: "a", title: "Alice", hint: "" }]);
  s.ctrl.editor.chain().insertContent("[[Zeta").run();
  const create = wikiMenu().querySelector(".wikilink-item-new");
  assert.ok(create, "the create row is offered");
  create.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(s.ctrl.getMarkdown(), "[[Zeta]]");
  s.close();
});

await check("does not reopen inside an already-closed link", () => {
  dismissMenu();
  const s = open("[[Alice]]", [{ id: "a", title: "Alice", hint: "" }]);
  // Caret between the brackets, after "Ali" (position 6 in a leading paragraph).
  s.ctrl.editor.chain().setTextSelection(6).run();
  assert.equal(wikiMenu(), null, "no menu while editing inside a link");
  s.close();
});

await check("the wikilink menu closes when its trigger is deleted", () => {
  dismissMenu();
  const s = open("", [{ id: "a", title: "Alice", hint: "" }]);
  s.ctrl.editor.chain().insertContent("[[").run();
  assert.ok(wikiMenu());
  s.ctrl.editor.chain().deleteRange({ from: 1, to: 3 }).run();
  assert.equal(wikiMenu(), null);
  s.close();
});

if (failures) {
  console.log(`editor-primitives: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("editor-primitives: all checks passed");
