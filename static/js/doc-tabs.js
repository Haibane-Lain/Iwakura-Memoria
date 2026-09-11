// Document tab strip: which documents are open and which is active.
//
// Pure bookkeeping (no DOM), for the same reason as editor-pool.js: the
// ordering, capping and eviction rules are the fiddly part, so they live in a
// module a unit test can pin down. project.js owns rendering and talks to the
// editor pool; this only decides *which* ids are open and active.
//
// `tabs` is the ordered strip, newest opened on the right. `active` is the
// document currently on screen.

export const DEFAULT_TAB_LIMIT = 10;

export function createDocTabs({ max = DEFAULT_TAB_LIMIT } = {}) {
  let tabs = [];
  let active = null;

  // Never evict the active tab, mirroring editor-pool's "the current editor is
  // pinned past the cap". The tab just opened is active by the time this runs.
  function evict() {
    while (max >= 0 && tabs.length > max) {
      const victim = tabs.find((t) => t !== active);
      if (victim === undefined) break;
      tabs = tabs.filter((t) => t !== victim);
    }
  }

  function snapshot() {
    return { tabs: [...tabs], active };
  }

  return {
    get tabs() {
      return [...tabs];
    },
    get active() {
      return active;
    },
    get size() {
      return tabs.length;
    },
    has(id) {
      return tabs.includes(id);
    },

    // Open (or focus) a document and make it the active tab.
    open(id) {
      if (!id) return active;
      if (!tabs.includes(id)) tabs = [...tabs, id];
      active = id;
      evict();
      return active;
    },

    // Close a tab. When it was active the neighbour to the right is chosen,
    // falling back to the left, then to nothing.
    close(id) {
      const index = tabs.indexOf(id);
      if (index === -1) return { active, closed: null, next: active };
      tabs = tabs.filter((t) => t !== id);
      let next = active;
      if (active === id) {
        next = tabs[index] ?? tabs[index - 1] ?? null;
        active = next;
      }
      return { active, closed: id, next };
    },

    // Drop a document everywhere (it was deleted). The active tab falls back to
    // the last remaining one; callers decide what to render.
    forget(id) {
      tabs = tabs.filter((t) => t !== id);
      if (active === id) active = tabs[tabs.length - 1] ?? null;
    },

    // A move or folder rename rewrites the path portion of an id.
    rekey(oldId, newId) {
      if (!oldId || !newId || oldId === newId) return;
      tabs = [...new Set(tabs.map((t) => (t === oldId ? newId : t)))];
      if (active === oldId) active = newId;
    },

    // Move to the next/previous tab, wrapping. No-op with fewer than two.
    cycle(direction) {
      if (tabs.length < 2) return active;
      const index = tabs.indexOf(active);
      const at = index === -1 ? 0 : (index + direction + tabs.length) % tabs.length;
      active = tabs[at];
      return active;
    },

    serialize: snapshot,

    // Rehydrate from persisted JSON. The caller has already filtered the ids
    // against the current tree; here we only enforce caps and pick an active.
    restore(data) {
      const source = data || {};
      const ids = Array.isArray(source.tabs) ? source.tabs.filter(Boolean) : [];
      tabs = [...new Set(ids)];
      if (max > 0 && tabs.length > max) tabs = tabs.slice(tabs.length - max);
      active = tabs.includes(source.active) ? source.active : tabs[tabs.length - 1] ?? null;
      return snapshot();
    },
  };
}
