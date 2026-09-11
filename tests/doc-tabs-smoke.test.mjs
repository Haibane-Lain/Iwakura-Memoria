// jsdom smoke test for the document tab strip and the sidebar's Recent list.
//
// Kept in its own file (and therefore its own Node process) because project.js
// is an ES module with process-wide state: re-importing it in app-smoke's
// process would double-register the router and share state between checks.
//
// The editor bundle is not loaded here, so document rendering stops at
// "Editor failed to load" after the strip and sidebar are already drawn —
// exactly the surface under test.
//
// Run: npm run build && node tests/doc-tabs-smoke.test.mjs  (or `npm run test:tabs-smoke`)
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
const TREE = {
  folders: [],
  documents: [
    { id: "a.md", title: "Alpha", kind: "chapter", words: 3 },
    { id: "b.md", title: "Beta", kind: "note", words: 2 },
  ],
};
const DOCS = {
  "a.md": { id: "a.md", title: "Alpha", kind: "chapter", content: "One two three", style: {}, words: 3 },
  "b.md": { id: "b.md", title: "Beta", kind: "note", content: "Four five", style: {}, words: 2 },
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

// --- the tab strip ----------------------------------------------------------

await check("the tab strip opens, focuses, lists recents and closes documents", async () => {
  const dom = makeDom();
  const { unmatched } = installFetch(ROUTES);
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

  // Booting a project with documents opens the first one as a tab.
  await waitFor(() => doc.querySelector(".doc-tabs .doc-tab"));
  const titles = () =>
    [...doc.querySelectorAll(".doc-tabs .doc-tab .doc-tab-title")].map((n) => n.textContent);
  const activeTitle = () => doc.querySelector(".doc-tabs .doc-tab.active .doc-tab-title").textContent;
  assert.deepEqual(titles(), ["Alpha"], "the first document is the only tab");

  // A sidebar click opens a second tab and focuses it.
  const beta = doc.querySelector('.tree-item[data-docid="b.md"]');
  assert.ok(beta, "the second document is in the tree");
  beta.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => doc.querySelectorAll(".doc-tabs .doc-tab").length === 2);
  assert.deepEqual(titles(), ["Alpha", "Beta"]);
  assert.equal(activeTitle(), "Beta", "the newly opened tab is active");

  // The sidebar's Recent list is MRU order.
  const recents = [...doc.querySelectorAll(".recent-item .recent-title")].map((n) => n.textContent);
  assert.deepEqual(recents, ["Beta", "Alpha"]);

  // Split view pairs the two open tabs, one pane each, with a shared toolbar.
  const splitBtn = doc.querySelector('.tool-btn[title^="Split the editor"]');
  assert.ok(splitBtn, "the Split toolbar button exists");
  splitBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => doc.querySelectorAll("#main-content .editor-pane").length === 2);
  assert.ok(doc.querySelector("#main-content .editor-panes.split"), "the pane container is split");
  const paneNames = [...doc.querySelectorAll("#main-content .editor-pane .doc-title-input")].map(
    (n) => n.value
  );
  assert.deepEqual(paneNames, ["Beta", "Alpha"], "each pane shows a different document");
  // Opening the split focused the companion (the tab that was not active).
  assert.equal(
    doc.querySelector("#main-content .editor-pane.focused .doc-title-input").value,
    "Alpha"
  );

  // Toggling it off leaves a single pane again.
  splitBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => doc.querySelectorAll("#main-content .editor-pane").length === 1);
  assert.ok(!doc.querySelector("#main-content .editor-panes.split"), "the split collapses");

  // Closing the active tab falls back to the neighbour on the left.
  doc
    .querySelector(".doc-tabs .doc-tab.active .doc-tab-close")
    .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => doc.querySelectorAll(".doc-tabs .doc-tab").length === 1);
  assert.deepEqual(titles(), ["Alpha"], "the remaining tab is Alpha");
  assert.equal(activeTitle(), "Alpha");

  assert.deepEqual(unmatched, [], `only known API routes were called: ${unmatched.join(", ")}`);
  assert.equal(errors.length, 0, `the tab flow threw: ${errors.map(String).join("; ")}`);
  dom.window.close();
});

if (failures) {
  console.error(`doc-tabs-smoke: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("doc-tabs-smoke: ok");
