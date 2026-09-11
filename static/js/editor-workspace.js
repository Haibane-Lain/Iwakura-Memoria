// The editing surface: document tabs, the split panes, the per-pane save
// pipeline, and the editor view render.
//
// It shares `state`, the panes, the editor pool and the tab list with the shell
// through project-context.js, and calls back into the shell (sidebar/topbar
// refreshes, document actions, image UI, the shared toolbar) through the
// `shell` service object. It never imports project.js, so there is no cycle.
import {
  state,
  panes,
  paneList,
  activePane,
  paneForCtrl,
  paneForDoc,
  editorPool,
  docTabs,
  allDocs,
  findDocAny,
  docTitleAny,
  shell,
} from "./project-context.js";
import { api } from "./api.js";
import { el, toast, countWords, formatNumber, escapeHtml } from "./ui.js";
import { fontStack } from "./fonts.js";
import { zoomFactor } from "./zoom.js";
import { defaultZoomForScope as resolveDefaultZoom } from "./editor-prefs.js";
import { prettyPath } from "./doc-tree.js";
import { commentsPanel } from "./comments-panel.js";

/* ---------------- tab persistence ---------------- */

const LS_TABS = "im.tabs";

// Only one document can be mid-open at a time.
let _opening = false;

function tabsStorageKey() {
  return state.project ? `${LS_TABS}.${state.project.id}` : null;
}

// Persist the strip, the split pairing, and a title for each id. Titles are how
// a stale path is repaired after a folder rename/move rewrites ids.
export function persistTabs() {
  const key = tabsStorageKey();
  if (!key) return;
  const data = docTabs.serialize();
  const titles = {};
  for (const id of [...data.tabs, panes.secondary.docId].filter(Boolean)) {
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

export function restoreTabs() {
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
  data = data || { tabs: [], active: null };
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

export function clearTabs() {
  docTabs.restore({ tabs: [], active: null });
}

/* ---------------- split panes ---------------- */

// Move focus (and the shared grammar slot, toolbar and style target) to a pane.
export function setActivePane(name) {
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
      p.ctrl.setGrammarEnabled(pane.revisionMode ? false : state.settings.grammarEnabled);
    } else {
      p.ctrl.deactivate();
    }
  }
  syncPaneFocus();
  shell.refreshToolbar();
  shell.refreshEditorContext();
  shell.updateTargetIndicator();
  shell.syncEditorControls();
}

function syncPaneFocus() {
  for (const p of paneList()) {
    if (p.root) p.root.classList.toggle("focused", p.name === state.activePane);
  }
}

/* ---------------- editor cache (undo survives document switches) -------- */

// Detach every mounted pane's editor without destroying it, so ProseMirror
// state (undo/redo history) is kept in the pool under its document id.
export function parkEditor() {
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
export function invalidateEditorCache(keepActive = false) {
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
export function resetEditorPool() {
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

function tabKind(id) {
  const d = findDocAny(id);
  if (d && d.kind === "chapter") return "chapter";
  return id.startsWith("worldbuilding/") ? "wiki" : "note";
}

// A deleted document is gone from the tree but may still be in the strip; this
// removes it and rewrites any id a folder move changed (matched by title).
export function reconcileTabs(oldTabs) {
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

export function renderDocTabs() {
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
          shell.showContextMenu(e.clientX, e.clientY, [
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
export function dropEditorFor(docId) {
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
export function dropTab(id) {
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

export async function closeDocumentTab(id) {
  if (!docTabs.has(id)) return;
  const isSecondary = panes.secondary.docId === id;
  const isPrimary = panes.primary.docId === id;

  if (!isPrimary && !isSecondary) {
    // An off-screen tab: drop it without touching the panes on screen.
    dropTab(id);
    shell.renderSidebar();
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
    shell.renderSidebar();
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
    shell.renderSidebar();
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
  shell.renderSidebar();
  renderDocTabs();
  await renderEditorView();
}

export function cycleTabs(direction) {
  const next = docTabs.cycle(direction);
  if (next && next !== state.currentDocId) openDocument(next);
}

// Turn the split companion on (pairing with another open tab) or off.
export async function toggleSplit() {
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
  shell.renderSidebar();
  await renderEditorView();
}

// Show a document in the secondary pane (from a tab or the tree).
export async function openInSplit(docId) {
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
    shell.renderSidebar();
    await renderEditorView();
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ---------------- editor view ---------------- */

// Compatibility entry point: put `doc` in the target pane and redraw the view.
// Most callers mean the primary pane; sidebar/tab clicks go to the focused one.
export async function renderEditorTab(doc, { wiki, pane } = {}) {
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
  pane.activeCommentId = null;
  pane.revisionMode = false;
  const header = docHeader(doc, pane);
  const mount = el("div", { class: "editor-mount" });
  const host = el("div", { class: "editor-host" + (pane.wiki ? " wiki-host" : "") }, [mount]);
  host.style.setProperty("--editor-font", fontStack(state.settings.editorFont));
  host.style.setProperty("--editor-size", `${state.settings.editorSize || 18}px`);
  host.style.setProperty("--editor-align", state.settings.editorAlign || "left");
  host.style.setProperty("--editor-zoom", String(zoomFactor(resolveDefaultZoom(state.settings, pane.wiki))));

  const comments = commentsPanel({
    projectId: state.project.id,
    pane,
    syncComments: (items) => syncPaneComments(pane, items),
    onCount: (items) => updateCommentsButton(pane, items),
  });
  const backlinks = backlinksPanel(pane);
  const panels = [comments, backlinks];
  const wrap = el("div", { class: "editor-wrap" }, [host, ...panels]);

  // One side panel is open at a time; the buttons in the status bar switch it.
  const togglePanel = (target) => {
    const willOpen = !target.classList.contains("open");
    for (const p of panels) p.classList.remove("open");
    if (!willOpen) return;
    target.classList.add("open");
    if (target === comments) comments._reload();
  };

  const wordsEl = el("span", { class: "st-words" }, "0 words");
  const saveEl = el("span", { class: "st-save status-save" }, "Ready");
  const commentsBtn = el("button", {
    class: "icon-btn",
    title: "Comments on the focused document",
    onclick: () => togglePanel(comments),
  }, "Comments");
  const status = el("div", { class: "editor-status" }, [
    wordsEl,
    el("div", { class: "spacer" }),
    commentsBtn,
    el("button", {
      class: "icon-btn",
      title: "Toggle backlinks",
      onclick: () => togglePanel(backlinks),
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
  pane.panel = backlinks;
  pane.commentsPanel = comments;
  pane.commentsBtn = commentsBtn;
  pane.wordsEl = wordsEl;
  pane.saveEl = saveEl;
  return root;
}

// Paint a pane's comment decorations from its sidecar list, and flag any marker
// with no body (an unlinked anchor left by an external edit).
function syncPaneComments(pane, items) {
  pane.comments = items || [];
  const ctrl = pane.ctrl;
  if (!ctrl) return;
  const known = new Set(pane.comments.map((c) => c.id));
  const meta = {};
  for (const comment of pane.comments) meta[comment.id] = { resolved: !!comment.resolved };
  for (const range of ctrl.getCommentRanges()) {
    if (!known.has(range.cid)) meta[range.cid] = { orphan: true };
  }
  if (pane.activeCommentId && meta[pane.activeCommentId]) {
    meta[pane.activeCommentId] = { ...meta[pane.activeCommentId], active: true };
  }
  ctrl.setComments(meta);
}

function updateCommentsButton(pane, items) {
  if (!pane.commentsBtn) return;
  const open = (items || []).filter((c) => !c.resolved).length;
  pane.commentsBtn.textContent = open ? `Comments (${open})` : "Comments";
  pane.commentsBtn.classList.toggle("has-comments", open > 0);
}

// The ribbon's Comment button and Ctrl+Alt+M land here: capture the focused
// pane's selection and hand it to that pane's comments panel.
export function startComment() {
  const pane = activePane();
  if (!pane || !pane.ctrl || !pane.commentsPanel) {
    toast("Open a document to comment on it", "info");
    return;
  }
  const editor = pane.ctrl.editor;
  const { from, to } = editor.state.selection;
  if (from === to) {
    toast("Select some text to comment on", "info");
    return;
  }
  const $from = editor.state.doc.resolve(from);
  const $to = editor.state.doc.resolve(to);
  if (!$from.sameParent($to) || !$from.parent.isTextblock) {
    toast("Select text within a single paragraph", "info");
    return;
  }
  pane.commentsPanel.beginComment({
    from,
    to,
    quote: editor.state.doc.textBetween(from, to, " "),
  });
}

// A revision pass over the focused document: hide grammar noise, open the
// comments panel, and step through the open comments one at a time.
export async function toggleRevisionMode() {
  const pane = activePane();
  if (!pane || !pane.ctrl || !pane.commentsPanel) {
    toast("Open a document to revise", "info");
    return;
  }
  pane.revisionMode = !pane.revisionMode;
  if (pane.revisionMode) {
    pane.ctrl.setGrammarEnabled(false);
    pane.commentsPanel.classList.add("open");
    await pane.commentsPanel._reload();
    pane.commentsPanel.startReview();
  } else {
    pane.ctrl.setGrammarEnabled(state.settings.grammarEnabled);
    pane.commentsPanel.stopReview();
    pane.commentsPanel.classList.remove("open");
  }
  shell.refreshToolbar();
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
      onWikilinkClick: shell.onWikilinkClick,
      showNav: pane.wiki,
      projectId: state.project.id,
      uploadImage: shell.uploadImageFile,
      onImageError: (message) => toast(message, "error"),
      onUploadState: (busy) => {
        if (busy) setPaneSaveStatus(pane, "pending", "Uploading image…");
      },
      onOpenImage: shell.showImageOverlay,
      onPickPortrait: (pos) => shell.pickImageFiles(pos),
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
  ctrl.editor.on("transaction", () => { shell.refreshToolbar(); shell.refreshEditorContext(); });
  ctrl.editor.on("selectionUpdate", () => { shell.refreshToolbar(); shell.refreshEditorContext(); });
  return true;
}

// Redraw the whole editor tab from pane state: tab strip, one shared toolbar,
// then one or two panes side by side.
export async function renderEditorView() {
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

  const tb = shell.toolbar(active.wiki);
  for (const { pane, doc } of rendered) container.append(renderPane(pane, doc));
  if (!rendered.length) {
    // No document, so no pane chrome; point the active pane at the bare host so
    // applyDocStyle still gives it its tab's font/zoom.
    const emptyHost = el("div", { class: "editor-host" + (active.wiki ? " wiki-host" : "") }, [
      el("div", { class: "empty-state" }, [
        el("h2", {}, "Nothing open"),
        el("p", {}, active.wiki ? "Pick a lore entry from the sidebar, or create one." : "Pick a chapter or note from the sidebar, or create one."),
      ]),
    ]);
    active.host = emptyHost;
    active.ctrl = null;
    container.append(emptyHost);
  }

  const children = [];
  if (docTabs.tabs.length) children.push(tabsEl);
  children.push(tb, container);
  main.classList.add("no-scroll");
  main.replaceChildren(...children);
  renderDocTabs();

  if (!rendered.length) {
    state.docStyle = {};
    shell.applyDocStyle();
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
  shell.applyDocStyle();
  for (const { pane } of rendered) {
    if (pane.panel) pane.panel._render();
    if (pane.commentsPanel) pane.commentsPanel._reload();
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

/* ---------------- pane chrome ---------------- */

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
        shell.renameCurrentDoc(e.target.value.trim());
      },
    }),
    el("span", { class: "chip" }, typeLabel),
    el("div", { class: "topbar-spacer" }),
    el("button", {
      class: "icon-btn danger",
      onclick: () => {
        focusPane();
        shell.deleteCurrentDoc();
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
            onclick: () => shell.createMissingNote(target, docId),
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

/* ---------------- save pipeline ---------------- */

function mode() {
  return state.settings.wordCountMode || "auto";
}

export function onEditorUpdate(ctrl, markdown) {
  // A parked editor (kept around for undo history) must never mark a visible
  // document dirty; only the mounted panes' changes count.
  const pane = paneForCtrl(ctrl);
  if (!pane) return;
  if (state.split && state.activePane !== pane.name) setActivePane(pane.name);
  pane.dirty = true;
  if (pane === activePane()) state.dirty = true;
  setPaneSaveStatus(pane, "pending", "Unsaved changes");
  updateLiveWords(pane);
  if (pane.wiki && pane === activePane()) updateContentsBox(markdown, docTitleAny(pane.docId));
  clearTimeout(pane.timer);
  pane.timer = setTimeout(() => savePane(pane), state.settings.autosaveMs || 800);
}

// Toolbar/style actions that change content outside the typing path.
export function markActiveDirty(text = "Unsaved changes") {
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
    shell.scheduleWikiRefresh();
    shell.updateTopbar();
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

export async function flushSave() {
  await Promise.all(paneList().map(flushPane));
}

export function updateTreeWords(docId, words) {
  const walk = (n) => {
    for (const d of n.documents || []) if (d.id === docId) d.words = words;
    for (const f of n.folders || []) walk(f);
  };
  walk(state.tree);
  walk(state.wikiTree);
  shell.renderSidebar();
}

// Push the dictionary into every mounted editor (both panes) and nudge grammar
// to re-run. The dialog reports changes through this so a split companion gets
// the update too, not just the focused pane.
export function applyDictionaryWords(words) {
  state.dictionary.words = [...words];
  for (const pane of [panes.primary, panes.secondary]) {
    const ctrl = pane.ctrl;
    if (!ctrl) continue;
    ctrl.setDictionaryWords(state.dictionary.words);
    if (ctrl.editor) {
      ctrl.editor.view.dispatch(ctrl.editor.state.tr.setMeta("forceGrammar", true));
    }
  }
}

/* ---------------- editor navigation ---------------- */

// Best-effort "jump to the match": the editor's text is what the check saw,
// but finding it by string is cheap and works for the common case. Markdown
// drift simply opens the document without a selection. ``occurrence`` selects
// the Nth hit within the document (search passes the one the user clicked).
export function revealText(text, occurrence = 0) {
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

/* ---------------- open / restore ---------------- */

export async function openDocument(docId) {
  // Already visible in a pane? Focus it rather than showing it twice.
  const visible = paneForDoc(docId);
  if (visible) {
    if (state.activePane !== visible.name) setActivePane(visible.name);
    return;
  }
  if (docId === state.currentDocId) return;
  console.warn("[diag] openDocument start", docId, { _opening });
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
    shell.setActiveTab(state.currentTab);
    // This re-render only moves the .active highlight, so the list must not
    // move with it (see keepScrollTop: Chromium nudges a scrolled container's
    // offset when its children are replaced).
    shell.renderSidebar({ keepScroll: true });
    await renderEditorTab(doc, { wiki });
  } catch (err) {
    console.warn("openDocument failed", docId, err);
    toast(err.message, "error");
  }
  } finally {
    _opening = false;
  }
}

// The restored body came from disk behind the editor's back: drop just this
// document's warm editor (other warm editors keep their undo) and reload it.
export async function afterSnapshotRestore(docId) {
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
  await shell.refreshTree();
  await shell.refreshWiki();
  shell.updateTopbar();
  if (!pane) return;
  state.activePane = pane.name;
  state.currentDocId = pane.docId;
  if (pane.wiki) state.wikiDocId = pane.docId;
  else state.writeDocId = pane.docId;
  await renderEditorView();
}

// A project-wide replace wrote documents behind the editor cache's back. Drop
// each changed warm editor; reload any changed document that is on screen.
export async function refreshAfterReplace(docIds) {
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
  await shell.refreshTree();
  await shell.refreshWiki();
  shell.updateTopbar();
  if (paneList().some((p) => p.docId && changed.has(p.docId))) {
    await renderEditorView();
  }
}
