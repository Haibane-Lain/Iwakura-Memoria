// Sidebar search for a document tree (Write or Wiki): filters documents by
// title and folders by name, keeping the hierarchy in place.
//
// Pure and DOM-free so `tests/tree-search.test.mjs` can drive it in Node.
// The input and output share the tree shape returned by
// `GET /api/projects/{id}/tree?scope=…`: each level is
// `{ folders, documents, entries? }`.
//
// Never mutates the tree it is given — a filtered query builds new node
// objects, and an empty query hands the original tree straight back.

function _countDocs(node) {
  let count = (node.documents || []).length;
  for (const f of node.folders || []) count += _countDocs(f);
  return count;
}

function _matches(name, query) {
  return String(name || "").toLowerCase().includes(query);
}

/**
 * @param {{folders?: Array, documents?: Array, entries?: Array}} tree
 * @param {string} query
 * @returns {{tree: object, openIds: Set<string>, count: number}}
 *   `openIds` lists folders that must render expanded (each match and every
 *   ancestor leading to one); `count` is the number of documents shown.
 */
export function filterTree(tree, query) {
  const root = tree || { folders: [], documents: [] };
  const q = String(query == null ? "" : query).trim().toLowerCase();
  const openIds = new Set();

  if (!q) {
    return { tree: root, openIds, count: _countDocs(root) };
  }

  // A folder whose own name matches keeps its entire subtree; a folder that
  // merely contains a match keeps only the surviving children. `matches` is
  // the number of documents that end up visible beneath the node.
  const filterNode = (node) => {
    const folders = [];
    const documents = [];
    const keepIds = new Set();
    let matches = 0;

    for (const folder of node.folders || []) {
      const id = folder.id;
      if (_matches(folder.name, q)) {
        folders.push(folder);
        keepIds.add(id);
        openIds.add(id);
        matches += _countDocs(folder);
        continue;
      }
      const sub = filterNode(folder);
      if (sub.matches > 0) {
        // Keep the folder's identity (id/name) and override its children with
        // the filtered ones.
        folders.push({ ...folder, ...sub.node });
        keepIds.add(id);
        openIds.add(id);
        matches += sub.matches;
      }
    }

    for (const doc of node.documents || []) {
      if (_matches(doc.title, q)) {
        documents.push(doc);
        keepIds.add(doc.id);
        matches += 1;
      }
    }

    const next = { folders, documents };
    if (Array.isArray(node.entries)) {
      next.entries = node.entries.filter((e) => e && keepIds.has(e.id));
    }
    return { node: next, matches };
  };

  const { node, matches } = filterNode(root);
  return { tree: node, openIds, count: matches };
}
