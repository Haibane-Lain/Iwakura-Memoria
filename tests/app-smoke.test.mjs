// jsdom smoke test for the app shell (static/js/app.js, library.js, project.js).
//
// The individual modules have their own unit tests, but nothing else loads the
// shell itself: the boot path, the router wiring and the big render functions
// (tabs, sidebar) are only covered by hand. That is exactly the surface a
// future split of project.js would most likely break — a module-eval error, a
// cycle, a renamed helper, a render that throws — so this pins "it still
// boots and renders" against a mocked API.
//
// jsdom has no layout engine: this is a smoke test, not an end-to-end one. It
// catches throws, not pixels.
//
// Run: npm run build && node tests/app-smoke.test.mjs  (or `npm run test:smoke`)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.join(here, "..", "static", "js");

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

// --- jsdom <-> Node scaffolding -------------------------------------------

/** Node's own globals are read-only in places; defineProperty is the safe write. */
function defineGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  } catch {
    globalThis[name] = value;
  }
}

/**
 * A jsdom document plus the browser globals the modules reference as bare
 * names (they are plain ES modules, not bundled, so `document` is resolved
 * against globalThis).
 */
function makeDom() {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
    { url: "http://localhost/" }
  );
  const w = dom.window;
  defineGlobal("window", w);
  defineGlobal("document", w.document);
  defineGlobal("location", w.location);
  defineGlobal("localStorage", w.localStorage);
  defineGlobal("getComputedStyle", w.getComputedStyle.bind(w));
  defineGlobal("HTMLElement", w.HTMLElement);
  defineGlobal("Element", w.Element);
  defineGlobal("Node", w.Node);
  defineGlobal("Event", w.Event);
  defineGlobal("CustomEvent", w.CustomEvent);
  defineGlobal("MouseEvent", w.MouseEvent);
  defineGlobal("KeyboardEvent", w.KeyboardEvent);
  defineGlobal("DOMParser", w.DOMParser);
  defineGlobal("requestAnimationFrame", (cb) => w.setTimeout(() => cb(Date.now()), 0));
  defineGlobal("cancelAnimationFrame", (id) => w.clearTimeout(id));
  return dom;
}

/** A minimal stand-in for the parts of `Response` that static/js/api.js reads. */
function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "",
    headers: { get: () => null },
    async json() {
      return data;
    },
    async blob() {
      return new Blob([]);
    },
  };
}

/**
 * Replace `fetch` with a route table. `routes` is `[RegExp, () => data]`;
 * anything not matched is recorded in `unmatched` so test drift is visible
 * instead of silently swallowed by the render code's own try/catch.
 */
function installFetch(routes) {
  const calls = [];
  const unmatched = [];
  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);
    const method = (opts.method || "GET").toUpperCase();
    calls.push(`${method} ${href}`);
    for (const [pattern, handler] of routes) {
      if (pattern.test(href)) return jsonResponse(await handler(href, method));
    }
    unmatched.push(`${method} ${href}`);
    return jsonResponse({}, 404);
  };
  return { calls, unmatched };
}

async function waitFor(predicate, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeout) {
      throw new Error("timed out waiting for the shell to render");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** Collect throws from boot (window "error") and un-awaited async (rejections). */
function captureErrors(dom) {
  const errors = [];
  const onWindowError = (e) => errors.push(e.error || e.message);
  const onRejection = (reason) => errors.push(reason);
  dom.window.addEventListener("error", onWindowError);
  process.on("unhandledRejection", onRejection);
  return {
    errors,
    stop() {
      dom.window.removeEventListener("error", onWindowError);
      process.removeListener("unhandledRejection", onRejection);
    },
  };
}

function importJs(name) {
  return import(pathToFileURL(path.join(JS_DIR, name)).href);
}

// --- fixtures ---------------------------------------------------------------

const PROJECT = {
  id: "demo",
  title: "Demo Project",
  goal: { wordsPerDay: 500, enabled: false },
  createdAt: "2026-01-01T00:00:00",
  updatedAt: "2026-01-01T00:00:00",
  words: 0,
  documents: 0,
};
const EMPTY_TREE = { folders: [], documents: [] };
const EMPTY_WIKI = { notes: [], links: [], backlinks: {}, broken: {}, linkCounts: {} };
const SETTINGS = {
  theme: "gothic",
  wordCountMode: "auto",
  autosaveMs: 800,
  editorFont: "serif",
  editorSize: 18,
  editorAlign: "left",
  editorZoom: 100,
  wikiZoom: 75,
  grammarEnabled: true,
  ai: {},
};
const STATS = {
  projectId: "demo",
  totalWords: 0,
  todayWords: 0,
  goal: { enabled: false, wordsPerDay: 0 },
  goalMetToday: false,
  progress: 0,
  streak: 0,
  lastDays: [],
  documents: 0,
};
const PROJECT_ROUTES = [
  [/\/api\/settings$/, () => SETTINGS],
  [/\/api\/projects\/demo\/tree\?scope=write$/, () => EMPTY_TREE],
  [/\/api\/projects\/demo\/tree\?scope=wiki$/, () => EMPTY_TREE],
  [/\/api\/projects\/demo\/tree\?scope=all$/, () => EMPTY_TREE],
  [/\/api\/projects\/demo\/dictionary$/, () => ({ words: [] })],
  [/\/api\/projects\/demo\/wiki$/, () => EMPTY_WIKI],
  [/\/api\/projects\/demo\/stats$/, () => STATS],
  [/\/api\/projects\/demo\/templates$/, () => []],
  [/\/api\/projects\/demo$/, () => PROJECT],
  [/\/api\/backups$/, () => []],
];

// --- 1. every module still evaluates ---------------------------------------

await check("every static/js module evaluates under jsdom", async () => {
  const dom = makeDom();
  const files = fs
    .readdirSync(JS_DIR)
    .filter((f) => f.endsWith(".js") && f !== "app.js")
    .sort();
  assert.ok(files.length >= 10, "found the frontend modules");
  for (const file of files) await importJs(file); // throws on a cycle/eval error

  const project = await importJs("project.js");
  const router = await importJs("router.js");
  const library = await importJs("library.js");
  const themes = await importJs("themes.js");
  assert.equal(typeof project.register, "function");
  assert.equal(typeof project.renderExportDialog, "function");
  assert.equal(typeof router.start, "function");
  assert.equal(typeof library.init, "function");
  assert.equal(typeof themes.themeSelect, "function");
  dom.window.close();
});

// --- 2. the project shell boots and switches tabs --------------------------

await check("the project shell boots against a mocked API", async () => {
  const dom = makeDom();
  const { unmatched } = installFetch(PROJECT_ROUTES);
  const capture = captureErrors(dom);

  const project = await importJs("project.js");
  const router = await importJs("router.js");
  project.register();
  dom.window.location.hash = "#/p/demo";
  router.start();

  const doc = dom.window.document;
  await waitFor(() => doc.querySelector("#app .workspace"));

  assert.ok(doc.querySelector("#app .topbar"), "topbar rendered");
  assert.ok(doc.querySelector("#app .sidebar"), "sidebar rendered");
  assert.ok(doc.querySelector("#app .workspace"), "workspace rendered");
  assert.ok(doc.querySelector("#app .main"), "main pane rendered");
  assert.equal(capture.errors.length, 0, `boot threw: ${capture.errors.map(String).join("; ")}`);

  // Switching tabs exercises the largest, most cross-coupled render functions.
  const click = (tab) =>
    doc
      .querySelector(`.tab-btn[data-tab="${tab}"]`)
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  click("settings");
  await waitFor(() => doc.querySelector("#main-content .settings-view"));
  assert.ok(doc.querySelector("#main-content .settings-view"), "settings tab renders");

  click("stats");
  await waitFor(() => doc.querySelector("#main-content .stats-view"));
  assert.ok(doc.querySelector("#main-content .stats-view"), "stats tab renders");

  click("write");
  await waitFor(() => doc.querySelector("#main-content .empty-state"));
  assert.match(
    doc.getElementById("main-content").textContent,
    /Nothing open/,
    "the empty Write tab renders its empty state"
  );

  assert.deepEqual(unmatched, [], `only known API routes were called: ${unmatched.join(", ")}`);
  assert.equal(capture.errors.length, 0, `a tab threw: ${capture.errors.map(String).join("; ")}`);
  capture.stop();
  dom.window.close();
});

// --- 3. app.js boots into the library --------------------------------------

await check("app.js boots into the library route", async () => {
  const dom = makeDom();
  const { unmatched } = installFetch([
    [/\/api\/settings$/, () => SETTINGS],
    [/\/api\/projects$/, () => []],
  ]);
  const capture = captureErrors(dom);

  await importJs("app.js"); // boot() runs on import
  const doc = dom.window.document;
  await waitFor(() => doc.querySelector("#app .library"));

  assert.ok(doc.querySelector("#app .topbar"), "library topbar rendered");
  assert.ok(doc.querySelector("#app .library"), "project library rendered");
  assert.match(doc.querySelector("#app .library").textContent, /No projects yet/);
  assert.equal(capture.errors.length, 0, `library boot threw: ${capture.errors.map(String).join("; ")}`);
  assert.deepEqual(unmatched, [], `only known API routes were called: ${unmatched.join(", ")}`);
  capture.stop();
  dom.window.close();
});

if (failures) {
  console.error(`app-smoke: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("app-smoke: ok");
