// Unit tests for the pure document-tree helpers. The module takes trees as
// arguments and returns new values, so these pin ordering, path prettifying and
// the recursive counts without a DOM.
//
// Run: node tests/doc-tree.test.mjs  (or `npm run test:doctree`)
import assert from "node:assert/strict";

import {
  collectTree,
  allDocs,
  findDocIn,
  resolveDocByTitle,
  prettyPath,
  folderNodeIn,
  countDocs,
  folderContainsDoc,
  firstDocIn,
  expandAll,
} from "../static/js/doc-tree.js";

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}\n      ${err.message}`);
  }
}

const TREE = {
  folders: [
    {
      id: "01-part",
      name: "Part One",
      folders: [
        {
          id: "01-part/01-ch",
          name: "Chapter",
          folders: [],
          documents: [{ id: "01-part/01-ch/01-scene.md", title: "Scene", kind: "note" }],
        },
      ],
      documents: [{ id: "01-part/00-prologue.md", title: "Prologue", kind: "chapter" }],
    },
  ],
  documents: [{ id: "00-front.md", title: "Front", kind: "note" }],
};

const WIKI = {
  folders: [],
  documents: [{ id: "worldbuilding/fauna/wolf.md", title: "Wolf", kind: "note" }],
};

console.log("doc-tree:");

check("collectTree flattens depth-first and remembers the folder", () => {
  assert.deepEqual(collectTree(TREE), [
    { id: "00-front.md", title: "Front", kind: "note", folder: "" },
    { id: "01-part/00-prologue.md", title: "Prologue", kind: "chapter", folder: "01-part" },
    { id: "01-part/01-ch/01-scene.md", title: "Scene", kind: "note", folder: "01-part/01-ch" },
  ]);
});

check("collectTree tolerates a missing tree", () => {
  assert.deepEqual(collectTree(null), []);
  assert.deepEqual(collectTree(undefined), []);
});

check("allDocs concatenates Write then Wiki", () => {
  const ids = allDocs(TREE, WIKI).map((d) => d.id);
  assert.deepEqual(ids, [
    "00-front.md",
    "01-part/00-prologue.md",
    "01-part/01-ch/01-scene.md",
    "worldbuilding/fauna/wolf.md",
  ]);
});

check("findDocIn finds a document or returns null", () => {
  assert.equal(findDocIn(TREE, "01-part/00-prologue.md").title, "Prologue");
  assert.equal(findDocIn(TREE, "missing.md"), null);
  assert.equal(findDocIn(null, "x.md"), null);
});

check("resolveDocByTitle matches a title, then an id, case-insensitively", () => {
  const docs = collectTree(TREE);
  assert.equal(resolveDocByTitle(docs, "prologue").id, "01-part/00-prologue.md");
  assert.equal(resolveDocByTitle(docs, "  00-FRONT.MD  ").id, "00-front.md");
  assert.equal(resolveDocByTitle(docs, ""), null);
  assert.equal(resolveDocByTitle(docs, "missing"), null);
});

check("prettyPath strips numeric prefixes and joins folders", () => {
  assert.equal(prettyPath({ id: "01-part/00-prologue.md", title: "Prologue" }), "part/Prologue");
  assert.equal(prettyPath({ id: "00-front.md", title: "Front" }), "Front");
  assert.equal(prettyPath({ id: "01-part/01-ch/01-scene.md", title: "Scene" }), "part/ch/Scene");
  assert.equal(prettyPath({ id: "x.md" }), "x.md");
});

check("folderNodeIn returns the root, a nested folder, or an empty fallback", () => {
  assert.equal(folderNodeIn(TREE, "", ""), TREE);
  assert.equal(folderNodeIn(TREE, "01-part/01-ch", "").name, "Chapter");
  assert.deepEqual(folderNodeIn(TREE, "nope", ""), { folders: [], documents: [] });
  assert.equal(folderNodeIn(TREE, "root", "root"), TREE);
});

check("countDocs counts the whole subtree", () => {
  assert.equal(countDocs(TREE), 3);
  assert.equal(countDocs(TREE.folders[0]), 2);
  assert.equal(countDocs({ folders: [], documents: [] }), 0);
});

check("folderContainsDoc searches nested folders", () => {
  assert.equal(folderContainsDoc(TREE, "01-part/01-ch/01-scene.md"), true);
  assert.equal(folderContainsDoc(TREE, "nope.md"), false);
});

check("firstDocIn is depth-first: own documents before subfolders", () => {
  assert.equal(firstDocIn(TREE).id, "00-front.md");
  assert.equal(
    firstDocIn({ folders: [TREE.folders[0]], documents: [] }).id,
    "01-part/00-prologue.md"
  );
  assert.equal(firstDocIn({ folders: [], documents: [] }), null);
  assert.equal(firstDocIn(null), null);
});

check("expandAll collects every folder id", () => {
  const set = new Set();
  expandAll(TREE, set);
  assert.deepEqual([...set].sort(), ["01-part", "01-part/01-ch"]);
  assert.equal(expandAll(null, set), set);
});

if (failures) {
  console.log(`doc-tree: ${failures} failure(s)`);
  process.exit(1);
}
console.log("doc-tree: ok");
