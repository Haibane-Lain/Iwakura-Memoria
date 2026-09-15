// Remembering each editor pane's scroll position across tab switches.
//
// Every tab switch rebuilds the pane chrome and creates a fresh `.editor-host`
// (the `overflow-y: auto` scroller in app.css), so its `scrollTop` starts at 0
// even though the warm ProseMirror editor is re-mounted from the pool. The
// editor's undo history survives via `editor-pool.js`; this small side table
// does the same for the scroll offset.
//
// Keyed by document id rather than by controller, so the offset survives the
// pool's LRU eviction (and a rebuilt-from-disk editor), and a move/rename can
// carry it over with `rekey`. It is intentionally in-memory: a remembered
// offset goes stale when a document's length changes between sessions.

/**
 * A per-document scroll-offset table.
 */
export function createScrollMemory() {
  const offsets = new Map(); // docId -> px

  return {
    /** Record `top` for `id`. Invalid/negative values become 0. */
    remember(id, top) {
      if (!id) return;
      const value = Number(top);
      offsets.set(id, Number.isFinite(value) && value > 0 ? value : 0);
    },
    /** The remembered offset for `id`, or 0 when there is none. */
    recall(id) {
      return offsets.get(id) || 0;
    },
    /** Move an offset when a move/rename changes a document id. */
    rekey(oldId, newId) {
      if (!oldId || !newId || oldId === newId) return;
      if (!offsets.has(oldId)) return;
      const value = offsets.get(oldId);
      offsets.delete(oldId);
      offsets.set(newId, value);
    },
    forget(id) {
      offsets.delete(id);
    },
    clear() {
      offsets.clear();
    },
    get size() {
      return offsets.size;
    },
  };
}
