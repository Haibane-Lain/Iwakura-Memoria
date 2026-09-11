// Lookup dialog: definitions and synonyms for a word. A leaf module — it owns
// the overlay and asks the API to look a word up. Replacing the editor's
// selection needs the shell, so that is injected through `onReplace` rather
// than imported back from project.js.
import { api } from "./api.js";
import { el, showModal } from "./ui.js";

export function renderLookupDialog({ word = "", onReplace } = {}) {
  const existing = document.querySelector(".modal-backdrop.lookup-modal");
  if (existing) {
    existing.remove();
    return;
  }

  let current = String(word || "").trim();

  const results = el("div", { class: "lookup-results" });
  const status = el("div", { class: "lookup-status" });
  const input = el("input", {
    type: "text",
    class: "lookup-input",
    placeholder: "Look up a word…",
    spellcheck: "false",
  });
  input.value = current;

  function chip(text) {
    return el("button", {
      class: "lookup-chip",
      title: `Replace with “${text}”`,
      onclick: () => {
        if (typeof onReplace === "function") onReplace(current, text);
      },
    }, text);
  }

  function renderResults(data) {
    if (!data || !data.found) {
      const missing = (data && data.word) || current;
      results.append(
        el("p", { class: "lookup-empty" }, `No entry for “${missing}”.`)
      );
      return;
    }
    if (data.headword && data.headword.toLowerCase() !== current.toLowerCase()) {
      results.append(
        el("div", { class: "lookup-headword" }, `Showing “${data.headword}”`)
      );
    }
    for (const entry of data.entries || []) {
      const senses = el("ol", { class: "lookup-senses" });
      for (const sense of entry.senses || []) {
        const item = el("li", { class: "lookup-sense" }, [
          el("div", { class: "lookup-def" }, sense.definition || ""),
        ]);
        if (sense.examples && sense.examples.length) {
          item.append(
            el("div", { class: "lookup-examples" },
              sense.examples.map((example) =>
                el("span", { class: "lookup-example" }, example)
              )
            )
          );
        }
        if (sense.synonyms && sense.synonyms.length) {
          item.append(
            el("div", { class: "lookup-words" }, [
              el("span", { class: "lookup-words-label" }, "Synonyms"),
              ...sense.synonyms.map(chip),
            ])
          );
        }
        if (sense.antonyms && sense.antonyms.length) {
          item.append(
            el("div", { class: "lookup-words" }, [
              el("span", { class: "lookup-words-label" }, "Antonyms"),
              ...sense.antonyms.map(chip),
            ])
          );
        }
        senses.append(item);
      }
      results.append(
        el("div", { class: "lookup-entry" }, [
          el("div", { class: "lookup-pos" }, entry.pos),
          senses,
        ])
      );
    }
  }

  async function search(term) {
    const query = String(term || "").trim();
    if (!query) {
      input.focus();
      return;
    }
    current = query;
    results.replaceChildren();
    status.classList.remove("error");
    status.textContent = "Looking up…";
    let data;
    try {
      data = await api.lookup.get(query);
    } catch (err) {
      status.classList.add("error");
      status.textContent =
        err.status === 503
          ? "WordNet isn't installed. See the README's Lookup section to add it."
          : err.message || "Lookup failed.";
      return;
    }
    status.textContent = "";
    renderResults(data);
  }

  const { backdrop, modal } = showModal([
    el("div", { class: "lookup-header" }, [
      el("h3", {}, "Lookup"),
      el("span", { class: "lookup-sub" }, "definitions & synonyms"),
    ]),
    el("div", { class: "lookup-search" }, [
      input,
      el("button", { class: "icon-btn primary", onclick: () => search(input.value) }, "Look up"),
    ]),
    status,
    results,
  ]);
  backdrop.classList.add("lookup-modal");
  modal.style.maxWidth = "560px";

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      search(input.value);
    }
  });

  if (current) search(current);
  else setTimeout(() => input.focus(), 30);
}
