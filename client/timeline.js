import { Node, mergeAttributes } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { inlineHtml } from "./raw-html.js";

// A timeline is a vertical list of dated events. It is stored in the Markdown as
// **one raw HTML block**, the same shape as the character table (client/
// character-table.js) and for the same reason: raw HTML is the only thing both
// parsers agree on — markdown-it (`html: true`) hands the whole block to
// ProseMirror untouched, python-markdown passes it through to the exporters.
//
//     <aside class="timeline">
//     <table class="tl-rows">
//     <tr class="tl-title"><th colspan="2">Timeline of the War</th></tr>
//     <tr class="tl-event"><td class="tl-date">1066</td><td class="tl-body">Norman Conquest</td></tr>
//     </table>
//     </aside>
//
// Two rules make it work: no blank line anywhere inside the block (that would
// end it), and never the `![alt](src)` form inside it (the interior is not
// parsed as Markdown). Every class name is part of the contract: the parse rules
// match them, and the generic GFM table rules step aside for `.timeline` (see
// `inRawTableBlock` in client/editor-primitives.js) so the block is never torn
// into an ordinary table.

export const DEFAULT_TIMELINE_TITLE = "Timeline";
export const DEFAULT_TIMELINE_EVENTS = 3;

const HEADING_KINDS = ["title", "section"];

/* ------------------------------------------------------------------ *
 * Raw-HTML rendering
 * ------------------------------------------------------------------ */

function headingHtml(node) {
  const kind = HEADING_KINDS.includes(node.attrs.kind) ? node.attrs.kind : "section";
  return `<tr class="tl-${kind}"><th colspan="2">${inlineHtml(node.content)}</th></tr>`;
}

function dateHtml(node) {
  return `<td class="tl-date">${inlineHtml(node.content)}</td>`;
}

function bodyHtml(node) {
  return `<td class="tl-body">${inlineHtml(node.content)}</td>`;
}

function eventHtml(node) {
  const cells = [];
  node.forEach((cell) => {
    if (cell.type.name === "tlDate") cells.push(dateHtml(cell));
    else if (cell.type.name === "tlBody") cells.push(bodyHtml(cell));
  });
  return `<tr class="tl-event">${cells.join("")}</tr>`;
}

function childHtml(node) {
  if (node.type.name === "tlHeading") return headingHtml(node);
  if (node.type.name === "tlEvent") return eventHtml(node);
  return "";
}

// The whole timeline as it is written to the Markdown file.
export function timelineHtml(node) {
  const lines = ['<aside class="timeline">', '<table class="tl-rows">'];
  node.forEach((child) => lines.push(childHtml(child)));
  lines.push("</table>", "</aside>");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Position helpers
 * ------------------------------------------------------------------ */

// The box (and the row/field) the caret currently sits in.
function boxContext(state) {
  const $from = state.selection && state.selection.$from;
  if (!$from) return null;
  let box = null;
  let row = null;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    const name = node.type.name;
    if (!box && name === "timeline") box = { node, pos: $from.before(depth) };
    if (!row && (name === "tlEvent" || name === "tlHeading")) {
      row = { node, pos: $from.before(depth) };
    }
  }
  if (!box) return null;
  return { box, row, field: $from.parent };
}

// Absolute positions of every field (textblock) inside a timeline: the title and
// section headings, each event's date, and its description.
function fieldStarts(box) {
  const starts = [];
  box.node.descendants((node, pos) => {
    if (node.isTextblock) {
      starts.push({ pos: box.pos + 1 + pos + 1, node });
      return false;
    }
    return true;
  });
  return starts;
}

function setCaret(editor, pos) {
  const doc = editor.state.doc;
  const at = Math.max(0, Math.min(pos, doc.content.size));
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(doc, at)));
  editor.view.focus();
}

function rowIndex(box, row) {
  const offset = row.pos - (box.pos + 1);
  let found = -1;
  let index = 0;
  box.node.forEach((child, childOffset) => {
    if (childOffset === offset) found = index;
    index += 1;
  });
  return found;
}

function appendEvent(editor, box) {
  const schema = editor.state.schema;
  const event = schema.nodes.tlEvent.create(null, [
    schema.nodes.tlDate.create(),
    schema.nodes.tlBody.create(),
  ]);
  const insertAt = box.pos + box.node.nodeSize - 1;
  editor.view.dispatch(editor.state.tr.insert(insertAt, event));
  return insertAt + 2; // start of the new date's text
}

function insertRowAfter(editor, box, row, makeNode) {
  const index = row ? rowIndex(box, row) : -1;
  const insertAt = index < 0
    ? box.pos + box.node.nodeSize - 1
    : row.pos + row.node.nodeSize;
  const node = makeNode(editor.state.schema);
  editor.view.dispatch(editor.state.tr.insert(insertAt, node));
  // A heading *is* the textblock (its text starts inside the node); an event's
  // first field is the cell one level further in.
  setCaret(editor, node.isTextblock ? insertAt + 1 : insertAt + 2);
  return true;
}

// The timeline a chip belongs to (its own node position) and, when the caret is
// inside that same timeline, the row the caret is in.
function ownBox(editor, pos) {
  if (typeof pos !== "number") return null;
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "timeline") return null;
  return { node, pos };
}

function caretRowIn(editor, box) {
  const context = boxContext(editor.state);
  if (!context || !context.box || context.box.pos !== box.pos) return null;
  return context.row;
}

function deleteRowAt(editor, box, row) {
  const state = editor.state;
  const index = rowIndex(box, row);
  const current = state.doc.nodeAt(box.pos);
  if (index < 0 || !current || current.childCount <= 1) return false;
  const tr = state.tr.delete(row.pos, row.pos + row.node.nodeSize);
  const after = tr.doc.nodeAt(box.pos);
  if (!after || after.childCount === 0) return false;
  editor.view.dispatch(tr);
  // Land the caret at the field that took the deleted row's place.
  const targetIndex = Math.min(index, after.childCount - 1);
  let targetOffset = null;
  after.forEach((child, offset, childIndex) => {
    if (childIndex === targetIndex) targetOffset = box.pos + 1 + offset;
  });
  if (targetOffset == null) return true;
  const next = fieldStarts({ node: after, pos: box.pos }).find(
    (field) => field.pos >= targetOffset
  );
  if (next) setCaret(editor, next.pos);
  return true;
}

function isNodeEmpty(node) {
  if (!node || !node.isBlock) return false;
  let empty = true;
  node.descendants((child) => {
    if (child.type.name === "image" || child.type.name === "hardBreak") empty = false;
    else if (child.isText && (child.text || "").trim()) empty = false;
    return empty;
  });
  return empty;
}

function removeTimelineAt(editor, pos) {
  const state = editor.state;
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.name !== "timeline") return false;
  let tr = state.tr;
  if (state.doc.childCount === 1) tr = tr.insert(pos + node.nodeSize, state.schema.nodes.paragraph.create());
  tr = tr.delete(pos, pos + node.nodeSize);
  editor.view.dispatch(tr);
  return true;
}

/* ------------------------------------------------------------------ *
 * Insertion
 * ------------------------------------------------------------------ */

export function buildTimeline(schema, { title, events } = {}) {
  const text = (value) => (value ? [schema.text(String(value))] : []);
  const content = [
    schema.nodes.tlHeading.create({ kind: "title" }, text(title || DEFAULT_TIMELINE_TITLE)),
  ];
  const count = Number.isFinite(events) && events > 0 ? Math.floor(events) : DEFAULT_TIMELINE_EVENTS;
  for (let i = 0; i < count; i += 1) {
    content.push(
      schema.nodes.tlEvent.create(null, [
        schema.nodes.tlDate.create(),
        schema.nodes.tlBody.create(),
      ])
    );
  }
  return schema.nodes.timeline.create(null, content);
}

function boxInsertionPoint(state) {
  const selection = state.selection;
  if (selection.node && selection.node.type.name === "timeline") return selection.to;
  const $from = selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    // Never nest inside another bespoke block (their interiors only accept
    // their own rows); the timeline goes after the outer block instead.
    if (name === "timeline" || name === "characterTable") return $from.after(depth);
  }
  // An empty top-level paragraph is where writing is about to happen, not a gap
  // to leave above the block: the timeline goes *before* it, so that paragraph
  // becomes the place to keep writing underneath.
  if ($from.depth === 1 && $from.parent.type.name === "paragraph" && $from.parent.content.size === 0) {
    return $from.before(1);
  }
  if ($from.depth === 0) return state.doc.content.size;
  return $from.after(1);
}

export function insertTimeline(editor, { title, events } = {}) {
  const state = editor.state;
  if (!state.schema.nodes.timeline) return false;
  const node = buildTimeline(state.schema, { title, events });
  const pos = boxInsertionPoint(state);
  let tr = state.tr.insert(pos, node);
  const after = pos + node.nodeSize;
  // A block node at the very end of the document would leave nowhere to keep
  // writing, so a paragraph is added after it.
  if (!tr.doc.resolve(Math.min(after, tr.doc.content.size)).nodeAfter) {
    tr = tr.insert(after, state.schema.nodes.paragraph.create());
  }
  const titleLength = String((node.firstChild && node.firstChild.textContent) || "").length;
  const caret = Math.min(pos + 2 + titleLength, tr.doc.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, caret));
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/* ------------------------------------------------------------------ *
 * Extensions
 * ------------------------------------------------------------------ */

export function makeTimelineNodes() {
  const TlHeading = Node.create({
    name: "tlHeading",
    content: "inline*",
    addAttributes() {
      return {
        kind: {
          default: "section",
          rendered: false,
          parseHTML: (el) => {
            const cls = el.getAttribute("class") || "";
            if (cls.includes("tl-title")) return "title";
            if (cls.includes("tl-section")) return "section";
            return "section";
          },
        },
      };
    },
    parseHTML() {
      return [
        { tag: "tr.tl-title" },
        { tag: "tr.tl-section" },
      ];
    },
    renderHTML({ node, HTMLAttributes }) {
      const kind = HEADING_KINDS.includes(node.attrs.kind) ? node.attrs.kind : "section";
      return [
        "tr",
        mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: `tl-${kind}` }),
        ["th", { colspan: "2" }, 0],
      ];
    },
    addStorage() {
      return { markdown: { serialize: (state, node) => state.write(headingHtml(node)) } };
    },
  });

  const TlDate = Node.create({
    name: "tlDate",
    content: "inline*",
    parseHTML() {
      return [{ tag: "td.tl-date" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["td", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: "tl-date" }), 0];
    },
    addStorage() {
      return { markdown: { serialize: (state, node) => state.write(dateHtml(node)) } };
    },
  });

  const TlBody = Node.create({
    name: "tlBody",
    content: "inline*",
    parseHTML() {
      return [{ tag: "td.tl-body" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["td", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: "tl-body" }), 0];
    },
    addStorage() {
      return { markdown: { serialize: (state, node) => state.write(bodyHtml(node)) } };
    },
  });

  const TlEvent = Node.create({
    name: "tlEvent",
    content: "(tlDate | tlBody)*",
    parseHTML() {
      return [{ tag: "tr.tl-event" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["tr", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: "tl-event" }), 0];
    },
    addStorage() {
      return { markdown: { serialize: (state, node) => state.write(eventHtml(node)) } };
    },
  });

  const Timeline = Node.create({
    name: "timeline",
    group: "block",
    content: "(tlHeading | tlEvent)*",
    parseHTML() {
      return [{ tag: "aside.timeline" }];
    },
    renderHTML({ HTMLAttributes }) {
      return [
        "aside",
        mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: "timeline" }),
        ["table", { class: "tl-rows" }, 0],
      ];
    },
    addStorage() {
      return {
        markdown: {
          serialize: (state, node) => {
            state.write(timelineHtml(node));
            state.closeBlock(node);
          },
        },
      };
    },
    addKeyboardShortcuts() {
      const editor = this.editor;
      return {
        Tab: () => {
          const context = boxContext(editor.state);
          if (!context) return false;
          const from = editor.state.selection.from;
          const next = fieldStarts(context.box).find((field) => field.pos > from);
          if (next) {
            setCaret(editor, next.pos + next.node.content.size);
            return true;
          }
          const caret = appendEvent(editor, context.box);
          setCaret(editor, caret);
          return true;
        },
        "Shift-Tab": () => {
          const context = boxContext(editor.state);
          if (!context) return false;
          const from = editor.state.selection.from;
          const fields = fieldStarts(context.box).filter((field) => field.pos < from);
          const previous = fields[fields.length - 1];
          if (!previous) return false;
          setCaret(editor, previous.pos + previous.node.content.size);
          return true;
        },
        Enter: () => {
          const context = boxContext(editor.state);
          if (!context) return false;
          const from = editor.state.selection.from;
          const next = fieldStarts(context.box).find((field) => field.pos > from);
          if (next) {
            setCaret(editor, next.pos + next.node.content.size);
            return true;
          }
          const caret = appendEvent(editor, context.box);
          setCaret(editor, caret);
          return true;
        },
        Backspace: () => {
          const { selection } = editor.state;
          if (!selection.empty) return false;
          if (selection.$from.parentOffset !== 0) return false;
          const context = boxContext(editor.state);
          if (!context || !context.row) return false;
          // An empty event folds away; otherwise the key is swallowed so cells
          // are never joined or selected (a cell has no meaning on its own).
          if (
            isNodeEmpty(context.row.node) &&
            context.box.node.childCount > 1 &&
            deleteRowAt(editor, context.box, context.row)
          ) {
            return true;
          }
          return true;
        },
      };
    },
    addNodeView() {
      return ({ getPos, editor }) => {
        const wrap = document.createElement("div");
        wrap.className = "tl-wrap";

        const aside = document.createElement("aside");
        aside.className = "timeline";
        const table = document.createElement("table");
        table.className = "tl-rows";
        aside.append(table);

        const chips = document.createElement("div");
        chips.className = "tl-chips";
        const chip = (label, title, onclick, cls) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `tl-chip${cls ? ` ${cls}` : ""}`;
          button.textContent = label;
          button.title = title;
          button.addEventListener("mousedown", (event) => event.preventDefault());
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onclick();
          });
          return button;
        };
        const caretRowOfKind = (targetEditor, box, kinds) => {
          const row = caretRowIn(targetEditor, box);
          return row && kinds.includes(row.node.type.name) ? row : null;
        };
        chips.append(
          chip("+ Event", "Add an event below", () => {
            const box = ownBox(editor, getPos());
            if (!box) return;
            // Below the event being edited; when the caret is on a heading or
            // nothing at all, the new event goes to the bottom.
            insertRowAfter(editor, box, caretRowOfKind(editor, box, ["tlEvent"]), (schema) =>
              schema.nodes.tlEvent.create(null, [schema.nodes.tlDate.create(), schema.nodes.tlBody.create()])
            );
          }),
          chip("+ Era", "Add an era (section) heading below", () => {
            const box = ownBox(editor, getPos());
            if (!box) return;
            insertRowAfter(editor, box, caretRowOfKind(editor, box, ["tlEvent", "tlHeading"]), (schema) =>
              schema.nodes.tlHeading.create({ kind: "section" })
            );
          }),
          chip("− Event", "Remove the event the caret is in", () => {
            const box = ownBox(editor, getPos());
            if (!box) return;
            const row = caretRowOfKind(editor, box, ["tlEvent", "tlHeading"]);
            if (row) deleteRowAt(editor, box, row);
          }),
          chip(
            "×",
            "Delete the timeline",
            () => {
              const pos = getPos();
              if (typeof pos === "number") removeTimelineAt(editor, pos);
            },
            "danger"
          )
        );

        wrap.append(aside, chips);

        return {
          dom: wrap,
          contentDOM: table,
          stopEvent: (event) => !!(event.target.closest && event.target.closest(".tl-chip")),
          update: (next) => next.type.name === "timeline",
        };
      };
    },
  });

  return [Timeline, TlHeading, TlEvent, TlDate, TlBody];
}
