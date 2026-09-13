// Unit tests for the pure board helpers. The module takes a tree and returns
// new values, so ordering, scope flattening, beat grouping and the reorder math
// are pinned without a DOM.
//
// Run: node tests/board-model.test.mjs  (or `npm run test:board-model`)
import assert from "node:assert/strict";

import {
  STATUS_OPTIONS,
  LABELS,
  labelColor,
  scopeEntries,
  docEntries,
  folderOptions,
  moveItem,
  beatColumns,
  findDocObject,
  folderWordCount,
  descendantDocs,
  progressPercent,
  synopsisSnippet,
} from "../static/js/board-model.js";

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
  entries: [
    { kind: "folder", id: "01-part" },
    { kind: "doc", id: "00-front.md" },
  ],
  folders: [
    {
      id: "01-part",
      name: "Part One",
      entries: [
        { kind: "doc", id: "01-part/00-prologue.md" },
        { kind: "folder", id: "01-part/01-ch" },
        { kind: "doc", id: "01-part/01-scene.md" },
      ],
      folders: [
        {
          id: "01-part/01-ch",
          name: "Chapter",
          entries: [{ kind: "doc", id: "01-part/01-ch/01-scene.md" }],
          folders: [],
          documents: [
            {
              id: "01-part/01-ch/01-scene.md",
              title: "Scene",
              kind: "note",
              words: 5,
              beat: "midpoint",
              status: "draft",
            },
          ],
        },
      ],
      documents: [
        {
          id: "01-part/00-prologue.md",
          title: "Prologue",
          kind: "chapter",
          words: 100,
          synopsis: "An opening.",
          beat: "opening-image",
          status: "final",
          label: "blue",
          tags: ["a"],
          target: 200,
        },
        {
          id: "01-part/01-scene.md",
          title: "Scene One",
          kind: "note",
          words: 50,
          beat: "",
          status: "",
        },
      ],
    },
  ],
  documents: [{ id: "00-front.md", title: "Front", kind: "note", words: 10 }],
};

console.log("board-model:");

check("scopeEntries returns the folder's mixed entries in order", () => {
  const { entries } = scopeEntries(TREE, "", "");
  assert.deepEqual(entries.map((e) => e.id), ["01-part", "00-front.md"]);
  assert.equal(entries[0].isFolder, true);
  assert.equal(entries[0].name, "Part One");
  assert.equal(entries[1].title, "Front");
});

check("scopeEntries carries the full summary for docs", () => {
  const { entries } = scopeEntries(TREE, "01-part", "");
  assert.deepEqual(entries.map((e) => e.id), [
    "01-part/00-prologue.md",
    "01-part/01-ch",
    "01-part/01-scene.md",
  ]);
  assert.equal(entries[0].beat, "opening-image");
  assert.equal(entries[0].target, 200);
  assert.equal(entries[1].isFolder, true);
});

check("scopeEntries falls back to folders-then-docs without an entry order", () => {
  const bare = {
    folders: [{ id: "f", name: "F", folders: [], documents: [] }],
    documents: [{ id: "d.md", title: "D" }],
  };
  const { entries } = scopeEntries(bare, "", "");
  assert.deepEqual(entries.map((e) => e.id), ["f", "d.md"]);
});

check("docEntries filters out folders", () => {
  const { entries } = scopeEntries(TREE, "01-part", "");
  assert.deepEqual(docEntries(entries).map((e) => e.id), [
    "01-part/00-prologue.md",
    "01-part/01-scene.md",
  ]);
});

check("folderOptions lists every folder with its depth", () => {
  assert.deepEqual(folderOptions(TREE, ""), [
    { id: "", depth: 0, name: "Project root" },
    { id: "01-part", depth: 1, name: "Part One" },
    { id: "01-part/01-ch", depth: 2, name: "Chapter" },
  ]);
});

check("moveItem reorders and clamps out-of-range moves", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  assert.deepEqual(moveItem(["a", "b"], 9, 0), ["a", "b"]);
});

check("beatColumns groups by beat, then orphans, then unassigned", () => {
  const docs = descendantDocs(TREE.folders[0]);
  docs.push({ id: "ghost.md", title: "Ghost", beat: "ghost-beat" });
  const columns = beatColumns(docs, [
    { id: "opening-image", name: "Opening Image" },
    { id: "midpoint", name: "Midpoint" },
  ]);
  assert.deepEqual(columns.map((c) => c.id), [
    "opening-image",
    "midpoint",
    "ghost-beat",
    "",
  ]);
  assert.deepEqual(columns[0].docs.map((d) => d.id), ["01-part/00-prologue.md"]);
  assert.deepEqual(columns[1].docs.map((d) => d.id), ["01-part/01-ch/01-scene.md"]);
  assert.deepEqual(columns[2].docs.map((d) => d.id), ["ghost.md"]);
  assert.deepEqual(columns[3].docs.map((d) => d.id), ["01-part/01-scene.md"]);
  assert.equal(columns[3].unassigned, true);
});

check("findDocObject searches nested folders", () => {
  assert.equal(findDocObject(TREE, "01-part/01-ch/01-scene.md").title, "Scene");
  assert.equal(findDocObject(TREE, "missing.md"), null);
  assert.equal(findDocObject(null, "x"), null);
});

check("folderWordCount sums the whole subtree", () => {
  assert.equal(folderWordCount(TREE), 165);
  assert.equal(folderWordCount(TREE.folders[0]), 155);
});

check("progressPercent clamps to 0..100", () => {
  assert.equal(progressPercent(100, 200), 50);
  assert.equal(progressPercent(500, 200), 100);
  assert.equal(progressPercent(50, 0), 0);
});

check("synopsisSnippet collapses whitespace and truncates", () => {
  assert.equal(synopsisSnippet("  a\n b  "), "a b");
  assert.equal(synopsisSnippet("abcdef", 4), "abc…");
});

check("labelColor resolves a palette key and ignores unknown ones", () => {
  assert.equal(labelColor("blue"), LABELS.find((l) => l.id === "blue").color);
  assert.equal(labelColor("nope"), "transparent");
  assert.equal(labelColor(""), "transparent");
});

check("status options are the documented picklist", () => {
  assert.deepEqual(STATUS_OPTIONS, ["idea", "outlined", "draft", "revised", "final"]);
});

if (failures) {
  console.log(`board-model: ${failures} failure(s)`);
  process.exit(1);
}
console.log("board-model: ok");
