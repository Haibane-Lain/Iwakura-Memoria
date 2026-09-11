// Pure helpers for the Write/Wiki document trees.
//
// A tree is the shape the API returns: `{ folders: [ { id, name, folders,
// documents } ], documents: [ { id, title, kind, ... } ] }`. Everything here
// takes its tree (or the flattened document list) as an argument and returns a
// new value, so it can be unit tested without jsdom and without the app's
// mutable state. project.js keeps thin, state-bound wrappers over these.

// Flatten a tree to documents in depth-first order, remembering the containing
// folder. The root's own documents get `folder: ""`.
export function collectTree(node) {
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

// Write and Wiki documents together, Write first.
export function allDocs(tree, wikiTree) {
  return [...collectTree(tree), ...collectTree(wikiTree)];
}

export function findDocIn(tree, docId) {
  return collectTree(tree).find((d) => d.id === docId) || null;
}

// Resolve a title (or a document id) the way wikilinks do: exact title first
// (case-insensitive, trimmed), then an id match.
export function resolveDocByTitle(docs, title) {
  const target = (title || "").trim();
  if (!target) return null;
  const norm = target.toLowerCase();
  return (
    docs.find((d) => d.title.toLowerCase() === norm) ||
    docs.find((d) => d.id.toLowerCase() === norm) ||
    null
  );
}

// "2-Chapters/01-Opening" -> "Chapters/Opening" for the hover tooltip.
export function prettyPath(doc) {
  const parts = (doc.id || "").split("/");
  parts.pop();
  const folderPart = parts.map((seg) => seg.replace(/^\d+-/, "")).join("/");
  return folderPart ? `${folderPart}/${doc.title || ""}` : doc.title || doc.id;
}

// Find a folder by id inside `tree`. `rootId` is the id that means the root
// itself ("worldbuilding" in the wiki scope, "" in Write).
export function folderNodeIn(tree, folderId, rootId = "") {
  const root = tree || { folders: [], documents: [] };
  if (!folderId || folderId === rootId) return root;
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

export function countDocs(node) {
  let count = (node.documents || []).length;
  for (const f of node.folders || []) count += countDocs(f);
  return count;
}

export function folderContainsDoc(node, docId) {
  if ((node.documents || []).some((d) => d.id === docId)) return true;
  return (node.folders || []).some((f) => folderContainsDoc(f, docId));
}

// First document in depth-first order (its own documents before subfolders).
export function firstDocIn(tree) {
  const walk = (n) => {
    if (n.documents && n.documents.length) return n.documents[0];
    for (const f of n.folders || []) {
      const d = walk(f);
      if (d) return d;
    }
    return null;
  };
  return walk(tree || { folders: [], documents: [] });
}

// Add every folder id (not the root's) to `set`. Mutates and returns it.
export function expandAll(node, set) {
  for (const f of (node && node.folders) || []) {
    set.add(f.id);
    expandAll(f, set);
  }
  return set;
}
