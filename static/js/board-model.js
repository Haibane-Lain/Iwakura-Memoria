// Pure helpers for the Board views (Outline / Corkboard / Beats).
//
// Everything here takes a tree (or a flat entry list) and returns a new value,
// so it can be unit tested without jsdom or the app's mutable state. The view
// module (board-view.js) keeps thin, state-bound wrappers over these.
//
// A "scope" is one folder. Its children are the mixed doc/folder entries the
// tree already orders, which matters because the reorder API requires *every*
// orderable entry in the folder — folders included — to be sent back.

import { folderNodeIn } from "./doc-tree.js";

// Scene statuses offered in the UI. Free-form strings are still allowed (the
// backend does not validate), this is just the picklist.
export const STATUS_OPTIONS = ["idea", "outlined", "draft", "revised", "final"];

// Card label palette. The stored value is the key; unknown keys fall back to a
// neutral color so hand-edited frontmatter never breaks a card.
export const LABELS = [
  { id: "gray", color: "#8a8f98" },
  { id: "red", color: "#c0504d" },
  { id: "orange", color: "#d08a3e" },
  { id: "yellow", color: "#c9b458" },
  { id: "green", color: "#6a9a5b" },
  { id: "blue", color: "#5b7fa6" },
  { id: "purple", color: "#8a6fa8" },
];

export const UNASSIGNED_BEAT = "";

export function labelColor(label) {
  const found = LABELS.find((l) => l.id === label);
  return found ? found.color : "transparent";
}

// The children of `folderId`, in tree order, with their full summary objects.
// Returns `{ node, entries }`; each entry is
// `{ kind: "doc"|"folder", id, name, ...summary }`.
export function scopeEntries(tree, folderId, rootId = "") {
  const node = folderNodeIn(tree, folderId, rootId);
  const docsById = new Map((node.documents || []).map((d) => [d.id, d]));
  const foldersById = new Map((node.folders || []).map((f) => [f.id, f]));

  let raw = node.entries;
  if (!Array.isArray(raw) || !raw.length) {
    // Fallback for a synthesised node without an explicit order: folders first,
    // then documents. The real API always sends `entries`.
    raw = [
      ...(node.folders || []).map((f) => ({ kind: "folder", id: f.id })),
      ...(node.documents || []).map((d) => ({ kind: "doc", id: d.id })),
    ];
  }

  const entries = raw.map((entry) => {
    if (entry.kind === "folder") {
      const folder = foldersById.get(entry.id);
      return { isFolder: true, id: entry.id, name: (folder && folder.name) || entry.id };
    }
    const doc = docsById.get(entry.id) || { id: entry.id, title: entry.id };
    // Spread the summary first: a document has its own `kind` ("chapter" /
    // "note"), so the entry discriminator is a separate `isFolder` flag rather
    // than a `kind` that the summary would overwrite.
    return { ...doc, isFolder: false };
  });
  return { node, entries };
}

export function docEntries(entries) {
  return entries.filter((e) => !e.isFolder);
}

// Every folder in the tree as `{ id, depth, name }`, root first. `rootId` is
// the id that means the root itself ("" for Write, "worldbuilding" for Wiki).
export function folderOptions(tree, rootId = "", rootName = "Project root") {
  const out = [{ id: rootId, depth: 0, name: rootName }];
  const walk = (node, depth) => {
    for (const folder of node.folders || []) {
      out.push({ id: folder.id, depth, name: folder.name });
      walk(folder, depth + 1);
    }
  };
  walk(tree || { folders: [], documents: [] }, 1);
  return out;
}

// Move one item within a list, returning a new array. Out-of-range moves are a
// no-op copy.
export function moveItem(list, fromIndex, toIndex) {
  const next = list.slice();
  if (fromIndex < 0 || fromIndex >= next.length) return next;
  const [item] = next.splice(fromIndex, 1);
  const to = Math.max(0, Math.min(toIndex, next.length));
  next.splice(to, 0, item);
  return next;
}

// Kanban columns for the beat board: known beats in order, then any beats a
// document references that are no longer in the list (so the value is never
// silently hidden), then the unassigned column last.
export function beatColumns(docs, beats) {
  const columns = (beats || []).map((b) => ({ id: b.id, name: b.name, docs: [] }));
  const byId = new Map(columns.map((c) => [c.id, c]));
  const unassigned = { id: UNASSIGNED_BEAT, name: "Unassigned", docs: [], unassigned: true };
  const extras = new Map();

  for (const doc of docs) {
    const beat = doc.beat || "";
    if (!beat) {
      unassigned.docs.push(doc);
      continue;
    }
    const column = byId.get(beat);
    if (column) {
      column.docs.push(doc);
      continue;
    }
    if (!extras.has(beat)) extras.set(beat, { id: beat, name: beat, docs: [], orphan: true });
    extras.get(beat).docs.push(doc);
  }
  return [...columns, ...extras.values(), unassigned];
}

// Find a document's actual summary object inside a tree, so an inline edit can
// update the value other views read without a full tree refetch.
export function findDocObject(node, docId) {
  for (const doc of (node && node.documents) || []) {
    if (doc.id === docId) return doc;
  }
  for (const folder of (node && node.folders) || []) {
    const found = findDocObject(folder, docId);
    if (found) return found;
  }
  return null;
}

// Total words under a node, including subfolders. Used for folder cards/rows.
export function folderWordCount(node) {
  let total = 0;
  for (const doc of (node && node.documents) || []) total += doc.words || 0;
  for (const folder of (node && node.folders) || []) total += folderWordCount(folder);
  return total;
}

// Every document under a node, depth-first. The beat board plans across a whole
// subtree rather than one folder level.
export function descendantDocs(node) {
  const out = [];
  const walk = (n) => {
    for (const doc of (n && n.documents) || []) out.push(doc);
    for (const folder of (n && n.folders) || []) walk(folder);
  };
  walk(node);
  return out;
}

export function progressPercent(words, target) {
  if (!target || target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((words || 0) / target) * 100)));
}

export function synopsisSnippet(text, max = 160) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}
