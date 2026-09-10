// Node test for the wiki sidebar search filter (static/js/wiki-search.js).
// Run: node tests/wiki-search.test.mjs  (or `npm run test:wiki`)
import assert from "node:assert/strict";

import { filterWikiTree } from "../static/js/wiki-search.js";

const doc = (id, title) => ({ id, title, kind: "note", words: 1 });

const folder = (id, name, folders, documents, entries) => ({
  id,
  name,
  folders,
  documents,
  entries: entries || [
    ...folders.map((f) => ({ kind: "folder", id: f.id })),
    ...documents.map((d) => ({ kind: "doc", id: d.id })),
  ],
});

// worldbuilding/
//   1-characters/            Aria
//     1-antagonists/         Vane
//   2-places/                Shiro Pass
//   1-loose.md               Loose Note
const ANTAGONISTS = "worldbuilding/1-characters/1-antagonists";
const CHARACTERS = "worldbuilding/1-characters";
const PLACES = "worldbuilding/2-places";
const VANE = `${ANTAGONISTS}/1-vane`;
const ARIA = `${CHARACTERS}/1-aria`;
const SHIRO = `${PLACES}/1-shiro`;
const LOOSE = "worldbuilding/1-loose";

function fixture() {
  const antagonists = folder(ANTAGONISTS, "Antagonists", [], [doc(VANE, "Vane")]);
  const characters = folder(CHARACTERS, "Characters", [antagonists], [doc(ARIA, "Aria")]);
  const places = folder(PLACES, "Places", [], [doc(SHIRO, "Shiro Pass")]);
  return {
    folders: [characters, places],
    documents: [doc(LOOSE, "Loose Note")],
    entries: [
      { kind: "folder", id: CHARACTERS },
      { kind: "folder", id: PLACES },
      { kind: "doc", id: LOOSE },
    ],
  };
}

const ids = (node) => (node.documents || []).map((d) => d.id);
const folderIds = (node) => (node.folders || []).map((f) => f.id);

// 1. An empty query returns the tree untouched and never forces a folder open.
for (const empty of ["", "   ", null, undefined]) {
  const tree = fixture();
  const res = filterWikiTree(tree, empty);
  assert.equal(res.tree, tree, `query ${JSON.stringify(empty)} returns the same tree`);
  assert.equal(res.count, 4, "all documents counted");
  assert.equal(res.openIds.size, 0, "nothing forced open");
}

// 2. Title match keeps ancestors, drops matched-out branches.
{
  const res = filterWikiTree(fixture(), "ari");
  assert.deepEqual(ids(res.tree), [], "root has no direct matches");
  assert.deepEqual(folderIds(res.tree), [CHARACTERS], "only the ancestor folder survives");
  assert.deepEqual(ids(res.tree.folders[0]), [ARIA], "sibling folder and non-matches dropped");
  assert.deepEqual(folderIds(res.tree.folders[0]), [], "empty branch removed");
  assert.equal(res.count, 1);
  assert.deepEqual([...res.openIds], [CHARACTERS], "ancestor auto-expanded");
}

// 3. Matching is case-insensitive and works mid-word.
{
  const res = filterWikiTree(fixture(), "SHIRO");
  assert.deepEqual(folderIds(res.tree), [PLACES]);
  assert.deepEqual(ids(res.tree.folders[0]), [SHIRO]);
  assert.equal(res.count, 1);
  assert.equal(res.tree.entries.some((e) => e.id === LOOSE), false, "root doc filtered out");
}

// 4. A folder whose own name matches keeps its whole subtree; only that
//    folder is force-opened (nested folders keep their normal expand state).
{
  const res = filterWikiTree(fixture(), "characters");
  assert.deepEqual(folderIds(res.tree), [CHARACTERS]);
  assert.deepEqual(folderIds(res.tree.folders[0]), [ANTAGONISTS], "descendant folder kept");
  assert.deepEqual(ids(res.tree.folders[0]).sort(), [ARIA], "own document kept");
  assert.deepEqual(ids(res.tree.folders[0].folders[0]), [VANE], "grandchild document kept");
  assert.equal(res.count, 2, "both documents under the matched folder counted");
  assert.deepEqual([...res.openIds], [CHARACTERS]);
}

// 5. Deeply nested match force-opens every ancestor on the path.
{
  const res = filterWikiTree(fixture(), "vane");
  assert.deepEqual(folderIds(res.tree), [CHARACTERS]);
  assert.deepEqual(folderIds(res.tree.folders[0]), [ANTAGONISTS]);
  assert.deepEqual(ids(res.tree.folders[0].folders[0]), [VANE]);
  assert.deepEqual(new Set(res.openIds), new Set([CHARACTERS, ANTAGONISTS]));
  assert.equal(res.count, 1);
}

// 6. No matches at all yields an empty tree plus a zero count.
{
  const res = filterWikiTree(fixture(), "zzzznope");
  assert.deepEqual(res.tree.folders, []);
  assert.deepEqual(res.tree.documents, []);
  assert.deepEqual(res.tree.entries, []);
  assert.equal(res.count, 0);
  assert.equal(res.openIds.size, 0);
}

// 7. `entries` keeps the original order, filtered to ids that survived.
{
  const res = filterWikiTree(fixture(), "note");
  assert.deepEqual(res.tree.entries, [{ kind: "doc", id: LOOSE }]);
  assert.deepEqual(ids(res.tree), [LOOSE]);
  assert.equal(res.count, 1);
}

// 8. The input tree is never mutated.
{
  const tree = fixture();
  const before = JSON.stringify(tree);
  filterWikiTree(tree, "aria");
  filterWikiTree(tree, "vane");
  assert.equal(JSON.stringify(tree), before, "fixture unchanged");
}

// 9. Levels without an `entries` key stay without one, so the renderer falls
//    back to folder-then-document order.
{
  const tree = { folders: [], documents: [doc("worldbuilding/1-x", "Xylophone")] };
  const res = filterWikiTree(tree, "xylo");
  assert.equal("entries" in res.tree, false);
  assert.deepEqual(ids(res.tree), ["worldbuilding/1-x"]);
}

// 10. An empty wiki (no folders, no documents) is handled without throwing.
{
  const res = filterWikiTree({ folders: [], documents: [] }, "aria");
  assert.deepEqual(res.tree.folders, []);
  assert.deepEqual(res.tree.documents, []);
  assert.equal(res.count, 0);
  assert.deepEqual(filterWikiTree(null, "").count, 0, "null tree tolerated");
}

console.log("wiki-search: all assertions passed");
