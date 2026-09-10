import { Node, mergeAttributes } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import {
  escapeHtmlAttr,
  imageAltFromFileName,
  imageHtmlTag,
  isImageFile,
  parseImageWidth,
} from "../static/js/image-utils.js";

// A character table is the wiki's right-hand info box (the Fandom "infobox"):
// a floating frame holding a title, a subtitle, a portrait and label/value
// rows. It is stored in the Markdown as **one raw HTML block**:
//
//     <aside class="character-table" data-width="340">
//     <table class="ct-rows">
//     <tr class="ct-title"><th colspan="2">Übel</th></tr>
//     <tr class="ct-section"><th colspan="2">Biographical Information</th></tr>
//     <tr class="ct-row"><td class="ct-label">Gender</td><td class="ct-value">Female</td></tr>
//     </table>
//     </aside>
//
// Raw HTML is what both parsers agree on: markdown-it (`html: true`) hands the
// whole block to ProseMirror untouched, python-markdown passes it through to
// the exporters. Two rules make it work:
//   * no blank line anywhere inside the block (that would end it), and
//   * never the `![alt](src)` form inside it — the interior is not parsed as
//     Markdown, so a picture must always be written as an `<img>` tag.
//
// Every class name is part of the contract: the parse rules match them, so a
// document's *other* HTML (a hand-written <table>, a stray <aside>) keeps
// behaving exactly as it did before this feature existed.

export const MIN_CHARACTER_WIDTH = 200;
export const DEFAULT_CHARACTER_WIDTH = 340;

// What the ribbon button inserts. The fields match the reference info box;
// anything unwanted is removed with the "− Row" chip.
export const DEFAULT_CHARACTER_SECTIONS = [
  [
    "Biographical Information",
    ["Aliases", "Gender", "Species", "Class", "Rank", "Affiliation", "Relatives", "Status"],
  ],
  ["Physical Description", ["Hair Color", "Eye Color"]],
  ["Series Information", ["Manga Debut", "Anime Debut", "Japanese VA", "English VA"]],
];

const HEADING_KINDS = ["title", "subtitle", "section"];

/* ------------------------------------------------------------------ *
 * Raw-HTML rendering
 * ------------------------------------------------------------------ */

function escText(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Marks this editor can carry into the box. A mark that is not listed keeps its
// text and loses its formatting rather than emitting markup we cannot parse.
function markTag(mark) {
  switch (mark.type.name) {
    case "bold":
      return ["<strong>", "</strong>"];
    case "italic":
      return ["<em>", "</em>"];
    case "underline":
      return ["<u>", "</u>"];
    case "strike":
      return ["<s>", "</s>"];
    case "code":
      return ["<code>", "</code>"];
    case "link": {
      const href = String((mark.attrs && mark.attrs.href) || "");
      return href ? [`<a href="${escapeHtmlAttr(href)}">`, "</a>"] : null;
    }
    case "fontSize":
      return mark.attrs && mark.attrs.size
        ? [`<span style="font-size:${parseInt(mark.attrs.size, 10)}px">`, "</span>"]
        : null;
    case "fontFamily":
      return mark.attrs && mark.attrs.family
        ? [`<span style="font-family:${escapeHtmlAttr(mark.attrs.family)}">`, "</span>"]
        : null;
    default:
      return null;
  }
}

function markedText(node) {
  let html = escText(node.text || "");
  for (const mark of node.marks || []) {
    const tag = markTag(mark);
    if (tag) html = tag[0] + html + tag[1];
  }
  return html;
}

// Inline content of one cell/heading/paragraph, as raw HTML.
function inlineHtml(content) {
  let html = "";
  content.forEach((child) => {
    if (child.isText) {
      html += markedText(child);
    } else if (child.type.name === "image") {
      html += imageHtmlTag(child.attrs || {});
    } else if (child.type.name === "hardBreak") {
      html += "<br>";
    } else if (child.isTextblock || child.isInline) {
      html += inlineHtml(child.content);
    }
  });
  return html;
}

function headingHtml(node) {
  const kind = HEADING_KINDS.includes(node.attrs.kind) ? node.attrs.kind : "section";
  return `<tr class="ct-${kind}"><th colspan="2">${inlineHtml(node.content)}</th></tr>`;
}

function portraitHtml(node) {
  const inner = [];
  node.forEach((child) => {
    if (child.type.name === "paragraph") inner.push(`<p>${inlineHtml(child.content)}</p>`);
  });
  return `<tr class="ct-portrait"><td colspan="2">${inner.join("")}</td></tr>`;
}

function rowHtml(node) {
  const cells = [];
  node.forEach((cell) => {
    if (cell.type.name === "ctLabel" || cell.type.name === "ctValue") {
      const cls = cell.type.name === "ctLabel" ? "ct-label" : "ct-value";
      cells.push(`<td class="${cls}">${inlineHtml(cell.content)}</td>`);
    }
  });
  return `<tr class="ct-row">${cells.join("")}</tr>`;
}

function rowChildHtml(node) {
  if (node.type.name === "ctHeading") return headingHtml(node);
  if (node.type.name === "ctPortrait") return portraitHtml(node);
  if (node.type.name === "ctRow") return rowHtml(node);
  return "";
}

// The whole box as it is written to the Markdown file.
export function characterTableHtml(node) {
  const width = parseImageWidth(node.attrs && node.attrs.width);
  const open = `<aside class="character-table"${width ? ` data-width="${width}"` : ""}>`;
  const lines = [open, '<table class="ct-rows">'];
  node.forEach((child) => lines.push(rowChildHtml(child)));
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
  let table = null;
  let row = null;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    const name = node.type.name;
    if (!table && name === "characterTable") table = { node, pos: $from.before(depth) };
    if (!row && (name === "ctRow" || name === "ctHeading" || name === "ctPortrait")) {
      row = { node, pos: $from.before(depth) };
    }
  }
  if (!table) return null;
  return { table, row, field: $from.parent };
}

// Absolute positions of every field (textblock) inside a box: the title and
// section headings, each label/value cell, and a portrait's caption paragraph.
function fieldStarts(table) {
  const starts = [];
  table.node.descendants((node, pos) => {
    if (node.isTextblock) {
      starts.push({ pos: table.pos + 1 + pos + 1, node });
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

function rowIndex(table, row) {
  const offset = row.pos - (table.pos + 1);
  let found = -1;
  let index = 0;
  table.node.forEach((child, childOffset) => {
    if (childOffset === offset) found = index;
    index += 1;
  });
  return found;
}

function appendRow(editor, table) {
  const schema = editor.state.schema;
  const row = schema.nodes.ctRow.create(null, [
    schema.nodes.ctLabel.create(),
    schema.nodes.ctValue.create(),
  ]);
  const insertAt = table.pos + table.node.nodeSize - 1;
  editor.view.dispatch(editor.state.tr.insert(insertAt, row));
  return insertAt + 2; // start of the new label's text
}

function insertRowAfter(editor, table, row, makeNode) {
  const index = row ? rowIndex(table, row) : -1;
  const insertAt = index < 0
    ? table.pos + table.node.nodeSize - 1
    : row.pos + row.node.nodeSize;
  const node = makeNode(editor.state.schema);
  editor.view.dispatch(editor.state.tr.insert(insertAt, node));
  // A heading *is* the textblock (its text starts inside the node); a row's
  // first field is the cell one level further in.
  setCaret(editor, node.isTextblock ? insertAt + 1 : insertAt + 2);
  return true;
}

// The box a chip belongs to (its own node position) and, when the caret is
// inside that same box, the row the caret is in.
function ownBox(editor, pos) {
  if (typeof pos !== "number") return null;
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "characterTable") return null;
  return { node, pos };
}

function caretRowIn(editor, table) {
  const context = boxContext(editor.state);
  if (!context || !context.table || context.table.pos !== table.pos) return null;
  return context.row;
}

function deleteRowAt(editor, table, row) {
  const state = editor.state;
  const index = rowIndex(table, row);
  const box = state.doc.nodeAt(table.pos);
  if (index < 0 || !box || box.childCount <= 1) return false;
  const tr = state.tr.delete(row.pos, row.pos + row.node.nodeSize);
  const after = tr.doc.nodeAt(table.pos);
  if (!after || after.childCount === 0) return false;
  editor.view.dispatch(tr);
  // Land the caret at the field that took the deleted row's place.
  const targetIndex = Math.min(index, after.childCount - 1);
  let targetOffset = null;
  after.forEach((child, offset, childIndex) => {
    if (childIndex === targetIndex) targetOffset = table.pos + 1 + offset;
  });
  if (targetOffset == null) return true;
  const next = fieldStarts({ node: after, pos: table.pos }).find(
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

function removeTableAt(editor, pos) {
  const state = editor.state;
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.name !== "characterTable") return false;
  let tr = state.tr;
  if (state.doc.childCount === 1) tr = tr.insert(pos + node.nodeSize, state.schema.nodes.paragraph.create());
  tr = tr.delete(pos, pos + node.nodeSize);
  editor.view.dispatch(tr);
  return true;
}

// The box's picture slot at (or containing) a document position, if any.
export function portraitTargetAt(state, pos) {
  const doc = state.doc;
  const at = Math.max(0, Math.min(Number(pos) || 0, doc.content.size));
  let found = null;
  try {
    const $pos = doc.resolve(at);
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      if ($pos.node(depth).type.name === "ctPortrait") {
        found = $pos.before(depth);
        break;
      }
    }
  } catch {
    return null;
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Insertion
 * ------------------------------------------------------------------ */

export function buildCharacterTable(schema, { title } = {}) {
  const text = (value) => (value ? [schema.text(String(value))] : []);
  const content = [
    schema.nodes.ctHeading.create({ kind: "title" }, text(title || "Character")),
    schema.nodes.ctHeading.create({ kind: "subtitle" }, text("")),
    schema.nodes.ctPortrait.create(null, []),
  ];
  for (const [section, labels] of DEFAULT_CHARACTER_SECTIONS) {
    content.push(schema.nodes.ctHeading.create({ kind: "section" }, text(section)));
    for (const label of labels) {
      content.push(
        schema.nodes.ctRow.create(null, [
          schema.nodes.ctLabel.create(null, text(label)),
          schema.nodes.ctValue.create(null, text("")),
        ])
      );
    }
  }
  return schema.nodes.characterTable.create(null, content);
}

function boxInsertionPoint(state) {
  const selection = state.selection;
  if (selection.node && selection.node.type.name === "characterTable") return selection.to;
  const $from = selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "characterTable") return $from.after(depth);
  }
  // An empty top-level paragraph is where writing is about to happen, not a gap
  // to leave above the box: the box goes *before* it, so that paragraph becomes
  // the place to keep writing underneath (and an empty document does not open
  // with a blank line beside the floating box).
  if ($from.depth === 1 && $from.parent.type.name === "paragraph" && $from.parent.content.size === 0) {
    return $from.before(1);
  }
  if ($from.depth === 0) return state.doc.content.size;
  return $from.after(1);
}

export function insertCharacterTable(editor, { title } = {}) {
  const state = editor.state;
  if (!state.schema.nodes.characterTable) return false;
  const node = buildCharacterTable(state.schema, { title });
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

// Upload the dropped/selected files and put the first one in the box's
// portrait slot. Nothing is inserted before the upload resolves, so an autosave
// can never see a half-updated document.
export async function setPortraitFromFiles(view, pos, files, imageOpts) {
  const wanted = (files || []).filter(isImageFile);
  if (!wanted.length || !imageOpts || !imageOpts.uploadImage) return false;
  const initial = view.state.doc.nodeAt(pos);
  if (!initial || initial.type.name !== "ctPortrait") return false;
  if (imageOpts.onUploadState) imageOpts.onUploadState(true);
  try {
    let info = null;
    let used = null;
    for (const file of wanted) {
      try {
        info = await imageOpts.uploadImage(file);
      } catch (err) {
        if (imageOpts.onImageError) imageOpts.onImageError((err && err.message) || String(err));
        continue;
      }
      if (info && info.path) {
        used = file;
        break;
      }
      info = null;
    }
    if (!info || !info.path || !view || view.isDestroyed) return false;
    const schema = view.state.schema;
    const target = view.state.doc.nodeAt(pos);
    if (!target || target.type.name !== "ctPortrait") return false;
    const image = schema.nodes.image.create({
      src: info.path,
      alt: imageAltFromFileName(used && used.name),
      title: null,
      width: null,
    });
    const paragraph = schema.nodes.paragraph.create(null, [image]);
    view.dispatch(
      view.state.tr.replaceWith(pos + 1, pos + 1 + target.content.size, paragraph)
    );
    return true;
  } finally {
    if (imageOpts.onUploadState) imageOpts.onUploadState(false);
  }
}

function clampCharacterWidth(px, max) {
  const limit = Math.max(MIN_CHARACTER_WIDTH, Math.round(Number(max) || 0));
  const value = Math.round(Number(px) || 0);
  if (value <= MIN_CHARACTER_WIDTH) return MIN_CHARACTER_WIDTH;
  const clamped = Math.min(value, limit);
  return Math.max(MIN_CHARACTER_WIDTH, Math.round(clamped / 10) * 10);
}

/* ------------------------------------------------------------------ *
 * Extensions
 * ------------------------------------------------------------------ */

export function makeCharacterTableNodes(imageOpts = {}) {
  const { onPickPortrait } = imageOpts;

  const CtHeading = Node.create({
    name: "ctHeading",
    content: "inline*",
    addAttributes() {
      return {
        kind: {
          default: "section",
          rendered: false,
          parseHTML: (el) => {
            const cls = el.getAttribute("class") || "";
            if (cls.includes("ct-title")) return "title";
            if (cls.includes("ct-subtitle")) return "subtitle";
            return "section";
          },
        },
      };
    },
    parseHTML() {
      return [
        { tag: "tr.ct-title" },
        { tag: "tr.ct-subtitle" },
        { tag: "tr.ct-section" },
      ];
    },
    renderHTML({ node, HTMLAttributes }) {
      const kind = HEADING_KINDS.includes(node.attrs.kind) ? node.attrs.kind : "section";
      return [
        "tr",
        mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: `ct-${kind}` }),
        ["th", { colspan: "2" }, 0],
      ];
    },
    addStorage() {
      return { markdown: { serialize: (state, node) => state.write(headingHtml(node)) } };
    },
  });

  const CtPortrait = Node.create({
    name: "ctPortrait",
    // `paragraph*` (not `image*`): a node whose content only allows images is
    // still a *textblock*, and typing into a textblock that forbids text can
    // build an invalid document. With paragraphs the caret only ever lands in
    // a legal textblock — and the paragraph doubles as the picture's caption.
    content: "paragraph*",
    parseHTML() {
      return [{ tag: "tr.ct-portrait" }];
    },
    renderHTML({ HTMLAttributes }) {
      return [
        "tr",
        mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: "ct-portrait" }),
        ["td", { colspan: "2" }, 0],
      ];
    },
    addStorage() {
      return { markdown: { serialize: (state, node) => state.write(portraitHtml(node)) } };
    },
  });

  const CtLabel = Node.create({
    name: "ctLabel",
    content: "inline*",
    parseHTML() {
      return [{ tag: "td.ct-label" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["td", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: "ct-label" }), 0];
    },
    addStorage() {
      return { markdown: { serialize: (state, node) => state.write(`<td class="ct-label">${inlineHtml(node.content)}</td>`) } };
    },
  });

  const CtValue = Node.create({
    name: "ctValue",
    content: "inline*",
    parseHTML() {
      return [{ tag: "td.ct-value" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["td", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: "ct-value" }), 0];
    },
    addStorage() {
      return { markdown: { serialize: (state, node) => state.write(`<td class="ct-value">${inlineHtml(node.content)}</td>`) } };
    },
  });

  const CtRow = Node.create({
    name: "ctRow",
    content: "(ctLabel | ctValue)*",
    parseHTML() {
      return [{ tag: "tr.ct-row" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["tr", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: "ct-row" }), 0];
    },
    addStorage() {
      return { markdown: { serialize: (state, node) => state.write(rowHtml(node)) } };
    },
  });

  const CharacterTable = Node.create({
    name: "characterTable",
    group: "block",
    content: "(ctHeading | ctPortrait | ctRow)*",
    addAttributes() {
      return {
        width: {
          default: null,
          rendered: false,
          parseHTML: (el) => parseImageWidth(el.getAttribute("data-width")),
        },
      };
    },
    parseHTML() {
      return [{ tag: "aside.character-table" }];
    },
    renderHTML({ node, HTMLAttributes }) {
      const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: "character-table",
      });
      const width = parseImageWidth(node.attrs.width);
      if (width) attrs["data-width"] = String(width);
      return ["aside", attrs, ["table", { class: "ct-rows" }, 0]];
    },
    addStorage() {
      return {
        markdown: {
          serialize: (state, node) => {
            state.write(characterTableHtml(node));
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
          const next = fieldStarts(context.table).find((field) => field.pos > from);
          if (next) {
            setCaret(editor, next.pos + next.node.content.size);
            return true;
          }
          const caret = appendRow(editor, context.table);
          setCaret(editor, caret);
          return true;
        },
        "Shift-Tab": () => {
          const context = boxContext(editor.state);
          if (!context) return false;
          const from = editor.state.selection.from;
          const fields = fieldStarts(context.table).filter((field) => field.pos < from);
          const previous = fields[fields.length - 1];
          if (!previous) return false;
          setCaret(editor, previous.pos + previous.node.content.size);
          return true;
        },
        Enter: () => {
          const context = boxContext(editor.state);
          if (!context) return false;
          const from = editor.state.selection.from;
          const next = fieldStarts(context.table).find((field) => field.pos > from);
          if (next) {
            setCaret(editor, next.pos + next.node.content.size);
            return true;
          }
          const caret = appendRow(editor, context.table);
          setCaret(editor, caret);
          return true;
        },
        Backspace: () => {
          const { selection } = editor.state;
          if (!selection.empty) return false;
          if (selection.$from.parentOffset !== 0) return false;
          const context = boxContext(editor.state);
          if (!context || !context.row) return false;
          // An empty row folds away; otherwise the key is swallowed so cells are
          // never joined or selected (a cell has no meaning on its own).
          if (
            isNodeEmpty(context.row.node) &&
            context.table.node.childCount > 1 &&
            deleteRowAt(editor, context.table, context.row)
          ) {
            return true;
          }
          return true;
        },
      };
    },
    addNodeView() {
      return ({ node, getPos, editor }) => {
        const wrap = document.createElement("div");
        wrap.className = "ct-wrap";

        const aside = document.createElement("aside");
        aside.className = "character-table";
        const table = document.createElement("table");
        table.className = "ct-rows";
        aside.append(table);

        const chips = document.createElement("div");
        chips.className = "ct-chips";
        const chip = (label, title, onclick, cls) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `ct-chip${cls ? ` ${cls}` : ""}`;
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
        const caretRowOfKind = (targetEditor, table, kinds) => {
          const row = caretRowIn(targetEditor, table);
          return row && kinds.includes(row.node.type.name) ? row : null;
        };
        chips.append(
          chip("+ Row", "Add a label/value row below", () => {
            const table = ownBox(editor, getPos());
            if (!table) return;
            // Below the row being edited; when the caret is on the title, the
            // subtitle or nothing at all, the new row goes to the bottom.
            insertRowAfter(editor, table, caretRowOfKind(editor, table, ["ctRow"]), (schema) =>
              schema.nodes.ctRow.create(null, [schema.nodes.ctLabel.create(), schema.nodes.ctValue.create()])
            );
          }),
          chip("+ Section", "Add a section heading below", () => {
            const table = ownBox(editor, getPos());
            if (!table) return;
            insertRowAfter(editor, table, caretRowOfKind(editor, table, ["ctRow", "ctHeading"]), (schema) =>
              schema.nodes.ctHeading.create({ kind: "section" })
            );
          }),
          chip("− Row", "Remove the row the caret is in", () => {
            const table = ownBox(editor, getPos());
            if (!table) return;
            // Any row the caret can be in, headings included; the portrait slot
            // is left alone (its picture is replaced, not deleted, by dropping
            // another one on it).
            const row = caretRowOfKind(editor, table, ["ctRow", "ctHeading"]);
            if (row) deleteRowAt(editor, table, row);
          }),
          chip(
            "×",
            "Delete the character table",
            () => {
              const pos = getPos();
              if (typeof pos === "number") removeTableAt(editor, pos);
            },
            "danger"
          )
        );

        const handle = document.createElement("span");
        handle.className = "ct-resize";
        handle.title = "Drag to resize the box (double-click for the default width)";
        handle.setAttribute("role", "button");

        wrap.append(aside, chips, handle);

        const applyWidth = (next) => {
          const width = parseImageWidth(next.attrs.width);
          aside.style.width = width ? `${width}px` : "";
          wrap.classList.toggle("sized", !!width);
        };
        applyWidth(node);

        handle.addEventListener("mousedown", (event) => event.preventDefault());
        handle.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          const startX = event.clientX;
          const startWidth = parseImageWidth(node.attrs.width) || DEFAULT_CHARACTER_WIDTH;
          const maxWidth = Math.max(MIN_CHARACTER_WIDTH, editor.view.dom.clientWidth || 900);
          let width = startWidth;
          wrap.classList.add("resizing");
          try {
            handle.setPointerCapture(event.pointerId);
          } catch {
            /* capture is a nicety; the drag still works without it */
          }
          const onMove = (moveEvent) => {
            width = clampCharacterWidth(startWidth + (moveEvent.clientX - startX), maxWidth);
            aside.style.width = `${width}px`;
          };
          const onUp = (upEvent) => {
            handle.removeEventListener("pointermove", onMove);
            handle.removeEventListener("pointerup", onUp);
            handle.removeEventListener("pointercancel", onUp);
            try {
              handle.releasePointerCapture(upEvent.pointerId);
            } catch {
              /* already released */
            }
            wrap.classList.remove("resizing");
            const pos = getPos();
            if (typeof pos !== "number") return;
            const current = editor.state.doc.nodeAt(pos);
            if (!current || current.type.name !== "characterTable") return;
            const next = clampCharacterWidth(width, maxWidth);
            if (next === current.attrs.width) return;
            editor.view.dispatch(
              editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width: next })
            );
          };
          handle.addEventListener("pointermove", onMove);
          handle.addEventListener("pointerup", onUp);
          handle.addEventListener("pointercancel", onUp);
        });
        handle.addEventListener("dblclick", (event) => {
          event.preventDefault();
          const pos = getPos();
          if (typeof pos !== "number") return;
          const current = editor.state.doc.nodeAt(pos);
          if (!current || current.type.name !== "characterTable" || current.attrs.width == null) return;
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width: null })
          );
        });

        // An empty picture slot is not a caret target, so it is a click target
        // instead: the host app opens its file picker and feeds the choice back
        // through setPortraitFromFiles at the slot's position.
        wrap.addEventListener("click", (event) => {
          if (!onPickPortrait) return;
          const slot = event.target.closest && event.target.closest(".ct-portrait");
          if (!slot || !wrap.contains(slot)) return;
          if (slot.querySelector("img")) return; // an existing picture keeps its own clicks
          event.preventDefault();
          const pos = getPos();
          if (typeof pos !== "number") return;
          let slotPos = null;
          try {
            slotPos = editor.view.posAtDOM(slot, 0);
          } catch {
            slotPos = null;
          }
          const target = portraitTargetAt(editor.state, slotPos == null ? pos + 1 : slotPos);
          if (target == null) return;
          onPickPortrait(target);
        });

        return {
          dom: wrap,
          contentDOM: table,
          stopEvent: (event) => !!(event.target.closest && event.target.closest(".ct-chip, .ct-resize")),
          update: (next) => {
            if (next.type.name !== "characterTable") return false;
            applyWidth(next);
            return true;
          },
        };
      };
    },
  });

  return [CharacterTable, CtHeading, CtPortrait, CtRow, CtLabel, CtValue];
}
