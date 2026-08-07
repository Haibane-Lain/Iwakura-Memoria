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

export function toast(message, type = "info") {
  let host = document.querySelector(".toast-host");
  if (!host) {
    host = el("div", { class: "toast-host" });
    document.body.append(host);
  }
  const node = el("div", { class: `toast ${type === "error" ? "error" : ""}` }, message);
  host.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transition = "opacity 0.3s";
    setTimeout(() => node.remove(), 320);
  }, 2800);
}

export function showModal(inner) {
  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: "modal" }, inner);
  backdrop.append(modal);
  document.body.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  return { backdrop, modal, close };
}

export function promptDialog({ title, label, value = "", placeholder = "", confirmText = "OK" }) {
  return new Promise((resolve) => {
    const input = el("input", { type: "text", value, placeholder });
    const { modal, close } = showModal([
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
    ]);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        close();
        resolve(input.value);
      }
      if (e.key === "Escape") {
        close();
        resolve(null);
      }
    });
  });
}

export function confirmDialog({ title, message, confirmText = "Delete", danger = true }) {
  return new Promise((resolve) => {
    const { modal, close } = showModal([
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
    ]);
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
