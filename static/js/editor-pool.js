// Keeps the live editor for recently visited documents so undo/redo survives
// switching away and back. Plain bookkeeping: it never touches the DOM, and it
// only relies on the small `activate` / `deactivate` / `destroy` contract that
// the editor bundle exposes, which keeps it testable without jsdom.
//
// The pool is LRU. `add`, `get` and `activate` move a document to the
// most-recently used end; growing past `max` destroys the oldest editor that
// is *not* the current document. `activeId` is the document whose editor
// belongs to `state.currentDocId`; it stays set while that editor is parked
// (for example while the Settings tab is open), so it is never evicted.

export const DEFAULT_EDITOR_POOL_LIMIT = 10;

export function createEditorPool({ max = DEFAULT_EDITOR_POOL_LIMIT } = {}) {
  const entries = new Map();
  // Documents that must never be evicted even when they are not the active
  // one — e.g. both panes when split view is open. Unlike `activeId`, any
  // number of ids can be pinned.
  const pins = new Set();
  let activeId = null;

  function touch(id) {
    const ctrl = entries.get(id);
    if (ctrl !== undefined) {
      entries.delete(id);
      entries.set(id, ctrl);
    }
    return ctrl;
  }

  function forget(id) {
    const ctrl = entries.get(id);
    if (ctrl === undefined) return null;
    entries.delete(id);
    pins.delete(id);
    if (activeId === id) activeId = null;
    return ctrl;
  }

  function destroy(id) {
    const ctrl = forget(id);
    if (ctrl) {
      try {
        ctrl.destroy && ctrl.destroy();
      } catch {
        /* the editor is already gone */
      }
    }
    return ctrl;
  }

  function destroyCtrl(ctrl) {
    try {
      ctrl.deactivate && ctrl.deactivate();
    } catch {
      /* ignore */
    }
    try {
      ctrl.destroy && ctrl.destroy();
    } catch {
      /* ignore */
    }
  }

  function evict() {
    // Walk oldest-first and drop unpinned entries until the cap is met. The
    // active document and anything pinned (the visible panes) are skipped;
    // when every entry is protected the pool can sit above `max`.
    for (const id of [...entries.keys()]) {
      if (entries.size <= max) break;
      if (id === activeId || pins.has(id)) continue;
      const ctrl = entries.get(id);
      entries.delete(id);
      destroyCtrl(ctrl);
    }
  }

  return {
    get size() {
      return entries.size;
    },
    get activeId() {
      return activeId;
    },
    keys() {
      return [...entries.keys()];
    },
    has(id) {
      return entries.has(id);
    },
    get(id) {
      return entries.get(id);
    },
    pin(id) {
      if (entries.has(id)) pins.add(id);
    },
    unpin(id) {
      pins.delete(id);
    },
    unpinAll() {
      pins.clear();
    },
    pinned() {
      return [...pins];
    },
    add(id, ctrl) {
      entries.delete(id);
      entries.set(id, ctrl);
      activeId = id;
      evict();
      return ctrl;
    },
    activate(id) {
      const ctrl = touch(id);
      if (ctrl === undefined) return null;
      activeId = id;
      try {
        ctrl.activate && ctrl.activate();
      } catch {
        /* ignore */
      }
      return ctrl;
    },
    // Park the current editor: stop its grammar work but keep it cached.
    // `activeId` is deliberately retained so the document is not evicted.
    park() {
      const ctrl = activeId != null ? entries.get(activeId) : null;
      if (ctrl) {
        try {
          ctrl.deactivate && ctrl.deactivate();
        } catch {
          /* ignore */
        }
      }
      return ctrl || null;
    },
    // Keep the current document's cache key in step with an id change (a move
    // or folder rename rewrites the path portion of a document id).
    rekey(oldId, newId) {
      if (!oldId || !newId || oldId === newId) return;
      const ctrl = entries.get(oldId);
      if (ctrl === undefined) return;
      entries.delete(oldId);
      const clash = entries.get(newId);
      if (clash !== undefined) {
        entries.delete(newId);
        try {
          clash.destroy && clash.destroy();
        } catch {
          /* ignore */
        }
      }
      entries.set(newId, ctrl);
      if (pins.delete(oldId)) pins.add(newId);
      if (activeId === oldId) activeId = newId;
    },
    forget,
    destroy,
    destroyAll() {
      const all = [...entries.values()];
      entries.clear();
      pins.clear();
      activeId = null;
      for (const ctrl of all) {
        destroyCtrl(ctrl);
      }
    },
  };
}
