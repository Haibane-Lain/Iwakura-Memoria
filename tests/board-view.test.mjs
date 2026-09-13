// Smoke test for the Board tab wiring: the three views render from a tree, an
// inline metadata edit PATCHes the document, and a drag reorder sends the
// folder's complete entry list to the reorder endpoint.
//
// The editor workspace fails to mount without the built bundle, which is fine:
// the board only calls into it on "Open", which these tests do not click.
//
// Run: node tests/board-view.test.mjs  (or `npm run test:board-view`)
import assert from "node:assert/strict";

import { JSDOM } from "jsdom";

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

function makeDom() {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="main-content"></div></body></html>',
    { url: "http://localhost/" }
  );
  const w = dom.window;
  for (const [name, value] of Object.entries({
    window: w,
    document: w.document,
    localStorage: w.localStorage,
    getComputedStyle: w.getComputedStyle.bind(w),
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    Event: w.Event,
    CustomEvent: w.CustomEvent,
    MouseEvent: w.MouseEvent,
    KeyboardEvent: w.KeyboardEvent,
    DOMParser: w.DOMParser,
    requestAnimationFrame: (cb) => w.setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => w.clearTimeout(id),
  })) {
    try {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    } catch {
      globalThis[name] = value;
    }
  }
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

const DOCS = {
  "01-alpha.md": { id: "01-alpha.md", title: "Alpha", kind: "chapter", words: 100, synopsis: "Alpha syn", status: "draft", beat: "opening-image" },
  "02-beta.md": { id: "02-beta.md", title: "Beta", kind: "note", words: 50, synopsis: "", status: "", beat: "midpoint" },
};

const TREE = {
  entries: [
    { kind: "doc", id: "01-alpha.md" },
    { kind: "folder", id: "01-part" },
    { kind: "doc", id: "02-beta.md" },
  ],
  folders: [{ id: "01-part", name: "Part One", entries: [], folders: [], documents: [] }],
  documents: [
    { id: "01-alpha.md", title: "Alpha", kind: "chapter", words: 100, synopsis: "Alpha syn", status: "draft", beat: "opening-image" },
    { id: "02-beta.md", title: "Beta", kind: "note", words: 50, synopsis: "", status: "", beat: "midpoint" },
  ],
};

const BEATS = [
  { id: "opening-image", name: "Opening Image" },
  { id: "midpoint", name: "Midpoint" },
];

function installFetch() {
  const patches = [];
  const reorders = [];
  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (href.endsWith("/documents/reorder")) {
      reorders.push(JSON.parse(opts.body));
      return jsonResponse({ renamed: {} });
    }
    if (/\/api\/projects\/demo\/beats$/.test(href)) {
      return jsonResponse({ beats: BEATS });
    }
    if (method === "PATCH" && /\/api\/projects\/demo\/documents\//.test(href)) {
      const id = decodeURIComponent(href.split("/documents/")[1]);
      const patch = JSON.parse(opts.body);
      patches.push({ id, patch });
      return jsonResponse({ ...DOCS[id], ...patch, id });
    }
    if (method === "GET" && /\/api\/projects\/demo\/documents\//.test(href)) {
      const id = decodeURIComponent(href.split("/documents/")[1]);
      return jsonResponse(DOCS[id] || {});
    }
    return jsonResponse({}, 404);
  };
  return { patches, reorders };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  const ctx = await import("../static/js/project-context.js");
  const board = await import("../static/js/board-view.js");
  ctx.registerShell({
    renderSidebar() {},
    refreshTree: async () => {},
    newDocument() {},
    newFolder: async () => {},
  });
  ctx.state.project = { id: "demo", title: "Demo", beats: BEATS };
  ctx.state.tree = TREE;
  ctx.state.wikiTree = { folders: [], documents: [] };
  ctx.state.currentTab = "board";
  ctx.state.boardView = "outline";
  ctx.state.boardFolder = "";
  return { ctx, board };
}

const dom = makeDom();

await check("outline renders a row per entry", async () => {
  installFetch();
  const { board } = await setup();
  await board.renderBoardTab();
  assert.equal(document.querySelectorAll(".outline-head").length, 1);
  assert.equal(document.querySelectorAll(".outline-row").length, 3);
  const titles = [...document.querySelectorAll(".outline-row .cell-input.title")].map((i) => i.value);
  assert.deepEqual(titles, ["Alpha", "Beta"]);
  assert.equal(document.querySelectorAll(".folder-row").length, 1);
});

await check("editing a synopsis PATCHes the document", async () => {
  const { patches } = installFetch();
  const { board } = await setup();
  await board.renderBoardTab();
  const area = document.querySelector(".outline-row .cell-input.synopsis");
  area.value = "A new synopsis";
  area.dispatchEvent(new dom.window.Event("change"));
  await tick();
  await tick();
  assert.deepEqual(patches, [{ id: "01-alpha.md", patch: { synopsis: "A new synopsis" } }]);
});

await check("changing a status PATCHes the document", async () => {
  const { patches } = installFetch();
  const { board } = await setup();
  await board.renderBoardTab();
  const select = document.querySelector(".outline-row .status-select");
  select.value = "final";
  select.dispatchEvent(new dom.window.Event("change"));
  await tick();
  await tick();
  assert.deepEqual(patches, [{ id: "01-alpha.md", patch: { status: "final" } }]);
});

await check("dragging a row reorders the folder's full entry list", async () => {
  const { reorders } = installFetch();
  const { board } = await setup();
  await board.renderBoardTab();
  const rows = [...document.querySelectorAll(".outline-row")];
  rows[0].dispatchEvent(new dom.window.Event("dragstart"));
  rows[2].dispatchEvent(new dom.window.Event("dragover", { cancelable: true }));
  rows[2].dispatchEvent(new dom.window.Event("drop", { cancelable: true }));
  await tick();
  await tick();
  await tick();
  assert.equal(reorders.length, 1);
  assert.deepEqual(reorders[0].orderedIds, ["01-part", "02-beta.md", "01-alpha.md"]);
  assert.equal(reorders[0].folder, null);
});

await check("corkboard renders cards plus add tiles", async () => {
  installFetch();
  const { ctx, board } = await setup();
  ctx.state.boardView = "corkboard";
  await board.renderBoardTab();
  assert.equal(document.querySelectorAll(".cork-card").length, 5); // 3 entries + 2 add
  assert.equal(document.querySelectorAll(".cork-synopsis").length, 2);
});

await check("beat board groups scenes into columns", async () => {
  installFetch();
  const { ctx, board } = await setup();
  ctx.state.boardView = "beats";
  await board.renderBoardTab();
  const columns = [...document.querySelectorAll(".beat-column")];
  assert.equal(columns.length, 3); // 2 beats + unassigned
  assert.equal(columns[0].querySelector(".beat-name").textContent, "Opening Image");
  assert.equal(document.querySelectorAll(".beat-card").length, 2);
});

await check("dropping a beat card on a column PATCHes its beat", async () => {
  const { patches } = installFetch();
  const { ctx, board } = await setup();
  ctx.state.boardView = "beats";
  await board.renderBoardTab();
  const card = document.querySelector(".beat-card");
  const bodies = [...document.querySelectorAll(".beat-cards")];
  card.dispatchEvent(new dom.window.Event("dragstart"));
  bodies[2].dispatchEvent(new dom.window.Event("dragover", { cancelable: true }));
  bodies[2].dispatchEvent(new dom.window.Event("drop", { cancelable: true }));
  await tick();
  await tick();
  assert.deepEqual(patches, [{ id: "01-alpha.md", patch: { beat: "" } }]);
});

if (failures) {
  console.error(`board-view: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("board-view: ok");
