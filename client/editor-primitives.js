import { Extension } from "@tiptap/core";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";

// The wiki's info box is stored as raw HTML: an `<aside class="character-table">`
// wrapping `<table class="ct-rows">` with `ct-*` rows and cells. Once a generic
// table node exists it matches `<table>`/`<tr>`/`<th>`/`<td>` too — including the
// box's — so every generic rule steps aside when the element lives inside the
// box. Without this, loading a wiki entry would tear the box's rows into an
// ordinary table and break its byte-for-byte Markdown round trip.
function inCharacterTable(el) {
  return !!(el.closest && el.closest(".character-table"));
}

// `getAttrs` returning false rejects the rule; returning null keeps the default
// attributes. One helper keeps every table rule consistent.
function unlessCharacterTable() {
  return (el) => (inCharacterTable(el) ? false : null);
}

// Generic tables (GFM pipe tables). Column resizing is off on purpose: it stores
// a `colwidth` attribute that the Markdown serializer cannot express, so a
// resized table would silently lose its widths on reload.
export function makeTableExtensions() {
  const TableNode = Table.extend({
    parseHTML() {
      return [{ tag: "table", getAttrs: unlessCharacterTable() }];
    },
  }).configure({ resizable: false });

  const Row = TableRow.extend({
    parseHTML() {
      return [{ tag: "tr", getAttrs: unlessCharacterTable() }];
    },
  });

  const Header = TableHeader.extend({
    parseHTML() {
      return [{ tag: "th", getAttrs: unlessCharacterTable() }];
    },
  });

  const Cell = TableCell.extend({
    parseHTML() {
      return [{ tag: "td", getAttrs: unlessCharacterTable() }];
    },
  });

  return [TableNode, Row, Header, Cell];
}

// Task lists (GFM `- [ ]` / `- [x]`). tiptap-markdown installs
// `markdown-it-task-lists` for parsing and serializes the `[ ]`/`[x]` marker
// directly, so no custom Markdown work is needed here.
//
// tiptap-markdown gives bullet/ordered lists a `tight` attribute that keeps
// their items on consecutive lines, but it does not know about task lists — so a
// tight `- [ ]` list would otherwise serialize with a blank line between every
// item. This mirrors the same attribute for `taskList`.
const TaskListTight = Extension.create({
  name: "taskListTight",
  addGlobalAttributes() {
    return [
      {
        types: ["taskList"],
        attributes: {
          tight: {
            default: true,
            parseHTML: (element) =>
              element.getAttribute("data-tight") === "true" || !element.querySelector("p"),
            renderHTML: (attributes) => ({
              "data-tight": attributes.tight ? "true" : null,
            }),
          },
        },
      },
    ];
  },
});

export function makeTaskListExtensions() {
  return [TaskList, TaskItem.configure({ nested: true }), TaskListTight];
}
