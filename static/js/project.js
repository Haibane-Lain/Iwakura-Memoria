import { api, encodePath, triggerDownload } from "./api.js";
import * as router from "./router.js";
import * as theme from "./themes.js";
import * as lain from "./lain.js";
import { FONTS, CUSTOM_ID, fontStack } from "./fonts.js";
import { filterTree } from "./tree-search.js";
import { createEditorPool } from "./editor-pool.js";
import { createDocTabs } from "./doc-tabs.js";
import { ASSET_ACCEPT, MAX_IMAGE_BYTES, isImageFile } from "./image-utils.js";
import { DEFAULT_WIKI_ZOOM, DEFAULT_ZOOM, ZOOM_PRESETS, zoomFactor } from "./zoom.js";
import { keepScrollTop } from "./scroll-keep.js";
import {
  el,
  toast,
  promptDialog,
  confirmDialog,
  showModal,
  countWords,
  formatNumber,
  escapeHtml,
} from "./ui.js";

const state = {
  project: null,
  tree: null,
  wikiTree: null,
  wiki: null,
  templates: null,
  settings: { wordCountMode: "auto", autosaveMs: 800 },
  currentDocId: null,
  writeDocId: null,
  wikiDocId: null,
  currentTab: "write",
  // Split view: which pane has focus and whether the second pane is visible.
  // The document shown in each pane lives in `panes` (see below).
  activePane: "primary",
  split: false,
  editorCtrl: null,
  dirty: false,
  saving: false,
  saveTimer: null,
  savePromise: null,
  wikiTimer: null,
  expanded: new Set(),
  wikiExpanded: new Set(),
  docStyle: {},
  currentSection: null,
  selectionActive: false,
  dictionary: { words: [] },
  statsThrottledAt: 0,
  wikiThrottledAt: 0,
  wikiQuery: "",
  writeQuery: "",
};

// Folders the current sidebar search render must show expanded. Display-only:
// searching never edits state.expanded / state.wikiExpanded.
let _treeSearchOpen = new Set();

let lainCtrl = null;
let _creating = false;

// Editors stay alive after their document is closed so undo/redo survives a
// switch. See editor-pool.js; the active document is pinned against eviction.
const editorPool = createEditorPool({ max: 10 });
let _switching = false;
let _opening = false;
let _beforeUnload = null;

// Which documents are open (the tab strip) and the cross-session recent list.
// Pure state lives in doc-tabs.js; this keeps persistence next to the project.
const docTabs = createDocTabs();
const LS_TABS = "im.tabs";
const LS_RECENT_OPEN = "im.recent.open";

function tabsStorageKey() {
  return state.project ? `${LS_TABS}.${state.project.id}` : null;
}

// Persist the strip, the split pairing, and a title for each id. Titles are how
// a stale path is repaired after a folder rename/move rewrites ids.
function persistTabs() {
  const key = tabsStorageKey();
  if (!key) return;
  const data = docTabs.serialize();
  const titles = {};
  for (const id of [...data.tabs, ...data.recent, panes.secondary.docId].filter(Boolean)) {
    const title = docTitleAny(id);
    if (title) titles[id] = title;
  }
  try {
    localStorage.setItem(key, JSON.stringify({
      ...data,
      split: state.split,
      secondary: panes.secondary.docId,
      titles,
    }));
  } catch {
    /* private mode / quota — tabs are a convenience, never load-bearing */
  }
}

function restoreTabs() {
  const key = tabsStorageKey();
  let data = null;
  if (key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  data = data || { tabs: [], active: null, recent: [] };
  const docs = allDocs();
  const valid = new Set(docs.map((d) => d.id));
  const titles = data.titles && typeof data.titles === "object" ? data.titles : {};
  const repair = (id) => {
    if (!id) return null;
    if (valid.has(id)) return id;
    const byTitle = titles[id] ? docs.find((d) => d.title === titles[id]) : null;
    return byTitle ? byTitle.id : null;
  };
  data.tabs = (Array.isArray(data.tabs) ? data.tabs : []).map(repair).filter(Boolean);
  data.recent = (Array.isArray(data.recent) ? data.recent : []).map(repair).filter(Boolean);
  data.active = repair(data.active);
  docTabs.restore(data);

  // Rehydrate the split companion. It must still be a tab and never the same
  // document as the primary, otherwise the split is dropped.
  panes.secondary.docId = null;
  panes.secondary.wiki = false;
  state.split = false;
  const secondary = repair(data.secondary);
  if (data.split && secondary && docTabs.has(secondary) && secondary !== docTabs.active) {
    panes.secondary.docId = secondary;
    panes.secondary.wiki = secondary.startsWith("worldbuilding/");
    state.split = true;
  }
}

/* ---------------- split panes ---------------- */

// Two independent editor panes. The primary always follows the tab strip; the
// secondary is the split companion. Each pane owns its own save state, so one
// pane's pending autosave can never clobber the other's.
function makePane(name) {
  return {
    name,
    docId: null,
    wiki: false,
    ctrl: null,
    root: null,
    mount: null,
    panel: null,
    wordsEl: null,
    saveEl: null,
    dirty: false,
    saving: false,
    timer: null,
    savePromise: null,
  };
}

const panes = { primary: makePane("primary"), secondary: makePane("secondary") };

function paneList() {
  return state.split ? [panes.primary, panes.secondary] : [panes.primary];
}

function activePane() {
  return panes[state.activePane] || panes.primary;
}

function paneForCtrl(ctrl) {
  return [panes.primary, panes.secondary].find((p) => p.ctrl === ctrl) || null;
}

function paneForDoc(docId) {
  return [panes.primary, panes.secondary].find((p) => p.docId === docId) || null;
}

// Move focus (and the shared grammar slot, toolbar and style target) to a pane.
function setActivePane(name) {
  if (name === "secondary" && !state.split) name = "primary";
  if (!panes[name]) name = "primary";
  state.activePane = name;
  const pane = activePane();
  state.editorCtrl = pane.ctrl;
  state.currentDocId = pane.docId;
  for (const p of paneList()) {
    if (!p.ctrl) continue;
    if (p === pane) {
      p.ctrl.activate();
      p.ctrl.setGrammarEnabled(state.settings.grammarEnabled);
    } else {
      p.ctrl.deactivate();
    }
  }
  syncPaneFocus();
  refreshToolbar();
  refreshEditorContext();
  updateTargetIndicator();
  syncEditorControls();
}

function syncPaneFocus() {
  for (const p of paneList()) {
    if (p.root) p.root.classList.toggle("focused", p.name === state.activePane);
  }
}

/* ---------------- helpers ---------------- */

function mode() {
  return state.settings.wordCountMode || "auto";
}

function isWikiScope() {
  return state.currentTab === "wiki";
}

function activeTree() {
  return isWikiScope() ? state.wikiTree : state.tree;
}

// Each scope keeps its own search text, like the paired expanded sets.
function treeQuery() {
  return isWikiScope() ? state.wikiQuery : state.writeQuery;
}

function setTreeQuery(query) {
  if (isWikiScope()) state.wikiQuery = query;
  else state.writeQuery = query;
}

function collectTree(node) {
  const out = [];
  const walk = (n, folderId) => {
    for (const doc of n.documents || []) {
      out.push({ id: doc.id, title: doc.title, kind: doc.kind, folder: folderId });
    }
    for (const f of n.folders || []) walk(f, f.id);
  };
  walk(node || { folders: [], documents: [] }, "");
  return out;
}

function allDocs() {
  return [...collectTree(state.tree), ...collectTree(state.wikiTree)];
}

function resolveDocByTitle(title) {
  const target = (title || "").trim();
  if (!target) return null;
  const norm = target.toLowerCase();
  const docs = allDocs();
  return (
    docs.find((d) => d.title.toLowerCase() === norm) ||
    docs.find((d) => d.id.toLowerCase() === norm) ||
    null
  );
}

function docTitle(docId) {
  const d = collectTree(activeTree()).find((x) => x.id === docId);
  return d ? d.title : null;
}

function prettyPath(doc) {
  const parts = (doc.id || "").split("/");
  parts.pop();
  const folderPart = parts.map((seg) => seg.replace(/^\d+-/, "")).join("/");
  return folderPart ? `${folderPart}/${doc.title || ""}` : doc.title || doc.id;
}

function folderNode(folderId) {
  const root = activeTree() || { folders: [], documents: [] };
  if (!folderId || folderId === rootFolderId()) return root;
  const walk = (n) => {
    for (const f of n.folders || []) {
      if (f.id === folderId) return f;
      const sub = walk(f);
      if (sub) return sub;
    }
    return null;
  };
  return walk(root) || { folders: [], documents: [] };
}

function countDocs(node) {
  let count = (node.documents || []).length;
  for (const f of node.folders || []) count += countDocs(f);
  return count;
}

function folderContainsDoc(node, docId) {
  if ((node.documents || []).some((d) => d.id === docId)) return true;
  return (node.folders || []).some((f) => folderContainsDoc(f, docId));
}

function firstDoc() {
  const walk = (n) => {
    if (n.documents && n.documents.length) return n.documents[0];
    for (const f of n.folders || []) {
      const d = walk(f);
      if (d) return d;
    }
    return null;
  };
  return walk(activeTree());
}

function expandAll(node, set) {
  for (const f of node.folders || []) {
    set.add(f.id);
    expandAll(f, set);
  }
}

async function refreshTree() {
  const [write, wiki] = await Promise.all([
    api.projects.tree(state.project.id, "write"),
    api.projects.tree(state.project.id, "wiki"),
  ]);
  state.tree = write;
  state.wikiTree = wiki;
  return activeTree();
}

/* ---------------- editor view preferences ---------------- */

function applyEditorPrefs() {
  const root = document.documentElement;
  root.style.setProperty("--editor-font", fontStack(state.settings.editorFont));
  root.style.setProperty("--editor-size", `${state.settings.editorSize || 18}px`);
  root.style.setProperty("--editor-align", state.settings.editorAlign || "left");
  root.style.setProperty("--editor-zoom", String(zoomFactor(defaultZoomForScope())));
  syncEditorControls();
}

function docStyle() {
  return state.docStyle || {};
}

function effectiveFont() {
  return docStyle().font || state.settings.editorFont;
}

function effectiveSize() {
  return docStyle().size || state.settings.editorSize;
}

function effectiveAlign() {
  return docStyle().align || state.settings.editorAlign;
}

function effectiveZoom() {
  return docStyle().zoom || defaultZoomForScope();
}

// Zoom is the one editor preference with a default *per tab*: see zoom.js.
function zoomKey(scope) {
  return scope === "wiki" ? "wikiZoom" : "editorZoom";
}

function defaultZoomForScope(wiki = isWikiScope()) {
  return (wiki ? state.settings.wikiZoom : state.settings.editorZoom) ||
    (wiki ? DEFAULT_WIKI_ZOOM : DEFAULT_ZOOM);
}

function sectionOverrides() {
  return docStyle().sections || {};
}

function presetIdForStack(stack) {
  const f = FONTS.find((x) => x.stack === stack);
  return f ? f.id : null;
}

function customNameFromStack(stack) {
  const first = (stack || "").split(",")[0].trim().replace(/^"|"$/g, "");
  return first || "";
}

function contextStyle() {
  const editor = state.editorCtrl && state.editorCtrl.editor;
  let font = effectiveFont();
  let size = effectiveSize();
  let align = effectiveAlign();
  const zoom = effectiveZoom();
  if (editor && state.selectionActive) {
    const fam = editor.getAttributes("fontFamily").family;
    const sz = editor.getAttributes("fontSize").size;
    if (fam) font = presetIdForStack(fam) || customNameFromStack(fam) || font;
    if (sz) size = parseInt(sz, 10) || size;
    const selAlign = selectedBlockAlign(editor);
    if (selAlign) align = selAlign;
  } else if (state.currentSection) {
    const s = sectionOverrides()[state.currentSection] || {};
    font = s.font || font;
    size = s.size || size;
    align = s.align || align;
  }
  return { font, size, align, zoom };
}

function selectedBlockAlign(editor) {
  const { from, to } = editor.state.selection;
  let value = null;
  let uniform = true;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (node.isTextblock && (node.type.name === "paragraph" || node.type.name === "heading")) {
      const a = node.attrs.textAlign || null;
      if (value === null) value = a;
      else if (value !== a) {
        uniform = false;
        return false;
      }
    }
    return true;
  });
  return uniform ? value : null;
}

function currentFont() {
  return contextStyle().font;
}

function currentSize() {
  return contextStyle().size;
}

function currentAlign() {
  return contextStyle().align;
}

function currentZoom() {
  return contextStyle().zoom;
}

function applyDocStyle() {
  const pane = activePane();
  const host = pane && pane.host;
  if (host) {
    host.style.setProperty("--editor-font", fontStack(effectiveFont()));
    host.style.setProperty("--editor-size", `${effectiveSize()}px`);
    host.style.setProperty("--editor-align", effectiveAlign());
    host.style.setProperty("--editor-zoom", String(zoomFactor(effectiveZoom())));
  }
  if (pane && pane.ctrl) {
    const map = {};
    for (const [name, ov] of Object.entries(sectionOverrides())) {
      const font = ov.font || effectiveFont();
      const size = ov.size || effectiveSize();
      const align = ov.align || effectiveAlign();
      map[name] = `font-family:${fontStack(font)};font-size:${size}px;text-align:${align};`;
    }
    pane.ctrl.setSectionStyles(map);
  }
  syncEditorControls();
}

function syncEditorControls() {
  const fontValue = currentFont();
  const isPreset = FONTS.some((f) => f.id === fontValue);
  document.querySelectorAll(".editor-control-font").forEach((sel) => {
    sel.value = isPreset ? fontValue : CUSTOM_ID;
    const customOpt = sel.querySelector(`option[value="${CUSTOM_ID}"]`);
    if (customOpt) customOpt.textContent = isPreset ? "Custom font…" : `${fontValue}…`;
  });
  document.querySelectorAll(".editor-control-size").forEach((sel) => {
    sel.value = String(currentSize());
  });
  document.querySelectorAll(".editor-control-zoom").forEach((sel) => {
    // The Settings rows carry the tab they default, so they show that saved
    // default; the toolbar's select has no scope and follows the open document.
    const scope = sel.dataset.zoomScope;
    sel.value = String(scope ? defaultZoomForScope(scope === "wiki") : currentZoom());
  });
  const align = currentAlign();
  document.querySelectorAll(".editor-control-align").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.align === align);
  });
}

function fontSelect(target) {
  const sel = el("select", { class: "toolbar-control font editor-control-font", title: "Font family" }, [
    ...FONTS.map((f) => el("option", { value: f.id }, f.label)),
    el("option", { value: CUSTOM_ID }, "Custom font…"),
  ]);
  const current = target === "global" ? state.settings.editorFont || "serif" : currentFont();
  const isPreset = FONTS.some((f) => f.id === current);
  sel.value = isPreset ? current : CUSTOM_ID;
  const customOpt = sel.querySelector(`option[value="${CUSTOM_ID}"]`);
  if (customOpt && !isPreset) customOpt.textContent = `${current}…`;
  sel.addEventListener("change", async () => {
    let value;
    if (sel.value === CUSTOM_ID) {
      const name = await promptDialog({
        title: "Custom font",
        label: "Font name",
        value: FONTS.some((f) => f.id === currentFont()) ? "" : currentFont(),
        placeholder: "e.g. Calibri, Futura, Charter…",
        confirmText: "Use font",
      });
      if (name === null || !name.trim()) {
        syncEditorControls();
        return;
      }
      value = name.trim();
    } else {
      value = sel.value;
    }
    if (target === "global") {
      state.settings = await api.settings.update({ editorFont: value });
      applyEditorPrefs();
    } else {
      await applyFontValue(value);
    }
  });
  return sel;
}

async function applyFontValue(value) {
  if (!state.editorCtrl || !state.currentDocId) {
    syncEditorControls();
    return;
  }
  if (state.selectionActive) {
    applyInlineFont(value);
    return;
  }
  try {
    const updated = await api.docs.style(state.project.id, state.currentDocId, {
      target: targetForContext(),
      ...(state.currentSection ? { section: state.currentSection } : {}),
      font: value,
    });
    state.docStyle = updated.style || {};
    applyDocStyle();
  } catch (err) {
    toast(err.message, "error");
  }
}

function applyInlineFont(value) {
  const editor = state.editorCtrl && state.editorCtrl.editor;
  if (!editor) return;
  if (value) editor.chain().focus().setMark("fontFamily", { family: fontStack(value) }).run();
  else editor.chain().focus().unsetMark("fontFamily").run();
  markActiveDirty();
  syncEditorControls();
}

const FONT_SIZES = [14, 16, 18, 20, 24, 28];

function sizeSelect(target) {
  const sel = el("select", { class: "toolbar-control size editor-control-size", title: "Font size" }, [
    ...FONT_SIZES.map((n) => el("option", { value: String(n) }, `${n}px`)),
  ]);
  sel.value = String(target === "global" ? state.settings.editorSize || 18 : currentSize());
  sel.addEventListener("change", async () => {
    const size = parseInt(sel.value, 10);
    if (!Number.isFinite(size)) return;
    if (target === "global") {
      state.settings = await api.settings.update({ editorSize: size });
      applyEditorPrefs();
      return;
    }
    if (state.selectionActive) {
      applyInlineSize(size);
    } else if (state.editorCtrl && state.currentDocId) {
      try {
        const updated = await api.docs.style(state.project.id, state.currentDocId, {
          target: targetForContext(),
          ...(state.currentSection ? { section: state.currentSection } : {}),
          size,
        });
        state.docStyle = updated.style || {};
        applyDocStyle();
      } catch (err) {
        toast(err.message, "error");
      }
    }
  });
  return sel;
}

function applyInlineSize(size) {
  const editor = state.editorCtrl && state.editorCtrl.editor;
  if (!editor) return;
  editor.chain().focus().setMark("fontSize", { size: String(size) }).run();
  markActiveDirty();
  syncEditorControls();
}

function zoomSelect(target, scope = "write") {
  const wiki = scope === "wiki";
  const sel = el("select", {
    class: "toolbar-control size editor-control-zoom",
    title:
      target === "global"
        ? `Default zoom for the ${wiki ? "Wiki" : "Write"} tab`
        : "Zoom",
    // Marks the two Settings defaults apart from the toolbar's per-document
    // control (syncEditorControls fills them from different sources).
    ...(target === "global" ? { dataset: { zoomScope: scope } } : {}),
  }, [
    ...ZOOM_PRESETS.map((n) => el("option", { value: String(n) }, `${n}%`)),
  ]);
  sel.value = String(target === "global" ? defaultZoomForScope(wiki) : currentZoom());
  sel.addEventListener("change", async () => {
    const zoom = parseInt(sel.value, 10);
    if (!Number.isFinite(zoom)) return;
    if (target === "global") {
      state.settings = await api.settings.update({ [zoomKey(scope)]: zoom });
      applyEditorPrefs();
      return;
    }
    if (!state.currentDocId) return;
    try {
      const updated = await api.docs.style(state.project.id, state.currentDocId, {
        target: "document",
        zoom,
      });
      state.docStyle = updated.style || {};
      applyDocStyle();
    } catch (err) {
      toast(err.message, "error");
    }
  });
  return sel;
}

const ALIGNMENTS = [
  { id: "left", label: "Left" },
  { id: "center", label: "Center" },
  { id: "right", label: "Right" },
  { id: "justify", label: "Justify" },
];

function alignGroup(target) {
  const align = target === "global" ? state.settings.editorAlign || "left" : currentAlign();
  const group = el("div", { class: "align-group" }, [
    ...ALIGNMENTS.map((a) =>
      el("button", {
        class: `tool-btn editor-control-align ${a.id === align ? "active" : ""}`,
        dataset: { align: a.id },
        title: `Align ${a.id}`,
        onclick: async () => {
          if (target === "global") {
            state.settings = await api.settings.update({ editorAlign: a.id });
            applyEditorPrefs();
            return;
          }
          if (!state.editorCtrl || !state.currentDocId) return;
          if (state.selectionActive) {
            state.editorCtrl.setBlockTextAlign(a.id);
            markActiveDirty();
            syncEditorControls();
            return;
          }
          try {
            const updated = await api.docs.style(state.project.id, state.currentDocId, {
              target: targetForContext(),
              ...(state.currentSection ? { section: state.currentSection } : {}),
              align: a.id,
            });
            state.docStyle = updated.style || {};
            applyDocStyle();
          } catch (err) {
            toast(err.message, "error");
          }
        },
      }, a.label)
    ),
  ]);
  return group;
}

function targetForContext() {
  if (state.currentSection) return "section";
  return "document";
}

function refreshEditorContext() {
  const editor = state.editorCtrl && state.editorCtrl.editor;
  if (!editor) {
    state.currentSection = null;
    state.selectionActive = false;
    return;
  }
  const sel = editor.state.selection;
  state.selectionActive = !sel.empty;
  const pos = sel.$from.pos;
  let section = null;
  editor.state.doc.descendants((node, p) => {
    if (p > pos) return false;
    if (node.type.name === "heading") section = node.textContent.trim();
    return true;
  });
  state.currentSection = section;
  updateTargetIndicator();
  syncEditorControls();
}

function updateTargetIndicator() {
  const node = document.getElementById("style-target");
  if (!node) return;
  if (state.selectionActive) node.textContent = "Selection";
  else if (state.currentSection) node.textContent = `Section: ${state.currentSection}`;
  else node.textContent = "Document";
}

async function resetContextStyle() {
  const editor = state.editorCtrl && state.editorCtrl.editor;
  if (!editor || !state.currentDocId) return;
  try {
    if (state.selectionActive) {
      editor.chain().focus().unsetMark("fontFamily").unsetMark("fontSize").run();
      state.editorCtrl.setBlockTextAlign(null);
      markActiveDirty();
      syncEditorControls();
      return;
    }
    const updated = await api.docs.style(state.project.id, state.currentDocId, {
      target: targetForContext(),
      ...(state.currentSection ? { section: state.currentSection } : {}),
      clear: true,
    });
    state.docStyle = updated.style || {};
    applyDocStyle();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function refreshWiki() {
  try {
    state.wiki = await api.projects.wiki(state.project.id);
  } catch (err) {
    console.warn("wiki refresh failed", err);
  }
  return state.wiki;
}

const WIKI_REFRESH_MS = 4000;

function scheduleWikiRefresh() {
  const now = performance.now();
  if (now - state.wikiThrottledAt < WIKI_REFRESH_MS) return;
  state.wikiThrottledAt = now;
  clearTimeout(state.wikiTimer);
  state.wikiTimer = setTimeout(refreshWiki, 1500);
}

/* ---------------- top bar ---------------- */

function topbar() {
  return el("div", { class: "topbar" }, [
    el("button", { class: "icon-btn", onclick: () => router.navigate("library") }, "← Projects"),
    el("div", { class: "brand", style: { pointerEvents: "none" } }, [
      el("span", { class: "dot" }),
      el("span", { id: "tb-title" }, state.project.title),
    ]),
    el("div", { class: "topbar-spacer" }),
    el("span", { id: "tb-goal", class: "chip" }),
    el("button", {
      class: "icon-btn",
      onclick: () => renderExportDialog(state.project.id),
    }, "Export"),
    el("button", {
      class: "icon-btn",
      id: "btn-lain",
      title: "Lain — AI assistant",
      onclick: () => {
        if (lainCtrl) lainCtrl.toggle();
      },
    }, "Lain"),
    theme.themeSelect(),
  ]);
}

const UPDATE_TOPBAR_STATS_MS = 4000;

async function updateTopbar() {
  document.getElementById("tb-title").textContent = state.project.title;
  const now = performance.now();
  if (now - state.statsThrottledAt < UPDATE_TOPBAR_STATS_MS) return;
  state.statsThrottledAt = now;
  try {
    const stats = await api.projects.stats(state.project.id);
    const goal = stats.goal.enabled ? ` / ${formatNumber(stats.goal.wordsPerDay)} goal` : "";
    const chip = document.getElementById("tb-goal");
    chip.textContent = `${formatNumber(stats.todayWords)} today${goal}`;
    chip.style.borderLeftColor = stats.goalMetToday ? "var(--ok)" : "";
  } catch {
    /* ignore */
  }
}

/* ---------------- sidebar ---------------- */

function sidebar() {
  const sidebarEl = el("div", { class: "sidebar" });
  // The search box is pinned between the tabs and the scroller so it stays
  // visible however long the tree below it gets.
  const pin = el("div", { class: "sidebar-pin" });
  const scroll = el("div", { class: "sidebar-scroll" });
  sidebarEl.append(
    el("div", { class: "sidebar-head" }, [
      el("input", {
        class: "project-title",
        value: state.project.title,
        placeholder: "Project title",
        title: "Rename project",
        onchange: renameProject,
      }),
    ]),
    el(
      "div",
      { class: "tabs" },
      [
        ["write", "Write"],
        ["stats", "Stats"],
        ["wiki", "Wiki"],
        ["settings", "Settings"],
      ].map(([id, label]) =>
        el("button", {
          class: `tab-btn ${state.currentTab === id ? "active" : ""}`,
          dataset: { tab: id },
          onclick: () => switchTab(id),
        }, label)
      )
    ),
    pin,
    scroll
  );
  sidebarEl._scroll = scroll;
  setupRootDrop(scroll);
  // The pinned strip is sidebar space too, so dropping onto it still means
  // "move to the root" — as it did when the search box scrolled with the list.
  setupRootDrop(pin);
  return sidebarEl;
}

async function renameProject(e) {
  const title = e.target.value.trim();
  if (!title || title === state.project.title) return;
  try {
    state.project = await api.projects.rename(state.project.id, title);
    document.getElementById("tb-title").textContent = title;
    toast("Project renamed");
  } catch (err) {
    toast(err.message, "error");
    e.target.value = state.project.title;
  }
}

function renderTree(sidebarEl, { keepScroll = false } = {}) {
  const wiki = isWikiScope();
  const tree = activeTree() || { folders: [], documents: [] };

  // The search box lives in the pinned strip, the toolbar and the tree in the
  // scroller underneath it.
  const pinEl = sidebarEl.querySelector(".sidebar-pin");
  const scrollEl = sidebarEl.querySelector(".sidebar-scroll");

  // Typing re-renders the whole sidebar, and renderSidebar() is also reached
  // from autosave and tree mutations. Remember the caret so the box keeps
  // focus and position across a replaceChildren().
  const prevInput = pinEl.querySelector(".tree-search-input");
  const hadFocus = !!prevInput && document.activeElement === prevInput;
  const caret = hadFocus ? [prevInput.selectionStart, prevInput.selectionEnd] : null;

  // The filter is scope-agnostic; only the tree and the box's wording differ.
  const { tree: shown, openIds, count } = filterTree(tree, treeQuery());
  _treeSearchOpen = openIds;

  const frag = document.createDocumentFragment();
  const recent = recentSection();
  if (recent) frag.append(recent);
  if (wiki) {
    frag.append(
      el("div", { class: "tree-toolbar" }, [
        el("button", { class: "mini-add wide", title: "New wiki entry", onclick: () => newWikiEntry("") }, "+ Entry"),
        el("button", { class: "mini-add wide", title: "New folder", onclick: () => newFolder("worldbuilding") }, "+ Folder"),
        el("button", { class: "mini-add wide", title: "Manage lore templates", onclick: templatesManager }, "Templates"),
      ])
    );
  } else {
    frag.append(
      el("div", { class: "tree-toolbar" }, [
        el("button", { class: "mini-add wide", title: "New chapter", onclick: () => newDocument("chapter", "") }, "+ Chapter"),
        el("button", { class: "mini-add wide", title: "New note", onclick: () => newDocument("note", "") }, "+ Note"),
        el("button", { class: "mini-add wide", title: "New folder", onclick: () => newFolder("") }, "+ Folder"),
      ])
    );
  }
  const root = {
    folders: shown.folders || [],
    documents: shown.documents || [],
    entries: shown.entries,
  };
  if (root.folders.length === 0 && root.documents.length === 0) {
    frag.append(el("div", { class: "empty-hint" }, emptyTreeHint(wiki)));
  } else {
    frag.append(renderLevel(root, wiki ? "worldbuilding" : ""));
  }
  // The box carries the query, the wording and the hit count, so it is rebuilt
  // every render — outside the scroller, where that cannot move the list. It is
  // refocused before the list is restored, since focusing a box that never
  // scrolls out of view has nothing to reveal.
  pinEl.replaceChildren(treeSearchRow(count));
  if (hadFocus) {
    const next = pinEl.querySelector(".tree-search-input");
    if (next) {
      next.focus();
      next.setSelectionRange(caret[0], caret[1]);
    }
  }
  keepScrollTop(scrollEl, () => scrollEl.replaceChildren(frag), keepScroll);
}

function emptyTreeHint(wiki) {
  const query = treeQuery().trim();
  if (query) return `No matches for "${query}".`;
  return wiki ? "Create a folder or lore entry to begin." : "Create a folder, chapter, or note to begin.";
}

function treeSearchRow(count) {
  const active = treeQuery().trim() !== "";
  const input = el("input", {
    class: "tree-search-input",
    type: "search",
    placeholder: isWikiScope() ? "Search wiki…" : "Search chapters & notes…",
    title: isWikiScope()
      ? "Filter wiki entries and folders by name"
      : "Filter chapters, notes, and folders by name",
    value: treeQuery(),
    oninput: (e) => {
      setTreeQuery(e.target.value);
      renderSidebar();
    },
    // Chromium's native clear button fires `search` (and `input`).
    onsearch: (e) => {
      setTreeQuery(e.target.value);
      renderSidebar();
    },
    onkeydown: (e) => {
      if (e.key !== "Escape" || !treeQuery()) return;
      // Keep this from reaching the document-level context-menu handler.
      e.stopPropagation();
      setTreeQuery("");
      renderSidebar();
    },
  });
  return el("div", { class: "tree-search" }, [
    input,
    active
      ? el("span", { class: "tree-search-count" }, `${count} entr${count === 1 ? "y" : "ies"}`)
      : null,
  ]);
}

function renderLevel(node, folderId) {
  const frag = document.createDocumentFragment();
  const byId = new Map();
  for (const f of node.folders || []) byId.set(f.id, { kind: "folder", node: f });
  for (const d of node.documents || []) byId.set(d.id, { kind: "doc", node: d });
  const entries = node.entries || [
    ...(node.folders || []).map((f) => ({ kind: "folder", id: f.id })),
    ...(node.documents || []).map((d) => ({ kind: "doc", id: d.id })),
  ];
  if (node.entries && entries.some((e) => !byId.has(e.id))) {
    entries.length = 0;
    entries.push(
      ...(node.folders || []).map((f) => ({ kind: "folder", id: f.id })),
      ...(node.documents || []).map((d) => ({ kind: "doc", id: d.id }))
    );
  }
  for (const e of entries) {
    const it = byId.get(e.id);
    if (!it) continue;
    if (it.kind === "folder") frag.append(renderFolderRow(it.node, folderId));
    else frag.append(docItem(it.node, folderId));
  }
  return frag;
}

function renderFolderRow(folder, parentId) {
  const wiki = isWikiScope();
  // A search renders matches (and their ancestors) open without touching the
  // user's own expand state.
  const searchOpen = _treeSearchOpen.has(folder.id);
  const expanded = searchOpen || (wiki ? state.wikiExpanded : state.expanded).has(folder.id);
  const head = el(
    "div",
    {
      class: "tree-folder-head",
      dataset: { folderid: folder.id, parentfolder: parentId || "" },
      draggable: "true",
    },
    [
      el("span", { class: "grip folder-grip" }, "⠿"),
      el("span", { class: "chevron", onclick: () => toggleFolder(folder.id) }, expanded ? "▾" : "▸"),
      el("span", { class: "folder-name", onclick: () => toggleFolder(folder.id) }, folder.name),
      el("span", { class: "folder-count" }, countDocs(folder)),
      el("button", {
        class: "mini-add folder-menu-btn",
        title: "Folder actions",
        onclick: (e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          const items = wiki
            ? [
                { label: "New entry", action: () => newWikiEntry(folder.id) },
                { label: "New subfolder", action: () => newFolder(folder.id) },
                null,
                { label: "Rename folder", action: () => renameFolder(folder.id) },
                { label: "Delete folder", action: () => deleteFolder(folder.id) },
              ]
            : [
                { label: "New chapter", action: () => newDocument("chapter", folder.id) },
                { label: "New note", action: () => newDocument("note", folder.id) },
                { label: "New subfolder", action: () => newFolder(folder.id) },
                null,
                { label: "Rename folder", action: () => renameFolder(folder.id) },
                { label: "Delete folder", action: () => deleteFolder(folder.id) },
              ];
          showContextMenu(rect.right - 170, rect.bottom + 4, items);
        },
      }, "⋯"),
    ]
  );
  const children = el("div", {
    class: "tree-folder-children",
    style: { display: expanded ? "" : "none" },
  });
  children.append(renderLevel(folder, folder.id));
  const row = el("div", { class: "tree-folder" }, [head, children]);

  head.addEventListener("dragover", (e) => {
    e.stopPropagation();
    const data = dragPayload || readDragData(e);
    const zone = dropZone(e, head, true);
    const allowed =
      zone === "nest"
        ? canDrop(data, folder.id)
        : canInsert(data, parentId || "") && !!data && data.id !== folder.id;
    head.classList.remove("drag-before", "drag-after", "drag-over");
    if (allowed) {
      head.classList.add(zone === "before" ? "drag-before" : zone === "after" ? "drag-after" : "drag-over");
      e.preventDefault();
    }
  });
  head.addEventListener("dragleave", () => head.classList.remove("drag-before", "drag-after", "drag-over"));
  head.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    head.classList.remove("drag-before", "drag-after", "drag-over");
    const data = dragPayload || readDragData(e);
    if (!data || !data.id) return;
    const zone = dropZone(e, head, true);
    if (zone === "nest") handleDrop(data, { parentId: folder.id, targetId: null, zone: "nest" });
    else handleDrop(data, { parentId: parentId || "", targetId: folder.id, zone });
  });
  children.addEventListener("dragover", (e) => {
    e.stopPropagation();
    if (!canDrop(dragPayload, folder.id)) return;
    e.preventDefault();
    children.classList.add("drag-over");
  });
  children.addEventListener("dragleave", () => children.classList.remove("drag-over"));
  children.addEventListener("drop", (e) => {
    e.stopPropagation();
    children.classList.remove("drag-over");
    const data = dragPayload || readDragData(e);
    if (!data || !data.id) return;
    handleDrop(data, { parentId: folder.id, targetId: null, zone: "nest" });
  });
  setupFolderDrag(head, folder, parentId || "");
  return row;
}

function docItem(doc, folderId) {
  const isPrimary = state.currentDocId === doc.id;
  const isSecondary = state.split && panes.secondary.docId === doc.id && !isPrimary;
  const node = el(
    "div",
    {
      class: `tree-item ${isPrimary ? "active" : ""}${isSecondary ? " split-active" : ""}`,
      dataset: { docid: doc.id, folder: folderId, kind: doc.kind },
      title: prettyPath(doc),
      draggable: "true",
      onclick: (e) => {
        if (e.target.closest(".grip")) return;
        openDocument(doc.id);
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, [
          { label: "Open", action: () => openDocument(doc.id) },
          { label: "Open in split", action: () => openInSplit(doc.id) },
        ]);
      },
    },
    [
      el("span", { class: "grip" }, doc.kind === "chapter" ? "≣" : "◦"),
      el("span", { class: "name" }, doc.title),
      el("span", { class: "words" }, formatNumber(doc.words)),
    ]
  );
  setupDocDrag(node);
  return node;
}

function toggleFolder(id) {
  const set = isWikiScope() ? state.wikiExpanded : state.expanded;
  if (set.has(id)) set.delete(id);
  else set.add(id);
  renderSidebar();
}

/* ---------------- context menu ---------------- */

let menuCleanup = null;

function closeContextMenu() {
  if (menuCleanup) {
    menuCleanup();
    menuCleanup = null;
  }
}

function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = el("div", { class: "context-menu", style: { left: `${x}px`, top: `${y}px` } });
  for (const item of items) {
    if (item === null) {
      menu.append(el("div", { class: "context-sep" }));
    } else {
      menu.append(
        el("div", {
          class: "context-item",
          onclick: () => {
            closeContextMenu();
            item.action();
          },
        }, item.label)
      );
    }
  }
  document.body.append(menu);
  const onDocClick = (e) => {
    if (!menu.contains(e.target)) closeContextMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeContextMenu();
  };
  setTimeout(() => document.addEventListener("click", onDocClick), 0);
  document.addEventListener("keydown", onKey);
  menuCleanup = () => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    menu.remove();
  };
}

/* ---------------- drag & drop ---------------- */

function readDragData(e) {
  try {
    return JSON.parse(e.dataTransfer.getData("text/plain"));
  } catch {
    return null;
  }
}

let dragPayload = null;

function dropZone(e, node, isFolder) {
  const r = node.getBoundingClientRect();
  const frac = r.height ? (e.clientY - r.top) / r.height : 0;
  if (isFolder) return frac < 0.25 ? "before" : frac > 0.75 ? "after" : "nest";
  return frac < 0.5 ? "before" : "after";
}

function canDrop(dragged, folderId) {
  if (!dragged || !dragged.id) return false;
  if (dragged.kind === "folder") {
    if (dragged.id === folderId) return false;
    if (folderId.startsWith(dragged.id + "/")) return false;
  }
  return true;
}

function canInsert(dragged, parentId) {
  if (!dragged || !dragged.id) return false;
  if (dragged.kind === "folder" && (parentId === dragged.id || parentId.startsWith(dragged.id + "/"))) {
    return false;
  }
  return true;
}

function folderEntries(folderId) {
  return (folderNode(folderId).entries || []).map((e) => ({ kind: e.kind, id: e.id }));
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function remapExpanded(renamed) {
  if (!renamed) return;
  for (const set of [state.expanded, state.wikiExpanded]) {
    const next = new Set();
    for (const id of set) next.add(renamed[id] || id);
    set.clear();
    for (const id of next) set.add(id);
  }
}

function setupDocDrag(item) {
  item.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(
      "text/plain",
      JSON.stringify({ id: item.dataset.docid, folder: item.dataset.folder, kind: "doc" })
    );
    dragPayload = { id: item.dataset.docid, folder: item.dataset.folder, kind: "doc" };
    item.classList.add("dragging");
  });
  item.addEventListener("dragend", () => {
    item.classList.remove("dragging");
    clearDragOverlays();
  });
  item.addEventListener("dragover", (e) => {
    e.stopPropagation();
    const data = dragPayload || readDragData(e);
    if (!canInsert(data, item.dataset.folder)) return;
    if (data && data.id === item.dataset.docid) return;
    e.preventDefault();
    item.classList.remove("drag-before", "drag-after", "drag-over");
    item.classList.add(dropZone(e, item, false) === "before" ? "drag-before" : "drag-after");
  });
  item.addEventListener("dragleave", () => item.classList.remove("drag-before", "drag-after", "drag-over"));
  item.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    item.classList.remove("drag-before", "drag-after", "drag-over");
    const data = dragPayload || readDragData(e);
    if (!data || !data.id || data.id === item.dataset.docid) return;
    handleDrop(data, { parentId: item.dataset.folder, targetId: item.dataset.docid, zone: dropZone(e, item, false) });
  });
}

function setupFolderDrag(head, folder, parentId) {
  head.addEventListener("dragstart", (e) => {
    if (e.target.closest("button")) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", JSON.stringify({ id: folder.id, parent: parentId, kind: "folder" }));
    dragPayload = { id: folder.id, parent: parentId, kind: "folder" };
    head.classList.add("dragging");
  });
  head.addEventListener("dragend", () => {
    head.classList.remove("dragging");
    clearDragOverlays();
  });
}

function rootFolderId() {
  return isWikiScope() ? "worldbuilding" : "";
}

function setupRootDrop(scroll) {
  scroll.addEventListener("dragover", (e) => {
    if (!canDrop(dragPayload, rootFolderId())) return;
    e.preventDefault();
    scroll.classList.add("drag-root");
  });
  scroll.addEventListener("dragleave", () => scroll.classList.remove("drag-root"));
  scroll.addEventListener("drop", (e) => {
    e.preventDefault();
    scroll.classList.remove("drag-root");
    const data = dragPayload || readDragData(e);
    if (data && data.id) handleDrop(data, { parentId: rootFolderId(), targetId: null, zone: "nest" });
  });
}

function clearDragOverlays() {
  dragPayload = null;
  document.querySelectorAll(".drag-over, .drag-root, .dragging, .drag-before, .drag-after").forEach((n) =>
    n.classList.remove("drag-over", "drag-root", "dragging", "drag-before", "drag-after")
  );
}

async function handleDrop(dragged, target) {
  if (dragged.kind === "folder") return handleFolderDrop(dragged, target);
  return handleDocDrop(dragged, target);
}

function planInsert(dragged, target, sameParent) {
  const ids = folderEntries(target.parentId).map((e) => e.id);
  const from = sameParent ? ids.indexOf(dragged.id) : -1;
  if (from >= 0) ids.splice(from, 1);
  let at = ids.indexOf(target.targetId);
  if (at < 0) at = ids.length;
  if (target.zone === "after") at += 1;
  if (sameParent) {
    ids.splice(at, 0, dragged.id);
    return { ids };
  }
  return { at };
}

async function handleDocDrop(dragged, target) {
  const sameParent = dragged.folder === target.parentId;
  if (target.zone === "nest") {
    if (sameParent) return;
    await performMove(dragged.id, target.parentId, null);
    return;
  }
  const { ids, at } = planInsert(dragged, target, sameParent);
  if (sameParent) {
    if (arraysEqual(ids, folderEntries(target.parentId).map((e) => e.id))) return;
    await performReorder(target.parentId, ids);
  } else {
    await performMove(dragged.id, target.parentId, at);
  }
}

async function handleFolderDrop(dragged, target) {
  const sameParent = dragged.parent === target.parentId;
  if (target.zone === "nest") {
    if (dragged.id === target.parentId || sameParent) return;
    await performFolderMove(dragged.id, target.parentId, null);
    return;
  }
  const { ids, at } = planInsert(dragged, target, sameParent);
  if (sameParent) {
    if (arraysEqual(ids, folderEntries(target.parentId).map((e) => e.id))) return;
    await performReorder(target.parentId, ids);
  } else {
    await performFolderMove(dragged.id, target.parentId, at);
  }
}

async function afterTreeChange() {
  const prevId = state.currentDocId;
  const prevTitle = docTitleAny(prevId);
  const oldTabs = docTabs.tabs.map((id) => ({ id, title: docTitleAny(id) }));
  await refreshTree();
  if (prevTitle) {
    const match = [...collectTree(state.tree), ...collectTree(state.wikiTree)].find(
      (d) => d.title === prevTitle
    );
    if (match) state.currentDocId = match.id;
  }
  // A move or folder rename rewrites the path portion of a document id; keep
  // the open document's warm editor keyed to its new id (and every tab too).
  if (prevId && state.currentDocId && state.currentDocId !== prevId) {
    editorPool.rekey(prevId, state.currentDocId);
  }
  reconcileTabs(oldTabs);
  renderSidebar();
}

async function performReorder(folderId, ids) {
  try {
    const res = await api.docs.reorder(state.project.id, ids, folderId);
    if (res && res.renamed) remapExpanded(res.renamed);
    await afterTreeChange();
    // A moved/renamed document gets a new id; drop the other warm editors
    // whose ids may have shifted with it.
    invalidateEditorCache(true);
    toast("Reordered");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function performMove(docId, targetFolder, index) {
  try {
    const res = await api.docs.move(state.project.id, docId, targetFolder, index);
    if (res && res.renamed) remapExpanded(res.renamed);
    await afterTreeChange();
    invalidateEditorCache(true);
    toast("Moved");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function performFolderMove(folderId, targetFolder, index) {
  try {
    const res = await api.folders.move(state.project.id, folderId, targetFolder, index);
    if (res && res.renamed) remapExpanded(res.renamed);
    await afterTreeChange();
    invalidateEditorCache(true);
    toast("Folder moved");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function onLainActions(actions) {
  if (!actions || !actions.length) return;
  const prevTitle = docTitleAny(state.currentDocId);
  const oldTabs = docTabs.tabs.map((id) => ({ id, title: docTitleAny(id) }));
  await refreshTree();
  await refreshWiki();
  if (prevTitle) {
    const match = [...collectTree(state.tree), ...collectTree(state.wikiTree)].find(
      (d) => d.title === prevTitle
    );
    if (match) state.currentDocId = match.id;
  }
  reconcileTabs(oldTabs);
  const current = state.currentDocId;
  const touched = actions.some((a) => a.id && (a.id === current || (current || "").startsWith(a.id + "/")));
  renderSidebar();
  if (lainCtrl) lainCtrl.refreshScope();
  // AI writes can rewrite any document's body. Save local edits first, then
  // drop the warm editors: the open document is rebuilt from disk when the
  // assistant touched it, and other warm editors are dropped either way.
  if (current && touched) await flushSave();
  invalidateEditorCache(!touched);
  if (!current || !touched) return;
  try {
    const doc = await api.docs.get(state.project.id, current);
    await renderEditorTab(doc, { wiki: isWikiScope() });
  } catch {
    state.currentDocId = null;
    const f = firstDoc();
    if (f) openDocument(f.id);
    else renderEditorTab(null, { wiki: isWikiScope() });
  }
}

/* ---------------- document actions ---------------- */

async function newDocument(kind, folder) {
  if (_creating) {
    _creating = false;
  }
  _creating = true;
  try {
    const title = await promptDialog({
      title: kind === "chapter" ? "New chapter" : "New note",
      label: "Title",
      placeholder: kind === "chapter" ? "Chapter title" : "Note title",
      confirmText: "Create",
    });
    if (title === null) return;
    if (!title.trim()) {
      toast("A title is required", "error");
      return;
    }
    const doc = await api.docs.create(state.project.id, {
      title: title.trim(),
      kind,
      folder: folder || null,
    });
    await flushSave();
    // A live filter would hide the chapter/note we just made; show the full tree.
    state.writeQuery = "";
    await afterTreeChange();
    await refreshWiki();
    await openDocument(doc.id);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    _creating = false;
  }
}

/* ---------------- wiki entries & templates ---------------- */

function buildTemplateContent(tpl) {
  return (tpl.sections || []).map((s) => `## ${s}\n\n---\n\n`).join("");
}

async function loadTemplates() {
  if (!state.templates) {
    try {
      state.templates = await api.templates.list(state.project.id);
    } catch (err) {
      toast(err.message, "error");
      state.templates = [];
    }
  }
  return state.templates;
}

async function loadWikiData() {
  if (!state.wikiTree) {
    state.wikiTree = await api.projects.tree(state.project.id, "wiki");
    expandAll(state.wikiTree, state.wikiExpanded);
  }
  await loadTemplates();
  return state.wikiTree;
}

async function pickTemplate() {
  await loadTemplates();
  return new Promise((resolve) => {
    const list = el("div", { class: "modal-list" });
    const { close } = showModalFromUI([
      el("h3", {}, "Choose a template"),
      el("p", { class: "desc" }, "The chosen sections will be pre-filled for the new entry."),
      list,
      el("div", { class: "modal-actions" }, [
        el("button", { class: "icon-btn", onclick: () => { close(); resolve(undefined); } }, "Cancel"),
      ]),
    ]);
    list.append(
      el("div", {
        class: "modal-list-item",
        onclick: () => { close(); resolve(null); },
      }, "Blank page")
    );
    for (const tpl of state.templates || []) {
      list.append(
        el("div", {
          class: "modal-list-item",
          onclick: () => { close(); resolve(tpl); },
        }, [
          el("strong", {}, tpl.name),
          el("span", {}, ` — ${(tpl.sections || []).join(", ")}`),
        ])
      );
    }
  });
}

async function newWikiEntry(folder) {
  const title = await promptDialog({
    title: "New wiki entry",
    label: "Title",
    placeholder: "Entry title",
    confirmText: "Next",
  });
  if (title === null) return;
  if (!title.trim()) {
    toast("A title is required", "error");
    return;
  }
  const tpl = await pickTemplate();
  if (tpl === undefined) return;
  try {
    const doc = await api.docs.create(state.project.id, {
      title: title.trim(),
      kind: "note",
      folder: folder || "worldbuilding",
      content: tpl ? buildTemplateContent(tpl) : "",
      docType: tpl ? tpl.type : "note",
    });
    await flushSave();
    // A live filter would hide the entry we just made; show the full tree.
    state.wikiQuery = "";
    await afterTreeChange();
    await refreshWiki();
    openDocument(doc.id);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function onWikilinkClick(name) {
  const resolved = resolveDocByTitle(name);
  if (resolved) {
    openDocument(resolved.id);
    return;
  }
  const ok = await confirmDialog({
    title: `"${name}" doesn't exist yet`,
    message: "Create it as a worldbuilding entry?",
    confirmText: "Create entry",
  });
  if (!ok) return;
  try {
    const doc = await api.docs.create(state.project.id, {
      title: name.trim(),
      kind: "note",
      folder: "worldbuilding",
      content: "",
      docType: "note",
    });
    await afterTreeChange();
    await refreshWiki();
    openDocument(doc.id);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function createMissingNote(title, fromDocId) {
  try {
    const doc = await api.docs.create(state.project.id, {
      title,
      kind: "note",
      folder: "worldbuilding",
    });
    if (fromDocId) {
      const from = await api.docs.get(state.project.id, fromDocId);
      const updated = from.content.replace(
        new RegExp(`\\[\\[${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\]`),
        `[[${title}]]`
      );
      await api.docs.save(state.project.id, fromDocId, updated);
      updateTreeWords(fromDocId, countWords(updated, mode()));
      // The source document's editor now holds pre-rewrite text; drop it so
      // returning to it rebuilds from disk instead of resurrecting the old body.
      dropEditorFor(fromDocId);
    }
    await afterTreeChange();
    await refreshWiki();
    toast(`Created note "${title}"`);
    openDocument(doc.id);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function templatesManager() {
  const list = el("div", { class: "tpl-list" });
  const render = async () => {
    await loadTemplates();
    list.replaceChildren(
      ...(state.templates || []).map((tpl) =>
        el("div", { class: "tpl-row" }, [
          el("div", { class: "tpl-info" }, [
            el("strong", {}, tpl.name),
            el("div", { class: "from" }, (tpl.sections || []).join(" · ")),
          ]),
          el("button", { class: "icon-btn", onclick: () => editTemplate(tpl, render) }, "Edit"),
          el("button", {
            class: "icon-btn danger",
            onclick: async () => {
              const ok = await confirmDialog({
                title: `Delete template "${tpl.name}"?`,
                message: "Existing entries are not affected.",
                confirmText: "Delete",
              });
              if (!ok) return;
              try {
                await api.templates.remove(state.project.id, tpl.id);
                state.templates = null;
                render();
              } catch (err) {
                toast(err.message, "error");
              }
            },
          }, "Delete"),
        ])
      )
    );
  };
  const { close } = showModalFromUI([
    el("h3", {}, "Lore templates"),
    el("p", { class: "desc" }, "Templates pre-fill sections when you create a wiki entry."),
    el("div", { class: "modal-actions" }, [
      el("button", { class: "icon-btn primary", onclick: () => editTemplate(null, render) }, "+ New template"),
    ]),
    el("div", { class: "modal-scroll" }, [list]),
    el("div", { class: "modal-actions" }, [
      el("button", { class: "icon-btn", onclick: () => close() }, "Done"),
    ]),
  ]);
  render();
}

function editTemplate(tpl, onSaved) {
  const nameInput = el("input", { type: "text", value: tpl ? tpl.name : "", placeholder: "Template name, e.g. Character" });
  const sectionsInput = el("textarea", {
    class: "tpl-sections",
    rows: 6,
    placeholder: "One section heading per line, e.g.\nAppearance\nPersonality",
  }, tpl ? (tpl.sections || []).join("\n") : "");
  const { close } = showModalFromUI([
    el("h3", {}, tpl ? `Edit "${tpl.name}"` : "New template"),
    el("div", { class: "field" }, [el("label", {}, "Name"), nameInput]),
    el("div", { class: "field" }, [el("label", {}, "Sections (one per line)"), sectionsInput]),
    el("div", { class: "modal-actions" }, [
      el("button", { class: "icon-btn", onclick: () => close() }, "Cancel"),
      el("button", {
        class: "icon-btn primary",
        onclick: async () => {
          const name = nameInput.value.trim();
          if (!name) {
            toast("A name is required", "error");
            return;
          }
          const sections = sectionsInput.value.split("\n").map((s) => s.trim()).filter(Boolean);
          try {
            if (tpl) await api.templates.update(state.project.id, tpl.id, { name, sections });
            else await api.templates.create(state.project.id, name, sections);
            state.templates = null;
            close();
            onSaved();
          } catch (err) {
            toast(err.message, "error");
          }
        },
      }, "Save"),
    ]),
  ]);
  nameInput.focus();
}

async function newFolder(parent) {
  const name = await promptDialog({
    title: "New folder",
    label: "Folder name",
    placeholder: "e.g. Part One",
    confirmText: "Create",
  });
  if (name === null) return;
  if (!name.trim()) {
    toast("A name is required", "error");
    return;
  }
  try {
    await api.folders.create(state.project.id, name.trim(), parent || null);
    if (parent) (isWikiScope() ? state.wikiExpanded : state.expanded).add(parent);
    // A live filter would hide the folder we just made; show the full tree.
    setTreeQuery("");
    await afterTreeChange();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function renameFolder(folderId) {
  const folder = folderNode(folderId);
  const name = await promptDialog({
    title: "Rename folder",
    label: "Folder name",
    value: folder.name,
    confirmText: "Rename",
  });
  if (name === null || !name.trim() || name.trim() === folder.name) return;
  try {
    await api.folders.rename(state.project.id, folderId, name.trim());
    await afterTreeChange();
    // Renaming a folder rewrites the ids of every document inside it.
    invalidateEditorCache(true);
  } catch (err) {
    toast(err.message, "error");
  }
}

function undoTrash(trashId) {
  return {
    label: "Undo",
    onClick: async () => {
      try {
        const r = await api.trash.restore(state.project.id, trashId);
        await afterTreeChange();
        await refreshWiki();
        updateTopbar();
        toast(r.renamed ? `Restored as "${r.name}" (renamed to avoid a clash)` : `Restored "${r.name}"`);
      } catch (err) {
        toast(err.message, "error");
      }
    },
  };
}

async function deleteFolder(folderId) {
  const folder = folderNode(folderId);
  const count = countDocs(folder);
  const ok = await confirmDialog({
    title: `Delete "${folder.name}"?`,
    message: `This moves the folder and its ${count} ${count === 1 ? "document" : "documents"} to the Trash. You can restore it later from Settings → Trash.`,
    confirmText: "Move to Trash",
  });
  if (!ok) return;
  try {
    const res = await api.folders.remove(state.project.id, folderId);
    // Drop any visible pane whose document was inside the deleted folder.
    for (const pane of [panes.primary, panes.secondary]) {
      if (pane.docId && folderContainsDoc(folder, pane.docId)) dropEditorFor(pane.docId);
    }
    await afterTreeChange();
    // Drop the warm editors for documents inside the deleted folder (and any
    // id that moved with it); the open document, if unrelated, is kept.
    invalidateEditorCache(true);
    await refreshWiki();
    await renderEditorView();
    updateTopbar();
    toast("Folder moved to Trash", "info", { action: undoTrash(res.trashId) });
  } catch (err) {
    toast(err.message, "error");
  }
}

async function openDocument(docId) {
  // Already visible in a pane? Focus it rather than showing it twice.
  const visible = paneForDoc(docId);
  if (visible) {
    if (state.activePane !== visible.name) setActivePane(visible.name);
    return;
  }
  if (docId === state.currentDocId) return;
  console.warn("[diag] openDocument start", docId, { _opening, _switching, _creating });
  if (_opening) {
    _opening = false;
  }
  _opening = true;
  try {
  await flushSave();
  const wiki = docId.startsWith("worldbuilding/");
  try {
    const doc = await api.docs.get(state.project.id, docId);
    docTabs.open(docId);
    persistTabs();
    state.currentDocId = docId;
    state.currentTab = wiki ? "wiki" : "write";
    if (wiki) state.wikiDocId = docId;
    else state.writeDocId = docId;
    setActiveTab(state.currentTab);
    // This re-render only moves the .active highlight, so the list must not
    // move with it (see keepScrollTop: Chromium nudges a scrolled container's
    // offset when its children are replaced).
    renderSidebar({ keepScroll: true });
    await renderEditorTab(doc, { wiki });
  } catch (err) {
    console.warn("openDocument failed", docId, err);
    toast(err.message, "error");
  }
  } finally {
    _opening = false;
  }
}

async function deleteCurrentDoc() {
  const info = findDocAny(state.currentDocId);
  if (!info) return;
  const ok = await confirmDialog({
    title: `Delete "${info.title}"?`,
    message: "This moves the document to the Trash. You can restore it later from Settings → Trash.",
    confirmText: "Move to Trash",
  });
  if (!ok) return;
  const wiki = info.id.startsWith("worldbuilding/");
  try {
    const res = await api.docs.remove(state.project.id, info.id);
    // Close the tab (which drops the editor and collapses a split pane if this
    // document was the companion).
    const result = dropTab(info.id);
    await refreshTree();
    await refreshWiki();
    updateTopbar();
    const next = result.next;
    renderSidebar();
    if (next) {
      state.activePane = "primary";
      await openDocument(next);
    } else {
      state.currentDocId = null;
      if (wiki) state.wikiDocId = null;
      else state.writeDocId = null;
      await renderEditorView();
    }
    toast("Document moved to Trash", "info", { action: undoTrash(res.trashId) });
  } catch (err) {
    toast(err.message, "error");
  }
}

async function renameCurrentDoc(newTitle) {
  if (!newTitle || !state.currentDocId) return;
  try {
    await api.docs.rename(state.project.id, state.currentDocId, newTitle);
    await refreshTree();
    // Renaming can rewrite wikilinks inside other documents, so drop the warm
    // editors for everything except the open one (whose body is unchanged).
    invalidateEditorCache(true);
    persistTabs();
    renderSidebar();
    renderDocTabs();
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ---------------- write tab ---------------- */

const TOOLBAR = [
  { cmd: "undo", label: "↶", title: "Undo" },
  { cmd: "redo", label: "↷", title: "Redo" },
  null,
  { cmd: "h1", label: "H1", title: "Heading 1" },
  { cmd: "h2", label: "H2", title: "Heading 2" },
  { cmd: "h3", label: "H3", title: "Heading 3" },
  null,
  { cmd: "bold", label: "B", title: "Bold", strong: true },
  { cmd: "italic", label: "I", title: "Italic", strong: true },
  { cmd: "underline", label: "U", title: "Underline", strong: true },
  { cmd: "strike", label: "S", title: "Strikethrough", strong: true },
  null,
  { cmd: "blockquote", label: "❝", title: "Blockquote" },
  { cmd: "bulletList", label: "• List", title: "Bullet list" },
  { cmd: "orderedList", label: "1. List", title: "Ordered list" },
  { cmd: "codeBlock", label: "</>", title: "Code block" },
  null,
  { cmd: "linkNote", label: "[[  ]]", title: "Link to a note" },
  { cmd: "image", label: "🖼", title: "Insert an image (or drag & drop / paste one)" },
  // The wiki's info box. The toolbar is shared with the Write tab, so the
  // button is marked wiki-only rather than living in a second toolbar.
  {
    cmd: "charTable",
    label: "👤",
    title: "Insert a character table (info box on the right)",
    wikiOnly: true,
  },
];

let toolbarButtons = [];

function grammarToggle() {
  const btn = el("button", {
    class: "tool-btn",
    title: "Toggle grammar check",
    onclick: async () => {
      const enabled = !state.settings.grammarEnabled;
      state.settings.grammarEnabled = enabled;
      btn.classList.toggle("grammar-on", enabled);
      btn.classList.toggle("grammar-off", !enabled);
      if (state.editorCtrl) state.editorCtrl.setGrammarEnabled(enabled);
      try {
        await api.settings.update({ grammarEnabled: enabled });
      } catch { /* ignore */ }
    },
  }, "✓");
  btn.classList.add(state.settings.grammarEnabled ? "grammar-on" : "grammar-off");
  return btn;
}

function dictionaryBtn() {
  const btn = el("button", {
    class: "tool-btn",
    title: "Project dictionary",
    onclick: () => renderDictionaryDialog(),
  }, "Dict");
  return btn;
}

function repetitionBtn() {
  const btn = el("button", {
    class: "tool-btn",
    title: "Repetition check — overused words, echoes, repeated sentences",
    onclick: () => renderRepetitionDialog(),
  }, "Repeat");
  return btn;
}

function searchBtn() {
  const btn = el("button", {
    class: "tool-btn",
    title: "Find & replace across documents (Ctrl+F)",
    onclick: () => renderSearchDialog(),
  }, "Find");
  return btn;
}

function historyBtn() {
  return el("button", {
    class: "tool-btn",
    title: "Document history — snapshots and restore",
    onclick: () => renderSnapshotsDialog(),
  }, "History");
}

function toolbar(wiki) {
  const bar = el("div", { class: "editor-toolbar" });
  toolbarButtons = [];
  for (const def of TOOLBAR) {
    if (def === null) {
      bar.append(el("div", { class: "toolbar-sep" }));
      continue;
    }
    if (def.wikiOnly && !wiki) continue;
    const btn = el("button", {
      class: "tool-btn",
      title: def.title,
      dataset: { cmd: def.cmd },
      style: def.strong ? { fontWeight: "800" } : {},
      onclick: () => toolbarCommand(def.cmd),
    }, def.label);
    bar.append(btn);
    toolbarButtons.push({ def, btn });
  }
  bar.append(
    el("div", { class: "toolbar-sep" }),
    grammarToggle(),
    dictionaryBtn(),
    repetitionBtn(),
    searchBtn(),
    historyBtn(),
    el("button", {
      class: `tool-btn${state.split ? " active" : ""}`,
      title: "Split the editor into two panes (Ctrl+\\)",
      onclick: () => toggleSplit(),
    }, "Split"),
    el("div", { class: "toolbar-sep" }),
    fontSelect("context"),
    sizeSelect("context"),
    zoomSelect("context"),
    el("div", { class: "toolbar-sep" }),
    alignGroup("context"),
    el("span", { class: "style-target", id: "style-target", title: "What the style controls apply to" }, "Document"),
    el("button", {
      class: "tool-btn",
      title: "Clear styling for the current selection/section/document",
      onclick: resetContextStyle,
    }, "Clear")
  );
  syncEditorControls();
  return bar;
}

function toolbarCommand(cmd) {
  if (cmd === "linkNote") {
    insertWikilinkDialog();
    return;
  }
  if (cmd === "image") {
    pickImageFiles();
    return;
  }
  if (cmd === "charTable") {
    if (state.editorCtrl) {
      state.editorCtrl.insertCharacterTable({ title: docTitle(state.currentDocId) });
    }
    return;
  }
  if (state.editorCtrl) state.editorCtrl.run(cmd);
}

function refreshToolbar() {
  const editor = state.editorCtrl && state.editorCtrl.editor;
  if (!editor) return;
  for (const { def, btn } of toolbarButtons) {
    let active = false;
    const cmd = def.cmd;
    if (cmd === "bold") active = editor.isActive("bold");
    else if (cmd === "italic") active = editor.isActive("italic");
    else if (cmd === "underline") active = editor.isActive("underline");
    else if (cmd === "strike") active = editor.isActive("strike");
    else if (cmd === "blockquote") active = editor.isActive("blockquote");
    else if (cmd === "bulletList") active = editor.isActive("bulletList");
    else if (cmd === "orderedList") active = editor.isActive("orderedList");
    else if (cmd === "codeBlock") active = editor.isActive("codeBlock");
    else if (cmd === "h1") active = editor.isActive("heading", { level: 1 });
    else if (cmd === "h2") active = editor.isActive("heading", { level: 2 });
    else if (cmd === "h3") active = editor.isActive("heading", { level: 3 });
    btn.classList.toggle("active", active);
  }
}

function docHeader(doc, pane) {
  if (!doc) return null;
  const typeLabel =
    doc.type && doc.type !== "note" && doc.type !== "chapter"
      ? doc.type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : doc.kind === "chapter"
        ? "Chapter"
        : "Note";
  const focusPane = () => {
    if (pane && state.split && state.activePane !== pane.name) setActivePane(pane.name);
  };
  return el("div", { class: "doc-header" }, [
    el("input", {
      class: "doc-title-input",
      value: doc.title,
      placeholder: "Untitled",
      title: "Rename document",
      onchange: (e) => {
        focusPane();
        renameCurrentDoc(e.target.value.trim());
      },
    }),
    el("span", { class: "chip" }, typeLabel),
    el("div", { class: "topbar-spacer" }),
    el("button", {
      class: "icon-btn danger",
      onclick: () => {
        focusPane();
        deleteCurrentDoc();
      },
    }, "Delete"),
  ]);
}

function backlinksPanel(pane) {
  const panel = el("div", { class: "side-panel" });
  const render = async () => {
    const docId = pane ? pane.docId : state.currentDocId;
    const wiki = state.wiki;
    let inner;
    if (!docId) {
      inner = [el("p", { class: "empty-hint" }, "Open a document to see its backlinks.")];
    } else if (!wiki) {
      inner = [el("p", { class: "empty-hint" }, "Loading…")];
    } else {
      const backlinks = (wiki.backlinks[docId] || []).map((id) => {
        const t = docTitleAny(id);
        return el("div", {
          class: "backlink",
          onclick: () => openDocument(id),
        }, t || id);
      });
      const broken = (wiki.broken[docId] || []).map((target) =>
        el("div", { class: "backlink broken-link" }, [
          el("span", { class: "name" }, `[[${escapeHtml(target)}]]`),
          el("button", {
            class: "mini-add",
            title: `Create "${target}"`,
            onclick: () => createMissingNote(target, docId),
          }, "+"),
        ])
      );
      inner = [
        el("div", { class: "panel-title" }, "Links to this document"),
        backlinks.length ? el("div", { class: "backlink-list" }, backlinks) : el("p", { class: "empty-hint" }, "Nothing links here yet."),
        el("div", { class: "panel-title", style: { marginTop: "18px" } }, "Unresolved links"),
        broken.length ? el("div", { class: "backlink-list" }, broken) : el("p", { class: "empty-hint" }, "None."),
      ];
    }
    panel.replaceChildren(...inner);
  };
  panel._render = render;
  return panel;
}

/* ---------------- inline images ---------------- */

// Transport for the editor's drag & drop / paste / toolbar insertion. The
// editor bundle owns the ProseMirror side (drop points, node insertion, the
// resize handle); everything that needs to know the project and show UI lives
// here. The size and type checks are duplicated server-side, which is the
// authoritative one.
async function uploadImageFile(file) {
  if (!isImageFile(file)) {
    throw new Error("Only PNG, JPEG, GIF and WebP images can be inserted.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`"${file.name || "That image"}" is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`);
  }
  return api.projects.assets.upload(state.project.id, file);
}

// Double-clicking a picture (in the editor) opens it full size.
function showImageOverlay({ url, alt }) {
  if (!url) return;
  let closed = false;
  const image = el("img", { class: "image-lightbox", src: url, alt: alt || "" });
  const { backdrop, close } = showModal([image]);
  const finish = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    close();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish();
    }
  };
  document.addEventListener("keydown", onKey, true);
  image.addEventListener("click", finish);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) finish();
  });
}

// A file dropped anywhere outside the editor would otherwise make Chromium
// (and therefore Electron) navigate the window to that file. This guard keeps
// the drop from doing anything but inserting a picture.
function setupFileDropGuard() {
  // Dragging a picture *within* the editor is ProseMirror moving its own node.
  // Chromium still reports it as a file drag, so it has to be told apart from
  // a drag that came in from outside — otherwise the guard would insert a
  // second copy while the editor moves the first.
  let internalDrag = false;
  const hasFiles = (e) => {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.from(types).indexOf("Files") !== -1;
  };
  const clearHint = () =>
    document.querySelectorAll(".editor-host.drop-active").forEach((node) => node.classList.remove("drop-active"));

  document.addEventListener(
    "dragstart",
    (e) => {
      internalDrag = !!(e.target && e.target.closest && e.target.closest(".ProseMirror"));
    },
    true
  );
  document.addEventListener("dragend", () => {
    internalDrag = false;
    clearHint();
  });
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e) || internalDrag) return;
    e.preventDefault();
    const host = e.target.closest && e.target.closest(".editor-host");
    if (host) host.classList.add("drop-active");
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) clearHint();
  });
  document.addEventListener("drop", (e) => {
    const wasInternal = internalDrag;
    internalDrag = false;
    if (!hasFiles(e)) return;
    e.preventDefault();
    clearHint();
    if (wasInternal) return; // the editor is moving its own picture
    // Inside the ProseMirror surface the editor already handled it (its own
    // drop listener runs first and inserts at the drop point).
    if (e.target.closest && e.target.closest(".ProseMirror")) return;
    const dropped = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const files = dropped.filter(isImageFile);
    if (!files.length) {
      if (dropped.length) toast("Only PNG, JPEG, GIF and WebP images can be inserted.", "error");
      return;
    }
    const ctrl = state.editorCtrl;
    if (!ctrl) return;
    if (e.target.closest && e.target.closest(".editor-host")) {
      // The editor's padding: no ProseMirror drop position, so insert at the caret.
      (async () => {
        for (const file of files) {
          await ctrl.insertImage(file);
        }
      })();
      return;
    }
    toast("Drop images into the editor to insert them");
  });
}

// The toolbar's picture button — a file picker, for the times dragging isn't
// convenient. With a `portrait` position the chosen picture fills a character
// table's picture slot instead of going in at the caret.
let _imageInput = null;
let _portraitTarget = null;

function pickImageFiles(portrait) {
  if (!state.editorCtrl) return;
  const target = typeof portrait === "number" ? portrait : null;
  if (!_imageInput) {
    _imageInput = el("input", {
      type: "file",
      multiple: true,
      accept: ASSET_ACCEPT,
      hidden: true,
      onchange: (e) => {
        const files = Array.from((e.target && e.target.files) || []);
        const slot = _portraitTarget;
        _portraitTarget = null;
        if (e.target) e.target.value = "";
        (async () => {
          if (!state.editorCtrl) return;
          if (slot != null) {
            await state.editorCtrl.setPortrait(slot, files);
            return;
          }
          for (const file of files) {
            await state.editorCtrl.insertImage(file);
          }
        })();
      },
    });
    document.body.append(_imageInput);
  }
  _portraitTarget = target;
  _imageInput.click();
}

/* ---------------- editor cache (undo survives document switches) -------- */

// Detach every mounted pane's editor without destroying it, so ProseMirror
// state (undo/redo history) is kept in the pool under its document id.
function parkEditor() {
  for (const pane of [panes.primary, panes.secondary]) {
    clearTimeout(pane.timer);
    pane.timer = null;
    const ctrl = pane.ctrl;
    if (!ctrl) continue;
    try {
      ctrl.deactivate();
    } catch {
      /* ignore */
    }
    const dom = ctrl.editor && ctrl.editor.view && ctrl.editor.view.dom;
    if (dom && dom.parentNode) dom.parentNode.removeChild(dom);
  }
  state.editorCtrl = null;
}

// Structural changes (delete, move, rename, restore, AI edits) can rewrite
// document bodies or reuse ids behind the cache's back. Drop the affected
// editors so anything reopened is rebuilt from disk. `keepActive` spares the
// visible panes when their own content is still valid.
function invalidateEditorCache(keepActive = false) {
  const keep = new Set();
  if (keepActive) {
    for (const pane of [panes.primary, panes.secondary]) {
      if (pane.docId) keep.add(pane.docId);
    }
  }
  for (const id of editorPool.keys()) {
    if (keep.has(id)) continue;
    const ctrl = editorPool.forget(id);
    if (ctrl) {
      try {
        ctrl.destroy();
      } catch {
        /* already gone */
      }
    }
  }
  for (const pane of [panes.primary, panes.secondary]) {
    if (pane.docId && !editorPool.has(pane.docId)) pane.ctrl = null;
  }
  if (!keepActive) state.editorCtrl = null;
}

// A fresh project route starts with no warm editors.
function resetEditorPool() {
  state.editorCtrl = null;
  for (const pane of [panes.primary, panes.secondary]) {
    clearTimeout(pane.timer);
    pane.timer = null;
    pane.ctrl = null;
    pane.docId = null;
    pane.dirty = false;
  }
  editorPool.destroyAll();
}

/* ---------------- document tabs ---------------- */

function findDocAny(docId) {
  return allDocs().find((d) => d.id === docId) || null;
}

function docTitleAny(docId) {
  const d = findDocAny(docId);
  return d ? d.title : null;
}

function tabKind(id) {
  const d = findDocAny(id);
  if (d && d.kind === "chapter") return "chapter";
  return id.startsWith("worldbuilding/") ? "wiki" : "note";
}

function tabGlyph(id) {
  const kind = tabKind(id);
  return kind === "chapter" ? "≣" : kind === "wiki" ? "✦" : "◦";
}

// A deleted document is gone from the tree but may still be in the strip; this
// removes it and rewrites any id a folder move changed (matched by title).
function reconcileTabs(oldTabs) {
  const docs = allDocs();
  const present = new Set(docs.map((d) => d.id));
  for (const { id, title } of oldTabs) {
    if (present.has(id)) continue;
    const byTitle = title ? docs.find((d) => d.title === title) : null;
    if (byTitle) docTabs.rekey(id, byTitle.id);
    else docTabs.forget(id);
  }
  persistTabs();
}

function renderDocTabs() {
  const strip = document.getElementById("doc-tabs");
  if (!strip) return;
  const ids = docTabs.tabs;
  strip.style.display = ids.length ? "" : "none";
  strip.replaceChildren(
    ...ids.map((id) => {
      const active = id === state.currentDocId;
      const splitDoc = state.split && panes.secondary.docId === id && !active;
      const info = findDocAny(id);
      const title = info ? info.title : id;
      return el("div", {
        class: `doc-tab doc-tab-${tabKind(id)}${active ? " active" : ""}${splitDoc ? " split-doc" : ""}`,
        dataset: { docid: id },
        title: info ? prettyPath(info) : id,
        onclick: () => {
          if (!active) openDocument(id);
        },
        onauxclick: (e) => {
          if (e.button === 1) {
            e.preventDefault();
            closeDocumentTab(id);
          }
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          showContextMenu(e.clientX, e.clientY, [
            { label: "Open", action: () => openDocument(id) },
            { label: "Open in split", action: () => openInSplit(id) },
            null,
            { label: "Close tab", action: () => closeDocumentTab(id) },
          ]);
        },
      }, [
        el("span", { class: "doc-tab-title" }, title),
        el("button", {
          class: "doc-tab-close",
          title: "Close tab",
          onclick: (e) => {
            e.stopPropagation();
            closeDocumentTab(id);
          },
        }, "✕"),
      ]);
    })
  );
}

// Destroy the warm editor for a document and clear it from whichever pane is
// showing it (collapsing the split if it was the companion). Used when a body
// changes behind the cache's back without the document tab being closed.
function dropEditorFor(docId) {
  const pane = paneForDoc(docId);
  if (pane) {
    clearTimeout(pane.timer);
    pane.timer = null;
    pane.ctrl = null;
    pane.dirty = false;
    pane.docId = null;
    if (pane.name === "secondary") {
      state.split = false;
      panes.secondary.wiki = false;
      if (state.activePane === "secondary") state.activePane = "primary";
    }
  }
  editorPool.destroy(docId);
  if (state.writeDocId === docId) state.writeDocId = null;
  if (state.wikiDocId === docId) state.wikiDocId = null;
  state.editorCtrl = activePane().ctrl;
  state.currentDocId = activePane().docId;
}

// Remove a tab and its warm editor without rendering. Returns the next tab.
function dropTab(id) {
  const pane = paneForDoc(id);
  const wasSecondary = panes.secondary.docId === id;
  const { next } = docTabs.close(id);
  persistTabs();
  if (pane) {
    clearTimeout(pane.timer);
    pane.timer = null;
    pane.ctrl = null;
    pane.dirty = false;
    pane.docId = null;
  }
  editorPool.destroy(id);
  if (state.writeDocId === id) state.writeDocId = null;
  if (state.wikiDocId === id) state.wikiDocId = null;
  if (wasSecondary) {
    state.split = false;
    panes.secondary.wiki = false;
    if (state.activePane === "secondary") state.activePane = "primary";
  }
  const active = activePane();
  state.editorCtrl = active.ctrl;
  state.currentDocId = active.docId;
  return { next };
}

async function closeDocumentTab(id) {
  if (!docTabs.has(id)) return;
  const isSecondary = panes.secondary.docId === id;
  const isPrimary = panes.primary.docId === id;

  if (!isPrimary && !isSecondary) {
    // An off-screen tab: drop it without touching the panes on screen.
    dropTab(id);
    renderSidebar();
    renderDocTabs();
    return;
  }

  // Flush whichever panes are about to be rebuilt.
  if (isSecondary) {
    await flushPane(panes.secondary);
  } else {
    await flushPane(panes.primary);
    if (state.split) await flushPane(panes.secondary);
  }

  const { next } = dropTab(id);
  if (isSecondary) {
    renderSidebar();
    renderDocTabs();
    await renderEditorView();
    return;
  }

  // The primary document is gone. Show the neighbour; if that neighbour is the
  // companion, promote it instead of showing it in both panes.
  if (next && next === panes.secondary.docId) {
    panes.primary.docId = next;
    panes.primary.wiki = panes.secondary.wiki;
    state.split = false;
    panes.secondary.docId = null;
    panes.secondary.wiki = false;
    state.activePane = "primary";
    state.currentDocId = next;
    persistTabs();
    renderSidebar();
    renderDocTabs();
    await renderEditorView();
    return;
  }
  if (next) {
    state.activePane = "primary";
    try {
      const doc = await api.docs.get(state.project.id, next);
      await renderEditorTab(doc, { wiki: next.startsWith("worldbuilding/"), pane: "primary" });
    } catch (err) {
      toast(err.message, "error");
    }
    return;
  }

  // No tabs left: promote the companion if present, else show the empty state.
  if (state.split && panes.secondary.docId) {
    panes.primary.docId = panes.secondary.docId;
    panes.primary.wiki = panes.secondary.wiki;
    state.split = false;
    panes.secondary.docId = null;
    panes.secondary.wiki = false;
  }
  state.activePane = "primary";
  state.currentDocId = panes.primary.docId;
  persistTabs();
  renderSidebar();
  renderDocTabs();
  await renderEditorView();
}

function cycleTabs(direction) {
  const next = docTabs.cycle(direction);
  if (next && next !== state.currentDocId) openDocument(next);
}

// Turn the split companion on (pairing with another open tab) or off.
async function toggleSplit() {
  if (state.split) {
    await flushPane(panes.secondary);
    state.split = false;
    panes.secondary.docId = null;
    panes.secondary.wiki = false;
    state.activePane = "primary";
    state.currentDocId = panes.primary.docId;
    persistTabs();
    renderDocTabs();
    await renderEditorView();
    return;
  }
  await flushSave();
  const primary = panes.primary.docId;
  const other = docTabs.tabs.find((id) => id !== primary && findDocAny(id)) || null;
  if (!other) {
    toast("Open another document to split the view", "info");
    return;
  }
  state.split = true;
  panes.secondary.docId = other;
  panes.secondary.wiki = other.startsWith("worldbuilding/");
  if (!docTabs.has(other)) docTabs.open(other);
  state.activePane = "secondary";
  state.currentDocId = other;
  persistTabs();
  renderDocTabs();
  renderSidebar();
  await renderEditorView();
}

// Show a document in the secondary pane (from a tab or the tree).
async function openInSplit(docId) {
  if (!state.project || !docId) return;
  if (panes.secondary.docId === docId) {
    setActivePane("secondary");
    return;
  }
  if (panes.primary.docId === docId) {
    if (state.split) {
      toast("Already open in the other pane", "info");
      return;
    }
    return openDocument(docId);
  }
  await flushSave();
  try {
    await api.docs.get(state.project.id, docId);
    docTabs.open(docId);
    state.split = true;
    panes.secondary.docId = docId;
    panes.secondary.wiki = docId.startsWith("worldbuilding/");
    state.activePane = "secondary";
    state.currentDocId = docId;
    persistTabs();
    renderDocTabs();
    renderSidebar();
    await renderEditorView();
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ---------------- recent documents ---------------- */

function recentIds() {
  return docTabs.recent.filter((id) => findDocAny(id));
}

function recentOpen() {
  try {
    return localStorage.getItem(LS_RECENT_OPEN) !== "0";
  } catch {
    return true;
  }
}

function recentSection() {
  const ids = recentIds();
  if (!ids.length) return null;
  const open = recentOpen();
  const list = el(
    "div",
    { class: "recent-list", style: { display: open ? "" : "none" } },
    ids.map((id) => {
      const d = findDocAny(id);
      return el("div", {
        class: `recent-item${id === state.currentDocId ? " active" : ""}`,
        title: prettyPath(d),
        onclick: () => openDocument(id),
      }, [
        el("span", { class: "recent-kind" }, tabGlyph(id)),
        el("span", { class: "recent-title" }, d.title),
      ]);
    })
  );
  return el("div", { class: "recent-section" }, [
    el("div", { class: "recent-head" }, [
      el("span", { class: "recent-heading" }, "Recent"),
      el("button", {
        class: "recent-toggle",
        title: open ? "Collapse recent" : "Expand recent",
        onclick: () => {
          try {
            localStorage.setItem(LS_RECENT_OPEN, open ? "0" : "1");
          } catch {
            /* ignore */
          }
          renderSidebar();
        },
      }, open ? "▾" : "▸"),
    ]),
    list,
  ]);
}

// Compatibility entry point: put `doc` in the target pane and redraw the view.
// Most callers mean the primary pane; sidebar/tab clicks go to the focused one.
async function renderEditorTab(doc, { wiki, pane } = {}) {
  let target = pane || (state.split ? state.activePane : "primary");
  if (target === "secondary" && !state.split) target = "primary";
  const p = panes[target] || panes.primary;
  p.docId = doc ? doc.id : null;
  p.wiki = !!wiki;
  // Never show the same document in both panes; opening the companion in the
  // primary pane just closes the split.
  if (doc && target === "primary" && panes.secondary.docId === doc.id) {
    panes.secondary.docId = null;
    panes.secondary.wiki = false;
    state.split = false;
  }
  if (!doc) {
    p.dirty = false;
    if (target === "secondary") {
      state.split = false;
      panes.secondary.docId = null;
      panes.secondary.wiki = false;
      state.activePane = "primary";
    }
  } else {
    docTabs.open(doc.id);
    persistTabs();
  }
  if (!state.split) {
    panes.secondary.docId = null;
    panes.secondary.wiki = false;
    state.activePane = "primary";
  } else {
    state.activePane = target;
  }
  state.currentDocId = activePane().docId;
  await renderEditorView();
}

// Build one pane's chrome (header, editor host, backlinks, status) and stash the
// element references on the pane record so focus and saving can reach them.
function renderPane(pane, doc) {
  const header = docHeader(doc, pane);
  const mount = el("div", { class: "editor-mount" });
  const host = el("div", { class: "editor-host" + (pane.wiki ? " wiki-host" : "") }, [mount]);
  host.style.setProperty("--editor-font", fontStack(state.settings.editorFont));
  host.style.setProperty("--editor-size", `${state.settings.editorSize || 18}px`);
  host.style.setProperty("--editor-align", state.settings.editorAlign || "left");
  host.style.setProperty("--editor-zoom", String(zoomFactor(defaultZoomForScope(pane.wiki))));
  const panel = backlinksPanel(pane);
  const wrap = el("div", { class: "editor-wrap" }, [host, panel]);
  const wordsEl = el("span", { class: "st-words" }, "0 words");
  const saveEl = el("span", { class: "st-save status-save" }, "Ready");
  const status = el("div", { class: "editor-status" }, [
    wordsEl,
    el("div", { class: "spacer" }),
    el("button", {
      class: "icon-btn",
      title: "Toggle backlinks",
      onclick: () => panel.classList.toggle("open"),
    }, "Backlinks"),
    saveEl,
  ]);
  const root = el("div", {
    class: `editor-pane${pane.name === state.activePane ? " focused" : ""}`,
    dataset: { pane: pane.name },
  }, [header, wrap, status].filter(Boolean));
  // Clicking into a pane focuses it, so the shared toolbar and grammar follow.
  root.addEventListener("mousedown", (e) => {
    if (state.split && state.activePane !== pane.name && !e.target.closest("button, input, select")) {
      setActivePane(pane.name);
    }
  });
  pane.root = root;
  pane.host = host;
  pane.mount = mount;
  pane.panel = panel;
  pane.wordsEl = wordsEl;
  pane.saveEl = saveEl;
  return root;
}

function mountPaneEditor(pane, doc) {
  const cached = editorPool.get(doc.id);
  if (cached) {
    // Re-mount the editor we kept: its undo history is still in ProseMirror.
    pane.mount.appendChild(cached.editor.view.dom);
    pane.ctrl = cached;
    editorPool.activate(doc.id);
    return true;
  }
  let ctrl = null;
  try {
    ctrl = window.LainEditor.create({
      element: pane.mount,
      content: doc.content || "",
      placeholder: pane.wiki ? "Begin lore entry…" : "Begin writing…",
      onChange: (md) => onEditorUpdate(ctrl, md),
      onWikilinkClick,
      showNav: pane.wiki,
      projectId: state.project.id,
      uploadImage: uploadImageFile,
      onImageError: (message) => toast(message, "error"),
      onUploadState: (busy) => {
        if (busy) setPaneSaveStatus(pane, "pending", "Uploading image…");
      },
      onOpenImage: showImageOverlay,
      onPickPortrait: (pos) => pickImageFiles(pos),
    });
  } catch {
    toast("Editor failed to load", "error");
    return false;
  }
  pane.ctrl = ctrl;
  editorPool.add(doc.id, ctrl);
  ctrl.setOnAddToDictionary(async (word) => {
    const words = state.dictionary.words || [];
    if (words.some((w) => w.toLowerCase() === word.toLowerCase())) return;
    words.push(word);
    state.dictionary.words = words;
    ctrl.setDictionaryWords(words);
    try {
      await api.projects.dictionary.update(state.project.id, words);
    } catch {
      /* ignore */
    }
    if (ctrl.editor) {
      ctrl.editor.view.dispatch(ctrl.editor.state.tr.setMeta("forceGrammar", true));
    }
  });
  ctrl.editor.on("transaction", () => { refreshToolbar(); refreshEditorContext(); });
  ctrl.editor.on("selectionUpdate", () => { refreshToolbar(); refreshEditorContext(); });
  return true;
}

// Redraw the whole editor tab from pane state: tab strip, one shared toolbar,
// then one or two panes side by side.
async function renderEditorView() {
  parkEditor();
  navListEl = null;
  const main = document.getElementById("main-content");
  const tabsEl = el("div", { class: "doc-tabs", id: "doc-tabs" });
  const container = el("div", { class: `editor-panes${state.split ? " split" : ""}` });

  const targets = paneList().filter((p) => p.docId);
  const docs = new Map();
  await Promise.all(targets.map(async (pane) => {
    try {
      docs.set(pane.docId, await api.docs.get(state.project.id, pane.docId));
    } catch {
      docs.set(pane.docId, null);
    }
  }));

  const rendered = [];
  for (const pane of targets) {
    const doc = docs.get(pane.docId);
    if (!doc) {
      pane.docId = null;
      pane.dirty = false;
      continue;
    }
    pane.wiki = doc.id.startsWith("worldbuilding/");
    pane.dirty = false;
    rendered.push({ pane, doc });
  }
  if (rendered.length && !rendered.some((r) => r.pane.name === state.activePane)) {
    state.activePane = rendered[0].pane.name;
  }
  const active = activePane();
  const activeDoc = docs.get(active.docId) || null;

  const tb = toolbar(active.wiki);
  for (const { pane, doc } of rendered) container.append(renderPane(pane, doc));
  if (!rendered.length) {
    container.append(
      el("div", { class: "editor-host" + (active.wiki ? " wiki-host" : "") }, [
        el("div", { class: "empty-state" }, [
          el("h2", {}, "Nothing open"),
          el("p", {}, active.wiki ? "Pick a lore entry from the sidebar, or create one." : "Pick a chapter or note from the sidebar, or create one."),
        ]),
      ])
    );
  }

  const children = [];
  if (docTabs.tabs.length) children.push(tabsEl);
  children.push(tb, container);
  main.classList.add("no-scroll");
  main.replaceChildren(...children);
  renderDocTabs();

  if (!rendered.length) {
    state.docStyle = {};
    applyDocStyle();
    return;
  }

  // Mount each pane's editor, pin both visible documents in the pool, and hand
  // focus (and the shared grammar slot) to the active pane.
  editorPool.unpinAll();
  for (const { pane, doc } of rendered) {
    if (mountPaneEditor(pane, doc)) editorPool.pin(doc.id);
  }
  for (const { pane } of rendered) {
    if (pane.ctrl) pane.ctrl.setDictionaryWords(state.dictionary.words || []);
  }
  setActivePane(state.activePane);

  if (activeDoc) {
    state.docStyle = activeDoc.style || {};
    state.currentDocId = active.docId;
    if (active.wiki) state.wikiDocId = active.docId;
    else state.writeDocId = active.docId;
    state.currentSection = null;
    state.selectionActive = false;
  } else {
    state.docStyle = {};
  }
  applyDocStyle();
  for (const { pane } of rendered) {
    if (pane.panel) pane.panel._render();
    updateLiveWords(pane);
  }
  if (active.ctrl) {
    if (active.wiki) {
      initNavBox();
      updateContentsBox(active.ctrl.getMarkdown(), docTitleAny(active.docId));
    }
    active.ctrl.focus();
  }
}

/* ---------------- navigation box (wiki) ---------------- */

let navListEl = null;

function initNavBox() {
  const navEl = state.editorCtrl && state.editorCtrl.navEl;
  if (!navEl) return;
  // A cached editor is re-mounted on every render; keep its existing controls.
  const existing = navEl.querySelector(".nav-list");
  if (existing) {
    navListEl = existing;
    return;
  }
  const list = el("div", { class: "nav-list" });
  const toggle = el("button", {
    class: "nav-toggle",
    title: "Collapse navigation",
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hidden = list.classList.toggle("collapsed");
      toggle.textContent = hidden ? "+" : "–";
      toggle.title = hidden ? "Expand navigation" : "Collapse navigation";
    },
  }, "–");
  navEl.append(
    el("div", { class: "nav-head" }, [
      el("span", { class: "nav-title" }, "Contents"),
      toggle,
    ]),
    list
  );
  navListEl = list;
}

function parseHeadings(md) {
  const headings = [];
  for (const line of (md || "").split("\n")) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      headings.push({ level: m[1].length, text: m[2].trim() });
      continue;
    }
    const h = line.match(/^<h([1-6])(?:\s[^>]*)?>(.*?)<\/h\1>$/i);
    if (h) {
      headings.push({ level: Number(h[1]), text: h[2].replace(/<[^>]+>/g, "").trim() });
    }
  }
  return headings;
}

function buildOutline(title, headings) {
  const items = [{ isRoot: true, depth: 0, number: "1", text: title || "Untitled", level: 0, pos: 0 }];
  const stack = [{ level: 0, num: "1", count: 0 }];
  for (const h of headings) {
    const L = h.level;
    while (stack.length > 1 && stack[stack.length - 1].level >= L) stack.pop();
    const top = stack[stack.length - 1];
    top.count += 1;
    const num = top.num + "." + top.count;
    stack.push({ level: L, num, count: 0 });
    items.push({ isRoot: false, depth: stack.length - 1, number: num, text: h.text, level: L, pos: -1 });
  }
  return items;
}

function updateContentsBox(markdown, title) {
  if (!navListEl) return;
  const outline = buildOutline(title, parseHeadings(markdown));
  navListEl.replaceChildren(
    ...outline.map((item) =>
      el("button", {
        class: "nav-btn" + (item.isRoot ? " nav-root" : ""),
        style: { paddingLeft: `${8 + item.depth * 16}px` },
        title: item.isRoot ? "Jump to top" : `Jump to ${item.text}`,
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          scrollToHeading(item);
        },
      }, [
        el("span", { class: "nav-num" }, item.number),
        el("span", { class: "nav-text" }, item.text),
      ])
    )
  );
}

function scrollToHeading(item) {
  const editor = state.editorCtrl && state.editorCtrl.editor;
  if (!editor) return;
  let targetPos = item.pos === 0 ? 0 : null;
  if (targetPos === null) {
    editor.state.doc.descendants((node, pos) => {
      if (!targetPos && node.type.name === "heading" && node.attrs.level === item.level && node.textContent.trim() === item.text) {
        targetPos = pos;
        return false;
      }
      return true;
    });
    if (targetPos === null) return;
  }
  editor.chain().focus().setTextSelection(targetPos).scrollIntoView().run();
}

function onEditorUpdate(ctrl, markdown) {
  // A parked editor (kept around for undo history) must never mark a visible
  // document dirty; only the mounted panes' changes count.
  const pane = paneForCtrl(ctrl);
  if (!pane) return;
  if (state.split && state.activePane !== pane.name) setActivePane(pane.name);
  pane.dirty = true;
  if (pane === activePane()) state.dirty = true;
  setPaneSaveStatus(pane, "pending", "Unsaved changes");
  updateLiveWords(pane);
  if (pane.wiki && pane === activePane()) updateContentsBox(markdown, docTitle(pane.docId));
  clearTimeout(pane.timer);
  pane.timer = setTimeout(() => savePane(pane), state.settings.autosaveMs || 800);
}

// Toolbar/style actions that change content outside the typing path.
function markActiveDirty(text = "Unsaved changes") {
  const pane = activePane();
  if (!pane.ctrl) return;
  pane.dirty = true;
  state.dirty = true;
  setPaneSaveStatus(pane, "pending", text);
  clearTimeout(pane.timer);
  pane.timer = setTimeout(() => savePane(pane), state.settings.autosaveMs || 800);
}

function updateLiveWords(pane = activePane()) {
  if (!pane || !pane.ctrl || !pane.wordsEl) return;
  const count = countWords(pane.ctrl.getText(), mode());
  pane.wordsEl.textContent = `${formatNumber(count)} words`;
}

function setPaneSaveStatus(pane, kind, text) {
  if (!pane || !pane.saveEl) return;
  pane.saveEl.textContent = text;
  pane.saveEl.className = `status-save ${kind === "pending" ? "pending" : ""}`;
}

async function _doSavePane(pane, docId, markdown) {
  const t0 = performance.now();
  pane.saving = true;
  setPaneSaveStatus(pane, "pending", "Saving…");
  console.warn("[diag] save start", docId);
  try {
    const saved = await api.docs.save(state.project.id, docId, markdown);
    console.warn(`[diag] save done ${(performance.now() - t0).toFixed(0)}ms`, docId);
    if (pane.docId === docId) setPaneSaveStatus(pane, "", "Saved");
    updateTreeWords(docId, saved.words);
    scheduleWikiRefresh();
    updateTopbar();
    return saved;
  } catch (err) {
    console.warn(`[diag] save error ${(performance.now() - t0).toFixed(0)}ms`, docId, err.message);
    pane.dirty = true;
    if (pane === activePane()) state.dirty = true;
    setPaneSaveStatus(pane, "pending", `Save failed: ${err.message}`);
    if (pane.ctrl && pane.docId === docId) {
      clearTimeout(pane.timer);
      pane.timer = setTimeout(() => savePane(pane), state.settings.autosaveMs || 800);
    }
    throw err;
  } finally {
    pane.saving = false;
    pane.savePromise = null;
  }
}

async function savePane(pane) {
  if (!pane.ctrl || !pane.docId || pane.saving) return;
  if (!pane.dirty) return;
  const markdown = pane.ctrl.getMarkdown();
  pane.dirty = false;
  if (pane === activePane()) state.dirty = false;
  pane.savePromise = _doSavePane(pane, pane.docId, markdown);
  try {
    await pane.savePromise;
  } catch {
    /* handled in _doSavePane */
  }
}

const FLUSH_SAVE_TIMEOUT_MS = 5000;

async function flushPane(pane) {
  if (!pane.ctrl || !pane.docId) return;
  if (pane.savePromise) {
    console.warn("[diag] flushPane reusing in-flight save", pane.docId);
    try {
      await Promise.race([
        pane.savePromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("save timed out")), FLUSH_SAVE_TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      console.warn(`[diag] flushPane awaited in-flight save: ${err.message}`);
    }
    return;
  }
  if (!pane.dirty) return;
  const docId = pane.docId;
  const markdown = pane.ctrl.getMarkdown();
  pane.dirty = false;
  if (pane === activePane()) state.dirty = false;
  pane.savePromise = _doSavePane(pane, docId, markdown);
  try {
    await Promise.race([
      pane.savePromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("save timed out")), FLUSH_SAVE_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    console.warn(`[diag] flushPane error: ${err.message}`);
    if (err.message === "save timed out") {
      toast("Save is taking a while; continuing without waiting");
    } else {
      toast(`Couldn't save before switching: ${err.message}`, "error");
    }
  }
}

async function flushSave() {
  await Promise.all(paneList().map(flushPane));
}

function updateTreeWords(docId, words) {
  const walk = (n) => {
    for (const d of n.documents || []) if (d.id === docId) d.words = words;
    for (const f of n.folders || []) walk(f);
  };
  walk(state.tree);
  walk(state.wikiTree);
  renderSidebar();
}

async function insertWikilinkDialog() {
  let notes;
  if (state.wiki) notes = state.wiki.notes;
  else {
    const wiki = await refreshWiki();
    notes = wiki.notes || [];
  }
  const current = state.currentDocId;
  const candidates = notes.filter((n) => n.id !== current);

  const search = el("input", { type: "text", placeholder: "Search notes…" });
  const list = el("div", { class: "modal-list" });

  const insert = (title) => {
    if (state.editorCtrl) state.editorCtrl.insertWikilink(title || search.value.trim());
  };

  const { close } = showModalFromUI([
    el("h3", {}, "Link to a note"),
    el("div", { class: "field" }, [el("label", {}, "Type a title or search"), search]),
    list,
    el("div", { class: "modal-actions" }, [
      el("button", { class: "icon-btn", onclick: () => close() }, "Cancel"),
      el("button", {
        class: "icon-btn primary",
        onclick: () => {
          insert();
          close();
        },
      }, "Insert"),
    ]),
  ]);

  const filter = () => {
    const q = search.value.trim().toLowerCase();
    const matches = candidates.filter((n) => !q || n.title.toLowerCase().includes(q));
    if (matches.length === 0) {
      const typed = search.value.trim();
      list.replaceChildren(
        el("div", {
          class: "modal-list-item",
          onclick: () => {
            insert(typed);
            close();
          },
        }, typed ? `Link to new note "${typed}"` : "Type a title to continue")
      );
      return;
    }
    list.replaceChildren(
      ...matches.map((n) =>
        el("div", {
          class: "modal-list-item",
          onclick: () => {
            insert(n.title);
            close();
          },
        }, [el("strong", {}, n.title), el("span", {}, ` — ${n.kind}`)])
      )
    );
  };
  search.addEventListener("input", filter);
  filter();
  search.focus();
}

function showModalFromUI(children) {
  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: "modal" }, children);
  backdrop.append(modal);
  document.body.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  return { backdrop, modal, close };
}

/* ---------------- stats tab ---------------- */

const LS_DAILY_LIST = "im.stats.dailyList";
let dailyCache = { id: null, data: null };

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function loadDailyHistory() {
  if (dailyCache.id === state.project.id) return dailyCache.data;
  const data = await api.projects.statsDaily(state.project.id);
  dailyCache = { id: state.project.id, data };
  return data;
}

function dailyHistoryEl(data) {
  const today = todayISO();
  const rows = [...data.days].reverse().map((d) => {
    const label = new Date(d.date + "T00:00:00").toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const cls = [d.words === 0 ? "zero" : "", d.date === today ? "hl" : ""].filter(Boolean).join(" ");
    return el("div", { class: `daily-row ${cls}` }, [
      el("span", { class: "daily-date" }, label),
      el("span", { class: "daily-words" }, formatNumber(d.words)),
    ]);
  });
  return el("div", { class: "daily-list" }, rows);
}

async function insertDailyHistory(anchorEl, checkbox) {
  const holder = el("div", { class: "daily-list loading" }, "Loading history…");
  anchorEl.after(holder);
  try {
    const data = await loadDailyHistory();
    if (!holder.isConnected) return; // toggled off or re-rendered meanwhile
    holder.replaceWith(dailyHistoryEl(data));
  } catch (err) {
    if (!holder.isConnected) return;
    holder.remove();
    if (checkbox) {
      checkbox.checked = false;
      localStorage.setItem(LS_DAILY_LIST, "0");
    }
    toast(err.message, "error");
  }
}

async function renderStatsTab() {
  const main = document.getElementById("main-content");
  main.replaceChildren(el("div", { class: "empty-state" }, [el("p", {}, "Loading stats…")]));
  let stats;
  try {
    stats = await api.projects.stats(state.project.id);
  } catch (err) {
    main.replaceChildren(el("div", { class: "empty-state" }, [el("p", {}, err.message)]));
    return;
  }

  const goalActive = stats.goal.enabled;
  const goalInput = el("input", {
    type: "number",
    min: 1,
    value: stats.goal.wordsPerDay || 500,
  });
  const toggle = el("button", { class: `switch ${goalActive ? "on" : ""}` });
  const saveGoal = async () => {
    const enabled = toggle.classList.contains("on");
    const words = parseInt(goalInput.value, 10) || 500;
    try {
      await api.projects.setGoal(state.project.id, words, enabled);
      toast("Goal updated");
      renderStatsTab();
      updateTopbar();
    } catch (err) {
      toast(err.message, "error");
    }
  };
  toggle.addEventListener("click", () => {
    toggle.classList.toggle("on");
    saveGoal();
  });
  goalInput.addEventListener("change", saveGoal);

  const progress = stats.goal.enabled ? stats.progress : 0;
  const progressFill = el("div", { class: "progress-fill", style: { width: `${Math.min(progress, 100)}%` } });
  const progressNote = stats.goal.enabled
    ? stats.goalMetToday
      ? `Goal met! ${formatNumber(stats.todayWords - stats.goal.wordsPerDay)} over today.`
      : `${formatNumber(Math.max(0, stats.goal.wordsPerDay - stats.todayWords))} words to reach today's goal.`
    : "Enable a daily goal to track progress and streaks.";

  const today = new Date().getDate();
  const bars = stats.lastDays.map((d) => {
    const dayNum = parseInt(d.date.slice(-2), 10);
    const max = Math.max(1, ...stats.lastDays.map((x) => x.words));
    const height = d.words ? Math.max(4, Math.round((d.words / max) * 100)) : 0;
    const isToday = dayNum === today;
    return el("div", { class: "bar-wrap", title: `${d.date}: ${d.words} words` }, [
      el("div", { class: `bar ${d.words === 0 ? "zero" : ""}`, style: { height: `${height}%` } }),
      el("div", { class: `bar-label ${isToday ? "hl" : ""}` }, dayNum),
    ]);
  });

  const chartEl = el("div", { class: "chart" }, bars);
  const dailyListOn = localStorage.getItem(LS_DAILY_LIST) === "1";
  const dailyCb = el("input", { type: "checkbox", id: "daily-list-cb", checked: dailyListOn });
  const toggleRow = el("div", { class: "daily-list-toggle" }, [
    dailyCb,
    el("label", { for: "daily-list-cb" }, "Show daily history"),
  ]);
  dailyCb.addEventListener("change", () => {
    localStorage.setItem(LS_DAILY_LIST, dailyCb.checked ? "1" : "0");
    const existing = main.querySelector(".daily-list");
    if (!dailyCb.checked) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) insertDailyHistory(toggleRow, dailyCb);
  });

  main.replaceChildren(
    el("div", { class: "stats-view" }, [
      el("h2", {}, "Writing stats"),
      el("div", { class: "stat-cards" }, [
        statCard("Today", formatNumber(stats.todayWords), "words written"),
        statCard("Total", formatNumber(stats.totalWords), "across the project"),
        statCard("Streak", formatNumber(stats.streak), stats.streak === 1 ? "day" : "days"),
        statCard("Documents", formatNumber(stats.documents), "chapters & notes"),
      ]),
      el("div", { class: "goal-panel" }, [
        el("div", { class: "field-row" }, [
          el("label", {}, "Daily word goal"),
          toggle,
        ]),
        el("div", { class: "goal-row" }, [
          goalInput,
          el("span", {}, "words per day"),
          el("div", { class: "spacer" }),
          el("button", { class: "icon-btn primary", onclick: saveGoal }, "Save goal"),
        ]),
        el("div", { class: "progress-track" }, [progressFill]),
        el("div", { class: "goal-fineprint" }, progressNote),
      ]),
      el("h2", {}, "Last 30 days"),
      chartEl,
      toggleRow,
    ])
  );

  if (dailyListOn) insertDailyHistory(toggleRow, dailyCb);
}

function statCard(label, value, sub) {
  return el("div", { class: "stat-card" }, [
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, value),
    el("div", { class: "sub" }, sub),
  ]);
}

/* ---------------- dictionary dialog ---------------- */

const DICT_MODAL_SEL = ".modal-overlay.dict-modal";

function renderDictionaryDialog() {
  const existing = document.querySelector(DICT_MODAL_SEL);
  if (existing) { existing.remove(); return; }

  const words = state.dictionary.words || [];
  let addInputEl, searchInputEl;

  function _saveWords() {
    state.dictionary.words = words;
    state.editorCtrl.setDictionaryWords(words);
    api.projects.dictionary.update(state.project.id, words).catch(() => {});
    if (state.editorCtrl.editor) {
      state.editorCtrl.editor.view.dispatch(state.editorCtrl.editor.state.tr.setMeta("forceGrammar", true));
    }
  }

  function addWord() {
    const w = addInputEl.value.trim();
    if (!w) return;
    if (words.some((x) => x.toLowerCase() === w.toLowerCase())) {
      addInputEl.value = "";
      return;
    }
    words.push(w);
    addInputEl.value = "";
    _saveWords();
    refreshList();
  }

  function removeWord(w) {
    const idx = words.indexOf(w);
    if (idx < 0) return;
    words.splice(idx, 1);
    _saveWords();
    refreshList();
  }

  function refreshList() {
    const query = searchInputEl ? searchInputEl.value.trim().toLowerCase() : "";
    const list = modal.querySelector(".dict-word-list");
    const count = modal.querySelector(".dict-word-count");
    if (!list) return;

    const filtered = query
      ? words.filter((w) => w.toLowerCase().includes(query))
      : words;

    const sorted = [...(filtered || [])].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );

    list.replaceChildren();
    if (words.length === 0) {
      list.append(el("div", { class: "dict-empty" }, "No words yet."));
    } else if (sorted.length === 0) {
      list.append(el("div", { class: "dict-empty" }, "No matching words."));
    } else {
      for (const w of sorted) {
        list.append(
          el("div", { class: "dict-word-row" }, [
            el("span", { class: "dict-word-text", title: w }, w),
            el("button", {
              class: "dict-word-remove",
              title: "Remove",
              onclick: () => removeWord(w),
            }, "\u00d7"),
          ])
        );
      }
    }

    if (count) {
      count.textContent = words.length
        ? `${words.length} word${words.length !== 1 ? "s" : ""}`
        : "";
    }
  }

  const overlay = el("div", { class: "modal-overlay dict-modal" }, [
    el("div", { class: "dict-dialog" }, [
      el("div", { class: "dict-header" }, [
        el("h3", {}, "Dictionary"),
        el("button", { class: "dict-close", onclick: () => overlay.remove() }, "\u00d7"),
      ]),
      el("div", { class: "dict-body" }, [
        el("div", { class: "dict-add-row" }, [
          addInputEl = el("input", {
            type: "text",
            class: "dict-add-input",
            placeholder: "Add word\u2026",
            onkeydown: (e) => { if (e.key === "Enter") addWord(); },
          }),
          el("button", { class: "primary dict-add-btn", onclick: addWord }, "Add"),
        ]),
        searchInputEl = el("input", {
          type: "text",
          class: "dict-search-input",
          placeholder: "Search\u2026",
          oninput: refreshList,
        }),
        el("div", { class: "dict-word-count" }),
        el("div", { class: "dict-word-list" }),
      ]),
    ]),
  ]);

  const modal = overlay.querySelector(".dict-dialog");
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  refreshList();

  setTimeout(() => { if (addInputEl) addInputEl.focus(); }, 100);
}

/* ---------------- export dialog ---------------- */

const EXPORT_FORMATS = [
  { value: "zip", label: "ZIP", desc: "Original Markdown files + project metadata." },
  { value: "docx", label: "DOCX", desc: "Formatted Word document (.docx)." },
  { value: "pdf", label: "PDF", desc: "Print-ready PDF with styled formatting." },
  { value: "epub", label: "EPUB", desc: "E-book (.epub) with auto-generated table of contents." },
];

export async function renderExportDialog(projectId) {
  let tree;
  try {
    tree = await api.projects.tree(projectId, "all");
  } catch (err) {
    toast(err.message, "error");
    return;
  }

  const topFolders = (tree && tree.folders) || [];
  const rootDocCount = (tree && tree.documents) ? tree.documents.length : 0;

  const selectAllCb = el("input", { type: "checkbox", id: "exp-sel-all" });
  selectAllCb.checked = true;

  const folderChecks = topFolders.map((f) => {
    const cb = el("input", { type: "checkbox", value: f.id || f.name });
    cb.checked = true;
    return { cb, folder: f, row: null };
  });

  let rootCheck = null;
  if (rootDocCount > 0) {
    const cb = el("input", { type: "checkbox", value: "." });
    cb.checked = true;
    rootCheck = { cb };
  }

  function _syncMaster() {
    const all = selectAllCb.checked;
    folderChecks.forEach((f) => { f.cb.checked = all; f.cb.disabled = all; });
    if (rootCheck) { rootCheck.cb.checked = all; rootCheck.cb.disabled = all; }
  }

  function _syncChild() {
    const allChecked = folderChecks.every((f) => f.cb.checked)
      && (rootCheck ? rootCheck.cb.checked : true);
    const noneChecked = folderChecks.every((f) => !f.cb.checked)
      && (rootCheck ? !rootCheck.cb.checked : true);
    selectAllCb.checked = allChecked;
    selectAllCb.indeterminate = !allChecked && !noneChecked;
  }

  selectAllCb.addEventListener("change", _syncMaster);
  folderChecks.forEach((fc) => fc.cb.addEventListener("change", _syncChild));
  if (rootCheck) rootCheck.cb.addEventListener("change", _syncChild);

  const folderListItems = [];
  const selAllLabel = el("label", { class: "export-check-label" }, [selectAllCb, " Select all folders"]);
  folderListItems.push(el("div", { class: "export-check-row export-check-all" }, [selAllLabel]));

  for (const fc of folderChecks) {
    const label = el("label", { class: "export-check-label" }, [fc.cb, ` ${fc.folder.name}`]);
    fc.row = el("div", { class: "export-check-row" }, [label]);
    folderListItems.push(fc.row);
  }

  if (rootCheck) {
    const label = el("label", { class: "export-check-label" }, [rootCheck.cb, ` Top-level documents (${rootDocCount})`]);
    folderListItems.push(el("div", { class: "export-check-row" }, [label]));
  }

  const folderList = el("div", { class: "export-folder-list" }, folderListItems);

  let selectedFormat = "zip";
  const formatRadios = EXPORT_FORMATS.map((f) => {
    const radio = el("input", { type: "radio", name: "export-format", value: f.value });
    if (f.value === "zip") radio.checked = true;
    radio.addEventListener("change", () => { selectedFormat = f.value; });
    return el("label", { class: "export-radio-label" }, [
      radio,
      el("span", { class: "export-radio-text" }, [el("strong", {}, f.label), ` — ${f.desc}`]),
    ]);
  });

  const formatSection = el("div", { class: "export-format-section" }, [
    el("div", { class: "export-section-title" }, "Format"),
    el("div", { class: "export-radio-group" }, formatRadios),
  ]);

  const statusEl = el("span", { class: "export-status" });

  const { modal, close } = showModal([
    el("h3", {}, "Export Project"),
    formatSection,
    el("div", { class: "export-section-title" }, "Folders"),
    folderList,
    el("div", { class: "modal-actions" }, [
      statusEl,
      el("button", { class: "icon-btn", onclick: () => close() }, "Cancel"),
      el("button", {
        class: "icon-btn primary",
        async onclick() {
          const btn = this;
          btn.disabled = true;
          statusEl.textContent = "Exporting…";
          try {
            let folders;
            if (selectAllCb.checked) {
              folders = null;
            } else {
              folders = [];
              folderChecks.forEach((fc) => { if (fc.cb.checked && fc.folder.id) folders.push(fc.folder.id); });
              if (rootCheck && rootCheck.cb.checked) folders.push(".");
            }

            if (window.pywebview && window.pywebview.api) {
              const result = await window.pywebview.api.export_with_dialog(projectId, selectedFormat, folders);
              if (result.cancelled) {
                close();
                return;
              }
              if (result.error) throw new Error(result.error);
            } else {
              const resp = await api.projects.export(projectId, { format: selectedFormat, folders });
              triggerDownload(resp);
            }
            statusEl.textContent = "Done!";
            setTimeout(close, 800);
          } catch (err) {
            toast(err.message, "error");
            btn.disabled = false;
            statusEl.textContent = "";
          }
        },
      }, "Export"),
    ]),
  ]);

  modal.style.maxWidth = "520px";
}

/* ---------------- repetition check ---------------- */

// Which findings the results panel shows. Remembered across runs, like the
// stats tab's daily-list toggle.
const LS_REP_FILTER = "im.repetition.filter";

// Best-effort "jump to the match": the editor's text is what the check saw,
// but finding it by string is cheap and works for the common case. Markdown
// drift simply opens the document without a selection. ``occurrence`` selects
// the Nth hit within the document (search passes the one the user clicked).
function revealText(text, occurrence = 0) {
  const editor = state.editorCtrl && state.editorCtrl.editor;
  const needle = (text || "").trim();
  if (!editor || !needle) return false;
  const lower = needle.toLowerCase();
  let remaining = Math.max(0, occurrence | 0);
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isTextblock) return found < 0;
    const content = node.textContent;
    const offsets = [];
    let index = content.indexOf(needle);
    if (index >= 0) {
      // Exact-case hits first, then a case-insensitive pass catches the rest
      // (mirrors the old single-match behavior, now across every block).
      while (index >= 0) {
        offsets.push(index);
        index = content.indexOf(needle, index + 1);
      }
    } else {
      const haystack = content.toLowerCase();
      index = haystack.indexOf(lower);
      while (index >= 0) {
        offsets.push(index);
        index = haystack.indexOf(lower, index + 1);
      }
    }
    if (remaining < offsets.length) {
      found = pos + 1 + offsets[remaining];
      return false;
    }
    remaining -= offsets.length;
    return true;
  });
  if (found < 0) return false;
  editor.chain().focus().setTextSelection({ from: found, to: found + needle.length }).scrollIntoView().run();
  return true;
}

function repInt(input, fallback) {
  const value = parseInt(input.value, 10);
  return Number.isFinite(value) ? value : fallback;
}

async function renderRepetitionDialog() {
  const existing = document.querySelector(".modal-backdrop.repetition-modal");
  if (existing) { existing.remove(); return; }

  let tree;
  try {
    tree = await api.projects.tree(state.project.id, "all");
  } catch (err) {
    toast(err.message, "error");
    return;
  }

  // --- scope tree -----------------------------------------------------
  // Default to the Write scope: the wiki's lore entries would otherwise flood
  // the prose results, and it is one click to include them.
  const allDocBoxes = [];
  const folderEntries = [];
  const masterBox = el("input", { type: "checkbox", id: "rep-sel-all" });

  function nodeRow(box, label, depth, className) {
    return el("div", { class: `rep-node${className ? ` ${className}` : ""}`, style: { paddingLeft: `${10 + depth * 16}px` } }, [
      el("label", { class: "export-check-label" }, [box, ` ${label}`]),
    ]);
  }

  function setFolderChecked(entry, checked) {
    entry.cb.checked = checked;
    entry.cb.indeterminate = false;
    for (const child of entry.children) setFolderChecked(child, checked);
  }

  function syncMaster() {
    const total = allDocBoxes.length;
    const checked = allDocBoxes.filter((box) => box.checked).length;
    masterBox.checked = total > 0 && checked === total;
    masterBox.indeterminate = checked > 0 && checked < total;
  }

  function refreshUp(entry) {
    while (entry) {
      if (entry.cb) {
        const checked = entry.docs.filter((box) => box.checked).length;
        entry.cb.checked = entry.docs.length > 0 && checked === entry.docs.length;
        entry.cb.indeterminate = checked > 0 && checked < entry.docs.length;
      }
      entry = entry.parent;
    }
    syncMaster();
  }

  function buildNode(node, depth, parent, checked) {
    const entry = { cb: el("input", { type: "checkbox" }), own: [], docs: [], children: [], parent };
    entry.cb.checked = checked;
    const rows = [nodeRow(entry.cb, node.name, depth, "rep-folder")];
    for (const doc of node.documents || []) {
      const box = el("input", { type: "checkbox", value: doc.id });
      box.checked = checked;
      allDocBoxes.push(box);
      entry.own.push(box);
      rows.push(nodeRow(box, doc.title, depth + 1));
      box.addEventListener("change", () => refreshUp(entry));
    }
    entry.docs.push(...entry.own);
    for (const childFolder of node.folders || []) {
      const child = buildNode(childFolder, depth + 1, entry, checked);
      entry.children.push(child);
      entry.docs.push(...child.docs);
      rows.push(...child.rows);
    }
    entry.cb.addEventListener("change", () => {
      setFolderChecked(entry, entry.cb.checked);
      for (const box of entry.docs) box.checked = entry.cb.checked;
      refreshUp(parent);
    });
    folderEntries.push(entry);
    entry.rows = rows;
    return entry;
  }

  const rootEntry = { cb: null, own: [], docs: [], children: [], parent: null };
  const scopeRows = [];
  for (const doc of tree.documents || []) {
    const box = el("input", { type: "checkbox", value: doc.id });
    box.checked = true;
    allDocBoxes.push(box);
    rootEntry.own.push(box);
    rootEntry.docs.push(box);
    scopeRows.push(nodeRow(box, doc.title, 0));
    box.addEventListener("change", () => refreshUp(rootEntry));
  }
  for (const folder of tree.folders || []) {
    const include = folder.id !== "worldbuilding";
    const child = buildNode(folder, 1, rootEntry, include);
    rootEntry.children.push(child);
    rootEntry.docs.push(...child.docs);
    scopeRows.push(...child.rows);
  }
  syncMaster();
  masterBox.addEventListener("change", () => {
    for (const box of allDocBoxes) box.checked = masterBox.checked;
    for (const entry of folderEntries) {
      entry.cb.checked = masterBox.checked;
      entry.cb.indeterminate = false;
    }
    masterBox.indeterminate = false;
  });

  // --- options --------------------------------------------------------
  const optMinCount = el("input", { type: "number", min: 2, max: 1000, value: 4 });
  const optMinLength = el("input", { type: "number", min: 1, max: 40, value: 4 });
  const optWindow = el("input", { type: "number", min: 1, max: 1000, value: 50 });
  const optPhraseMin = el("input", { type: "number", min: 2, max: 10, value: 2 });
  const optPhraseMax = el("input", { type: "number", min: 2, max: 12, value: 5 });
  const optPhraseCount = el("input", { type: "number", min: 2, max: 1000, value: 3 });
  const optSentence = el("input", { type: "number", min: 1, max: 1000, value: 6 });
  const optStop = el("input", { type: "checkbox" });
  optStop.checked = true;
  const optProper = el("input", { type: "checkbox" });
  optProper.checked = true;
  const optionRow = (label, control) =>
    el("div", { class: "rep-option" }, [el("span", { class: "rep-option-label" }, label), control]);
  const options = el("details", { class: "rep-options" }, [
    el("summary", {}, "Options"),
    el("div", { class: "rep-options-grid" }, [
      optionRow("Flag words used at least", optMinCount),
      optionRow("Ignore words shorter than", optMinLength),
      optionRow("Flag repeats within (words)", optWindow),
      optionRow("Shortest phrase (words)", optPhraseMin),
      optionRow("Longest phrase (words)", optPhraseMax),
      optionRow("Flag phrases used at least", optPhraseCount),
      optionRow("Ignore repeated sentences under", optSentence),
      optionRow("Ignore common words", optStop),
      optionRow("Ignore proper nouns", optProper),
    ]),
  ]);

  // --- results --------------------------------------------------------
  const statusEl = el("span", { class: "export-status" });
  const results = el("div", { class: "rep-results" });

  function wordRows(items, kind) {
    return items.map((item) =>
      el("div", { class: "rep-row" }, [
        el("span", { class: "rep-word" }, item.word),
        el("span", { class: "rep-count" }, kind === "echo" ? `${item.count}× (gap ${item.minGap})` : `${item.count}×`),
        el("span", { class: "rep-per10k" }, kind === "echo" ? "" : `${item.per10k}/10k`),
        el("span", { class: "rep-docs", title: item.documents.join(", ") }, item.documents.join(", ")),
      ])
    );
  }

  function section(title, note, children) {
    return el("div", { class: "rep-section" }, [
      el("div", { class: "export-section-title" }, [title, note ? el("span", { class: "rep-note" }, ` — ${note}`) : null]),
      children.length ? el("div", { class: "rep-list" }, children) : el("div", { class: "rep-empty" }, "None."),
    ]);
  }

  function renderResults(result) {
    const wordSection = section("Overused words", "count · per 10k · documents", wordRows(result.overused, "overuse"));
    const echoSection = section("Nearby echoes", "same word reused close together", wordRows(result.echoes, "echo"));
    const jump = (docId, text) => async () => {
      close();
      await openDocument(docId);
      if (!revealText(text)) toast("Opened the document");
    };
    const phraseItems = result.phrases.map((item) =>
      el("div", { class: "rep-phrase" }, [
        el("div", { class: "rep-phrase-text" }, `“${item.phrase}”`),
        el("div", { class: "rep-phrase-meta" }, [
          el("span", { class: "rep-count" }, `${item.count}×`),
          el("span", { class: "rep-per10k" }, `${item.per10k}/10k`),
          ...item.occurrences.map((occ) =>
            el("button", { class: "rep-chip", title: "Open this document", onclick: jump(occ.docId, item.phrase) }, occ.title)
          ),
        ]),
      ])
    );
    const phraseSection = section("Repeated phrases", "longest repeated form", phraseItems);
    const sentenceItems = result.sentences.map((item) =>
      el("div", { class: "rep-sentence" }, [
        el("div", { class: "rep-sentence-text" }, `“${item.text}”`),
        el("div", { class: "rep-sentence-meta" }, [
          el("span", { class: "rep-count" }, `${item.count}×`),
          ...item.occurrences.map((occ) =>
            el("button", { class: "rep-chip", title: "Open this document", onclick: jump(occ.docId, occ.text) }, occ.title)
          ),
        ]),
      ])
    );
    const sentenceSection = section("Repeated sentences", "exact matches", sentenceItems);

    // "Words" covers both word sections so choosing it never hides the echoes.
    const sections = {
      words: [wordSection, echoSection],
      phrases: [phraseSection],
      sentences: [sentenceSection],
    };
    const allSections = Object.values(sections).flat();
    const stored = localStorage.getItem(LS_REP_FILTER);
    const filterSelect = el(
      "select",
      { class: "rep-filter", id: "rep-filter", title: "Which findings to show" },
      [["all", "All"], ["words", "Words"], ["phrases", "Phrases"], ["sentences", "Sentences"]].map(
        ([value, label]) => el("option", { value }, label)
      )
    );
    filterSelect.value = sections[stored] ? stored : "all";
    const applyFilter = () => {
      const visible = filterSelect.value === "all" ? allSections : sections[filterSelect.value];
      for (const node of allSections) node.hidden = !visible.includes(node);
    };
    filterSelect.addEventListener("change", () => {
      localStorage.setItem(LS_REP_FILTER, filterSelect.value);
      applyFilter();
    });
    const filterRow = el("div", { class: "rep-filter-row" }, [
      el("label", { class: "rep-filter-label", for: "rep-filter" }, "Show:"),
      filterSelect,
    ]);

    results.replaceChildren(
      el("div", { class: "rep-summary" }, `${formatNumber(result.words)} words across ${result.documents} document${result.documents === 1 ? "" : "s"}`),
      filterRow,
      wordSection,
      echoSection,
      phraseSection,
      sentenceSection
    );
    applyFilter();
  }

  // --- run ------------------------------------------------------------
  const runBtn = el("button", {
    class: "icon-btn primary",
    async onclick() {
      const selection = masterBox.checked
        ? null
        : { folders: [], documents: allDocBoxes.filter((box) => box.checked).map((box) => box.value) };
      if (selection && selection.documents.length === 0) {
        toast("Select at least one chapter or folder", "error");
        return;
      }
      const payload = {
        selection,
        options: {
          words: {
            minCount: repInt(optMinCount, 4),
            minLength: repInt(optMinLength, 4),
            proximityWindow: repInt(optWindow, 50),
            ignoreStopwords: optStop.checked,
            ignoreDictionary: true,
            ignoreProperNouns: optProper.checked,
          },
          phrases: {
            minWords: repInt(optPhraseMin, 2),
            maxWords: repInt(optPhraseMax, 5),
            minCount: repInt(optPhraseCount, 3),
          },
          sentences: { minWords: repInt(optSentence, 6) },
        },
      };
      runBtn.disabled = true;
      statusEl.textContent = "Checking…";
      try {
        const result = await api.projects.repetition(state.project.id, payload);
        renderResults(result);
        statusEl.textContent = "Done";
      } catch (err) {
        toast(err.message, "error");
        statusEl.textContent = "";
      } finally {
        runBtn.disabled = false;
      }
    },
  }, "Check");

  const { backdrop, modal, close } = showModal([
    el("h3", {}, "Repetition check"),
    el("div", { class: "export-section-title" }, "Include"),
    el("div", { class: "rep-scope" }, [
      el("div", { class: "export-check-row export-check-all" }, [
        el("label", { class: "export-check-label" }, [masterBox, " Select all (whole project)"]),
      ]),
      ...scopeRows,
    ]),
    options,
    el("div", { class: "modal-actions" }, [
      statusEl,
      el("button", { class: "icon-btn", onclick: () => close() }, "Close"),
      runBtn,
    ]),
    results,
  ]);
  backdrop.classList.add("repetition-modal");
  modal.style.maxWidth = "640px";
}

/* ---------------- full-text search ---------------- */

async function renderSearchDialog() {
  const existing = document.querySelector(".modal-backdrop.search-modal");
  if (existing) { existing.remove(); return; }

  const input = el("input", {
    type: "search",
    class: "search-input",
    placeholder: "Search all documents…",
  });
  const replaceInput = el("input", {
    type: "text",
    class: "search-input search-replace-input",
    placeholder: "Replace with…",
  });
  const caseBox = el("input", { type: "checkbox", id: "search-case" });
  const wordBox = el("input", { type: "checkbox", id: "search-word" });
  const scopeSelect = el(
    "select",
    { class: "search-scope", id: "search-scope" },
    [
      ["all", "Whole project"],
      ["write", "Write"],
      ["wiki", "Wiki"],
      ["document", "Current document"],
    ].map(([value, label]) => el("option", { value }, label))
  );
  const statusEl = el("span", { class: "export-status" });
  const results = el("div", { class: "search-results" });

  let requestId = 0;
  let timer = null;

  function renderResults(result) {
    if (!result.totalMatches) {
      results.replaceChildren(
        el("div", { class: "search-empty" }, `No matches for “${result.query}”.`)
      );
      return;
    }
    const summary = el(
      "div",
      { class: "search-summary" },
      `${formatNumber(result.totalMatches)} match${result.totalMatches === 1 ? "" : "es"} in ${result.documentsMatched} document${result.documentsMatched === 1 ? "" : "s"}${result.truncated ? " · results capped" : ""}`
    );
    const groups = result.results.map((group) => {
      const hits = group.matches.map((hit) =>
        el("button", {
          class: "search-hit",
          title: "Open and select this match",
          onclick: () => jump(group.docId, hit),
        }, [hit.before, el("mark", {}, hit.match), hit.after])
      );
      return el("div", { class: "search-group" }, [
        el("div", { class: "search-doc" }, [
          el("span", { class: "search-doc-title" }, group.title),
          group.folder ? el("span", { class: "search-doc-folder" }, group.folder) : null,
          el("span", { class: "search-doc-count" }, `${group.count}×`),
        ]),
        ...hits,
      ]);
    });
    results.replaceChildren(summary, ...groups);
  }

  async function run() {
    const query = input.value.trim();
    const id = ++requestId;
    if (!query) {
      results.replaceChildren(el("div", { class: "search-empty" }, "Type to search."));
      statusEl.textContent = "";
      return;
    }
    const scope = scopeSelect.value;
    if (scope === "document" && !state.currentDocId) {
      results.replaceChildren(el("div", { class: "search-empty" }, "No document is open."));
      return;
    }
    statusEl.textContent = "Searching…";
    try {
      const payload = {
        query,
        scope,
        selection:
          scope === "document"
            ? { folders: [], documents: [state.currentDocId] }
            : null,
        options: { caseSensitive: caseBox.checked, wholeWord: wordBox.checked },
      };
      const result = await api.projects.search(state.project.id, payload);
      if (id !== requestId) return;
      renderResults(result);
      statusEl.textContent = "";
    } catch (err) {
      if (id !== requestId) return;
      statusEl.textContent = "";
      toast(err.message, "error");
    }
  }

  // The fields shared by the preview search and the replace itself.
  function replaceBase() {
    const scope = scopeSelect.value;
    return {
      query: input.value.trim(),
      scope,
      selection:
        scope === "document"
          ? { folders: [], documents: [state.currentDocId] }
          : null,
      options: { caseSensitive: caseBox.checked, wholeWord: wordBox.checked },
    };
  }

  async function replaceAll() {
    const query = input.value.trim();
    if (!query) {
      input.focus();
      return;
    }
    if (scopeSelect.value === "document" && !state.currentDocId) {
      toast("No document is open", "error");
      return;
    }
    statusEl.textContent = "Previewing…";
    try {
      // Make sure the open document's latest text is on disk before the sweep.
      await flushSave();
      const preview = await api.projects.search(state.project.id, replaceBase());
      statusEl.textContent = "";
      if (!preview.totalMatches) {
        toast("Nothing to replace");
        return;
      }
      const docs = preview.documentsMatched;
      const ok = await confirmDialog({
        title: "Replace all?",
        message:
          `Replace ${formatNumber(preview.totalMatches)} occurrence${preview.totalMatches === 1 ? "" : "s"} ` +
          `in ${formatNumber(docs)} document${docs === 1 ? "" : "s"} with “${replaceInput.value}”. ` +
          "Each document is snapshotted first, so a mistake can be undone from History.",
        confirmText: "Replace all",
        danger: false,
      });
      if (!ok) return;
      statusEl.textContent = "Replacing…";
      const result = await api.projects.replace(state.project.id, {
        ...replaceBase(),
        replacement: replaceInput.value,
      });
      statusEl.textContent = "";
      toast(
        `Replaced ${formatNumber(result.totalReplacements)} in ${formatNumber(result.documentsChanged)} document${result.documentsChanged === 1 ? "" : "s"}`
      );
      await refreshAfterReplace(result.results.map((entry) => entry.docId));
      run();
    } catch (err) {
      statusEl.textContent = "";
      toast(err.message, "error");
    }
  }

  const jump = async (docId, hit) => {
    close();
    await openDocument(docId);
    if (!revealText(hit.match, hit.occurrence)) toast("Opened the document");
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(timer);
      run();
    }
  });
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceAll();
    }
  });
  caseBox.addEventListener("change", run);
  wordBox.addEventListener("change", run);
  scopeSelect.addEventListener("change", run);

  const { backdrop, modal, close } = showModal([
    el("h3", {}, "Find & replace"),
    el("div", { class: "search-bar" }, [
      input,
      el("button", { class: "icon-btn primary", onclick: run }, "Search"),
    ]),
    el("div", { class: "search-bar search-replace-bar" }, [
      replaceInput,
      el("button", { class: "icon-btn", onclick: replaceAll }, "Replace all"),
    ]),
    el("div", { class: "search-options" }, [
      el("label", { class: "export-check-label" }, [caseBox, " Case sensitive"]),
      el("label", { class: "export-check-label" }, [wordBox, " Whole word"]),
      el("label", { class: "search-scope-label" }, ["In", scopeSelect]),
    ]),
    results,
    el("div", { class: "modal-actions" }, [
      statusEl,
      el("button", { class: "icon-btn", onclick: () => close() }, "Close"),
    ]),
  ]);
  backdrop.classList.add("search-modal");
  modal.style.maxWidth = "640px";
  input.focus();
  run();
}

/* ---------------- document history (snapshots) ---------------- */

const SNAPSHOT_REASON_LABELS = {
  auto: "Auto",
  manual: "Manual",
  "before-restore": "Before restore",
  ai: "Lain",
  replace: "Before replace",
};

function snapshotReasonLabel(reason) {
  return SNAPSHOT_REASON_LABELS[reason] || reason || "Snapshot";
}

function snapshotWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// The restored body came from disk behind the editor's back: drop just this
// document's warm editor (other warm editors keep their undo) and reload it.
async function afterSnapshotRestore(docId) {
  const pane = paneForDoc(docId);
  if (pane) {
    clearTimeout(pane.timer);
    pane.timer = null;
    pane.ctrl = null;
    editorPool.destroy(docId);
    if (state.activePane === pane.name) state.editorCtrl = null;
  } else {
    editorPool.destroy(docId);
  }
  await refreshTree();
  await refreshWiki();
  updateTopbar();
  if (!pane) return;
  state.activePane = pane.name;
  state.currentDocId = pane.docId;
  if (pane.wiki) state.wikiDocId = pane.docId;
  else state.writeDocId = pane.docId;
  await renderEditorView();
}

// A project-wide replace wrote documents behind the editor cache's back. Drop
// each changed warm editor; reload any changed document that is on screen.
async function refreshAfterReplace(docIds) {
  const changed = new Set(docIds || []);
  if (!changed.size) return;
  for (const id of changed) {
    const pane = paneForDoc(id);
    if (pane) {
      clearTimeout(pane.timer);
      pane.timer = null;
      pane.ctrl = null;
      if (state.activePane === pane.name) state.editorCtrl = null;
    }
    editorPool.destroy(id);
  }
  await refreshTree();
  await refreshWiki();
  updateTopbar();
  if (paneList().some((p) => p.docId && changed.has(p.docId))) {
    await renderEditorView();
  }
}

function renderSnapshotsDialog() {
  const existing = document.querySelector(".modal-backdrop.snapshot-modal");
  if (existing) { existing.remove(); return; }

  const docId = state.currentDocId;
  const list = el("div", { class: "snap-list" });
  const statusEl = el("span", { class: "export-status" });
  const snapshotNow = el("button", { class: "icon-btn primary" }, "Snapshot now");

  function renderList(items) {
    if (!items.length) {
      list.replaceChildren(
        el("div", { class: "snap-empty" }, "No snapshots yet. One is saved automatically as you write.")
      );
      return;
    }
    list.replaceChildren(...items.map((s) =>
      el("div", { class: "snap-item" }, [
        el("div", { class: "snap-info" }, [
          el("span", { class: "snap-when" }, snapshotWhen(s.createdAt)),
          el("span", { class: "snap-meta" },
            `${snapshotReasonLabel(s.reason)} · ${formatNumber(s.words || 0)} words`),
        ]),
        el("span", { class: "snap-actions" }, [
          el("button", { class: "link-btn", onclick: () => preview(s.id) }, "preview"),
          el("button", { class: "link-btn", onclick: () => restore(s) }, "restore"),
          el("button", { class: "link-btn", onclick: () => remove(s) }, "delete"),
        ]),
      ])
    ));
  }

  async function refresh() {
    if (!docId) return;
    statusEl.textContent = "Loading…";
    try {
      const items = await api.snapshots.list(state.project.id, docId);
      statusEl.textContent = "";
      renderList(items);
    } catch (err) {
      statusEl.textContent = "";
      list.replaceChildren(
        el("div", { class: "snap-empty" }, `Couldn't load history: ${err.message}`)
      );
    }
  }

  async function preview(id) {
    statusEl.textContent = "Loading…";
    try {
      const snap = await api.snapshots.get(state.project.id, id, docId);
      statusEl.textContent = "";
      const body = el("pre", { class: "snap-preview" });
      body.textContent = snap.body || "";
      list.replaceChildren(
        el("div", { class: "snap-preview-head" }, [
          el("span", {},
            `${snapshotWhen(snap.meta.createdAt)} · ${snapshotReasonLabel(snap.meta.reason)} · ${formatNumber(snap.meta.words || 0)} words`),
          el("button", { class: "link-btn", onclick: () => refresh() }, "back to list"),
        ]),
        body
      );
    } catch (err) {
      statusEl.textContent = "";
      toast(err.message, "error");
    }
  }

  async function restore(s) {
    const ok = await confirmDialog({
      title: "Restore this snapshot?",
      message: `Replace the current text with the version from ${snapshotWhen(s.createdAt)}. Your current text is snapshotted first, so you can put it back.`,
      confirmText: "Restore",
      danger: false,
    });
    if (!ok) return;
    statusEl.textContent = "Restoring…";
    try {
      await flushSave();
      await api.snapshots.restore(state.project.id, s.id, docId);
      statusEl.textContent = "";
      close();
      await afterSnapshotRestore(docId);
      toast("Snapshot restored");
    } catch (err) {
      statusEl.textContent = "";
      toast(err.message, "error");
    }
  }

  async function remove(s) {
    const ok = await confirmDialog({
      title: "Delete this snapshot?",
      message: "This removes the snapshot for good.",
      confirmText: "Delete",
    });
    if (!ok) return;
    try {
      await api.snapshots.remove(state.project.id, s.id, docId);
      refresh();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  snapshotNow.addEventListener("click", async () => {
    if (!docId) return;
    try {
      await flushSave();
      await api.snapshots.create(state.project.id, docId);
      toast("Snapshot saved");
      refresh();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  const { backdrop, modal, close } = showModal([
    el("h3", {}, "Document history"),
    el("p", { class: "desc" },
      docId
        ? "Snapshots are saved automatically while you write. Restoring keeps your document's title and styling."
        : "Open a document to see its history."),
    el("div", { class: "snap-bar" }, [snapshotNow, statusEl]),
    list,
  ]);
  backdrop.classList.add("snapshot-modal");
  modal.style.maxWidth = "620px";
  if (!docId) {
    snapshotNow.disabled = true;
    list.replaceChildren(
      el("div", { class: "snap-empty" }, "Open a document to see its history.")
    );
    return;
  }
  refresh();
}

/* ---------------- wiki tab ---------------- */

/* ---------------- settings tab ---------------- */

async function renderSettingsTab() {
  const main = document.getElementById("main-content");
  const modeSelect = el(
    "select",
    {},
    [
      ["auto", "Auto (words + CJK characters)"],
      ["words", "Words only"],
      ["chars", "Characters"],
    ].map(([value, label]) => el("option", { value, selected: state.settings.wordCountMode === value }, label))
  );
  modeSelect.addEventListener("change", async () => {
    try {
      state.settings = await api.settings.update({ wordCountMode: modeSelect.value });
      toast("Word counting updated");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  const KEY_MASK = "••••••••••••";
  let aiCfg = {};
  let aiProvider = "deepseek";
  let keyConfigured = false; // true when a real key is stored for the active provider
  try {
    const full = await api.settings.get();
    const ai = full.ai || {};
    aiProvider = ai.provider || "deepseek";
    aiCfg = (ai[aiProvider]) || {};
    keyConfigured = aiCfg.apiKey === KEY_MASK;
  } catch {
    /* ignore */
  }

  const modelSuggestions = {
    deepseek: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    opencode_go: [
      "deepseek-v4-flash", "deepseek-v4-pro", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6",
      "longcat-2.0", "glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5.1", "mimo-v2.5",
      "mimo-v2.5-pro", "hy4-preview", "hy3", "qwen3.8-flash", "qwen3.8-max",
      "qwen3.7-max", "qwen3.7-plus", "minimax-m3", "minimax-m2.7", "grok-4.6",
      "gpt-5.6-luna", "muse-spark-1.2-contributor",
    ],
  };
  const modelDatalist = el("datalist", { id: "ai-model-list" });
  const updateModelDatalist = (prov) => {
    const list = modelSuggestions[prov] || [];
    modelDatalist.replaceChildren(...list.map((m) => el("option", { value: m })));
  };
  const aiProviderSelect = el("select", {},
    Object.entries({
      deepseek: "DeepSeek",
      lmstudio: "LM Studio",
      openai_compatible: "OpenAI Compatible",
      opencode_go: "OpenCode Go",
    }).map(([value, label]) =>
      el("option", { value, selected: aiProvider === value }, label)
    )
  );
  const aiKeyInput = el("input", {
    type: "password",
    value: keyConfigured ? "" : (aiCfg.apiKey || ""),
    placeholder: keyConfigured ? "•••••••••••• (saved)" : "sk-…",
  });
  const clearKeyBtn = el("button", {
    class: "link-btn",
    type: "button",
    title: "Forget the saved API key for this provider",
    hidden: !keyConfigured,
    onclick: () => {
      aiKeyInput.value = "";
      keyConfigured = false;
      aiKeyInput.placeholder = "sk-…";
      clearKeyBtn.hidden = true;
    },
  }, "clear saved key");
  const aiModelInput = el("input", {
    type: "text",
    list: "ai-model-list",
    value: aiCfg.model || "",
    placeholder: "e.g. deepseek-v4-flash",
  });
  const aiBaseInput = el("input", { type: "text", value: aiCfg.baseUrl || "", placeholder: "https://api.deepseek.com" });
  const aiMaxIterInput = el("input", {
    type: "number",
    min: 1,
    max: 200,
    value: aiCfg.maxIterations || "",
    placeholder: "20",
  });
  const aiTestStatus = el("span", { id: "ai-test-status", class: "chip" });

  function readAiConfig() {
    const prov = aiProviderSelect.value;
    const m = parseInt(aiMaxIterInput.value, 10);
    return {
      provider: prov,
      apiKey: aiKeyInput.value.trim(),
      model: aiModelInput.value.trim(),
      baseUrl: aiBaseInput.value.trim(),
      maxIterations: Number.isFinite(m) && m > 0 ? m : undefined,
    };
  }

  function updateAiPlaceholders(prov) {
    const defaults = {
      deepseek: { key: "sk-…", model: "e.g. deepseek-v4-flash", base: "https://api.deepseek.com", iter: "20" },
      lmstudio: { key: "any value (LM Studio ignores auth)", model: "e.g. meta-llama-3.1-8b-instruct", base: "http://localhost:1234/v1", iter: "50" },
      openai_compatible: { key: "sk-…", model: "e.g. gpt-4o", base: "", iter: "50" },
      opencode_go: { key: "sk-…", model: "e.g. deepseek-v4-flash", base: "https://opencode.ai/zen/go/v1", iter: "20" },
    };
    const d = defaults[prov] || defaults.openai_compatible;
    aiKeyInput.placeholder = d.key;
    aiModelInput.placeholder = d.model;
    aiBaseInput.placeholder = d.base;
    aiMaxIterInput.placeholder = d.iter;
  }

  aiProviderSelect.addEventListener("change", async () => {
    const prov = aiProviderSelect.value;
    updateAiPlaceholders(prov);
    updateModelDatalist(prov);
    try {
      const full = await api.settings.get();
      const cfg = (full.ai && full.ai[prov]) || {};
      const stored = cfg.apiKey === KEY_MASK;
      aiKeyInput.value = stored ? "" : (cfg.apiKey || "");
      if (stored) aiKeyInput.placeholder = "•••••••••••• (saved)";
      keyConfigured = stored;
      clearKeyBtn.hidden = !stored;
      aiModelInput.value = cfg.model || "";
      aiBaseInput.value = cfg.baseUrl || "";
      aiMaxIterInput.value = cfg.maxIterations || "";
    } catch {
      /* ignore */
    }
  });
  updateAiPlaceholders(aiProvider);
  updateModelDatalist(aiProvider);

  const saveAiSettings = async () => {
    try {
      const cfg = readAiConfig();
      const value = cfg.apiKey;
      const providerCfg = {
        model: cfg.model || undefined,
        baseUrl: cfg.baseUrl || undefined,
      };
      if (value !== "") {
        providerCfg.apiKey = value; // set or replace
      } else if (!keyConfigured) {
        providerCfg.apiKey = ""; // nothing stored — explicit no-op
      }
      // empty + keyConfigured: omit apiKey so the server keeps the stored key
      if (cfg.maxIterations !== undefined) {
        providerCfg.maxIterations = cfg.maxIterations;
      }
      const payload = {
        ai: {
          provider: cfg.provider,
          [cfg.provider]: providerCfg,
        },
      };
      // Carry forward other providers' config so they aren't wiped
      const full = await api.settings.get();
      const existingAi = full.ai || {};
      for (const [k, v] of Object.entries(existingAi)) {
        if (k !== "provider" && k !== cfg.provider && v && typeof v === "object") {
          payload.ai[k] = v;
        }
      }
      await api.settings.update(payload);
      toast("AI settings saved");
      if (lainCtrl) lainCtrl.refresh();
    } catch (err) {
      toast(err.message, "error");
    }
  };
  const testAiConnection = async () => {
    aiTestStatus.textContent = "Testing…";
    try {
      const r = await api.ai.test();
      aiTestStatus.textContent = `OK · ${r.reply || "connected"}`;
      toast("Connection OK");
    } catch (err) {
      aiTestStatus.textContent = "Failed";
      toast(err.message, "error");
    }
  };

  const renameInput = el("input", { type: "text", value: state.project.title });
  const goalNum = el("input", {
    type: "number",
    min: 1,
    value: state.project.goal.wordsPerDay,
  });
  const goalToggle = el("button", {
    class: `switch ${state.project.goal.enabled ? "on" : ""}`,
  });

  const formatBytes = (n) => {
    if (!Number.isFinite(n)) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${(v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1))} ${units[i]}`;
  };
  const backupsList = el("ul", { class: "backup-list" });
  const backupStatus = el("span", { class: "chip" });
  const refreshBackups = async () => {
    try {
      const items = await api.backups.list();
      backupsList.replaceChildren(...items.map((b) =>
        el("li", { class: "backup-item" }, [
          el("span", { class: "backup-name" }, b.name),
          el("span", { class: "backup-meta" },
            `${formatBytes(b.size)}${b.created ? ` · ${b.created.replace("T", " ").slice(0, 19)}` : ""}`),
          el("button", {
            class: "link-btn",
            onclick: async () => {
              const ok = await confirmDialog({
                title: "Delete this backup?",
                message: `Remove ${b.name}? This cannot be undone.`,
                confirmText: "Delete",
              });
              if (!ok) return;
              try {
                await api.backups.remove(b.name);
                toast("Backup deleted");
                refreshBackups();
              } catch (err) {
                toast(err.message, "error");
              }
            },
          }, "delete"),
        ])
      ));
      backupStatus.hidden = items.length === 0;
      backupStatus.textContent = items.length
        ? `${items.length} saved (the ${items.length === 1 ? "newest is" : "10 newest are"} kept)`
        : "No backups yet";
    } catch (err) {
      backupsList.replaceChildren(
        el("li", { class: "backup-item backup-meta" }, `Couldn't load backups: ${err.message}`)
      );
    }
  };
  const runBackup = async () => {
    try {
      backupStatus.textContent = "Creating…";
      const r = await api.backups.create();
      toast(`Backup saved (${formatBytes(r.size)})`);
      refreshBackups();
    } catch (err) {
      backupStatus.textContent = "Failed";
      toast(err.message, "error");
    }
  };

  const trashList = el("ul", { class: "backup-list trash-list" });
  const trashStatus = el("span", { class: "chip" });
  const refreshTrash = async () => {
    try {
      const items = await api.trash.list(state.project.id);
      trashList.replaceChildren(...items.map((t) =>
        el("li", { class: "backup-item" }, [
          el("span", { class: "backup-name" }, t.name),
          el("span", { class: "backup-meta" },
            `${t.kind === "folder" ? "Folder" : "Document"}${t.deletedAt ? ` · ${t.deletedAt.replace("T", " ").slice(0, 19)}` : ""}`),
          el("span", { class: "trash-actions" }, [
            el("button", {
              class: "link-btn",
              onclick: async () => {
                try {
                  const r = await api.trash.restore(state.project.id, t.id);
                  await afterTreeChange();
                  await refreshWiki();
                  updateTopbar();
                  refreshTrash();
                  toast(r.renamed ? `Restored as "${r.name}" (renamed to avoid a clash)` : `Restored "${r.name}"`);
                } catch (err) {
                  toast(err.message, "error");
                }
              },
            }, "restore"),
            el("button", {
              class: "link-btn",
              onclick: async () => {
                const ok = await confirmDialog({
                  title: `Permanently delete "${t.name}"?`,
                  message: "This removes it from the Trash for good. This cannot be undone.",
                  confirmText: "Delete",
                });
                if (!ok) return;
                try {
                  await api.trash.remove(state.project.id, t.id);
                  refreshTrash();
                  toast("Deleted");
                } catch (err) {
                  toast(err.message, "error");
                }
              },
            }, "delete"),
          ]),
        ])
      ));
      trashStatus.hidden = items.length === 0;
      trashStatus.textContent = items.length
        ? `${items.length} item${items.length === 1 ? "" : "s"}`
        : "Trash is empty";
    } catch (err) {
      trashList.replaceChildren(
        el("li", { class: "backup-item backup-meta" }, `Couldn't load Trash: ${err.message}`)
      );
    }
  };

  main.replaceChildren(
    el("div", { class: "settings-view" }, [
      el("div", { class: "settings-section" }, [
        el("h2", {}, "Project"),
        el("div", { class: "field-row" }, [
          el("label", {}, "Project title"),
          renameInput,
        ]),
        el("div", { class: "modal-actions" }, [
          el("button", {
            class: "icon-btn primary",
            onclick: async () => {
              try {
                state.project = await api.projects.rename(state.project.id, renameInput.value.trim() || state.project.title);
                document.getElementById("tb-title").textContent = state.project.title;
                toast("Renamed");
              } catch (err) {
                toast(err.message, "error");
              }
            },
          }, "Rename project"),
        ]),
      ]),
      el("div", { class: "settings-section" }, [
        el("h2", {}, "Daily goal"),
        el("p", { class: "desc" }, "Set how many words you want to write each day to track streaks."),
        el("div", { class: "field-row" }, [
          el("label", {}, "Enabled"),
          goalToggle,
        ]),
        el("div", { class: "goal-row" }, [
          goalNum,
          el("span", {}, "words per day"),
        ]),
        el("div", { class: "modal-actions" }, [
          el("button", {
            class: "icon-btn primary",
            onclick: async () => {
              try {
                state.project = await api.projects.setGoal(
                  state.project.id,
                  parseInt(goalNum.value, 10) || 500,
                  goalToggle.classList.contains("on")
                );
                toast("Goal saved");
                updateTopbar();
              } catch (err) {
                toast(err.message, "error");
              }
            },
          }, "Save goal"),
        ]),
      ]),
      el("div", { class: "settings-section" }, [
        el("h2", {}, "Appearance"),
        el("div", { class: "field-row" }, [
          el("label", {}, "Theme"),
          theme.themeSelect(),
        ]),
        el("div", { class: "field-row" }, [
          el("label", {}, "Word counting"),
          modeSelect,
        ]),
      ]),
      el("div", { class: "settings-section" }, [
        el("h2", {}, "Editor defaults"),
        el("p", { class: "desc" }, "Global default font, size, and alignment for all documents, plus a zoom per tab — font, size and alignment are shared, zoom is not, because a wiki entry is a reference page rather than prose. Each document and section can override these from the editor toolbar."),
        el("div", { class: "field-row" }, [
          el("label", {}, "Font"),
          fontSelect("global"),
        ]),
        el("div", { class: "field-row" }, [
          el("label", {}, "Font size"),
          sizeSelect("global"),
        ]),
        el("div", { class: "field-row" }, [
          el("label", {}, "Alignment"),
          alignGroup("global"),
        ]),
        el("div", { class: "field-row" }, [
          el("label", {}, "Write tab zoom"),
          zoomSelect("global", "write"),
        ]),
        el("div", { class: "field-row" }, [
          el("label", {}, "Wiki tab zoom"),
          zoomSelect("global", "wiki"),
        ]),
      ]),
      el("div", { class: "settings-section" }, [
        el("h2", {}, "AI assistant (Lain)"),
        el("p", { class: "desc" }, "Connect a provider so Lain can organize and maintain your lore from the sidebar chat. OpenCode Go, DeepSeek, LM Studio, or any OpenAI-compatible endpoint. Your key stays stored locally and is never shown back to the page."),
        el("div", { class: "field-row" }, [
          el("label", {}, "Provider"),
          aiProviderSelect,
        ]),
        el("div", { class: "field-row" }, [
          el("label", {}, "API key"),
          aiKeyInput,
          clearKeyBtn,
        ]),
        el("div", { class: "field-row" }, [
          el("label", {}, "Model"),
          aiModelInput,
          modelDatalist,
        ]),
        el("div", { class: "field-row" }, [
          el("label", {}, "Base URL"),
          aiBaseInput,
        ]),
        el("div", { class: "field-row" }, [
          el("label", {}, "Max iterations"),
          aiMaxIterInput,
        ]),
        el("div", { class: "modal-actions" }, [
          el("button", { class: "icon-btn primary", onclick: saveAiSettings }, "Save AI settings"),
          el("button", { class: "icon-btn", onclick: testAiConnection }, "Test connection"),
          aiTestStatus,
        ]),
      ]),
      el("div", { class: "settings-section" }, [
        el("h2", {}, "Export & backup"),
        el("p", { class: "desc" }, "Export this project as zip, docx, pdf, or epub — or back up your whole library: every project, settings, stats, and chat history, saved as a timestamped zip next to your data folder (the 10 newest backups are kept)."),
        el("div", { class: "modal-actions" }, [
          el("button", { class: "icon-btn primary", onclick: () => renderExportDialog(state.project.id) }, "Export project…"),
          el("button", { class: "icon-btn", onclick: runBackup }, "Back up everything now"),
          backupStatus,
        ]),
        backupsList,
      ]),
      el("div", { class: "settings-section" }, [
        el("h2", {}, "Trash"),
        el("p", { class: "desc" }, "Deleted chapters, notes, wiki entries, and folders wait here instead of being erased. Restoring puts an entry back where it was."),
        trashList,
        el("div", { class: "modal-actions" }, [
          el("button", {
            class: "icon-btn",
            onclick: async () => {
              const ok = await confirmDialog({
                title: "Empty Trash?",
                message: "Permanently delete everything in the Trash. This cannot be undone.",
                confirmText: "Empty Trash",
              });
              if (!ok) return;
              try {
                await api.trash.empty(state.project.id);
                refreshTrash();
                toast("Trash emptied");
              } catch (err) {
                toast(err.message, "error");
              }
            },
          }, "Empty Trash"),
          trashStatus,
        ]),
      ]),
      el("div", { class: "settings-section" }, [
        el("h2", {}, "Danger zone"),
        el("p", { class: "desc" }, "Permanently remove this project and all of its files."),
        el("div", { class: "modal-actions" }, [
          el("button", {
            class: "icon-btn danger",
            onclick: async () => {
              const ok = await confirmDialog({
                title: `Delete "${state.project.title}"?`,
                message: "This removes the project folder. This cannot be undone.",
                confirmText: "Delete",
              });
              if (!ok) return;
              try {
                await api.projects.remove(state.project.id);
                router.navigate("library");
              } catch (err) {
                toast(err.message, "error");
              }
            },
          }, "Delete project"),
        ]),
      ]),
    ])
  );
  refreshBackups();
  refreshTrash();
}

/* ---------------- tab switching ---------------- */

async function switchTab(tab) {
  console.warn("[diag] switchTab start", tab, { _switching, _creating, _opening });
  if (_creating) _creating = false;
  if (_switching) _switching = false;
  _switching = true;
  const main = document.getElementById("main-content");
  if (main) main.style.opacity = "0";
  try {
  // Leaving a tab drops its search, so arriving there always shows the full
  // tree rather than a stale filter hiding documents.
  if (tab !== "wiki") state.wikiQuery = "";
  if (tab !== "write") state.writeQuery = "";
  if (tab === "write" || tab === "wiki") {
    await flushSave();
    const wiki = tab === "wiki";
    state.currentTab = tab;
    setActiveTab(tab);
    state.currentDocId = wiki ? state.wikiDocId : state.writeDocId;
    if (wiki) await loadWikiData();
    if (!state.currentDocId) {
      const f = firstDoc();
      if (f) {
        state.currentDocId = f.id;
        if (wiki) state.wikiDocId = f.id;
        else state.writeDocId = f.id;
      }
    }
    // Make sure the target is a tab (and the sidebar's Recent list current)
    // before the sidebar render below.
    if (state.currentDocId) {
      docTabs.open(state.currentDocId);
      persistTabs();
    }
    renderSidebar();
    const doc = state.currentDocId
      ? await api.docs.get(state.project.id, state.currentDocId)
      : null;
    await renderEditorTab(doc, { wiki, pane: "primary" });
    return;
  }
  await flushSave();
  state.currentTab = tab;
  setActiveTab(tab);
  // Keep the document's editor cached so its undo history survives a detour
  // through Settings or Stats.
  parkEditor();
  if (tab === "stats") await renderStatsTab();
  else if (tab === "settings") await renderSettingsTab();
  if (main) main.classList.remove("no-scroll");
  } catch (err) {
    console.warn("switchTab failed", tab, err);
  } finally {
    if (main) requestAnimationFrame(() => { main.style.opacity = "1"; });
    _switching = false;
  }
}

function setActiveTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
}

/* ---------------- render shell ---------------- */

function renderSidebar({ keepScroll = false } = {}) {
  const bar = document.querySelector(".sidebar");
  if (bar) renderTree(bar, { keepScroll });
}

async function init(params) {
  // A fresh project route starts with no warm editors from a previous project.
  resetEditorPool();
  // Tabs belong to the project just left; restoreTabs() refills from storage
  // once the new tree is known.
  docTabs.restore({ tabs: [], active: null, recent: [] });
  state.currentDocId = null;
  state.writeDocId = null;
  state.wikiDocId = null;
  state.activePane = "primary";
  state.split = false;
  // A fresh project starts with unfiltered sidebars.
  state.wikiQuery = "";
  state.writeQuery = "";
  try {
    const settings = await api.settings.get();
    state.settings = {
      wordCountMode: settings.wordCountMode || "auto",
      autosaveMs: settings.autosaveMs || 800,
      editorFont: settings.editorFont || "serif",
      editorSize: settings.editorSize || 18,
      editorAlign: settings.editorAlign || "left",
      editorZoom: settings.editorZoom || DEFAULT_ZOOM,
      wikiZoom: settings.wikiZoom || DEFAULT_WIKI_ZOOM,
      grammarEnabled: settings.grammarEnabled !== false,
    };
  } catch (err) {
    console.warn("settings unavailable", err);
  }
  applyEditorPrefs();

  try {
    state.project = await api.projects.get(params.id);
    state.tree = await api.projects.tree(params.id, "write");
    state.wikiTree = await api.projects.tree(params.id, "wiki");
    try {
      state.dictionary = await api.projects.dictionary.get(params.id);
    } catch {
      state.dictionary = { words: [] };
    }
  } catch (err) {
    const root = document.getElementById("app");
    root.replaceChildren(
      el("div", { class: "empty-state" }, [
        el("h2", {}, "Project not found"),
        el("p", {}, err.message),
        el("button", { class: "icon-btn primary", onclick: () => router.navigate("library") }, "Back to projects"),
      ])
    );
    return;
  }

  const root = document.getElementById("app");
  const sb = sidebar();
  const main = el("div", { class: "main" }, [
    el("div", { id: "main-content", class: "main-scroll" }),
  ]);
  const ws = el("div", { class: "workspace" }, [sb, main]);
  lainCtrl = lain.mount(ws, {
    projectId: () => state.project.id,
    currentDocId: () => state.currentDocId,
    onActions: onLainActions,
    goSettings: () => switchTab("settings"),
  });
  root.replaceChildren(topbar(), ws);
  expandAll(state.tree, state.expanded);
  expandAll(state.wikiTree, state.wikiExpanded);
  restoreTabs();
  renderSidebar();

  await Promise.all([refreshWiki(), updateTopbar()]);

  if (_beforeUnload) window.removeEventListener("beforeunload", _beforeUnload);
  _beforeUnload = () => {
    for (const pane of paneList()) {
      if (!pane.dirty || !pane.ctrl || !pane.docId) continue;
      const md = pane.ctrl.getMarkdown();
      if (!md) continue;
      fetch(`/api/projects/${encodePath(state.project.id)}/documents/${encodePath(pane.docId)}`, {
        method: "PUT",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: md }),
      });
    }
  };
  window.addEventListener("beforeunload", _beforeUnload);

  const start = docTabs.active || (firstDoc() ? firstDoc().id : null);
  if (start) {
    openDocument(start);
  } else {
    switchTab("write");
  }
}

export function register() {
  setupFileDropGuard();
  router.on("project", init);
  // Ctrl/Cmd+F (and Ctrl/Cmd+Shift+F) opens the Find & replace dialog.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "F" || e.key === "f")) {
      if (!state.project) return;
      e.preventDefault();
      renderSearchDialog();
    }
  });
  // Tab shortcuts: Ctrl+W closes, Ctrl+Tab / Ctrl+Shift+Tab cycle, Ctrl+1..9
  // jump, Ctrl+\ toggles the split pane. Only while a project is open.
  document.addEventListener("keydown", (e) => {
    if (!state.project || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === "\\") {
      e.preventDefault();
      toggleSplit();
      return;
    }
    if (e.key === "w" || e.key === "W") {
      if (!state.currentDocId) return;
      e.preventDefault();
      closeDocumentTab(state.currentDocId);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      cycleTabs(e.shiftKey ? -1 : 1);
      return;
    }
    if (/^[1-9]$/.test(e.key)) {
      const target = docTabs.tabs[Number(e.key) - 1];
      if (!target) return;
      e.preventDefault();
      if (target !== state.currentDocId) openDocument(target);
    }
  });
}
