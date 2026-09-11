import { api, encodePath } from "./api.js";
import { renderExportDialog } from "./export-dialog.js";
import { renderRepetitionDialog } from "./repetition-dialog.js";
import { renderDictionaryDialog } from "./dictionary-dialog.js";
import { renderSnapshotsDialog } from "./snapshots-dialog.js";
import { renderSearchDialog } from "./search-dialog.js";
import * as router from "./router.js";
import * as theme from "./themes.js";
import * as lain from "./lain.js";
import { FONTS, CUSTOM_ID, fontStack } from "./fonts.js";
import { filterTree } from "./tree-search.js";
import {
  state,
  panes,
  paneList,
  activePane,
  editorPool,
  docTabs,
  allDocs,
  findDocAny,
  docTitleAny,
  registerShell,
} from "./project-context.js";
import * as workspace from "./editor-workspace.js";
import {
  collectTree,
  findDocIn,
  resolveDocByTitle as resolveDocByTitleIn,
  prettyPath,
  folderNodeIn,
  countDocs,
  folderContainsDoc,
  firstDocIn,
  expandAll,
} from "./doc-tree.js";
import {
  zoomKey,
  defaultZoomForScope as resolveDefaultZoom,
  effectiveFont as resolveFont,
  effectiveSize as resolveSize,
  effectiveAlign as resolveAlign,
  effectiveZoom as resolveZoom,
} from "./editor-prefs.js";
import { ASSET_ACCEPT, MAX_IMAGE_BYTES, isImageFile } from "./image-utils.js";
import { DEFAULT_WIKI_ZOOM, DEFAULT_ZOOM, ZOOM_PRESETS, zoomFactor } from "./zoom.js";
import { keepScrollTop } from "./scroll-keep.js";
import { TEXT_COLORS } from "./text-colors.js";
import {
  el,
  toast,
  promptDialog,
  confirmDialog,
  showModal,
  countWords,
  formatNumber,
} from "./ui.js";

// The workspace owns the editing surface, but the shell still calls into it by
// name (openDocument, flushSave, renderEditorView, …), so bind those locally.
const {
  openDocument,
  closeDocumentTab,
  cycleTabs,
  toggleSplit,
  openInSplit,
  renderEditorTab,
  renderEditorView,
  renderDocTabs,
  recentSection,
  applyDictionaryWords,
  invalidateEditorCache,
  dropTab,
  dropEditorFor,
  resetEditorPool,
  restoreTabs,
  persistTabs,
  reconcileTabs,
  revealText,
  markActiveDirty,
  parkEditor,
  flushSave,
  updateTreeWords,
  afterSnapshotRestore,
  refreshAfterReplace,
  startComment,
} = workspace;

// Folders the current sidebar search render must show expanded. Display-only:
// searching never edits state.expanded / state.wikiExpanded.
let _treeSearchOpen = new Set();

let lainCtrl = null;
let _creating = false;

let _switching = false;
let _beforeUnload = null;

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

// The pure tree helpers live in doc-tree.js; these thin wrappers bind them to
// the current scope's trees and document-title lookups.
function resolveDocByTitle(title) {
  return resolveDocByTitleIn(allDocs(), title);
}

function docTitle(docId) {
  const d = findDocIn(activeTree(), docId);
  return d ? d.title : null;
}

function folderNode(folderId) {
  return folderNodeIn(activeTree(), folderId, rootFolderId());
}

function firstDoc() {
  return firstDocIn(activeTree());
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

// The resolution rules are pure and live in editor-prefs.js; these wrappers
// feed them the current document's style and the user's settings.
function effectiveFont() {
  return resolveFont(docStyle(), state.settings);
}

function effectiveSize() {
  return resolveSize(docStyle(), state.settings);
}

function effectiveAlign() {
  return resolveAlign(docStyle(), state.settings);
}

function effectiveZoom() {
  return resolveZoom(docStyle(), state.settings, isWikiScope());
}

function defaultZoomForScope(wiki = isWikiScope()) {
  return resolveDefaultZoom(state.settings, wiki);
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
  { cmd: "highlight", label: "▮", title: "Highlight" },
  { cmd: "color", label: "A", title: "Text color" },
  { cmd: "subscript", label: "A₂", title: "Subscript" },
  { cmd: "superscript", label: "A²", title: "Superscript" },
  null,
  { cmd: "blockquote", label: "❝", title: "Blockquote" },
  { cmd: "bulletList", label: "• List", title: "Bullet list" },
  { cmd: "orderedList", label: "1. List", title: "Ordered list" },
  { cmd: "taskList", label: "☑", title: "Task list (checkboxes)" },
  { cmd: "codeBlock", label: "</>", title: "Code block" },
  { cmd: "table", label: "▦", title: "Insert a table (3×3 with a header row)" },
  null,
  { cmd: "linkNote", label: "[[  ]]", title: "Link to a note" },
  { cmd: "comment", label: "💬", title: "Comment on the selected text (Ctrl+Alt+M)" },
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
    onclick: () => renderDictionaryDialog({
      projectId: state.project.id,
      words: [...(state.dictionary.words || [])],
      onChanged: applyDictionaryWords,
    }),
  }, "Dict");
  return btn;
}

function repetitionBtn() {
  const btn = el("button", {
    class: "tool-btn",
    title: "Repetition check — overused words, echoes, repeated sentences",
    onclick: () => renderRepetitionDialog({ projectId: state.project.id, openDocument, revealText }),
  }, "Repeat");
  return btn;
}

function searchBtn() {
  const btn = el("button", {
    class: "tool-btn",
    title: "Find & replace across documents (Ctrl+F)",
    onclick: () => openFindReplace(),
  }, "Find");
  return btn;
}

// The find dialog needs a few shell capabilities (flush before replacing,
// reload changed documents, open-and-select a hit). Bundle them once so the
// toolbar button and the Ctrl+F shortcut stay in step.
function openFindReplace() {
  renderSearchDialog({
    projectId: state.project.id,
    currentDocId: () => state.currentDocId,
    flushSave,
    refreshAfterReplace,
    openDocument,
    revealText,
  });
}

function historyBtn() {
  return el("button", {
    class: "tool-btn",
    title: "Document history — snapshots and restore",
    onclick: () => renderSnapshotsDialog({
      projectId: state.project.id,
      currentDocId: state.currentDocId,
      flushSave,
      afterSnapshotRestore,
    }),
  }, "History");
}

function toolbar(wiki) {
  closeColorMenu();
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
      onclick: (e) => toolbarCommand(def.cmd, e.currentTarget),
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

function toolbarCommand(cmd, button) {
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
  if (cmd === "comment") {
    startComment();
    return;
  }
  if (cmd === "color") {
    openColorMenu(button);
    return;
  }
  if (state.editorCtrl) state.editorCtrl.run(cmd);
}

let colorMenu = null;

function closeColorMenu() {
  if (colorMenu) {
    colorMenu.remove();
    colorMenu = null;
  }
}

// A small palette under the color button, using the same swatches as the slash
// menu (static/js/text-colors.js) so the two never drift.
function openColorMenu(anchor) {
  const sameAnchor = !!colorMenu && colorMenu._anchor === anchor;
  closeColorMenu();
  if (sameAnchor || !anchor) return;

  const pop = el("div", { class: "color-popover" });
  for (const color of TEXT_COLORS) {
    pop.append(
      el("button", {
        class: `color-swatch${color.value ? "" : " color-swatch-default"}`,
        title: color.label,
        style: color.value ? { background: color.value } : {},
        onclick: (e) => {
          e.stopPropagation();
          if (state.editorCtrl) state.editorCtrl.setTextColor(color.value);
          closeColorMenu();
          refreshToolbar();
        },
      })
    );
  }
  document.body.append(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.left = `${Math.round(rect.left)}px`;
  pop.style.top = `${Math.round(rect.bottom + 6)}px`;
  pop._anchor = anchor;
  colorMenu = pop;

  const onOutside = (event) => {
    if (pop.contains(event.target) || (anchor && anchor.contains(event.target))) return;
    closeColorMenu();
    document.removeEventListener("mousedown", onOutside, true);
  };
  setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
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
    else if (cmd === "highlight") active = editor.isActive("highlight");
    else if (cmd === "subscript") active = editor.isActive("subscript");
    else if (cmd === "superscript") active = editor.isActive("superscript");
    else if (cmd === "color") active = editor.isActive("textColor");
    else if (cmd === "blockquote") active = editor.isActive("blockquote");
    else if (cmd === "bulletList") active = editor.isActive("bulletList");
    else if (cmd === "orderedList") active = editor.isActive("orderedList");
    else if (cmd === "taskList") active = editor.isActive("taskList");
    else if (cmd === "codeBlock") active = editor.isActive("codeBlock");
    else if (cmd === "h1") active = editor.isActive("heading", { level: 1 });
    else if (cmd === "h2") active = editor.isActive("heading", { level: 2 });
    else if (cmd === "h3") active = editor.isActive("heading", { level: 3 });
    btn.classList.toggle("active", active);
  }
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
  console.warn("[diag] switchTab start", tab, { _switching, _creating });
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

// Hand the workspace the shell services it calls back into. Runs at module
// load; the workspace only reads `shell` when a document is opened, so this is
// early enough.
registerShell({
  setActiveTab,
  renderSidebar,
  refreshToolbar,
  refreshEditorContext,
  updateTargetIndicator,
  syncEditorControls,
  renameCurrentDoc,
  deleteCurrentDoc,
  createMissingNote,
  showContextMenu,
  onWikilinkClick,
  uploadImageFile,
  showImageOverlay,
  pickImageFiles,
  toolbar,
  applyDocStyle,
  scheduleWikiRefresh,
  updateTopbar,
  refreshTree,
  refreshWiki,
});

export function register() {
  setupFileDropGuard();
  router.on("project", init);
  // Ctrl/Cmd+F (and Ctrl/Cmd+Shift+F) opens the Find & replace dialog.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "F" || e.key === "f")) {
      if (!state.project) return;
      e.preventDefault();
      openFindReplace();
    }
  });
  // Ctrl/Cmd+Alt+M comments on the selected text.
  document.addEventListener("keydown", (e) => {
    if (!state.project) return;
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "m" || e.key === "M")) {
      e.preventDefault();
      startComment();
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
