// jsdom smoke test for chapter review colors in the sidebar.
//
// Kept in its own file (and therefore its own Node process) because project.js
// is an ES module with process-wide state: re-importing it in another test's
// process would double-register the router and share state between checks.
//
// The editor bundle is not loaded here, so document rendering stops at
// "Editor failed to load" after the sidebar is already drawn — exactly the
// surface under test.
//
// Run: npm run build && node tests/tree-colors.test.mjs  (or `npm run test:treecolors`)
import assert from "node:assert/strict";
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

function defineGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    globalThis[name] = value;
  }
}

function makeDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
    url: "http://localhost/",
  });
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

// `handler` receives (href, method, opts) so a route can read the request body.
function installFetch(routes) {
  const calls = [];
  const unmatched = [];
  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);
    const method = (opts.method || "GET").toUpperCase();
    calls.push(`${method} ${href}`);
    for (const [pattern, handler] of routes) {
      if (pattern.test(href)) return jsonResponse(await handler(href, method, opts));
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
    if (Date.now() - start > timeout) throw new Error("timed out waiting for the shell to render");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function importJs(name) {
  return import(pathToFileURL(path.join(JS_DIR, name)).href);
}

// --- fixtures ---------------------------------------------------------------

const PROJECT = {
  id: "demo",
  title: "Demo Project",
  goal: { wordsPerDay: 0, enabled: false },
  createdAt: "2026-01-01T00:00:00",
  updatedAt: "2026-01-01T00:00:00",
  words: 0,
  documents: 0,
};
// "Alpha" is already marked red, "Beta" is an unmarked chapter, "Gamma" is a
// note (colors do not apply). The tree is mutated in place by the color route
// so a refresh after setting a color shows the new mark.
const TREE = {
  folders: [],
  documents: [
    { id: "a.md", title: "Alpha", kind: "chapter", words: 3, color: "red" },
    { id: "b.md", title: "Beta", kind: "chapter", words: 2, color: null },
    { id: "c.md", title: "Gamma", kind: "note", words: 2, color: null },
  ],
};
const DOCS = {
  "a.md": { id: "a.md", title: "Alpha", kind: "chapter", content: "One two three", style: {}, words: 3, color: "red" },
  "b.md": { id: "b.md", title: "Beta", kind: "chapter", content: "Four five", style: {}, words: 2, color: null },
  "c.md": { id: "c.md", title: "Gamma", kind: "note", content: "Six seven", style: {}, words: 2, color: null },
};
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
const ROUTES = [
  [/\/api\/settings$/, () => SETTINGS],
  [/\/api\/projects\/demo\/tree\?scope=write$/, () => TREE],
  [/\/api\/projects\/demo\/tree\?scope=wiki$/, () => ({ folders: [], documents: [] })],
  [/\/api\/projects\/demo\/dictionary$/, () => ({ words: [] })],
  [/\/api\/projects\/demo\/wiki$/, () => EMPTY_WIKI],
  [/\/api\/projects\/demo\/stats$/, () => STATS],
  [/\/api\/projects\/demo\/comments/, () => []],
  [
    /\/api\/projects\/demo\/documents\/(.+)\/color$/,
    (href, _method, opts) => {
      const id = decodeURIComponent(href.split("/documents/")[1].replace(/\/color$/, ""));
      const color = JSON.parse(opts.body).color || null;
      const doc = TREE.documents.find((d) => d.id === id);
      if (doc) doc.color = color;
      return { ...DOCS[id], color };
    },
  ],
  [
    /\/api\/projects\/demo\/documents\/[^/]+$/,
    (href, method) => {
      if (method === "PUT") return { words: 3 };
      const id = decodeURIComponent(href.split("/documents/")[1]);
      return DOCS[id] || {};
    },
  ],
  [/\/api\/projects\/demo$/, () => PROJECT],
];

// --- the color marks --------------------------------------------------------

await check("chapters can be color-marked from the sidebar", async () => {
  const dom = makeDom();
  const { calls, unmatched } = installFetch(ROUTES);
  const errors = [];
  dom.window.addEventListener("error", (e) => errors.push(e.error || e.message));
  process.on("unhandledRejection", (reason) => errors.push(reason));

  const project = await importJs("project.js");
  const router = await importJs("router.js");
  project.register();
  dom.window.location.hash = "#/p/demo";
  router.start();

  const doc = dom.window.document;
  await waitFor(() => doc.querySelector("#app .workspace"));
  await waitFor(() => doc.querySelector('.tree-item[data-docid="b.md"]'));

  const row = (id) => doc.querySelector(`.tree-item[data-docid="${id}"]`);
  const menuLabels = () =>
    [...doc.querySelectorAll(".context-menu .context-item")].map((n) => n.textContent);
  const openMenu = async (id) => {
    row(id).dispatchEvent(
      new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 30 })
    );
    return waitFor(() => doc.querySelector(".context-menu"));
  };
  const closeMenu = async () => {
    doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => !doc.querySelector(".context-menu"));
  };
  const clickItem = (label) =>
    [...doc.querySelectorAll(".context-menu .context-item")]
      .find((n) => n.textContent === label)
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  // A chapter carrying a color renders the dot and the left-bar class.
  assert.ok(row("a.md").classList.contains("mark-red"), "the red chapter row is marked");
  assert.ok(row("a.md").querySelector(".chapter-mark.mark-red"), "the red chapter shows a dot");
  assert.ok(!row("b.md").classList.contains("mark-red"), "an unmarked chapter has no class");

  // An unmarked chapter offers both marks.
  await openMenu("b.md");
  assert.deepEqual(menuLabels(), ["Open", "Open in split", "Mark for deletion", "Mark for rewrite"]);
  await closeMenu();

  // A note is left alone — no color items.
  await openMenu("c.md");
  assert.deepEqual(menuLabels(), ["Open", "Open in split"], "a note has no color actions");
  await closeMenu();

  // An already-red chapter omits "Mark for deletion" and offers "Clear mark".
  await openMenu("a.md");
  assert.deepEqual(menuLabels(), ["Open", "Open in split", "Mark for rewrite", "Clear mark"]);
  await closeMenu();

  // Applying a mark persists it and repaints the row.
  await openMenu("b.md");
  clickItem("Mark for deletion");
  await waitFor(() => row("b.md").classList.contains("mark-red"));
  assert.ok(row("b.md").querySelector(".chapter-mark.mark-red"), "the dot appears after marking");
  assert.ok(
    calls.includes("PUT /api/projects/demo/documents/b.md/color"),
    `the color was saved: ${calls.join(", ")}`
  );

  assert.deepEqual(unmatched, [], `only known API routes were called: ${unmatched.join(", ")}`);
  assert.equal(errors.length, 0, `the color flow threw: ${errors.map(String).join("; ")}`);
  dom.window.close();
});

if (failures) {
  console.error(`tree-colors: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("tree-colors: ok");
