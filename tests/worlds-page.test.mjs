// jsdom smoke test for the worlds library and a world's page.
//
// Kept in its own file (and therefore its own Node process) because the
// frontend modules carry process-wide router state.
//
// Run: node tests/worlds-page.test.mjs  (or `npm run test:worlds`)
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
    if (Date.now() - start > timeout) throw new Error("timed out waiting for the page to render");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function importJs(name) {
  return import(pathToFileURL(path.join(JS_DIR, name)).href);
}

// --- fixtures ---------------------------------------------------------------

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

const book = (id, title, words, documents, cover = null) => ({
  id,
  title,
  words,
  documents,
  cover,
  updatedAt: "",
});

const WORLD = {
  id: "demo",
  title: "The Amber Kingdom",
  cover: null,
  series: [
    {
      id: "s1",
      title: "Book One",
      books: [book("a", "Alpha", 1200, 4), book("b", "Beta", 300, 2, "/api/covers/book-b-1.png")],
    },
  ],
  books: [book("c", "Gamma", 50, 1)],
};

function findBook(projectId) {
  for (const series of WORLD.series) {
    const hit = series.books.find((b) => b.id === projectId);
    if (hit) return hit;
  }
  return WORLD.books.find((b) => b.id === projectId);
}

const ROUTES = [
  [/\/api\/settings$/, () => SETTINGS],
  [/\/api\/worlds$/, () => [{ id: "demo", title: "The Amber Kingdom", cover: null, series: 1, books: 3 }]],
  [/\/api\/worlds\/demo$/, () => WORLD],
  [
    /\/api\/worlds\/demo\/books\/[^/]+$/,
    (href, _method, opts) => {
      const pid = decodeURIComponent(href.split("/books/")[1]);
      const seriesId = (JSON.parse(opts.body || "{}").seriesId || null);
      const moved = findBook(pid);
      for (const series of WORLD.series) series.books = series.books.filter((b) => b.id !== pid);
      WORLD.books = WORLD.books.filter((b) => b.id !== pid);
      const target = seriesId ? WORLD.series.find((s) => s.id === seriesId) : null;
      (target ? target.books : WORLD.books).push(moved);
      return WORLD;
    },
  ],
];

// --- the worlds list and one world's page -----------------------------------

await check("worlds list and world page render, navigate and reorganize", async () => {
  const dom = makeDom();
  const { calls, unmatched } = installFetch(ROUTES);
  const errors = [];
  dom.window.addEventListener("error", (e) => errors.push(e.error || e.message));
  process.on("unhandledRejection", (reason) => errors.push(reason));

  const theme = await importJs("themes.js");
  await theme.load();
  const library = await importJs("library.js");
  const world = await importJs("world.js");
  const router = await importJs("router.js");
  library.init();
  world.init();
  dom.window.location.hash = "#/";
  router.start();

  const doc = dom.window.document;
  await waitFor(() => doc.querySelector(".world-grid .world-card"));

  // The worlds list shows the cover (white placeholder), title and counts.
  const card = doc.querySelector(".world-card");
  assert.match(card.querySelector(".world-title").textContent, /The Amber Kingdom/);
  assert.match(card.querySelector(".world-counts").textContent, /1 series/);
  assert.match(card.querySelector(".world-counts").textContent, /3 books/);
  assert.ok(card.querySelector(".world-cover.cover-placeholder"), "a plain white cover by default");

  // Opening the world.
  card.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => doc.querySelector(".world-page"));
  assert.equal(dom.window.location.hash, "#/w/demo");

  // The series container holds its books; the unsorted shelf holds the rest.
  const panel = doc.querySelector('.series-panel[data-seriesid="s1"]');
  assert.match(panel.querySelector(".series-title").textContent, /Book One/);
  const alpha = panel.querySelector('.book-card[data-projectid="a"]');
  assert.ok(alpha, "Alpha is in the series");
  assert.match(alpha.querySelector(".book-meta").textContent, /1,200 words/);
  assert.match(alpha.querySelector(".book-meta").textContent, /4 docs/);
  assert.ok(alpha.querySelector(".book-cover.cover-placeholder"), "Alpha has a white cover");
  const betaCover = panel.querySelector('.book-card[data-projectid="b"] .book-cover');
  assert.equal(betaCover.getAttribute("src"), "/api/covers/book-b-1.png");

  const unsorted = doc.querySelector(".series-panel.unsorted");
  assert.ok(unsorted.querySelector('.book-card[data-projectid="c"]'), "Gamma sits in Unsorted");

  // A book's right-click menu offers the organizing actions.
  alpha.dispatchEvent(
    new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 30 })
  );
  const menu = await waitFor(() => doc.querySelector(".context-menu"));
  const labels = [...menu.querySelectorAll(".context-item")].map((n) => n.textContent);
  assert.deepEqual(labels, ["Open", "Rename", "Change cover", "Move to…", "Move to Unsorted", "Delete"]);

  // Moving a book to Unsorted persists and repaints.
  const moveItem = [...menu.querySelectorAll(".context-item")].find(
    (n) => n.textContent === "Move to Unsorted"
  );
  moveItem.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(
    () => doc.querySelector('.series-panel.unsorted .book-card[data-projectid="a"]')
  );
  assert.ok(
    calls.includes("PUT /api/worlds/demo/books/a"),
    `the move was saved: ${calls.join(", ")}`
  );
  assert.ok(!doc.querySelector('.series-panel[data-seriesid="s1"] .book-card[data-projectid="a"]'));

  // Clicking a book opens it in the editor.
  doc
    .querySelector('.book-card[data-projectid="a"]')
    .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => dom.window.location.hash === "#/p/a");

  assert.deepEqual(unmatched, [], `only known API routes were called: ${unmatched.join(", ")}`);
  assert.equal(errors.length, 0, `the page threw: ${errors.map(String).join("; ")}`);
  dom.window.close();
});

if (failures) {
  console.error(`worlds-page: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("worlds-page: ok");
