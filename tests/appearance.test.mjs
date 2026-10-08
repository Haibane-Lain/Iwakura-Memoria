// Unit/behavior tests for the appearance layer and the theme picker.
//
// appearance.js is pure except for applyAppearance(), which touches a target
// element; themes.js builds DOM, so this runs under jsdom for the picker half.
//
// Run: node tests/appearance.test.mjs  (or `npm run test:appearance`)
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
for (const [name, value] of Object.entries({
  window: w,
  document: w.document,
  location: w.location,
  HTMLElement: w.HTMLElement,
  Element: w.Element,
  Node: w.Node,
  Event: w.Event,
  MouseEvent: w.MouseEvent,
  CustomEvent: w.CustomEvent,
})) {
  defineGlobal(name, value);
}

const appearance = await import("../static/js/appearance.js");
const themesMod = await import("../static/js/themes.js");

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

console.log("appearance:");

check("editorWidthPx maps the width ids, falling back to medium", () => {
  assert.equal(appearance.editorWidthPx("narrow"), 620);
  assert.equal(appearance.editorWidthPx("medium"), 760);
  assert.equal(appearance.editorWidthPx("wide"), 960);
  assert.equal(appearance.editorWidthPx("nonsense"), 760);
  assert.equal(appearance.editorWidthPx(undefined), 760);
});

check("uiFontStack returns the stack, or empty for the theme default", () => {
  assert.equal(appearance.uiFontStack(""), "");
  assert.match(appearance.uiFontStack("mono"), /Consolas/);
  assert.equal(appearance.uiFontStack("nonsense"), "");
});

check("pickAppearance keeps only the keys it owns", () => {
  const picked = appearance.pickAppearance({
    theme: "noir",
    editorWidth: "wide",
    reducedMotion: true,
    ai: {},
  });
  assert.deepEqual(picked, { editorWidth: "wide", reducedMotion: true });
});

check("applyAppearance writes the overrides and removes them again", () => {
  const target = document.createElement("div");

  appearance.applyAppearance(target, {
    accentColor: "#ff8800",
    cornerStyle: "sharp",
    uiFont: "mono",
    texturesEnabled: false,
    reducedMotion: true,
    editorWidth: "wide",
  });
  assert.equal(target.style.getPropertyValue("--accent"), "#ff8800");
  assert.ok(target.hasAttribute("data-accent"));
  assert.equal(target.dataset.corners, "sharp");
  assert.match(target.style.getPropertyValue("--font-ui"), /Consolas/);
  assert.ok(target.classList.contains("no-texture"));
  assert.ok(target.classList.contains("reduced-motion"));
  assert.equal(target.style.getPropertyValue("--editor-max-width"), "960px");

  // Defaults: no inline accent, no attribute, theme decides the rest.
  appearance.applyAppearance(target, {});
  assert.equal(target.style.getPropertyValue("--accent"), "");
  assert.ok(!target.hasAttribute("data-accent"));
  assert.equal(target.dataset.corners, undefined);
  assert.equal(target.style.getPropertyValue("--font-ui"), "");
  assert.ok(!target.classList.contains("no-texture"));
  assert.ok(!target.classList.contains("reduced-motion"));
  assert.equal(target.style.getPropertyValue("--editor-max-width"), "760px");
});

check("the theme list keeps the old seven and adds the new four", () => {
  const ids = themesMod.themes.map((t) => t.id);
  for (const id of ["paper", "ink", "typewriter", "gothic", "horror", "fantasy", "sci-fi"]) {
    assert.ok(ids.includes(id), `missing legacy theme ${id}`);
  }
  for (const id of ["sepia", "vellum", "terminal", "noir"]) {
    assert.ok(ids.includes(id), `missing new theme ${id}`);
  }
  assert.equal(themesMod.DEFAULT_THEME, "gothic");
});

check("themePicker renders a card per theme, marking the current one", () => {
  const grid = themesMod.themePicker();
  const cards = grid.querySelectorAll(".theme-card");
  assert.equal(cards.length, themesMod.themes.length);
  const active = grid.querySelector(".theme-card.active");
  assert.ok(active, "one card is active");
  assert.equal(active.dataset.themeId, themesMod.getCurrent());
  // Each preview carries the real theme attribute, so CSS paints it.
  assert.equal(grid.querySelectorAll(".theme-thumb[data-theme]").length, themesMod.themes.length);
});

if (failures) {
  console.log(`appearance: ${failures} failure(s)`);
  process.exit(1);
}
console.log("appearance: ok");
