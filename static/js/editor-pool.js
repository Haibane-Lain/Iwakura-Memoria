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

  function evict() {
    while (entries.size > max) {
      const oldest = entries.keys().next().value;
      if (oldest === activeId) break;
      const ctrl = entries.get(oldest);
      entries.delete(oldest);
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
      if (activeId === oldId) activeId = newId;
    },
    forget,
    destroy,
    destroyAll() {
      const all = [...entries.values()];
      entries.clear();
      activeId = null;
      for (const ctrl of all) {
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
    },
  };
}
