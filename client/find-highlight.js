// Find-in-document highlighting. The panel (static/js/search-dialog.js) owns
// the query and the navigation; this module owns everything ProseMirror: finding
// the literal matches in the open document and painting them as decorations.
//
// Decorations, not a selection: a selection disappears the moment the find
// input holds the keyboard, whereas a decoration stays visible so the user can
// keep typing in the panel (or in the document) with the matches still tinted.
// The classes are `find-hit` (every match) and `find-hit-active` (the current
// one); closing the panel clears them.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const findPluginKey = new PluginKey("lain-find");

// The same matching rules the server search uses (app/services/search.py):
// a literal, escaped query, optionally case-sensitive and/or whole-word. The
// boundaries deliberately exclude [A-Za-z0-9_] rather than using \b, which does
// not treat non-ASCII word characters consistently.
const WORD_BEFORE = "(?<![A-Za-z0-9_])";
const WORD_AFTER = "(?![A-Za-z0-9_])";

function buildPattern(query, caseSensitive, wholeWord) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = wholeWord ? WORD_BEFORE + escaped + WORD_AFTER : escaped;
  return new RegExp(body, caseSensitive ? "g" : "gi");
}

// A textblock's inline children, flattened to one string plus the document
// position each character came from. Using text nodes (rather than
// `node.textContent`) keeps the offsets exact when a leaf — an inline image, a
// hard break — sits between text runs, so a match can never highlight the wrong
// characters.
function flattenBlock(node, pos) {
  const pieces = [];
  let text = "";
  node.forEach((child, offset) => {
    if (!child.isText || !child.text) return;
    pieces.push({ start: text.length, pos: pos + 1 + offset, len: child.text.length });
    text += child.text;
  });
  return { text, pieces };
}

function offsetToPos(pieces, index) {
  for (const piece of pieces) {
    if (index < piece.start + piece.len) return piece.pos + (index - piece.start);
  }
  return null;
}

// Every match of `query` in `doc`, in document order, as {from, to} ranges.
// Matches never span a block boundary (a paragraph, heading, list item, table
// cell), which is also how the server reports per-document ordinals.
export function findMatchRanges(doc, query, { caseSensitive = false, wholeWord = false } = {}) {
  const needle = String(query == null ? "" : query);
  if (!doc || !needle) return [];
  const pattern = buildPattern(needle, caseSensitive, wholeWord);
  const ranges = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const { text, pieces } = flattenBlock(node, pos);
    if (!text || !pieces.length) return true;
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      if (!match[0]) {
        pattern.lastIndex += 1;
      } else {
        const from = offsetToPos(pieces, match.index);
        const end = offsetToPos(pieces, match.index + match[0].length - 1);
        if (from !== null && end !== null) ranges.push({ from, to: end + 1 });
      }
      match = pattern.exec(text);
    }
    return true;
  });
  return ranges;
}

function buildDecorations(doc, ranges, active) {
  const decorations = [];
  const limit = doc.content.size;
  ranges.forEach((range, index) => {
    const from = Math.max(0, Math.min(range.from, limit));
    const to = Math.max(0, Math.min(range.to, limit));
    if (to <= from) return;
    const classes = index === active ? "find-hit find-hit-active" : "find-hit";
    decorations.push(Decoration.inline(from, to, { class: classes }));
  });
  return DecorationSet.create(doc, decorations);
}

function makeFindPlugin() {
  return new Plugin({
    key: findPluginKey,
    state: {
      init: () => ({ ranges: [], active: -1, set: DecorationSet.empty }),
      apply: (tr, value) => {
        const incoming = tr.getMeta(findPluginKey);
        if (incoming !== undefined) {
          const ranges = (incoming.ranges || []).map((range) => ({
            from: range.from,
            to: range.to,
          }));
          const active = typeof incoming.active === "number" ? incoming.active : -1;
          return { ranges, active, set: buildDecorations(tr.doc, ranges, active) };
        }
        // The user edited the document with the panel open: shift the
        // highlights with the text instead of re-scanning on every keystroke.
        // The panel re-scans on the next search or navigation.
        if (tr.docChanged && value.ranges.length) {
          const ranges = value.ranges.map((range) => ({
            from: tr.mapping.map(range.from),
            to: tr.mapping.map(range.to),
          }));
          return { ranges, active: value.active, set: buildDecorations(tr.doc, ranges, value.active) };
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

export function makeFindHighlightExtension() {
  return Extension.create({
    name: "findHighlight",
    addProseMirrorPlugins() {
      return [makeFindPlugin()];
    },
  });
}

// Push the ranges (`activeIndex` is the one drawn strongly) into an editor.
export function setFindRanges(editor, ranges, activeIndex = -1) {
  if (!editor || editor.isDestroyed) return;
  editor.view.dispatch(
    editor.state.tr.setMeta(findPluginKey, { ranges: ranges || [], active: activeIndex })
  );
}
