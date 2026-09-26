// Typewriter mode keeps the caret near the vertical middle of the editor's
// scroll area, the way a typewriter holds the current line in place. All the
// measurement is DOM work, so the arithmetic lives in `typewriter-math.js` and
// is unit-tested on its own; this module is a thin shell around `centerCaret`.
//
// `scrollPosIntoView` is the same measurement generalised: it is what "jump to
// this match" navigation (find results, comments, headings) uses, so those
// jumps share typewriter's CSS `zoom` handling and do not depend on
// ProseMirror's `scrollIntoView` (which no-ops unless the editor owns the DOM
// selection and miscalculates under `zoom`).
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { TYPEWRITER_RATIO, clampScrollTop, scrollDelta } from "./typewriter-math.js";

// The nearest ancestor that actually scrolls vertically, starting above the
// ProseMirror surface (`.editor-host` in the app). Null when nothing scrolls,
// which is also what jsdom reports.
export function scrollParent(el) {
  let node = el && el.parentElement;
  while (node) {
    try {
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
      if (scrolls && node.scrollHeight > node.clientHeight) return node;
    } catch {
      /* detached or no view */
    }
    node = node.parentElement;
  }
  return null;
}

// Scroll `view`'s container so the document position `pos` rests `ratio` of the
// way down the visible area. Returns false whenever layout isn't available
// (jsdom, a detached view, a document short enough not to scroll) instead of
// throwing. Never focuses anything, so it works while the find panel holds the
// keyboard.
export function scrollPosIntoView(view, pos, { ratio = TYPEWRITER_RATIO } = {}) {
  if (!view || !view.state) return false;
  const scroller = scrollParent(view.dom);
  if (!scroller) return false;
  let coords;
  try {
    coords = view.coordsAtPos(pos);
  } catch {
    return false;
  }
  if (!coords) return false;
  const rect = scroller.getBoundingClientRect();
  if (!rect || !rect.height) return false;
  // Under CSS `zoom`, getBoundingClientRect is scaled while scrollTop may not
  // be. rect-height / offset-height recovers the factor either way: if the
  // browser reports both scaled the ratio is 1, and if it reports offsetHeight
  // unscaled the ratio is the zoom.
  const zoomRatio = scroller.offsetHeight ? rect.height / scroller.offsetHeight : 1;
  scroller.scrollTop = clampScrollTop(
    scrollDelta({
      targetTop: coords.top,
      viewportTop: rect.top,
      viewportHeight: rect.height,
      ratio,
      zoomRatio,
    }),
    scroller.scrollTop,
    scroller.scrollHeight,
    scroller.clientHeight
  );
  return true;
}

// Nudge the caret toward the middle. Returns false whenever layout isn't
// available (jsdom, a detached view) instead of throwing.
export function centerCaret(view) {
  if (!view || !view.state) return false;
  return scrollPosIntoView(view, view.state.selection.head, {
    ratio: TYPEWRITER_RATIO,
  });
}

// `getEnabled` is read live, so the shell can flip the mode without rebuilding
// the editor (the same shape the grammar extension uses).
export function makeTypewriterExtension(getEnabled) {
  const isEnabled = () => (typeof getEnabled === "function" ? !!getEnabled() : false);
  return Extension.create({
    name: "typewriterMode",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("lain-typewriter"),
          view() {
            return {
              update(view, prevState) {
                if (!isEnabled()) return;
                // Recenter only when the document or caret actually moved, so a
                // manual scroll (which changes neither) is left alone.
                if (prevState.selection.eq(view.state.selection) && prevState.doc.eq(view.state.doc)) {
                  return;
                }
                centerCaret(view);
              },
            };
          },
        }),
      ];
    },
  });
}
