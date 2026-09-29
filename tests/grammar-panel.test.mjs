// jsdom test for the Language panel: the list, the severity filters, reveal,
// applying a suggestion, spelling, and the dock/undock toggle. The panel is a
// plain static/js module, so this drives it with a fake controller rather than
// the editor bundle.
//
// Run: node tests/grammar-panel.test.mjs  (or `npm run test:languagepanel`)
import assert from "node:assert/strict";

import { JSDOM } from "jsdom";

function defineGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    globalThis[name] = value;
  }
}

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/" });
const w = dom.window;
defineGlobal("window", w);
defineGlobal("document", w.document);
defineGlobal("location", w.location);
defineGlobal("HTMLElement", w.HTMLElement);
defineGlobal("Element", w.Element);
defineGlobal("Node", w.Node);
defineGlobal("Event", w.Event);
defineGlobal("MouseEvent", w.MouseEvent);
defineGlobal("localStorage", w.localStorage);

const DOC_TEXT = "teh cat sat.";

function makeDoc(text) {
  const block = { isTextblock: true, textContent: text };
  return {
    content: { size: text.length + 2 },
    textBetween: (from, to) => text.slice(from - 1, to - 1),
    descendants: (fn) => fn(block, 0),
  };
}

function makeCtrl(text) {
  const calls = { reveal: [], replace: [] };
  const doc = makeDoc(text);
  return {
    calls,
    editor: { state: { doc } },
    revealRange: (from, to) => {
      calls.reveal.push([from, to]);
      return true;
    },
    applyGrammarReplacement: (from, to, value) => {
      calls.replace.push([from, to, value]);
      return true;
    },
  };
}

function entry(from, to, match) {
  return { from, to, match };
}

const ERROR = {
  severity: "error",
  message: "Possible spelling mistake",
  category: "Possible Typo",
  rule_description: "Possible spelling mistake",
  replacements: ["the"],
  context_text: DOC_TEXT,
  context_offset: 0,
  length: 3,
};
const STYLE = {
  severity: "style",
  message: "For a more expressive style, consider the active voice.",
  category: "Style",
  rule_description: "passive voice",
  replacements: ["the cat"],
  context_text: DOC_TEXT,
  context_offset: 4,
  length: 3,
};

const { grammarPanel } = await import("../static/js/grammar-panel.js");

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}\n      ${err.stack || err.message}`);
  }
}

function click(node) {
  node.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
}

function mount(overrides = {}) {
  w.localStorage.clear();
  const ctrl = makeCtrl(DOC_TEXT);
  const pane = { name: "primary", docId: "01-scene", ctrl };
  const counts = [];
  const words = [];
  const panel = grammarPanel({
    pane,
    isEnabled: () => true,
    onCount: (n) => counts.push(n),
    onAddWord: (word) => words.push(word),
    onClose: () => {},
    ...overrides,
  });
  panel.classList.add("open");
  panel._render();
  return { panel, ctrl, counts, words };
}

function setResults(panel, matches) {
  panel.setResults({ matches, textHash: "h" });
}

function items(panel) {
  return [...panel.querySelectorAll(".language-item")];
}

await check("lists every issue, headlines the count, and reports it", async () => {
  const { panel, counts } = mount();
  setResults(panel, [entry(1, 4, ERROR), entry(5, 8, STYLE)]);
  assert.equal(items(panel).length, 2, "both issues listed");
  assert.equal(panel.querySelector(".language-total").textContent, "2");
  assert.deepEqual(counts.at(-1), 2, "onCount got the total");
  const flags = items(panel).map((el) => el.querySelector(".language-flag").textContent);
  assert.deepEqual(flags, ["teh", "cat"], `flags: ${JSON.stringify(flags)}`);
});

await check("the severity filter narrows the list", async () => {
  const { panel } = mount();
  setResults(panel, [entry(1, 4, ERROR), entry(5, 8, STYLE)]);
  const styleFilter = panel.querySelector('.language-filter[data-severity="style"]');
  click(styleFilter);
  const shown = items(panel);
  assert.equal(shown.length, 1, "only the style issue remains");
  assert.ok(shown[0].classList.contains("severity-style"));
  click(panel.querySelector('.language-filter[data-severity="all"]'));
  assert.equal(items(panel).length, 2, "All restores both");
});

await check("clicking an issue reveals its range in the editor", async () => {
  const { panel, ctrl } = mount();
  setResults(panel, [entry(1, 4, ERROR), entry(5, 8, STYLE)]);
  click(items(panel)[1]);
  assert.deepEqual(ctrl.calls.reveal.at(-1), [5, 8]);
  assert.ok(items(panel)[1].classList.contains("active"), "the row is marked active");
});

await check("a suggestion chip applies the replacement at the right range", async () => {
  const { panel, ctrl } = mount();
  setResults(panel, [entry(1, 4, ERROR)]);
  const chip = panel.querySelector(".language-rep");
  assert.equal(chip.textContent, "the");
  click(chip);
  assert.deepEqual(ctrl.calls.replace.at(-1), [1, 4, "the"]);
});

await check("Add to spelling hands the flagged word over", async () => {
  const { panel, words } = mount();
  setResults(panel, [entry(1, 4, ERROR)]);
  const add = [...panel.querySelectorAll(".language-rep")].find((b) => b.textContent === "In spelling");
  click(add);
  assert.deepEqual(words, ["teh"]);
});

await check("an edit marks the list stale without dropping it", async () => {
  const { panel } = mount();
  setResults(panel, [entry(1, 4, ERROR)]);
  panel.markStale();
  assert.ok(panel.querySelector(".language-stale"), "a stale note is shown");
  assert.equal(items(panel).length, 1, "the issues stay listed");
});

await check("docked by default, undock floats and is remembered", async () => {
  const { panel } = mount();
  assert.ok(panel.classList.contains("docked"), "starts docked");
  assert.ok(!panel.classList.contains("floating"));
  click(panel.querySelector(".language-dock"));
  assert.ok(panel.classList.contains("floating"), "now floating");
  assert.equal(w.localStorage.getItem("im.language.docked"), "0", "the choice persisted");
});

await check("a drifted offset is re-found by its text", async () => {
  const { panel, ctrl } = mount();
  // The stored range no longer holds "teh" (the text moved), so the panel must
  // locate it by the flagged text instead.
  setResults(panel, [{ from: 20, to: 23, match: ERROR }]);
  click(items(panel)[0]);
  assert.deepEqual(ctrl.calls.reveal.at(-1), [1, 4]);
});

await check("grammar off shows a hint instead of a stale list", async () => {
  const { panel } = mount({ isEnabled: () => false });
  setResults(panel, [entry(1, 4, ERROR)]);
  panel._render();
  assert.ok(panel.querySelector(".empty-hint"), "a hint is shown");
  assert.equal(items(panel).length, 0, "no issues listed while off");
});

await check("a pending document shows an empty state", async () => {
  const { panel } = mount({ isEnabled: () => true });
  panel._render();
  assert.ok(panel.textContent.includes("No issues found"), `got: ${panel.textContent}`);
});

if (failures) {
  console.error(`grammar-panel: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("grammar-panel: ok");
