// jsdom test for comment anchors: the inline `data-cid` mark, its decoration
// state, and the editor commands the shell drives.
//
// The gate is the Markdown round trip: a comment that the editor cannot write
// back to the same bytes would corrupt a document on the next save. The bodies
// live in a sidecar (tests/test_comments.py), so this only covers the marker.
//
// Run: npm run build && node tests/editor-comments.test.mjs  (or `npm run test:comments`)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "static", "dist", "editor.bundle.js");
if (!fs.existsSync(bundlePath)) {
  console.error("editor-comments: static/dist/editor.bundle.js is missing — run `npm run build` first");
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

const CID = "c_0123456789ab";

await check("a stored comment survives load → save byte for byte", () => {
  const source = `Alpha <span data-cid="${CID}">bravo</span> charlie.`;
  const s = open(source);
  assert.equal(s.ctrl.getMarkdown(), source);
  s.close();
});

await check("setComment wraps the selection and removeComment unwraps it", () => {
  const s = open("Alpha bravo charlie.");
  s.ctrl.editor.chain().setTextSelection({ from: 7, to: 12 }).run();
  s.ctrl.setComment(CID);
  assert.equal(
    s.ctrl.getMarkdown(),
    `Alpha <span data-cid="${CID}">bravo</span> charlie.`
  );

  s.ctrl.removeComment(CID);
  assert.equal(s.ctrl.getMarkdown(), "Alpha bravo charlie.");
  s.close();
});

await check("getCommentRanges reports every anchor in document order", () => {
  const s = open('A <span data-cid="c_aaa">one</span> B <span data-cid="c_bbb">two</span>.');
  const ranges = s.ctrl.getCommentRanges();
  assert.deepEqual([...ranges.map((r) => r.cid)], ["c_aaa", "c_bbb"]);
  assert.deepEqual([...ranges.map((r) => r.text)], ["one", "two"]);
  s.close();
});

await check("decorations follow the metadata the shell pushes", () => {
  const s = open(`A <span data-cid="${CID}">one</span> B.`);
  s.ctrl.setComments({ [CID]: { active: true } });
  let anchor = s.host.querySelector(".comment-anchor");
  assert.ok(anchor, "the anchor is decorated");
  assert.ok(anchor.classList.contains("active"));

  s.ctrl.setComments({ [CID]: { resolved: true } });
  anchor = s.host.querySelector(".comment-anchor");
  assert.ok(anchor.classList.contains("resolved"));
  assert.ok(!anchor.classList.contains("active"));

  s.ctrl.setComments({});
  anchor = s.host.querySelector(".comment-anchor");
  assert.ok(!anchor.classList.contains("resolved"));
  assert.ok(!anchor.classList.contains("active"));
  s.close();
});

await check("revealComment selects the anchored text", () => {
  const s = open(`A <span data-cid="${CID}">one</span> B.`);
  assert.equal(s.ctrl.revealComment(CID), true);
  assert.equal(s.ctrl.editor.state.selection.from, 3);
  assert.equal(s.ctrl.editor.state.selection.to, 6);
  assert.equal(s.ctrl.revealComment("c_nope"), false);
  s.close();
});

await check("the anchor maps through edits elsewhere in the document", () => {
  const s = open("Alpha bravo charlie.");
  s.ctrl.editor.chain().setTextSelection({ from: 7, to: 12 }).run();
  s.ctrl.setComment(CID);
  s.ctrl.editor.chain().setTextSelection(1).insertContent("XYZ ").run();
  assert.equal(
    s.ctrl.getMarkdown(),
    `XYZ Alpha <span data-cid="${CID}">bravo</span> charlie.`
  );
  assert.equal(s.ctrl.getCommentRanges()[0].text, "bravo");
  s.close();
});

await check("removing several anchors at once keeps the plain text", () => {
  const s = open(
    'A <span data-cid="c_aaa">one</span> B <span data-cid="c_bbb">two</span>.'
  );
  s.ctrl.removeComments(["c_aaa", "c_bbb"]);
  assert.equal(s.ctrl.getMarkdown(), "A one B two.");
  s.close();
});

await check("a comment inside a character-table cell survives", () => {
  const box = [
    '<aside class="character-table">',
    '<table class="ct-rows">',
    `<tr class="ct-row"><td class="ct-label">A</td><td class="ct-value"><span data-cid="${CID}">hi</span></td></tr>`,
    "</table>",
    "</aside>",
  ].join("\n");
  const s = open(box);
  assert.equal(s.ctrl.getMarkdown(), box);
  s.close();
});

if (failures) {
  console.log(`editor-comments: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("editor-comments: all checks passed");
