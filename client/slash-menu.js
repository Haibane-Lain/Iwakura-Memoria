import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { TEXT_COLORS } from "../static/js/text-colors.js";

// A hand-rolled slash menu: type `/` at the start of a word and a filtered list
// of insert commands appears above the caret. It is deliberately not built on
// @tiptap/suggestion or tippy — the app already positions its own editor UI
// (grammar tooltips, character-table chips), and this keeps one fewer
// dependency and one more thing jsdom can drive.
//
// The trigger is matched against the text before the caret, so it appears and
// disappears with the ordinary transaction stream; nothing is inserted into the
// document until a command is chosen.

const TRIGGER_RE = /(?:^|\s)\/([\p{L}0-9-]*)$/u;

// The command list the menu shows. `run` builds a fresh chain each time so it
// always acts on the current selection.
export function slashCommands(editor) {
  const chain = () => editor.chain().focus();
  const run = (fn) => () => fn().run();
  return [
    { id: "h1", label: "Heading 1", hint: "Large section heading", keywords: "title", run: run(() => chain().toggleHeading({ level: 1 })) },
    { id: "h2", label: "Heading 2", hint: "Medium heading", keywords: "subtitle", run: run(() => chain().toggleHeading({ level: 2 })) },
    { id: "h3", label: "Heading 3", hint: "Small heading", run: run(() => chain().toggleHeading({ level: 3 })) },
    { id: "bulletList", label: "Bullet list", hint: "Unordered list", keywords: "ul", run: run(() => chain().toggleBulletList()) },
    { id: "orderedList", label: "Numbered list", hint: "Ordered list", keywords: "ol", run: run(() => chain().toggleOrderedList()) },
    { id: "taskList", label: "Task list", hint: "Checkboxes", keywords: "todo checkbox", run: run(() => chain().toggleTaskList()) },
    { id: "blockquote", label: "Quote", hint: "Blockquote", keywords: "citation", run: run(() => chain().toggleBlockquote()) },
    { id: "codeBlock", label: "Code block", hint: "Preformatted text", keywords: "pre", run: run(() => chain().toggleCodeBlock()) },
    { id: "horizontalRule", label: "Divider", hint: "Horizontal rule", keywords: "hr line", run: run(() => chain().setHorizontalRule()) },
    { id: "table", label: "Table", hint: "3×3 with a header row", keywords: "grid", run: run(() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true })) },
    { id: "highlight", label: "Highlight", hint: "Mark the text", keywords: "mark", run: run(() => chain().toggleHighlight()) },
    { id: "subscript", label: "Subscript", hint: "Lowered text", run: run(() => chain().toggleSubscript()) },
    { id: "superscript", label: "Superscript", hint: "Raised text", run: run(() => chain().toggleSuperscript()) },
    { id: "color", label: "Text color", hint: "Pick a color", keywords: "colour", palette: true },
  ];
}

export function filterSlashCommands(commands, query) {
  const q = (query || "").toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (command) =>
      command.label.toLowerCase().includes(q) ||
      command.id.toLowerCase().includes(q) ||
      (command.keywords || "").includes(q)
  );
}

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

function item(label, hint, active, onclick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `slash-item${active ? " active" : ""}`;
  node.dataset.label = label;
  const name = document.createElement("span");
  name.className = "slash-item-label";
  name.textContent = label;
  node.appendChild(name);
  if (hint) {
    const detail = document.createElement("span");
    detail.className = "slash-item-hint";
    detail.textContent = hint;
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
  const { el, palette } = menu;
  el.replaceChildren();
  const head = document.createElement("div");
  head.className = "slash-head";
  head.textContent = palette ? "Text color" : "Insert";
  el.appendChild(head);

  if (palette) {
    const row = document.createElement("div");
    row.className = "slash-swatches";
    for (const color of TEXT_COLORS) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "slash-swatch";
      swatch.title = color.label;
      swatch.dataset.color = color.value || "default";
      if (color.value) swatch.style.background = color.value;
      else swatch.classList.add("slash-swatch-default");
      swatch.addEventListener("mousedown", (event) => event.preventDefault());
      swatch.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyColor(color.value);
      });
      row.appendChild(swatch);
    }
    el.appendChild(row);
    return;
  }

  menu.commands.forEach((command, index) => {
    el.appendChild(item(command.label, command.hint, index === menu.index, () => choose(index)));
  });
}

function applyColor(value) {
  const current = menu;
  if (!current) return;
  const { view, start, editor } = current;
  const to = view.state.selection.from;
  if (to > start) view.dispatch(view.state.tr.delete(start, to));
  closeMenu();
  const chain = editor.chain().focus();
  if (value) chain.setMark("textColor", { color: value }).run();
  else chain.unsetMark("textColor").run();
}

function choose(index) {
  const current = menu;
  if (!current || current.palette) return;
  const command = current.commands[index];
  if (!command) return;
  if (command.palette) {
    current.palette = true;
    paint();
    return;
  }
  const { view, start } = current;
  const to = view.state.selection.from;
  if (to > start) view.dispatch(view.state.tr.delete(start, to));
  closeMenu();
  try {
    command.run();
  } catch {
    /* a command that cannot apply in this position is a no-op */
  }
}

function openMenu(view, editor, commands, start, pos) {
  if (!menu) {
    const el = document.createElement("div");
    el.className = "slash-menu";
    el.setAttribute("role", "listbox");
    document.body.appendChild(el);
    menu = { el, view, editor, commands, start, index: 0, palette: false };
  } else {
    menu.view = view;
    menu.editor = editor;
    menu.commands = commands;
    menu.start = start;
    menu.index = Math.min(menu.index, Math.max(0, commands.length - 1));
  }
  position(menu.el, view, pos);
  paint();
}

function move(delta) {
  if (!menu || menu.palette || !menu.commands.length) return;
  const count = menu.commands.length;
  menu.index = (menu.index + delta + count) % count;
  paint();
}

function selected() {
  if (!menu || menu.palette) return;
  const command = menu.commands[menu.index];
  if (command) choose(menu.index);
}

export function makeSlashMenuExtension() {
  return Extension.create({
    name: "slashMenu",
    addProseMirrorPlugins() {
      const editor = this.editor;

      const sync = (view) => {
        const { selection } = view.state;
        const inTextblock = selection.empty && selection.$from.parent.isTextblock;
        const $from = inTextblock ? selection.$from : null;
        const match = $from
          ? TRIGGER_RE.exec($from.parent.textBetween(0, $from.parentOffset))
          : null;

        if (!match) {
          // An open color palette stays until it is clicked away or dismissed;
          // the ordinary list follows its trigger and closes with it.
          if (menu && !menu.palette) closeMenu();
          return;
        }
        if (menu && menu.palette) return;
        const commands = filterSlashCommands(slashCommands(editor), match[1]);
        if (!commands.length) {
          closeMenu();
          return;
        }
        openMenu(view, editor, commands, $from.pos - (match[1].length + 1), $from.pos);
      };

      return [
        new Plugin({
          key: new PluginKey("lain-slash"),
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
                if (menu.palette) return false;
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

// Close the menu when the user clicks anywhere else. Registered once.
document.addEventListener("mousedown", (event) => {
  if (menu && menu.el && !menu.el.contains(event.target)) closeMenu();
});
