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

// Every comment run in a document, in document order. Contiguous runs of the
// same id are merged into one selection target; runs with a gap between them
// are reported separately — a single note may anchor several spans (a comment
// over a selection that wraps an existing anchor marks each free span).
export function collectCommentRanges(doc) {
  const runs = [];
  const lastByCid = new Map();
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "comment");
    if (!mark) return;
    const cid = mark.attrs && mark.attrs.cid;
    if (!cid) return;
    const from = pos;
    const to = pos + node.nodeSize;
    const prev = lastByCid.get(cid);
    if (prev && prev.to === from) {
      // Adjacent to the previous run for this id: extend it.
      prev.to = to;
      prev.text += node.text;
      return;
    }
    // A gap (other text, an image, another block) starts a new run.
    const run = { cid, from, to, text: node.text };
    runs.push(run);
    lastByCid.set(cid, run);
  });
  return runs.sort((a, b) => a.from - b.from);
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

// The sub-ranges of [from, to) whose text is not already inside a comment
// anchor. A same-type mark excludes its siblings, so a plain `setMark` over
// already-annotated text silently deletes the existing anchor; the caller uses
// these spans to mark only the free text and leave every existing note linked.
export function freeCommentSpans(doc, from, to) {
  const occupied = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    if (node.marks.some((m) => m.type.name === "comment")) {
      occupied.push([pos, pos + node.nodeSize]);
    }
    return true;
  });
  occupied.sort((a, b) => a[0] - b[0]);
  const spans = [];
  let cursor = from;
  for (const [start, end] of occupied) {
    if (end <= cursor) continue;
    if (start > cursor) spans.push([cursor, Math.min(start, to)]);
    cursor = Math.max(cursor, end);
    if (cursor >= to) break;
  }
  if (cursor < to) spans.push([cursor, to]);
  return spans;
}

// Apply a comment mark to the selection without clobbering existing anchors.
// Returns false when the selection is empty or every character is already part
// of a comment (the caller then reports that no anchor was made).
export function setCommentPreserving(editor, cid) {
  if (!editor || editor.isDestroyed || !cid) return false;
  const markType = editor.schema.marks.comment;
  if (!markType) return false;
  editor.commands.focus();
  const { from, to } = editor.state.selection;
  if (from >= to) return false;
  const spans = freeCommentSpans(editor.state.doc, from, to);
  if (!spans.length) return false;
  const tr = editor.state.tr;
  for (const [start, end] of spans) tr.addMark(start, end, markType.create({ cid }));
  editor.view.dispatch(tr);
  return true;
}

// First live anchor run per comment id, in document order.
function firstRunsByCid(doc) {
  const byId = new Map();
  for (const run of collectCommentRanges(doc)) {
    if (!byId.has(run.cid)) byId.set(run.cid, run);
  }
  return byId;
}

// Apply suggested rewrites in one transaction: swap each anchor's text for its
// replacement and strip that comment's mark, so accepting a suggestion leaves
// no stale ``data-cid`` span behind. Applied in reverse document order so the
// earlier targets' positions stay valid as the later ones change length.
// Returns the number of suggestions applied — a suggestion whose anchor is gone
// is skipped.
export function applyCommentReplacements(editor, suggestions) {
  if (!editor || editor.isDestroyed) return 0;
  const markType = editor.schema.marks.comment;
  if (!markType) return 0;
  const byId = firstRunsByCid(editor.state.doc);
  const targets = [];
  for (const item of suggestions || []) {
    const cid = item && item.cid;
    const run = cid ? byId.get(cid) : null;
    if (!run) continue;
    targets.push({ ...run, replacement: String(item.replacement ?? "") });
  }
  if (!targets.length) return 0;
  targets.sort((a, b) => b.from - a.from);
  const accepted = new Set(targets.map((t) => t.cid));
  const tr = editor.state.tr;
  for (const target of targets) {
    // ``insertText`` inherits marks across the replaced range, so the comment
    // mark would ride onto the accepted text; the cleanup pass below strips it.
    tr.insertText(target.replacement, target.from, target.to);
  }
  // Strip the anchor from the accepted notes wherever it survives — the
  // rewritten span plus any other runs of the same note, so accepting never
  // leaves an unlinked ``data-cid`` behind.
  const residual = [];
  tr.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "comment");
    if (mark && accepted.has(mark.attrs && mark.attrs.cid)) {
      residual.push([pos, pos + node.nodeSize]);
    }
  });
  for (const [start, end] of residual) tr.removeMark(start, end, markType);
  editor.view.dispatch(tr);
  return targets.length;
}

// Replace a single suggestion's anchored text. Returns false when the note has
// no live anchor.
export function applyCommentReplacement(editor, cid, replacement) {
  return applyCommentReplacements(editor, [{ cid, replacement }]) > 0;
}
