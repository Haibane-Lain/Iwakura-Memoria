// Pure helpers for the drag-to-reorder grids (worlds, series, books). Kept
// DOM-free so `tests/drag-order.test.mjs` can exercise them in Node.

// Move `dragId` next to `targetId` in an id list. Returns a new array, or the
// original one when nothing would change.
export function reorderById(ids, dragId, targetId, after = false) {
  const from = ids.indexOf(dragId);
  if (from < 0 || dragId === targetId) return ids;
  const next = ids.slice();
  next.splice(from, 1);
  const at = next.indexOf(targetId);
  if (at < 0) return ids;
  next.splice(after ? at + 1 : at, 0, dragId);
  return next;
}

// True when the pointer is in the lower half of `node`, so a drop can decide
// whether it lands before or after the row under it.
export function afterMidpoint(node, event) {
  const rect = node.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2;
}

// Attach the shared "reorder by dragging" behavior to a list of nodes.
// `getDragId(node)` returns the id being dragged; `onReorder(orderedIds)` is
// called with the new order once the drop settles.
export function enableDragOrder(container, nodes, getDragId, onReorder) {
  let dragId = null;
  nodes.forEach((node) => {
    node.draggable = true;
    node.addEventListener("dragstart", (e) => {
      dragId = getDragId(node);
      e.dataTransfer.effectAllowed = "move";
      // Some browsers need data set for the drag to start at all.
      try {
        e.dataTransfer.setData("text/plain", dragId);
      } catch {
        /* ignore */
      }
      node.classList.add("dragging");
    });
    node.addEventListener("dragend", () => {
      node.classList.remove("dragging");
      container.querySelectorAll(".drop-before, .drop-after").forEach((n) => {
        n.classList.remove("drop-before", "drop-after");
      });
      dragId = null;
    });
    node.addEventListener("dragover", (e) => {
      if (!dragId || dragId === getDragId(node)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      node.classList.toggle("drop-after", afterMidpoint(node, e));
      node.classList.toggle("drop-before", !afterMidpoint(node, e));
    });
    node.addEventListener("dragleave", () => {
      node.classList.remove("drop-before", "drop-after");
    });
    node.addEventListener("drop", (e) => {
      e.preventDefault();
      const after = afterMidpoint(node, e);
      node.classList.remove("drop-before", "drop-after");
      if (!dragId || dragId === getDragId(node)) return;
      onReorder(dragId, getDragId(node), after);
    });
  });
}
