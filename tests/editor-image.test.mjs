// jsdom test for inline images in the built editor bundle.
//
// This drives the real `static/dist/editor.bundle.js` (built from
// client/editor-entry.js), because the risky part is the Markdown round trip:
// before image support existed the editor silently *deleted* `![](...)` from
// any document it opened, and a resize has to survive save/reopen without
// corrupting the file.
//
// Run: npm run build && node tests/editor-image.test.mjs  (or `npm run test:editor`)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "static", "dist", "editor.bundle.js");
if (!fs.existsSync(bundlePath)) {
  console.error("editor-image: static/dist/editor.bundle.js is missing — run `npm run build` first");
  process.exit(1);
}

const dom = new JSDOM("<!DOCTYPE html><body><div id='m'></div></body>", { runScripts: "dangerously" });
dom.window.eval(fs.readFileSync(bundlePath, "utf8"));

const PID = "my-project";
const Q = String.fromCharCode(34);

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
  const ctrl = dom.window.LainEditor.create({
    element: host,
    content,
    placeholder: "Begin writing…",
    onChange: () => {},
    projectId: "projectId" in opts ? opts.projectId : PID,
    uploadImage:
      opts.uploadImage ||
      (async (f) => {
        uploaded.push(f.name);
        return { path: "assets/new-file-abc123.png", width: 8, height: 6 };
      }),
    onImageError: (message) => errors.push(message),
    onUploadState: (busy) => active.push(busy),
    onOpenImage: opts.onOpenImage || (() => {}),
  });
  return { host, ctrl, errors, active, uploaded, close: () => ctrl.destroy() };
}

const img = (host) => host.querySelector("img.doc-image");
const file = (name = "Mara Portrait.png", type = "image/png") =>
  new dom.window.File([new Uint8Array([137, 80, 78, 71])], name, { type });

/* ---------------- round trips ---------------- */

await check("a plain Markdown image survives load → save", () => {
  const s = open("Before\n\n![a cat](assets/cat.png)\n\nAfter");
  assert.equal(s.ctrl.getMarkdown(), "Before\n\n![a cat](assets/cat.png)\n\nAfter");
  assert.equal(img(s.host).getAttribute("src"), `/api/projects/${PID}/assets/cat.png`);
  s.close();
});

await check("a resized inline-HTML image keeps its width", () => {
  const source = `text <img src=${Q}assets/x.png${Q} alt=${Q}cat${Q} width=${Q}300${Q}> more`;
  const s = open(source);
  assert.equal(s.ctrl.getMarkdown(), source);
  assert.equal(img(s.host).style.width, "300px");
  assert.equal(img(s.host).style.height, "auto");
  s.close();
});

await check("text input is still untouched", () => {
  const source = "# Heading\n\nSome *text* with **bold** and [[a link]].\n\n- one\n- two";
  const s = open(source);
  assert.equal(s.ctrl.getMarkdown(), source);
  s.close();
});

await check("a served URL inside a file is normalised back to the stored path", () => {
  const s = open(`x\n\n![](/api/projects/${PID}/assets/cat.png)`);
  assert.equal(s.ctrl.getMarkdown(), "x\n\n![](assets/cat.png)");
  s.close();
});

await check("an external URL is left alone", () => {
  const s = open("x\n\n![](https://example.com/y.png)");
  assert.equal(s.ctrl.getMarkdown(), "x\n\n![](https://example.com/y.png)");
  assert.equal(img(s.host).getAttribute("src"), "https://example.com/y.png");
  s.close();
});

await check("clipboard HTML carries the served URL and the width", () => {
  const s = open(`text <img src=${Q}assets/x.png${Q} width=${Q}250${Q}> more`);
  const html = s.ctrl.editor.getHTML();
  assert.match(html, /src="\/api\/projects\/my-project\/assets\/x\.png"/);
  assert.match(html, /width="250"/);
  s.close();
});

await check("many images in one document all survive", () => {
  const source =
    "![](assets/a.png)\n\n![b](assets/b.png)\n\n" +
    `<img src=${Q}assets/c.png${Q} width=${Q}120${Q}>`;
  const s = open(source);
  assert.equal(s.ctrl.getMarkdown(), source);
  assert.equal(s.host.querySelectorAll("img.doc-image").length, 3);
  s.close();
});

/* ---------------- insertion ---------------- */

await check("insertImage uploads and inserts at the caret", async () => {
  const s = open("x");
  await s.ctrl.insertImage(file());
  assert.deepEqual(s.uploaded, ["Mara Portrait.png"]);
  assert.equal(s.ctrl.getMarkdown(), "![Mara Portrait](assets/new-file-abc123.png)x");
  assert.equal(img(s.host).getAttribute("src"), `/api/projects/${PID}/assets/new-file-abc123.png`);
  assert.deepEqual(s.active, [true, false]);
  s.close();
});

await check("a failed upload inserts nothing and reports the error", async () => {
  const s = open("x", {
    uploadImage: async () => {
      throw new Error("Image exceeds the 10 MB limit");
    },
  });
  await s.ctrl.insertImage(file());
  assert.equal(s.ctrl.getMarkdown(), "x");
  assert.equal(img(s.host), null);
  assert.deepEqual(s.errors, ["Image exceeds the 10 MB limit"]);
  s.close();
});

await check("a non-image file is ignored without an upload", async () => {
  const s = open("x");
  await s.ctrl.insertImage(file("notes.txt", "text/plain"));
  assert.equal(s.uploaded.length, 0);
  assert.equal(s.ctrl.getMarkdown(), "x");
  s.close();
});

await check("several files insert in the given order", async () => {
  let n = 0;
  const s = open("x", {
    uploadImage: async () => ({ path: `assets/pic${++n}-aaaa1111.png` }),
  });
  await s.ctrl.insertImage([file("a.png"), file("b.png")]);
  const markdown = s.ctrl.getMarkdown();
  assert.ok(markdown.indexOf("pic1-") < markdown.indexOf("pic2-"), markdown);
  s.close();
});

/* ---------------- drop & paste props ---------------- */

// ProseMirror's own drop handler needs real layout (it resolves a position
// before consulting this prop), so the prop is called directly here.
async function settle(fn, host) {
  for (let i = 0; i < 100 && !fn(host); i++) await new Promise((r) => setTimeout(r, 5));
}

await check("a drop inserts the picture at the drop position", async () => {
  const s = open("one two three");
  const view = s.ctrl.editor.view;
  const props = s.ctrl.editor.options.editorProps;
  const original = view.posAtCoords;
  view.posAtCoords = () => ({ pos: 1, inside: -1 });
  let prevented = false;
  const handled = props.handleDrop(view, {
    clientX: 5,
    clientY: 5,
    preventDefault: () => {
      prevented = true;
    },
    dataTransfer: { files: [file("Dropped Shot.png")] },
  });
  view.posAtCoords = original;

  assert.equal(handled, true);
  assert.equal(prevented, true, "the browser default (navigating to the file) is suppressed");
  await settle((host) => host.querySelector("img.doc-image"), s.host);
  assert.deepEqual(s.uploaded, ["Dropped Shot.png"]);
  assert.equal(s.ctrl.getMarkdown(), "![Dropped Shot](assets/new-file-abc123.png)one two three");
  assert.deepEqual(s.active, [true, false]);
  s.close();
});

await check("a drop without layout info falls back to the caret", async () => {
  const s = open("text");
  const view = s.ctrl.editor.view;
  view.posAtCoords = () => {
    throw new TypeError("no layout here");
  };
  const props = s.ctrl.editor.options.editorProps;
  const handled = props.handleDrop(view, {
    clientX: 0,
    clientY: 0,
    preventDefault: () => {},
    dataTransfer: { files: [file("Fallback.png")] },
  });
  assert.equal(handled, true);
  await settle((host) => host.querySelector("img.doc-image"), s.host);
  assert.equal(s.uploaded.length, 1);
  s.close();
});

await check("a dropped non-image is refused, not inserted", () => {
  const s = open("text");
  const props = s.ctrl.editor.options.editorProps;
  const handled = props.handleDrop(s.ctrl.editor.view, {
    clientX: 0,
    clientY: 0,
    preventDefault: () => {},
    dataTransfer: { files: [file("report.pdf", "application/pdf")] },
  });
  assert.equal(handled, true, "consumed so the window never navigates to the file");
  assert.deepEqual(s.errors, ["Only PNG, JPEG, GIF and WebP images can be inserted."]);
  assert.equal(s.uploaded.length, 0);
  s.close();
});

await check("a drag with no files is left to ProseMirror", () => {
  const s = open("text");
  const props = s.ctrl.editor.options.editorProps;
  assert.equal(
    props.handleDrop(s.ctrl.editor.view, { preventDefault: () => {}, dataTransfer: { files: [] } }),
    false
  );
  assert.equal(props.handleDrop(s.ctrl.editor.view, { dataTransfer: null }), false);
  s.close();
});

await check("moving a picture inside the editor is left to ProseMirror", async () => {
  // Chromium puts the dragged <img> into dataTransfer.files *and* ProseMirror
  // records the drag in view.dragging. Treating that as a file drop copied the
  // picture instead of moving it, so the prop must decline while dragging.
  const s = open("![](assets/x.png)");
  const view = s.ctrl.editor.view;
  const props = s.ctrl.editor.options.editorProps;
  view.dragging = { slice: null, move: true, node: null };
  let prevented = false;
  const handled = props.handleDrop(view, {
    clientX: 5,
    clientY: 5,
    preventDefault: () => {
      prevented = true;
    },
    dataTransfer: { files: [file("x-abc123.png")] },
  });
  view.dragging = null;

  assert.equal(handled, false, "ProseMirror keeps the drop");
  assert.equal(prevented, false);
  assert.equal(s.uploaded.length, 0, "no second copy is uploaded");
  assert.equal(s.host.querySelectorAll("img.doc-image").length, 1);
  s.close();
});

await check("pasting a picture copied from the editor keeps its width", async () => {
  // The clipboard carries both the document slice and the image file; the
  // slice wins so a resized picture is not silently reset to natural size.
  const s = open("text");
  const props = s.ctrl.editor.options.editorProps;
  const slice = {
    content: {
      descendants(cb) {
        cb({ type: { name: "image" }, attrs: { src: "assets/x.png", width: 300 } });
      },
    },
  };
  const handled = props.handlePaste(s.ctrl.editor.view, { clipboardData: { files: [file()] } }, slice);
  assert.equal(handled, false, "ProseMirror pastes the slice");
  assert.equal(s.uploaded.length, 0);
  s.close();
});

await check("a slice carrying a remote picture still uploads the file", async () => {
  const s = open("text");
  const props = s.ctrl.editor.options.editorProps;
  const slice = {
    content: {
      descendants(cb) {
        cb({ type: { name: "image" }, attrs: { src: "https://example.com/pasted.png" } });
      },
    },
  };
  const handled = props.handlePaste(
    s.ctrl.editor.view,
    { preventDefault: () => {}, clipboardData: { files: [file()] } },
    slice
  );
  assert.equal(handled, true);
  assert.equal(s.uploaded.length, 1);
  s.close();
});

await check("a pasted image is inserted, ordinary pastes pass through", async () => {
  const s = open("text");
  const props = s.ctrl.editor.options.editorProps;
  let prevented = false;
  const handled = props.handlePaste(s.ctrl.editor.view, {
    preventDefault: () => {
      prevented = true;
    },
    clipboardData: { files: [file("Pasted Shot.png")] },
  });
  assert.equal(handled, true);
  assert.equal(prevented, true);
  await settle((host) => host.querySelector("img.doc-image"), s.host);
  assert.deepEqual(s.uploaded, ["Pasted Shot.png"]);

  // Plain text (and a paste carrying no files) must reach ProseMirror normally.
  assert.equal(props.handlePaste(s.ctrl.editor.view, { clipboardData: { files: [] } }), false);
  assert.equal(props.handlePaste(s.ctrl.editor.view, { clipboardData: null }), false);
  s.close();
});

/* ---------------- node view ---------------- */

await check("the resize handle and reset chip are rendered", () => {
  const s = open(`<img src=${Q}assets/x.png${Q} width=${Q}300${Q}>`);
  const wrap = s.host.querySelector(".image-node");
  assert.ok(wrap, "wrapper");
  assert.ok(s.host.querySelector(".image-resize-handle"), "handle");
  assert.ok(wrap.classList.contains("can-reset"), "reset chip shown for a sized image");
  s.close();

  const plain = open("![](assets/y.png)");
  assert.ok(!plain.host.querySelector(".image-node").classList.contains("can-reset"));
  plain.close();
});

await check("a picture that fails to load shows a missing-image chip", () => {
  const s = open("![](assets/gone.png)");
  const image = img(s.host);
  image.dispatchEvent(new dom.window.Event("error"));
  const wrap = s.host.querySelector(".image-node");
  assert.ok(wrap.classList.contains("missing"));
  assert.match(s.host.querySelector(".image-missing").textContent, /assets\/gone\.png/);
  s.close();
});

await check("double-clicking a picture offers the full-size view", () => {
  const opened = [];
  const s = open("![](assets/x.png)", { onOpenImage: (info) => opened.push(info) });
  img(s.host).dispatchEvent(new dom.window.Event("dblclick", { bubbles: true }));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, `/api/projects/${PID}/assets/x.png`);
  assert.equal(opened[0].src, "assets/x.png");
  s.close();
});

await check("without a project id a picture has no servable url", () => {
  const opened = [];
  const s = open("![](assets/x.png)", { projectId: null, onOpenImage: (info) => opened.push(info) });
  assert.equal(img(s.host).getAttribute("src"), "assets/x.png");
  img(s.host).dispatchEvent(new dom.window.Event("dblclick", { bubbles: true }));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, "assets/x.png");
  s.close();
});

if (failures) {
  console.log(`editor-image: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("editor-image: all checks passed");
