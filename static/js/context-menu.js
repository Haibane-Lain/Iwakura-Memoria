// The shared right-click menu: a positioned list of items with an optional
// `null` separator. One menu is open at a time, and it closes on an outside
// click or Escape. The sidebar tree and the world page both use it.
import { el } from "./ui.js";

let cleanup = null;

export function closeContextMenu() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}

export function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = el("div", { class: "context-menu", style: { left: `${x}px`, top: `${y}px` } });
  for (const item of items) {
    if (item === null) {
      menu.append(el("div", { class: "context-sep" }));
    } else {
      menu.append(
        el("div", {
          class: "context-item",
          onclick: () => {
            closeContextMenu();
            item.action();
          },
        }, item.label)
      );
    }
  }
  document.body.append(menu);
  // Keep the menu on screen: a row near the bottom would otherwise open it
  // past the viewport edge, where it cannot be reached.
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 4))}px`;
  const onDocClick = (e) => {
    if (!menu.contains(e.target)) closeContextMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeContextMenu();
  };
  // The click listener waits a tick so the opening click does not close the
  // menu; clear the timer on dismiss so a menu closed before it fires cannot
  // leave a stray listener that closes the *next* menu.
  const timer = setTimeout(() => document.addEventListener("click", onDocClick), 0);
  document.addEventListener("keydown", onKey);
  cleanup = () => {
    clearTimeout(timer);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    menu.remove();
  };
}
