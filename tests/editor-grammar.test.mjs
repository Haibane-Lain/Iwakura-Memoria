// jsdom test for grammar decorations in the built editor bundle.
//
// Two mapping bugs are pinned here. `_grammarDocText` used to merge two text
// runs whenever they were adjacent in the *flattened* text, which also happens
// across an inline leaf (an image, a hard break) — every position after the
// leaf was then off by its size. And a suggestion used the offsets captured
// when the check ran, which go stale as soon as the user types: clicking it
// replaced the wrong characters. The squiggle is mapped by ProseMirror, so the
// clicked element is always the source of truth.
//
// Run: npm run build && node tests/editor-grammar.test.mjs  (or `npm run test:grammar`)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "static", "dist", "editor.bundle.js");
if (!fs.existsSync(bundlePath)) {
  console.error("editor-grammar: static/dist/editor.bundle.js is missing — run `npm run build` first");
  process.exit(1);
}

const dom = new JSDOM("<!DOCTYPE html><body><div id='m'></div></body>", { runScripts: "dangerously" });
dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);

// The editor posts the document text to /api/grammar/check; answer with a
// single "teh" -> "the" typo wherever it appears, using the LT text offsets the
// real server would report.
let lastCheckedText = "";
dom.window.fetch = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  lastCheckedText = body.text;
  const idx = body.text.indexOf("teh");
  const matches = idx < 0
    ? []
    : [
        {
          offset: idx,
          length: 3,
          message: "Possible spelling mistake",
          replacements: ["the"],
          rule: "MORFOLOGIK_RULE_EN_US",
        },
      ];
  return { ok: true, json: async () => ({ matches }) };
};

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const errors = (host) => [...host.querySelectorAll(".grammar-error")];

// forceGrammar fires on the next 300 ms tick.
async function runCheck(ctrl) {
  ctrl.setDictionaryWords([]);
  await wait(450);
}

function click(el) {
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

await check("a flagged word after an inline image is underlined in the right place", async () => {
  const s = open("abc ![cat](assets/x.png) teh end");
  try {
    await runCheck(s.ctrl);
    assert.ok(lastCheckedText.includes("teh"), `checked text: ${lastCheckedText}`);
    const hits = errors(s.host);
    assert.equal(hits.length, 1, `expected one squiggle, got ${hits.length}`);
    assert.equal(hits[0].textContent, "teh", `squiggle covers ${JSON.stringify(hits[0].textContent)}`);
  } finally {
    s.close();
  }
});

await check("a suggestion applies to the word that was clicked, not a stale offset", async () => {
  const s = open("teh end");
  try {
    await runCheck(s.ctrl);
    const [hit] = errors(s.host);
    assert.ok(hit, "the word is flagged");
    // Type before the flagged word; the decoration maps with the text.
    s.ctrl.editor.view.dispatch(s.ctrl.editor.state.tr.insertText("XY ", 1));
    const [moved] = errors(s.host);
    assert.equal(moved.textContent, "teh", "the squiggle followed the word");

    click(moved);
    const chip = [...dom.window.document.querySelectorAll(".grammar-rep-chip")].find(
      (el) => el.textContent === "the"
    );
    assert.ok(chip, "the replacement chip is offered");
    click(chip);

    const md = s.ctrl.getMarkdown();
    assert.equal(md.trim(), "XY the end", `got: ${JSON.stringify(md)}`);
  } finally {
    s.close();
  }
});

await check("clicking a suggestion after an inline image keeps the image", async () => {
  const s = open("abc ![cat](assets/x.png) teh end");
  try {
    await runCheck(s.ctrl);
    const [hit] = errors(s.host);
    assert.ok(hit, "the word is flagged");
    click(hit);
    const chip = [...dom.window.document.querySelectorAll(".grammar-rep-chip")].find(
      (el) => el.textContent === "the"
    );
    assert.ok(chip, "the replacement chip is offered");
    click(chip);

    const md = s.ctrl.getMarkdown();
    assert.ok(md.includes("assets/x.png"), `the picture survived: ${md}`);
    assert.ok(md.includes("the end"), `the word was replaced: ${md}`);
    assert.ok(!md.includes("teh"), `the typo is gone: ${md}`);
  } finally {
    s.close();
  }
});

await check("disabling grammar clears the squiggles", async () => {
  const s = open("teh end");
  try {
    await runCheck(s.ctrl);
    assert.equal(errors(s.host).length, 1, "flagged while enabled");
    s.ctrl.setGrammarEnabled(false);
    assert.equal(errors(s.host).length, 0, "cleared when disabled");
  } finally {
    s.close();
  }
});

if (failures) {
  console.error(`editor-grammar: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("editor-grammar: ok");
