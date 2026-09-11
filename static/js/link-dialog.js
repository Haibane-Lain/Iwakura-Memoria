// Link dialog: set, edit or remove a URL link on the selection. A leaf module —
// it owns the overlay and the URL cleanup, while applying the link to the
// editor needs the shell (the editor lives in a separate bundle), so that is
// injected through `onApply` / `onRemove` rather than imported back from
// project.js, the same arrangement the lookup dialog uses.
import { el, showModal } from "./ui.js";

const SAFE_SCHEME_RE = /^(https?|mailto|tel):/i;
const ANY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

// Turn what someone typed into a usable href. A bare host gets `https://`;
// site-relative paths (`/…`) and in-page anchors (`#…`) are left alone; the
// dangerous pseudo-schemes are refused (empty string) so they can never slip
// into the stored Markdown.
export function normalizeLinkHref(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return "";
  if (/^(javascript|data|vbscript):/i.test(raw)) return "";
  if (raw.startsWith("#") || raw.startsWith("/")) return raw;
  if (SAFE_SCHEME_RE.test(raw) || ANY_SCHEME_RE.test(raw)) return raw;
  return `https://${raw}`;
}

export function renderLinkDialog({
  href = "",
  selectionText = "",
  onApply,
  onRemove,
} = {}) {
  const existing = document.querySelector(".modal-backdrop.link-modal");
  if (existing) {
    existing.remove();
    return;
  }

  let close = () => {};
  const input = el("input", {
    type: "text",
    class: "link-input",
    placeholder: "https://example.com",
    spellcheck: "false",
  });
  input.value = String(href || "");

  const hint = el(
    "p",
    { class: "link-hint" },
    selectionText
      ? `Links “${selectionText}”.`
      : "Nothing is selected — the URL is inserted as the link text."
  );

  const apply = () => {
    const url = normalizeLinkHref(input.value);
    if (typeof onApply === "function") onApply(url);
    close();
  };

  const children = [
    el("h3", {}, "Link"),
    el("div", { class: "field" }, [el("label", {}, "URL"), input]),
    hint,
    el("div", { class: "modal-actions" }, [
      href
        ? el("button", {
            class: "icon-btn link-remove",
            onclick: () => {
              if (typeof onRemove === "function") onRemove();
              close();
            },
          }, "Remove link")
        : null,
      el("button", { class: "icon-btn", onclick: () => close() }, "Cancel"),
      el("button", { class: "icon-btn primary", onclick: apply }, href ? "Update" : "Insert"),
    ]),
  ];

  const overlay = showModal(children);
  close = overlay.close;
  overlay.backdrop.classList.add("link-modal");
  overlay.modal.style.maxWidth = "460px";

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      apply();
    }
  });

  setTimeout(() => {
    input.focus();
    input.select();
  }, 30);
}
