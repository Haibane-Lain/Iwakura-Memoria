// Per-project dictionary dialog (the LanguageTool ignore list). A leaf module:
// it owns the overlay and persistence, and reports word changes through
// `onChanged` so the shell can update its state and every live editor.
import { api } from "./api.js";
import { el } from "./ui.js";

const DICT_MODAL_SEL = ".modal-overlay.dict-modal";

export function renderDictionaryDialog({ projectId, words, onChanged }) {
  const existing = document.querySelector(DICT_MODAL_SEL);
  if (existing) { existing.remove(); return; }

  let addInputEl, searchInputEl;

  function saveWords() {
    if (typeof onChanged === "function") onChanged(words);
    api.projects.dictionary.update(projectId, words).catch(() => {});
  }

  function addWord() {
    const w = addInputEl.value.trim();
    if (!w) return;
    if (words.some((x) => x.toLowerCase() === w.toLowerCase())) {
      addInputEl.value = "";
      return;
    }
    words.push(w);
    addInputEl.value = "";
    saveWords();
    refreshList();
  }

  function removeWord(w) {
    const idx = words.indexOf(w);
    if (idx < 0) return;
    words.splice(idx, 1);
    saveWords();
    refreshList();
  }

  function refreshList() {
    const query = searchInputEl ? searchInputEl.value.trim().toLowerCase() : "";
    const list = modal.querySelector(".dict-word-list");
    const count = modal.querySelector(".dict-word-count");
    if (!list) return;

    const filtered = query
      ? words.filter((w) => w.toLowerCase().includes(query))
      : words;

    const sorted = [...(filtered || [])].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );

    list.replaceChildren();
    if (words.length === 0) {
      list.append(el("div", { class: "dict-empty" }, "No words yet."));
    } else if (sorted.length === 0) {
      list.append(el("div", { class: "dict-empty" }, "No matching words."));
    } else {
      for (const w of sorted) {
        list.append(
          el("div", { class: "dict-word-row" }, [
            el("span", { class: "dict-word-text", title: w }, w),
            el("button", {
              class: "dict-word-remove",
              title: "Remove",
              onclick: () => removeWord(w),
            }, "\u00d7"),
          ])
        );
      }
    }

    if (count) {
      count.textContent = words.length
        ? `${words.length} word${words.length !== 1 ? "s" : ""}`
        : "";
    }
  }

  const overlay = el("div", { class: "modal-overlay dict-modal" }, [
    el("div", { class: "dict-dialog" }, [
      el("div", { class: "dict-header" }, [
        el("h3", {}, "Dictionary"),
        el("button", { class: "dict-close", onclick: () => overlay.remove() }, "\u00d7"),
      ]),
      el("div", { class: "dict-body" }, [
        el("div", { class: "dict-add-row" }, [
          addInputEl = el("input", {
            type: "text",
            class: "dict-add-input",
            placeholder: "Add word\u2026",
            onkeydown: (e) => { if (e.key === "Enter") addWord(); },
          }),
          el("button", { class: "primary dict-add-btn", onclick: addWord }, "Add"),
        ]),
        searchInputEl = el("input", {
          type: "text",
          class: "dict-search-input",
          placeholder: "Search\u2026",
          oninput: refreshList,
        }),
        el("div", { class: "dict-word-count" }),
        el("div", { class: "dict-word-list" }),
      ]),
    ]),
  ]);

  const modal = overlay.querySelector(".dict-dialog");
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  refreshList();

  setTimeout(() => { if (addInputEl) addInputEl.focus(); }, 100);
}
