// Unit test for the editor workspace's per-pane save pipeline. The jsdom smoke
// tests never load the editor bundle, so `mountPaneEditor` fails there and the
// save/dirty logic is untestable. Here a fake `window.LainEditor` records each
// editor's options so a test can drive onChange and check that each pane saves
// its own text.
//
// Run: node tests/editor-workspace.test.mjs  (or `npm run test:workspace`)
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
  "a.md": { id: "a.md", title: "Alpha", kind: "chapter", content: "Alpha body", style: {} },
  "b.md": { id: "b.md", title: "Beta", kind: "note", content: "Beta body", style: {} },
};

function installFetch() {
  const saved = [];
  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (/\/api\/projects\/demo\/documents\/[^/]+$/.test(href)) {
      const id = decodeURIComponent(href.split("/documents/")[1]);
      if (method === "PUT") {
        saved.push({ id, content: JSON.parse(opts.body).content });
        return jsonResponse({ words: 2 });
      }
      return jsonResponse(DOCS[id] || {});
    }
    if (/\/api\/projects\/demo\/comments/.test(href)) {
      return jsonResponse([]);
    }
    return jsonResponse({}, 404);
  };
  return { saved };
}

// Like installFetch, but PUTs stay pending until the test releases them, so a
// save can be held open while the test types more.
function installDeferredFetch() {
  const saved = [];
  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (/\/api\/projects\/demo\/documents\/[^/]+$/.test(href)) {
      const id = decodeURIComponent(href.split("/documents/")[1]);
      if (method === "PUT") {
        const entry = { id, content: JSON.parse(opts.body).content, release: null };
        saved.push(entry);
        return new Promise((resolve) => {
          entry.release = () => resolve(jsonResponse({ words: 2 }));
        });
      }
      return jsonResponse(DOCS[id] || {});
    }
    if (/\/api\/projects\/demo\/comments/.test(href)) {
      return jsonResponse([]);
    }
    return jsonResponse({}, 404);
  };
  return { saved };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// A fake editor: the workspace only needs this small contract, plus the options
// it passes (so the test can fire onChange).
function makeFakeEditor(slot) {
  return {
    create(opts) {
      const ctrl = {
        editor: {
          view: { dom: document.createElement("div") },
          on() {},
          state: {},
          isActive: () => false,
          chain: () => ({ focus() { return this; }, run() {}, setTextSelection() { return this; }, scrollIntoView() { return this; } }),
        },
        getMarkdown: () => ctrl._md,
        getText: () => String(ctrl._md || "").replace(/\s+/g, " ").trim(),
        setDictionaryWords() {},
        setGrammarEnabled() {},
        setTypewriterMode() {},
        setOnAddToDictionary() {},
        setOnWordMenu() {},
        setOnLookupWord() {},
        getCommentRanges: () => [],
        setComments() {},
        setComment() {},
        removeComment() {},
        removeComments() {},
        revealComment() { return false; },
        activate() {},
        deactivate() {},
        destroy() {},
        insertImage() {},
        focus() {},
      };
      ctrl._md = opts.content || "";
      // A real editor updates its document, then calls onChange; mirror that so
      // getMarkdown() reflects the edit the way the save pipeline expects.
      const original = opts.onChange;
      opts.onChange = (md) => {
        ctrl._md = md;
        if (original) original(md);
      };
      slot.opts = opts;
      return ctrl;
    },
  };
}

const STUB_SHELL = {
  renderSidebar() {},
  updateTopbar() {},
  refreshWiki: async () => {},
  scheduleWikiRefresh() {},
  refreshTree: async () => {},
  setActiveTab() {},
  refreshToolbar() {},
  refreshEditorContext() {},
  updateTargetIndicator() {},
  syncEditorControls() {},
  toolbar: () => document.createElement("div"),
  applyDocStyle() {},
  renameCurrentDoc() {},
  deleteCurrentDoc() {},
  createMissingNote() {},
  showContextMenu() {},
  openLookup() {},
  onWikilinkClick() {},
  uploadImageFile() {},
  showImageOverlay() {},
  pickImageFiles() {},
};

async function freshWorkspace() {
  // The modules keep process-wide singletons, so reset the bits that matter.
  const ctx = await import("../static/js/project-context.js");
  const workspace = await import("../static/js/editor-workspace.js");
  ctx.registerShell(STUB_SHELL);
  ctx.editorPool.destroyAll();
  ctx.docTabs.restore({ tabs: [], active: null });
  for (const pane of [ctx.panes.primary, ctx.panes.secondary]) {
    pane.docId = null;
    pane.ctrl = null;
    pane.dirty = false;
    pane.timer = null;
    pane.savePromise = null;
    pane.saveLoop = null;
  }
  ctx.state.project = { id: "demo" };
  ctx.state.tree = { folders: [], documents: [
    { id: "a.md", title: "Alpha", kind: "chapter", words: 2 },
    { id: "b.md", title: "Beta", kind: "note", words: 2 },
  ] };
  ctx.state.wikiTree = { folders: [], documents: [] };
  ctx.state.wiki = null;
  ctx.state.settings = { wordCountMode: "auto", autosaveMs: 100000, grammarEnabled: true, editorFont: "serif", editorSize: 18, editorAlign: "left" };
  ctx.state.dictionary = { words: [] };
  ctx.state.split = false;
  ctx.state.activePane = "primary";
  ctx.state.currentDocId = null;
  ctx.state.docStyle = {};
  document.getElementById("main-content").replaceChildren();
  return { ctx, workspace };
}

await check("opening a document mounts an editor and saves its edits", async () => {
  const dom = makeDom();
  const { saved } = installFetch();
  const { ctx, workspace } = await freshWorkspace();
  const slot = {};
  dom.window.LainEditor = makeFakeEditor(slot);

  await workspace.openDocument("a.md");
  assert.equal(ctx.panes.primary.docId, "a.md", "the primary pane shows a.md");
  assert.ok(slot.opts, "the editor was created");
  assert.equal(ctx.panes.primary.dirty, false, "a freshly opened document is clean");

  // Type: onChange marks the pane dirty.
  slot.opts.onChange("Alpha edited");
  assert.equal(ctx.panes.primary.dirty, true, "typing marks the pane dirty");

  await workspace.flushSave();
  assert.equal(ctx.panes.primary.dirty, false, "flushing clears the dirty flag");
  assert.deepEqual(saved, [{ id: "a.md", content: "Alpha edited" }]);
  dom.window.close();
});

await check("split panes save independently", async () => {
  const dom = makeDom();
  const { saved } = installFetch();
  const { ctx, workspace } = await freshWorkspace();

  // Each pane gets its own fake editor; record the options per document id.
  const slots = {};
  dom.window.LainEditor = {
    create(opts) {
      const id = opts.content.startsWith("Beta") ? "b.md" : "a.md";
      slots[id] = { opts };
      return makeFakeEditor(slots[id]).create(opts);
    },
  };

  await workspace.openDocument("a.md");
  await workspace.openInSplit("b.md");
  assert.equal(ctx.panes.primary.docId, "a.md");
  assert.equal(ctx.panes.secondary.docId, "b.md");
  assert.equal(ctx.state.split, true, "split is on");

  slots["a.md"].opts.onChange("Alpha v2");
  slots["b.md"].opts.onChange("Beta v2");
  assert.equal(ctx.panes.primary.dirty, true);
  assert.equal(ctx.panes.secondary.dirty, true);

  await workspace.flushSave();
  const byId = Object.fromEntries(saved.map((s) => [s.id, s.content]));
  assert.deepEqual(byId, { "a.md": "Alpha v2", "b.md": "Beta v2" });
  dom.window.close();
});

await check("an edit made during an in-flight save is not dropped", async () => {
  const dom = makeDom();
  const { saved } = installDeferredFetch();
  const { ctx, workspace } = await freshWorkspace();
  const slot = {};
  dom.window.LainEditor = makeFakeEditor(slot);

  await workspace.openDocument("a.md");
  slot.opts.onChange("v1");
  const flush = workspace.flushSave();
  await tick();
  assert.equal(saved.length, 1, "the first save is in flight");
  assert.equal(saved[0].content, "v1");

  // Type again while the save is held open, then let it finish.
  slot.opts.onChange("v2");
  saved[0].release();
  await tick();
  assert.equal(saved.length, 2, "the drain loop makes a second save");
  assert.equal(saved[1].content, "v2", "the newer text is persisted");
  saved[1].release();
  await flush;

  assert.equal(ctx.panes.primary.dirty, false, "the pane drains clean");
  dom.window.close();
});

await check("re-rendering keeps a dirty edit instead of discarding it", async () => {
  const dom = makeDom();
  const { saved } = installFetch();
  const { ctx, workspace } = await freshWorkspace();
  const slot = {};
  dom.window.LainEditor = makeFakeEditor(slot);

  await workspace.openDocument("a.md");
  slot.opts.onChange("Alpha v3");
  // A re-render (tab switch, tree refresh) used to clear `dirty` and drop the
  // edit; the pane must stay dirty and still write on the next flush.
  await workspace.renderEditorView();
  await workspace.flushSave();
  assert.deepEqual(saved, [{ id: "a.md", content: "Alpha v3" }]);
  assert.equal(ctx.panes.primary.dirty, false);
  dom.window.close();
});

await check("revision mode opens the comments panel and closes it again", async () => {
  const dom = makeDom();
  installFetch();
  const { ctx, workspace } = await freshWorkspace();
  const slot = {};
  dom.window.LainEditor = makeFakeEditor(slot);

  await workspace.openDocument("a.md");
  const pane = ctx.panes.primary;
  assert.equal(pane.revisionMode, false);

  await workspace.toggleRevisionMode();
  assert.equal(pane.revisionMode, true, "revision mode turns on");
  assert.ok(pane.commentsPanel.classList.contains("open"), "the panel opens");

  await workspace.toggleRevisionMode();
  assert.equal(pane.revisionMode, false, "revision mode turns off");
  assert.ok(!pane.commentsPanel.classList.contains("open"), "the panel closes");
  dom.window.close();
});

if (failures) {
  console.error(`editor-workspace: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("editor-workspace: ok");
