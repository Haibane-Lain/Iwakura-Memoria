import { Mark } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Comment anchors. A comment's *body* lives in a data-root sidecar
// (app/services/comments.py); the document carries only a bare inline marker,
// `<span data-cid="...">`, which is what makes the anchor exact and lets it
// survive edits, reloads, and the Markdown round trip. The stored form is
// written by a custom serializer so no editor-only class leaks into the file.
//
// The visual layer is a decoration, not the mark itself: the mark always
// renders as the plain `data-cid` span, and the plugin paints the state
// (open/resolved/active/orphan) on top from a metadata map the shell pushes.

const commentsPluginKey = new PluginKey("lain-comments");

function buildDecorations(doc, meta) {
  const decorations = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "comment");
    if (!mark) return;
    const cid = mark.attrs && mark.attrs.cid;
    if (!cid) return;
    const info = (meta && meta[cid]) || {};
    const classes = ["comment-anchor"];
    if (info.resolved) classes.push("resolved");
    if (info.active) classes.push("active");
    if (info.orphan) classes.push("orphan");
    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        class: classes.join(" "),
        "data-cid": cid,
      })
    );
  });
  return DecorationSet.create(doc, decorations);
}

function makeCommentsPlugin() {
  return new Plugin({
    key: commentsPluginKey,
    state: {
      init: (_config, state) => ({ set: buildDecorations(state.doc, {}), meta: {} }),
      apply: (tr, value) => {
        const incoming = tr.getMeta(commentsPluginKey);
        const meta = incoming !== undefined ? incoming || {} : value.meta;
        if (tr.docChanged || incoming !== undefined) {
          return { set: buildDecorations(tr.doc, meta), meta };
        }
        return value;
      },
    },
    props: {
      decorations(state) {
        const value = this.getState(state);
        return value ? value.set : DecorationSet.empty;
      },
    },
  });
}

export const CommentMark = Mark.create({
  name: "comment",
  inclusive: false,
  addAttributes() {
    return { cid: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-cid]",
        getAttrs: (element) => ({ cid: element.getAttribute("data-cid") }),
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-cid": HTMLAttributes.cid }, 0];
  },
  addStorage() {
    return {
      markdown: {
        serialize: {
          open(_state, mark) {
            return `<span data-cid="${mark.attrs.cid}">`;
          },
          close() {
            return "</span>";
          },
        },
      },
    };
  },
  addProseMirrorPlugins() {
    return [makeCommentsPlugin()];
  },
});

export function makeCommentsExtension() {
  return CommentMark;
}

// Push the shell's comment metadata (id -> {resolved, active, orphan}) into an
// editor so its decorations reflect the current sidecar.
export function applyCommentsMeta(editor, meta) {
  if (!editor || editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(commentsPluginKey, meta || {}));
}

// Every comment range in a document, one entry per id in document order.
// Adjacent runs of the same id are merged so the result is usable as a single
// selection target.
export function collectCommentRanges(doc) {
  const byCid = new Map();
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "comment");
    if (!mark) return;
    const cid = mark.attrs && mark.attrs.cid;
    if (!cid) return;
    const from = pos;
    const to = pos + node.nodeSize;
    const entry = byCid.get(cid);
    if (!entry) {
      byCid.set(cid, { cid, from, to, text: node.text });
      return;
    }
    entry.from = Math.min(entry.from, from);
    entry.to = Math.max(entry.to, to);
    entry.text += node.text;
  });
  return [...byCid.values()].sort((a, b) => a.from - b.from);
}

// Strip the comment mark for the given ids, leaving the anchored text in place.
export function removeCommentMarks(editor, cids) {
  const wanted = new Set((cids || []).filter(Boolean));
  if (!wanted.size || !editor || editor.isDestroyed) return;
  const markType = editor.schema.marks.comment;
  if (!markType) return;
  const tr = editor.state.tr;
  let changed = false;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "comment");
    if (!mark || !wanted.has(mark.attrs && mark.attrs.cid)) return;
    tr.removeMark(pos, pos + node.nodeSize, markType);
    changed = true;
  });
  if (changed) editor.view.dispatch(tr);
}
