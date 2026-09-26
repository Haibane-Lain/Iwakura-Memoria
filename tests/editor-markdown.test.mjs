// jsdom test pinning the built editor bundle's Markdown round trip for
// escaped brackets.
//
// `[[wikilinks]]` are literal text decorated by WIKILINK_RE, so the serializer
// escapes each bracket and `toMarkdown()` unescapes them. That unescape used to
// be global (`\\[` -> `[`), which also ate *real* escapes in link labels, image
// alt text and code spans — permanently corrupting the stored Markdown on save.
// The fix narrows it to the doubled `\[\[` / `\]\]` forms only.
//
// Run: npm run build && node tests/editor-markdown.test.mjs  (or `npm run test:markdown`)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "static", "dist", "editor.bundle.js");
if (!fs.existsSync(bundlePath)) {
  console.error("editor-markdown: static/dist/editor.bundle.js is missing — run `npm run build` first");
  process.exit(1);
}

const dom = new JSDOM("<!DOCTYPE html><body><div id='m'></div></body>", { runScripts: "dangerously" });
dom.window.eval(fs.readFileSync(bundlePath, "utf8"));

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

function roundTrip(content) {
  const host = dom.window.document.getElementById("m");
  host.replaceChildren();
  const ctrl = dom.window.LainEditor.create({
    element: host,
    content,
    placeholder: "Begin writing…",
    onChange: () => {},
    projectId: "my-project",
    uploadImage: async () => ({ path: "assets/x.png", width: 8, height: 6 }),
    onImageError: () => {},
    onUploadState: () => {},
    onOpenImage: () => {},
  });
  const out = ctrl.getMarkdown();
  ctrl.destroy();
  return out;
}

/* ---------------- escaped brackets ---------------- */

check("a wikilink still round-trips unescaped", () => {
  assert.equal(roundTrip("See [[Alice]] and [[Target|alias]]."), "See [[Alice]] and [[Target|alias]].");
});

check("an escaped bracket in a link label is preserved", () => {
  const source = "[a\\]b](https://example.com)";
  assert.equal(roundTrip(source), source, "the label's real escape must survive");
});

// Note: an escaped bracket inside image alt text is *not* covered here.
// markdown-it renders the image's `alt` attribute with bracket escapes dropped
// (a separate pre-existing limitation), so the editor never round-trips it.

check("escaped brackets inside a code span are preserved", () => {
  const source = "Use `\\[x\\]` here.";
  assert.equal(roundTrip(source), source, "code content must not be rewritten");
});

check("escaped brackets inside a fenced code block are preserved", () => {
  const source = "```\n\\[x\\]\n```";
  assert.equal(roundTrip(source), source, "fenced code content must not be rewritten");
});

check("single escaped brackets in prose survive", () => {
  const source = "An aside \\[sic\\] in the text.";
  assert.equal(roundTrip(source), source);
});

/* ---------------- aligned blocks ---------------- */

check("an aligned paragraph keeps project-relative image srcs", () => {
  const host = dom.window.document.getElementById("m");
  host.replaceChildren();
  const ctrl = dom.window.LainEditor.create({
    element: host,
    content: "before ![cat](assets/x.png) after",
    placeholder: "Begin writing…",
    onChange: () => {},
    projectId: "my-project",
    uploadImage: async () => ({ path: "assets/x.png" }),
    onImageError: () => {},
    onUploadState: () => {},
    onOpenImage: () => {},
  });
  // Align the paragraph the way the ribbon does, then save.
  ctrl.editor.commands.selectAll();
  ctrl.setBlockTextAlign("center");
  const out = ctrl.getMarkdown();
  ctrl.destroy();

  assert.ok(out.includes("text-align:center"), `the alignment was lost: ${out}`);
  assert.ok(out.includes('src="assets/x.png"'), `expected the stored src, got: ${out}`);
  assert.ok(!out.includes("/api/"), `a served URL leaked into the Markdown: ${out}`);
  assert.ok(!out.includes("doc-image"), `an editor-only class leaked: ${out}`);
  assert.ok(!out.includes("loading="), `an editor-only attribute leaked: ${out}`);
});

/* ---------------- heading levels ---------------- */

check("h4-h6 headings survive load → save", () => {
  const source = "# One\n\n#### Four\n\n##### Five\n\n###### Six\n\nBody.";
  assert.equal(roundTrip(source), source, "deeper headings must not flatten to paragraphs");
});

if (failures) {
  console.error(`editor-markdown: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("editor-markdown: ok");
