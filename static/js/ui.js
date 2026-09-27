export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2), value);
    else if (key === "style" && typeof value === "object")
      Object.assign(node.style, value);
    else node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function toast(message, type = "info", opts = {}) {
  let host = document.querySelector(".toast-host");
  if (!host) {
    host = el("div", { class: "toast-host" });
    document.body.append(host);
  }
  const node = el("div", { class: `toast ${type === "error" ? "error" : ""}` }, message);
  const dismiss = () => {
    node.style.opacity = "0";
    node.style.transition = "opacity 0.3s";
    setTimeout(() => node.remove(), 320);
  };
  const timer = setTimeout(dismiss, opts.action ? 8000 : 2800);
  if (opts.action && typeof opts.action.onClick === "function") {
    const action = el("button", { class: "toast-action" }, opts.action.label || "Undo");
    action.addEventListener("click", () => {
      clearTimeout(timer);
      node.remove();
      opts.action.onClick();
    });
    node.append(action);
  }
  host.append(node);
}

// Open dialogs, bottom to top. Only the top-most owns Escape.
let dialogStack = [];
// The document the shared Escape listener is bound to, so it can follow a
// document swap (the jsdom tests build a fresh document per check).
let escapeDoc = null;

function topDialog() {
  // A dialog whose overlay was removed out from under us (link/lookup/repetition
  // reopen by removing the old node) must not sit in the stack swallowing keys.
  while (dialogStack.length && !dialogStack[dialogStack.length - 1].overlay.isConnected) {
    dialogStack.pop();
  }
  return dialogStack[dialogStack.length - 1] || null;
}

function onDialogKey(e) {
  if (e.key !== "Escape") return;
  // A context menu or the color palette on top owns Escape; it has its own
  // handler, and the dialog must not close underneath it.
  if (document.querySelector(".context-menu, .color-popover")) return;
  const top = topDialog();
  if (!top) {
    // Everything was pruned (removed directly); drop the listener with it.
    if (!dialogStack.length) unbindDialogEscape();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  top.dismiss();
}

function bindDialogEscape() {
  if (escapeDoc === document) return;
  if (escapeDoc) escapeDoc.removeEventListener("keydown", onDialogKey, true);
  escapeDoc = document;
  escapeDoc.addEventListener("keydown", onDialogKey, true);
}

function unbindDialogEscape() {
  if (!escapeDoc) return;
  escapeDoc.removeEventListener("keydown", onDialogKey, true);
  escapeDoc = null;
}

function focusInto(dialog) {
  const target = dialog.querySelector(
    "input, textarea, select, button, a[href], [tabindex]:not([tabindex='-1'])"
  );
  if (target) target.focus();
  else dialog.focus();
}

// Wire the shared dialog behavior onto an overlay and its box: ARIA, focus move
// and restore, and Escape. `close` is programmatic; `dismiss` is a user
// dismissal (Escape or backdrop) and also runs `onDismiss`. Exported so an
// overlay that predates `showModal` (the spelling dialog) can opt in.
export function presentDialog(overlay, dialog, { onDismiss } = {}) {
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");

  const previous = document.activeElement;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    const at = dialogStack.indexOf(entry);
    if (at >= 0) dialogStack.splice(at, 1);
    topDialog(); // drop any entries removed out from under us
    if (!dialogStack.length) unbindDialogEscape();
    overlay.remove();
    if (previous && previous.isConnected && typeof previous.focus === "function") {
      previous.focus();
    }
  };
  const dismiss = () => {
    if (closed) return;
    close();
    if (typeof onDismiss === "function") onDismiss();
  };

  topDialog(); // drop stale entries before this one joins the stack
  const entry = { overlay, dismiss };
  dialogStack.push(entry);
  bindDialogEscape();
  focusInto(dialog);

  return { close, dismiss };
}

export function showModal(inner, options = {}) {
  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: "modal" }, inner);
  backdrop.append(modal);
  document.body.append(backdrop);
  const { close, dismiss } = presentDialog(backdrop, modal, options);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) dismiss();
  });
  return { backdrop, modal, close, dismiss };
}

export function promptDialog({ title, label, value = "", placeholder = "", confirmText = "OK" }) {
  return new Promise((resolve) => {
    const input = el("input", { type: "text", value, placeholder });
    const { close } = showModal(
      [
        el("h3", {}, title),
        el("div", { class: "field" }, [el("label", {}, label), input]),
        el(
          "div",
          { class: "modal-actions" },
          [
            el("button", { class: "icon-btn", onclick: () => { close(); resolve(null); } }, "Cancel"),
            el("button", {
              class: "icon-btn primary",
              onclick: () => { close(); resolve(input.value); },
            }, confirmText),
          ]
        ),
      ],
      // Escape and a backdrop click are dismissals, so the promise resolves
      // null rather than hanging (the Escape itself is handled by showModal).
      { onDismiss: () => resolve(null) }
    );
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        close();
        resolve(input.value);
      }
    });
  });
}

export function confirmDialog({ title, message, confirmText = "Delete", danger = true }) {
  return new Promise((resolve) => {
    const { close } = showModal(
      [
        el("h3", {}, title),
        el("p", { style: { marginBottom: "8px" } }, message),
        el(
          "div",
          { class: "modal-actions" },
          [
            el("button", { class: "icon-btn", onclick: () => { close(); resolve(false); } }, "Cancel"),
            el("button", {
              class: `icon-btn ${danger ? "danger" : "primary"}`,
              onclick: () => { close(); resolve(true); },
            }, confirmText),
          ]
        ),
      ],
      { onDismiss: () => resolve(false) }
    );
  });
}

export function countWords(text, mode) {
  if (!text) return 0;
  if (mode === "chars") return text.replace(/\s+/g, "").length;
  const words = (text.match(/\S+/g) || []).length;
  if (mode === "words") return words;
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  return words + cjk;
}

export function formatNumber(n) {
  return n.toLocaleString();
}

export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text);
  return div.innerHTML;
}
