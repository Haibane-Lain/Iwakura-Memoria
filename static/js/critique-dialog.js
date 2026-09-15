// The critique picker: choose one or more entries for Lain to review, then let
// it propose anchored comments (which the user confirms). A leaf module — it
// owns the overlay and returns the picked ids, so the shell decides how to run
// the pass (see project.js `openCritique` / lain.js `startCritique`).
import { el, showModal } from "./ui.js";

// Mirrors sessions.MAX_SELECTED_ENTRIES: the server caps a session's picked
// entries, so the dialog must not offer more than it will keep.
export const MAX_CRITIQUE_ENTRIES = 50;

// Pure filter so the search rules are testable without the DOM.
export function filterCritiqueEntries(entries, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [...(entries || [])];
  return (entries || []).filter((entry) => {
    const haystack = [entry.title, entry.id, entry.folder, entry.group]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function renderCritiqueDialog({ entries = [], currentDocId = null } = {}) {
  return new Promise((resolve) => {
    const selected = new Set();
    if (currentDocId && entries.some((entry) => entry.id === currentDocId)) {
      selected.add(currentDocId);
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      close();
      resolve(value);
    };

    const listEl = el("div", { class: "critique-list" });
    const countEl = el("span", { class: "critique-count" });
    const searchEl = el("input", {
      type: "search",
      class: "critique-search",
      placeholder: "Filter entries…",
      oninput: () => renderList(),
    });
    const startBtn = el("button", { class: "icon-btn primary", onclick: () => finish([...selected]) }, "Start critique");

    function updateCount() {
      const over = selected.size > MAX_CRITIQUE_ENTRIES;
      countEl.textContent = `${selected.size} selected`;
      startBtn.disabled = selected.size === 0 || over;
      if (over) countEl.textContent += ` (max ${MAX_CRITIQUE_ENTRIES})`;
    }

    function renderList() {
      const visible = filterCritiqueEntries(entries, searchEl.value);
      if (!visible.length) {
        listEl.replaceChildren(el("p", { class: "critique-empty" }, "No matching entries."));
        updateCount();
        return;
      }
      listEl.replaceChildren(
        ...visible.map((entry) =>
          el("label", { class: "critique-item", title: entry.id }, [
            el("input", {
              type: "checkbox",
              checked: selected.has(entry.id),
              disabled: !selected.has(entry.id) && selected.size >= MAX_CRITIQUE_ENTRIES,
              onchange: (event) => {
                if (event.target.checked) selected.add(entry.id);
                else selected.delete(entry.id);
                // Re-render so a new selection can disable the rest at the cap.
                renderList();
              },
            }),
            el("span", { class: "critique-name" }, entry.title || entry.id),
            el("span", { class: "critique-path" }, entry.folder || entry.group || ""),
          ])
        )
      );
      updateCount();
    }

    function selectVisible(all) {
      const visible = filterCritiqueEntries(entries, searchEl.value);
      if (all) {
        for (const entry of visible) {
          if (selected.size >= MAX_CRITIQUE_ENTRIES) break;
          selected.add(entry.id);
        }
      } else {
        for (const entry of visible) selected.delete(entry.id);
      }
      renderList();
    }

    const onKey = (event) => {
      if (event.key === "Escape") finish(null);
      else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        if (!startBtn.disabled) finish([...selected]);
      }
    };

    const { backdrop, close } = showModal([
      el("h3", {}, "Lain critique"),
      el(
        "p",
        { class: "critique-hint" },
        "Pick the entries for Lain to review. It will propose comments on exact quotes; you confirm each note before it is anchored."
      ),
      searchEl,
      el("div", { class: "critique-tools" }, [
        el("button", { class: "mini-btn", onclick: () => selectVisible(true) }, "Select all"),
        el("button", { class: "mini-btn", onclick: () => selectVisible(false) }, "Clear"),
        el("span", { class: "panel-head-spacer" }),
        countEl,
      ]),
      listEl,
      el("div", { class: "modal-actions" }, [
        el("button", { class: "icon-btn", onclick: () => finish(null) }, "Cancel"),
        startBtn,
      ]),
    ]);

    renderList();
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) finish(null);
    });
    document.addEventListener("keydown", onKey);
  });
}
