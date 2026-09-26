// Holds a document position in editor state while an async upload is in flight.
//
// A dropped/pasted image and a character-table portrait both know where they
// should land before the upload starts, but an upload is a network round trip:
// the writer can keep typing, and every edit shifts the document underneath.
// Reusing the captured offset then drops the picture in the wrong place (or, for
// a portrait, into whatever node now sits at that offset). Keeping the position
// in a state field lets ProseMirror map it through each transaction until the
// upload resolves — the same idea find-highlight uses for its ranges.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

const pendingPosKey = new PluginKey("pendingPos");

const pendingPosPlugin = new Plugin({
  key: pendingPosKey,
  state: {
    init: () => null,
    // A `setMeta` value wins; otherwise the held position moves with the doc.
    apply(tr, pos) {
      const meta = tr.getMeta(pendingPosKey);
      if (meta !== undefined) return meta;
      if (pos == null) return pos;
      return tr.mapping.map(pos);
    },
  },
});

// Registered by the editor so the helpers below can be shared without a cycle
// between editor-entry.js and character-table.js.
export const PendingPos = Extension.create({
  name: "pendingPos",
  addProseMirrorPlugins() {
    return [pendingPosPlugin];
  },
});

export function setPendingPos(view, pos) {
  view.dispatch(view.state.tr.setMeta(pendingPosKey, pos));
}

export function pendingPos(view) {
  return pendingPosKey.getState(view.state);
}

export function clearPendingPos(view) {
  view.dispatch(view.state.tr.setMeta(pendingPosKey, null));
}
