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

const tables = (host) => host.querySelectorAll("table");
const cells = (host) => [...host.querySelectorAll("th, td")].map((el) => el.textContent.trim());

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

if (failures) {
  console.log(`editor-primitives: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("editor-primitives: all checks passed");
