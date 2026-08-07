import { api, encodePath, triggerDownload } from "./api.js";
import * as router from "./router.js";
import * as theme from "./themes.js";
import * as lain from "./lain.js";
import { FONTS, CUSTOM_ID, fontStack } from "./fonts.js";
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
  editorCtrl: null,
  dirty: false,
  saving: false,
  saveTimer: null,
  wikiTimer: null,
  expanded: new Set(),
  wikiExpanded: new Set(),
  docStyle: {},
  currentSection: null,
  selectionActive: false,
  dictionary: { words: [] },
};

let lainCtrl = null;

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

function findDoc(docId) {
  const d = collectTree(activeTree()).find((x) => x.id === docId);
  if (!d) return null;
  return { id: d.id, title: d.title, kind: d.kind };
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
  root.style.setProperty("--editor-zoom", String((state.settings.editorZoom || 100) / 100));
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
  return docStyle().zoom || state.settings.editorZoom;
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
  const host = document.querySelector(".editor-host");
  if (host) {
    host.style.setProperty("--editor-font", fontStack(effectiveFont()));
    host.style.setProperty("--editor-size", `${effectiveSize()}px`);
    host.style.setProperty("--editor-align", effectiveAlign());
    host.style.setProperty("--editor-zoom", String(effectiveZoom() / 100));
  }
  if (state.editorCtrl) {
    const map = {};
    for (const [name, ov] of Object.entries(sectionOverrides())) {
      const font = ov.font || effectiveFont();
      const size = ov.size || effectiveSize();
      const align = ov.align || effectiveAlign();
      map[name] = `font-family:${fontStack(font)};font-size:${size}px;text-align:${align};`;
    }
    state.editorCtrl.setSectionStyles(map);
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
    sel.value = String(currentZoom());
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
  state.dirty = true;
  setSaveStatus("pending", "Unsaved changes");
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
  state.dirty = true;
  setSaveStatus("pending", "Unsaved changes");
  syncEditorControls();
}

const ZOOM_PRESETS = [75, 90, 100, 110, 125, 150, 200];

function zoomSelect(target) {
  const sel = el("select", { class: "toolbar-control size editor-control-zoom", title: "Zoom" }, [
    ...ZOOM_PRESETS.map((n) => el("option", { value: String(n) }, `${n}%`)),
  ]);
  sel.value = String(target === "global" ? state.settings.editorZoom || 100 : currentZoom());
  sel.addEventListener("change", async () => {
    const zoom = parseInt(sel.value, 10);
    if (!Number.isFinite(zoom)) return;
    if (target === "global") {
      state.settings = await api.settings.update({ editorZoom: zoom });
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
            state.dirty = true;
            setSaveStatus("pending", "Unsaved changes");
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
      state.dirty = true;
      setSaveStatus("pending", "Unsaved changes");
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

function scheduleWikiRefresh() {
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

async function updateTopbar() {
  document.getElementById("tb-title").textContent = state.project.title;
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
    scroll
  );
  sidebarEl._scroll = scroll;
  setupRootDrop(scroll);
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

function renderTree(scrollEl) {
  const wiki = isWikiScope();
  const tree = activeTree() || { folders: [], documents: [] };
  const frag = document.createDocumentFragment();
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
  const root = { folders: tree.folders, documents: tree.documents, entries: tree.entries };
  if (tree.folders.length === 0 && tree.documents.length === 0) {
    frag.append(
      el("div", { class: "empty-hint" }, wiki ? "Create a folder or lore entry to begin." : "Create a folder, chapter, or note to begin.")
    );
  } else {
    frag.append(renderLevel(root, wiki ? "worldbuilding" : ""));
  }
  scrollEl.replaceChildren(frag);
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
  const expanded = (wiki ? state.wikiExpanded : state.expanded).has(folder.id);
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
  const node = el(
    "div",
    {
      class: `tree-item ${state.currentDocId === doc.id ? "active" : ""}`,
      dataset: { docid: doc.id, folder: folderId, kind: doc.kind },
      title: prettyPath(doc),
      draggable: "true",
      onclick: (e) => {
        if (e.target.closest(".grip")) return;
        openDocument(doc.id);
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
  const prevTitle = docTitle(state.currentDocId);
  await refreshTree();
  if (prevTitle) {
    const match = [...collectTree(state.tree), ...collectTree(state.wikiTree)].find(
      (d) => d.title === prevTitle
    );
    if (match) state.currentDocId = match.id;
  }
  renderSidebar();
}

async function performReorder(folderId, ids) {
  try {
    const res = await api.docs.reorder(state.project.id, ids, folderId);
    if (res && res.renamed) remapExpanded(res.renamed);
    await afterTreeChange();
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
    toast("Folder moved");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function onLainActions(actions) {
  if (!actions || !actions.length) return;
  const prevTitle = state.currentDocId ? docTitle(state.currentDocId) : null;
  await refreshTree();
  await refreshWiki();
  if (prevTitle) {
    const match = [...collectTree(state.tree), ...collectTree(state.wikiTree)].find(
      (d) => d.title === prevTitle
    );
    if (match) state.currentDocId = match.id;
  }
  const current = state.currentDocId;
  const touched = actions.some((a) => a.id && (a.id === current || (current || "").startsWith(a.id + "/")));
  renderSidebar();
  if (lainCtrl) lainCtrl.refreshScope();
  if (!current || !touched) return;
  await flushSave();
  try {
    const doc = await api.docs.get(state.project.id, current);
    renderEditorTab(doc, { wiki: isWikiScope() });
  } catch {
    state.currentDocId = null;
    const f = firstDoc();
    if (f) openDocument(f.id);
    else renderEditorTab(null, { wiki: isWikiScope() });
  }
}

/* ---------------- document actions ---------------- */

async function newDocument(kind, folder) {
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
  try {
    const doc = await api.docs.create(state.project.id, {
      title: title.trim(),
      kind,
      folder: folder || null,
    });
    await flushSave();
    await afterTreeChange();
    await refreshWiki();
    switchTab("write");
    openDocument(doc.id);
  } catch (err) {
    toast(err.message, "error");
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

function pickTemplate() {
  return new Promise(async (resolve) => {
    await loadTemplates();
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
      el("button", { class: "icon-btn", onclick: close }, "Done"),
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
  const { modal, close } = showModalFromUI([
    el("h3", {}, tpl ? `Edit "${tpl.name}"` : "New template"),
    el("div", { class: "field" }, [el("label", {}, "Name"), nameInput]),
    el("div", { class: "field" }, [el("label", {}, "Sections (one per line)"), sectionsInput]),
    el("div", { class: "modal-actions" }, [
      el("button", { class: "icon-btn", onclick: close }, "Cancel"),
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
  } catch (err) {
    toast(err.message, "error");
  }
}

async function deleteFolder(folderId) {
  const folder = folderNode(folderId);
  const count = countDocs(folder);
  const ok = await confirmDialog({
    title: `Delete "${folder.name}"?`,
    message: `This deletes the folder and its ${count} ${count === 1 ? "document" : "documents"}. This cannot be undone.`,
    confirmText: "Delete folder",
  });
  if (!ok) return;
  try {
    await api.folders.remove(state.project.id, folderId);
    if (state.currentDocId && folderContainsDoc(folder, state.currentDocId)) {
      state.currentDocId = null;
    }
    await afterTreeChange();
    await refreshWiki();
    if (!state.currentDocId) renderWriteTab(null);
    updateTopbar();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function openDocument(docId) {
  if (docId === state.currentDocId) return;
  await flushSave();
  const wiki = docId.startsWith("worldbuilding/");
  state.currentDocId = docId;
  state.currentTab = wiki ? "wiki" : "write";
  if (wiki) state.wikiDocId = docId;
  else state.writeDocId = docId;
  setActiveTab(state.currentTab);
  renderSidebar();
  try {
    const doc = await api.docs.get(state.project.id, docId);
    renderEditorTab(doc, { wiki });
  } catch (err) {
    toast(err.message, "error");
  }
}

async function deleteCurrentDoc() {
  const info = findDoc(state.currentDocId);
  if (!info) return;
  const ok = await confirmDialog({
    title: `Delete "${info.title}"?`,
    message: "This deletes the Markdown file. This cannot be undone.",
    confirmText: "Delete",
  });
  if (!ok) return;
  const wiki = isWikiScope();
  try {
    await api.docs.remove(state.project.id, info.id);
    state.currentDocId = null;
    if (wiki) state.wikiDocId = null;
    else state.writeDocId = null;
    await refreshTree();
    await refreshWiki();
    renderSidebar();
    renderEditorTab(null, { wiki });
    updateTopbar();
    toast("Document deleted");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function renameCurrentDoc(newTitle) {
  if (!newTitle || !state.currentDocId) return;
  try {
    await api.docs.rename(state.project.id, state.currentDocId, newTitle);
    await refreshTree();
    renderSidebar();
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
];

let toolbarButtons = [];

let _grammarToggleBtn = null;

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
  _grammarToggleBtn = btn;
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

function toolbar() {
  const bar = el("div", { class: "editor-toolbar" });
  toolbarButtons = [];
  for (const def of TOOLBAR) {
    if (def === null) {
      bar.append(el("div", { class: "toolbar-sep" }));
      continue;
    }
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

function docHeader(doc) {
  if (!doc) return null;
  const typeLabel =
    doc.type && doc.type !== "note" && doc.type !== "chapter"
      ? doc.type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : doc.kind === "chapter"
        ? "Chapter"
        : "Note";
  return el("div", { class: "doc-header" }, [
    el("input", {
      class: "doc-title-input",
      value: doc.title,
      placeholder: "Untitled",
      title: "Rename document",
      onchange: (e) => renameCurrentDoc(e.target.value.trim()),
    }),
    el("span", { class: "chip" }, typeLabel),
    el("div", { class: "topbar-spacer" }),
    el("button", { class: "icon-btn danger", onclick: deleteCurrentDoc }, "Delete"),
  ]);
}

function backlinksPanel() {
  const panel = el("div", { class: "side-panel" });
  const render = async () => {
    const docId = state.currentDocId;
    const wiki = state.wiki;
    let inner;
    if (!docId) {
      inner = [el("p", { class: "empty-hint" }, "Open a document to see its backlinks.")];
    } else if (!wiki) {
      inner = [el("p", { class: "empty-hint" }, "Loading…")];
    } else {
      const backlinks = (wiki.backlinks[docId] || []).map((id) => {
        const t = docTitle(id);
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

async function renderEditorTab(doc, { wiki }) {
  if (state.editorCtrl) {
    state.editorCtrl.destroy();
    state.editorCtrl = null;
  }
  contentsEl = null;
  navListEl = null;
  const main = document.getElementById("main-content");
  const header = docHeader(doc);
  const tb = toolbar();
  const host = el("div", { class: "editor-host" + (wiki ? " wiki-host" : "") }, [el("div", { id: "editor-mount" })]);
  const panel = backlinksPanel();
  const wrap = el("div", { class: "editor-wrap" }, [host, panel]);
  const status = el("div", { class: "editor-status" }, [
    el("span", { id: "st-words" }, "0 words"),
    el("div", { class: "spacer" }),
    el("button", {
      class: "icon-btn",
      id: "btn-backlinks",
      title: "Toggle backlinks",
      onclick: () => {
        panel.classList.toggle("open");
      },
    }, "Backlinks"),
    el("span", { id: "st-save", class: "status-save" }, "Ready"),
  ]);
  const children = [];
  if (header) children.push(header);
  children.push(tb, wrap, status);
  main.classList.add("no-scroll");
  main.replaceChildren(...children);

  if (!doc) {
    host.replaceChildren(
      el("div", { class: "empty-state" }, [
        el("h2", {}, "Nothing open"),
        el("p", {}, wiki ? "Pick a lore entry from the sidebar, or create one." : "Pick a chapter or note from the sidebar, or create one."),
      ])
    );
    panel._render();
    return;
  }

  state.currentDocId = doc.id;
  if (wiki) state.wikiDocId = doc.id;
  else state.writeDocId = doc.id;
  state.docStyle = doc.style || {};
  state.currentSection = null;
  state.selectionActive = false;

  const mount = document.getElementById("editor-mount");
  const wasPending = state.dirty && state.currentDocId === doc.id;
  state.dirty = false;
  state.editorCtrl = window.LainEditor.create({
    element: mount,
    content: doc.content || "",
    placeholder: wiki ? "Begin lore entry…" : "Begin writing…",
    onChange: onEditorUpdate,
    onWikilinkClick,
    showNav: wiki,
  });
  state.editorCtrl.setGrammarEnabled(state.settings.grammarEnabled);
  state.editorCtrl.setDictionaryWords(state.dictionary.words || []);
  state.editorCtrl.setOnAddToDictionary(async (word) => {
    const words = state.dictionary.words || [];
    if (words.some((w) => w.toLowerCase() === word.toLowerCase())) return;
    words.push(word);
    state.dictionary.words = words;
    state.editorCtrl.setDictionaryWords(words);
    try {
      await api.projects.dictionary.update(state.project.id, words);
    } catch {
      /* ignore */
    }
    if (state.editorCtrl.editor) { state.editorCtrl.editor.view.dispatch(state.editorCtrl.editor.state.tr.setMeta("forceGrammar", true)); }
  });
  state.editorCtrl.editor.on("transaction", () => { refreshToolbar(); refreshEditorContext(); });
  state.editorCtrl.editor.on("selectionUpdate", () => { refreshToolbar(); refreshEditorContext(); });
  refreshToolbar();
  refreshEditorContext();
  applyDocStyle();
  panel._render();
  if (wiki) {
    initNavBox();
    updateContentsBox(doc.content || "", doc.title);
  }
  state.editorCtrl.focus();

  if (wasPending) {
    setSaveStatus("pending", "Saved locally — will save");
  }
}

function renderWriteTab(doc) {
  return renderEditorTab(doc, { wiki: false });
}

/* ---------------- navigation box (wiki) ---------------- */

let contentsEl = null;
let navListEl = null;

function initNavBox() {
  const navEl = state.editorCtrl && state.editorCtrl.navEl;
  if (!navEl) return;
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
  contentsEl = navEl;
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

function onEditorUpdate(markdown) {
  state.dirty = true;
  setSaveStatus("pending", "Unsaved changes");
  updateLiveWords();
  updateContentsBox(markdown, docTitle(state.currentDocId));
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveCurrentDoc, state.settings.autosaveMs || 800);
}

function updateLiveWords() {
  const ctrl = state.editorCtrl;
  if (!ctrl) return;
  const count = countWords(ctrl.getText(), mode());
  const node = document.getElementById("st-words");
  if (node) node.textContent = `${formatNumber(count)} words`;
}

function setSaveStatus(kind, text) {
  const node = document.getElementById("st-save");
  if (!node) return;
  node.textContent = text;
  node.className = `status-save ${kind === "pending" ? "pending" : ""}`;
}

async function saveCurrentDoc() {
  const docId = state.currentDocId;
  if (!state.editorCtrl || !docId || state.saving) return;
  const markdown = state.editorCtrl.getMarkdown();
  if (!state.dirty) return;
  state.dirty = false;
  state.saving = true;
  setSaveStatus("pending", "Saving…");
  try {
    const saved = await api.docs.save(state.project.id, docId, markdown);
    if (state.currentDocId === docId) {
      setSaveStatus("", "Saved");
    }
    updateTreeWords(docId, saved.words);
    scheduleWikiRefresh();
    updateTopbar();
  } catch (err) {
    state.dirty = true;
    setSaveStatus("pending", `Save failed: ${err.message}`);
  } finally {
    state.saving = false;
  }
}

async function flushSave() {
  if (state.editorCtrl && state.dirty && state.currentDocId) {
    const docId = state.currentDocId;
    const markdown = state.editorCtrl.getMarkdown();
    state.dirty = false;
    try {
      const saved = await api.docs.save(state.project.id, docId, markdown);
      updateTreeWords(docId, saved.words);
      scheduleWikiRefresh();
      updateTopbar();
    } catch (err) {
      state.dirty = true;
      toast(`Couldn't save before switching: ${err.message}`, "error");
    }
  }
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
  let notes = [];
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
      el("button", { class: "icon-btn", onclick: close }, "Cancel"),
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
      el("div", { class: "chart" }, bars),
    ])
  );
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

  const { backdrop, modal, close } = showModal([
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

  let aiCfg = {};
  try {
    const full = await api.settings.get();
    aiCfg = (full.ai && full.ai.deepseek) || {};
  } catch {
    /* ignore */
  }
  const aiKeyInput = el("input", { type: "password", value: aiCfg.apiKey || "", placeholder: "sk-…" });
  const aiModelSelect = el("select", {}, [
    ["deepseek-v4-flash", "deepseek-v4-flash"],
    ["deepseek-v4-pro", "deepseek-v4-pro"],
  ].map(([value]) => el("option", { value, selected: (aiCfg.model || "deepseek-v4-flash") === value }, value)));
  const aiBaseInput = el("input", { type: "text", value: aiCfg.baseUrl || "", placeholder: "https://api.deepseek.com" });
  const aiTestStatus = el("span", { id: "ai-test-status", class: "chip" });
  const saveAiSettings = async () => {
    try {
      await api.settings.update({
        ai: {
          deepseek: {
            apiKey: aiKeyInput.value.trim(),
            model: aiModelSelect.value,
            baseUrl: aiBaseInput.value.trim() || undefined,
          },
        },
      });
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
        el("p", { class: "desc" }, "Global default font, size, and alignment for all documents. Each document and section can override these from the editor toolbar."),
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
          el("label", {}, "Zoom"),
          zoomSelect("global"),
        ]),
      ]),
      el("div", { class: "settings-section" }, [
        el("h2", {}, "AI assistant (Lain)"),
        el("p", { class: "desc" }, "Connect DeepSeek so Lain can organize and maintain your lore from the sidebar chat. The API key is stored locally in data/settings.json."),
        el("div", { class: "field-row" }, [
          el("label", {}, "DeepSeek API key"),
          aiKeyInput,
        ]),
        el("div", { class: "field-row" }, [
          el("label", {}, "Model"),
          aiModelSelect,
        ]),
        el("div", { class: "field-row" }, [
          el("label", {}, "Base URL"),
          aiBaseInput,
        ]),
        el("div", { class: "modal-actions" }, [
          el("button", { class: "icon-btn primary", onclick: saveAiSettings }, "Save AI settings"),
          el("button", { class: "icon-btn", onclick: testAiConnection }, "Test connection"),
          aiTestStatus,
        ]),
      ]),
      el("div", { class: "settings-section" }, [
        el("h2", {}, "Export & backup"),
        el("p", { class: "desc" }, "Download your project as zip, docx, pdf, or epub. Choose which folders to include."),
        el("div", { class: "modal-actions" }, [
          el("button", { class: "icon-btn primary", onclick: () => renderExportDialog(state.project.id) }, "Export…"),
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
}

/* ---------------- tab switching ---------------- */

async function switchTab(tab) {
  const main = document.getElementById("main-content");
  if (main) main.style.opacity = "0";

  if (tab === "write" || tab === "wiki") {
    await flushSave();
    const wiki = tab === "wiki";
    state.currentTab = tab;
    setActiveTab(tab);
    if (state.editorCtrl) {
      state.editorCtrl.destroy();
      state.editorCtrl = null;
    }
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
    renderSidebar();
    const doc = state.currentDocId
      ? await api.docs.get(state.project.id, state.currentDocId)
      : null;
    renderEditorTab(doc, { wiki });
    if (main) { requestAnimationFrame(() => { main.style.opacity = "1"; }); }
    return;
  }
  await flushSave();
  state.currentTab = tab;
  setActiveTab(tab);
  if (state.editorCtrl) {
    state.editorCtrl.destroy();
    state.editorCtrl = null;
  }
  if (tab === "stats") renderStatsTab();
  else if (tab === "settings") renderSettingsTab();
  if (main) {
    main.classList.remove("no-scroll");
    requestAnimationFrame(() => { main.style.opacity = "1"; });
  }
}

function setActiveTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
}

/* ---------------- render shell ---------------- */

function renderSidebar() {
  const scroll = document.querySelector(".sidebar-scroll");
  if (scroll) renderTree(scroll);
}

async function init(params) {
  try {
    const settings = await api.settings.get();
    state.settings = {
      wordCountMode: settings.wordCountMode || "auto",
      autosaveMs: settings.autosaveMs || 800,
      editorFont: settings.editorFont || "serif",
      editorSize: settings.editorSize || 18,
      editorAlign: settings.editorAlign || "left",
      editorZoom: settings.editorZoom || 100,
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
  renderSidebar();

  await Promise.all([refreshWiki(), updateTopbar()]);

  window.addEventListener("beforeunload", () => {
    if (state.dirty) {
      const md = state.editorCtrl && state.editorCtrl.getMarkdown();
      if (md && state.currentDocId) {
        navigator.sendBeacon(
          `/api/projects/${encodePath(state.project.id)}/documents/${encodePath(state.currentDocId)}`,
          new Blob([JSON.stringify({ content: md })], { type: "application/json" })
        );
      }
    }
  });

  const first = firstDoc();
  if (state.currentDocId) {
    openDocument(state.currentDocId);
  } else if (first) {
    openDocument(first.id);
  } else {
    switchTab("write");
  }
}

export function register() {
  router.on("project", init);
}
