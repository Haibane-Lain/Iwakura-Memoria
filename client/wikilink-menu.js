import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import {
  filterWikilinkItems,
  isInsideWikilink,
  matchWikilinkTrigger,
  wikilinkText,
} from "./wikilink-suggest.js";

// A hand-rolled `[[wikilink]]` autocomplete popup, built the same way as the
// slash menu: the trigger is matched against the text before the caret, so the
// popup appears and disappears with ordinary transactions and nothing is
// inserted until an item is chosen. No `@tiptap/suggestion`, no tippy.
//
// Titles come from `getWikilinkItems`, injected when the editor is created (the
// shell reads the project trees), so this module never reaches back into app
// state and stays a leaf.

let menu = null;

function closeMenu() {
  if (menu && menu.el) menu.el.remove();
  menu = null;
}

function position(el, view, pos) {
  let rect = { left: 0, top: 0 };
  try {
    const coords = view.coordsAtPos(pos);
    rect = { left: coords.left, top: coords.bottom + 6 };
  } catch {
    /* no layout (jsdom): the menu still opens, just at the origin */
  }
  el.style.left = `${Math.max(8, rect.left)}px`;
  el.style.top = `${Math.max(8, rect.top)}px`;
}

function item(entry, active, onclick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `wikilink-item${active ? " active" : ""}${entry.create ? " wikilink-item-new" : ""}`;
  node.dataset.title = entry.title;
  const name = document.createElement("span");
  name.className = "wikilink-item-label";
  name.textContent = entry.label;
  node.appendChild(name);
  if (entry.hint) {
    const detail = document.createElement("span");
    detail.className = "wikilink-item-hint";
    detail.textContent = entry.hint;
    node.appendChild(detail);
  }
  node.addEventListener("mousedown", (event) => event.preventDefault());
  node.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onclick();
  });
  return node;
}

function paint() {
  if (!menu) return;
  const { el, entries } = menu;
  el.replaceChildren();
  const head = document.createElement("div");
  head.className = "wikilink-head";
  head.textContent = "Link to note";
  el.appendChild(head);
  entries.forEach((entry, index) => {
    el.appendChild(item(entry, index === menu.index, () => choose(index)));
  });
}

// Replace `[[query` with the completed link. `create` entries carry the typed
// text as their title, so the same path inserts a literal `[[query]]` — the
// unresolved link the backlinks panel already knows how to offer to create.
function choose(index) {
  const current = menu;
  if (!current) return;
  const entry = current.entries[index];
  if (!entry) return;
  const { view, start } = current;
  const to = view.state.selection.from;
  closeMenu();
  const tr = view.state.tr;
  if (to > start) tr.delete(start, to);
  tr.insertText(wikilinkText(entry.title), start);
  view.dispatch(tr);
  view.focus();
}

function openMenu(view, entries, start, pos, query) {
  if (!menu) {
    const el = document.createElement("div");
    el.className = "wikilink-menu";
    el.setAttribute("role", "listbox");
    document.body.appendChild(el);
    menu = { el, view, entries, start, index: 0, query };
  } else {
    if (menu.query !== query) menu.index = 0; // new query -> start at the top
    menu.view = view;
    menu.entries = entries;
    menu.start = start;
    menu.query = query;
    menu.index = Math.min(menu.index, Math.max(0, entries.length - 1));
  }
  position(menu.el, view, pos);
  paint();
}

function move(delta) {
  if (!menu || !menu.entries.length) return;
  const count = menu.entries.length;
  menu.index = (menu.index + delta + count) % count;
  paint();
}

function selected() {
  if (!menu) return;
  choose(menu.index);
}

export function makeWikilinkMenuExtension(getItems) {
  const items = () => {
    const list = typeof getItems === "function" ? getItems() : [];
    return Array.isArray(list) ? list : [];
  };

  return Extension.create({
    name: "wikilinkMenu",
    addProseMirrorPlugins() {
      const sync = (view) => {
        const { selection } = view.state;
        if (!selection.empty || !selection.$from.parent.isTextblock) {
          closeMenu();
          return;
        }
        const $from = selection.$from;
        const parent = $from.parent;
        const trigger = matchWikilinkTrigger(
          parent.textBetween(0, $from.parentOffset)
        );
        const textAfter = parent.textBetween($from.parentOffset, parent.content.size);
        // Never reopen inside a link that is already closed: completing there
        // would leave the old `]]` behind.
        if (!trigger || isInsideWikilink(textAfter)) {
          closeMenu();
          return;
        }

        const query = trigger.query;
        const matches = filterWikilinkItems(items(), query);
        const entries = matches.map((entry) => ({
          title: entry.title,
          hint: entry.hint || "",
          label: entry.title,
        }));
        const typed = query.trim();
        if (typed && matches.length === 0) {
          entries.push({
            create: true,
            title: typed,
            label: `Link to new note “${typed}”`,
            hint: "",
          });
        }
        if (!entries.length) {
          closeMenu();
          return;
        }
        openMenu(view, entries, $from.start() + trigger.start, $from.pos, query);
      };

      return [
        new Plugin({
          key: new PluginKey("lain-wikilink-menu"),
          props: {
            handleKeyDown(_view, event) {
              if (!menu) return false;
              if (event.key === "ArrowDown") {
                move(1);
                return true;
              }
              if (event.key === "ArrowUp") {
                move(-1);
                return true;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                selected();
                return true;
              }
              if (event.key === "Escape") {
                closeMenu();
                return true;
              }
              return false;
            },
          },
          view() {
            return {
              update: (view) => sync(view),
              destroy: () => closeMenu(),
            };
          },
        }),
      ];
    },
  });
}

// Close the popup when the user clicks anywhere else. Registered once, like the
// slash menu's own listener.
document.addEventListener("mousedown", (event) => {
  if (menu && menu.el && !menu.el.contains(event.target)) closeMenu();
});
