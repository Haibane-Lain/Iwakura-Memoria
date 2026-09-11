// Shared state for the project shell and the editor workspace.
//
// `project.js` (the shell: sidebar, topbar, document actions, settings) and
// `editor-workspace.js` (the editing surface: panes, tabs, saving, the editor
// view) both need the same mutable state and the same long-lived singletons.
// Passing a large context object around, or importing each other, would be
// awkward or cyclic, so both import them from here.
//
// `shell` starts empty and is filled by `registerShell()` once `project.js` has
// defined its functions. The workspace only reads `shell` at call time, so the
// registration order is safe.
import { createEditorPool } from "./editor-pool.js";
import { createDocTabs } from "./doc-tabs.js";
import { collectTree } from "./doc-tree.js";

export const state = {
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

// Editors stay alive after their document is closed so undo/redo survives a
// switch. See editor-pool.js; the active document is pinned against eviction.
export const editorPool = createEditorPool({ max: 10 });

// Which documents are open (the tab strip) and the cross-session recent list.
// Pure state lives in doc-tabs.js; persistence lives in editor-workspace.js.
export const docTabs = createDocTabs();

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
    comments: [],
    commentsPanel: null,
    commentsBtn: null,
    activeCommentId: null,
    wordsEl: null,
    saveEl: null,
    dirty: false,
    saving: false,
    timer: null,
    savePromise: null,
  };
}

export const panes = { primary: makePane("primary"), secondary: makePane("secondary") };

export function paneList() {
  return state.split ? [panes.primary, panes.secondary] : [panes.primary];
}

export function activePane() {
  return panes[state.activePane] || panes.primary;
}

export function paneForCtrl(ctrl) {
  return [panes.primary, panes.secondary].find((p) => p.ctrl === ctrl) || null;
}

export function paneForDoc(docId) {
  return [panes.primary, panes.secondary].find((p) => p.docId === docId) || null;
}

export function allDocs() {
  return [...collectTree(state.tree), ...collectTree(state.wikiTree)];
}

export function findDocAny(docId) {
  return allDocs().find((d) => d.id === docId) || null;
}

export function docTitleAny(docId) {
  const d = findDocAny(docId);
  return d ? d.title : null;
}

// Shell services the workspace calls back into (rendering, refreshes, document
// actions, image UI). Filled by `registerShell()`.
export const shell = {};

export function registerShell(services) {
  Object.assign(shell, services);
}
