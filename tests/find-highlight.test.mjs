// jsdom test for find-in-document highlighting: the matcher, the decoration
// classes, and their behaviour while the document is edited.
//
// The point of the feature is that the tint survives the find input holding the
// keyboard, so a decoration (not a selection) is what these checks pin down.
//
// Run: npm run build && node tests/find-highlight.test.mjs  (or `npm run test:find`)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "static", "dist", "editor.bundle.js");
if (!fs.existsSync(bundlePath)) {
  console.error("find-highlight: static/dist/editor.bundle.js is missing — run `npm run build` first");
  process.exit(1);
}

const dom = new JSDOM("<!DOCTYPE html><body><div id='m'></div></body>", { runScripts: "dangerously" });
dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.eval(fs.readFileSync(bundlePath, "utf8"));
const doc = dom.window.document;

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
  const host = doc.getElementById("m");
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

const hits = (host) => [...host.querySelectorAll(".find-hit")];
const active = (host) => host.querySelector(".find-hit-active");
const textOf = (node) => node.textContent;

await check("findMatches locates every literal match in document order", () => {
  const s = open("Alpha dark bravo dark charlie.");
  try {
    const ranges = s.ctrl.findMatches("dark", {});
    assert.equal(ranges.length, 2, `expected 2 matches, got ${ranges.length}`);
    assert.ok(ranges[0].from < ranges[1].from, "matches come back in document order");
    assert.equal(ranges[1].to - ranges[0].from > 0, true);
  } finally {
    s.close();
  }
});

await check("case sensitivity and whole word follow the search options", () => {
  const s = open("dark darkness Dark.");
  try {
    assert.equal(s.ctrl.findMatches("dark", {}).length, 3, "default is case-insensitive substring");
    assert.equal(s.ctrl.findMatches("dark", { caseSensitive: true }).length, 2);
    assert.equal(s.ctrl.findMatches("dark", { wholeWord: true }).length, 2);
    assert.equal(
      s.ctrl.findMatches("dark", { caseSensitive: true, wholeWord: true }).length,
      1
    );
    assert.equal(s.ctrl.findMatches("", {}).length, 0, "an empty query matches nothing");
  } finally {
    s.close();
  }
});

await check("setFindHighlights paints every match and only the active one strongly", () => {
  const s = open("Alpha dark bravo dark charlie.");
  try {
    const ranges = s.ctrl.findMatches("dark", {});
    s.ctrl.setFindHighlights(ranges, 1);
    assert.equal(hits(s.host).length, 2, "both matches are tinted");
    assert.equal(s.host.querySelectorAll(".find-hit-active").length, 1);
    assert.equal(textOf(active(s.host)), "dark");
    assert.equal(
      textOf(hits(s.host)[1]),
      "dark",
      "the active decoration covers the second match"
    );
  } finally {
    s.close();
  }
});

await check("highlights shift with an edit instead of snapping to the old offsets", () => {
  const s = open("Alpha dark bravo.");
  try {
    s.ctrl.setFindHighlights(s.ctrl.findMatches("dark", {}), 0);
    assert.equal(hits(s.host).length, 1);
    s.ctrl.editor.commands.insertContentAt(0, "ZZZ ");
    assert.equal(hits(s.host).length, 1, "the match is still highlighted");
    assert.equal(textOf(hits(s.host)[0]), "dark", "and still covers the same word");
  } finally {
    s.close();
  }
});

await check("clearFindHighlights removes every tint", () => {
  const s = open("Alpha dark bravo dark charlie.");
  try {
    s.ctrl.setFindHighlights(s.ctrl.findMatches("dark", {}), 0);
    assert.equal(hits(s.host).length, 2);
    s.ctrl.clearFindHighlights();
    assert.equal(hits(s.host).length, 0, "no .find-hit survives");
    assert.equal(active(s.host), null);
  } finally {
    s.close();
  }
});

await check("revealRange selects the match without stealing the keyboard", () => {
  const s = open("Alpha dark bravo.");
  try {
    const [range] = s.ctrl.findMatches("dark", {});
    const sink = doc.createElement("input");
    doc.body.append(sink);
    sink.focus();
    assert.equal(doc.activeElement, sink, "the find input starts focused");
    s.ctrl.revealRange(range.from, range.to, { focus: false });
    assert.equal(doc.activeElement, sink, "focus stayed in the find input");
    const { from, to } = s.ctrl.editor.state.selection;
    assert.equal(from, range.from);
    assert.equal(to, range.to);
    sink.remove();
  } finally {
    s.close();
  }
});

if (failures) {
  console.log(`find-highlight: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("find-highlight: all checks passed");
