// Project-wide find & replace dialog. A leaf module: it runs the searches and
// the replace through the API. Opening a hit, flushing the editor before the
// sweep, and reloading changed documents are shell concerns and arrive via
// `ctx`.
import { api } from "./api.js";
import { el, toast, showModal, confirmDialog, formatNumber } from "./ui.js";

export function renderSearchDialog({
  projectId,
  currentDocId,
  flushSave,
  refreshAfterReplace,
  openDocument,
  revealText,
}) {
  const existing = document.querySelector(".modal-backdrop.search-modal");
  if (existing) { existing.remove(); return; }

  const input = el("input", {
    type: "search",
    class: "search-input",
    placeholder: "Search all documents…",
  });
  const replaceInput = el("input", {
    type: "text",
    class: "search-input search-replace-input",
    placeholder: "Replace with…",
  });
  const caseBox = el("input", { type: "checkbox", id: "search-case" });
  const wordBox = el("input", { type: "checkbox", id: "search-word" });
  const scopeSelect = el(
    "select",
    { class: "search-scope", id: "search-scope" },
    [
      ["all", "Whole project"],
      ["write", "Write"],
      ["wiki", "Wiki"],
      ["document", "Current document"],
    ].map(([value, label]) => el("option", { value }, label))
  );
  const statusEl = el("span", { class: "export-status" });
  const results = el("div", { class: "search-results" });

  let requestId = 0;
  let timer = null;

  function renderResults(result) {
    if (!result.totalMatches) {
      results.replaceChildren(
        el("div", { class: "search-empty" }, `No matches for “${result.query}”.`)
      );
      return;
    }
    const summary = el(
      "div",
      { class: "search-summary" },
      `${formatNumber(result.totalMatches)} match${result.totalMatches === 1 ? "" : "es"} in ${result.documentsMatched} document${result.documentsMatched === 1 ? "" : "s"}${result.truncated ? " · results capped" : ""}`
    );
    const groups = result.results.map((group) => {
      const hits = group.matches.map((hit) =>
        el("button", {
          class: "search-hit",
          title: "Open and select this match",
          onclick: () => jump(group.docId, hit),
        }, [hit.before, el("mark", {}, hit.match), hit.after])
      );
      return el("div", { class: "search-group" }, [
        el("div", { class: "search-doc" }, [
          el("span", { class: "search-doc-title" }, group.title),
          group.folder ? el("span", { class: "search-doc-folder" }, group.folder) : null,
          el("span", { class: "search-doc-count" }, `${group.count}×`),
        ]),
        ...hits,
      ]);
    });
    results.replaceChildren(summary, ...groups);
  }

  async function run() {
    const query = input.value.trim();
    const id = ++requestId;
    if (!query) {
      results.replaceChildren(el("div", { class: "search-empty" }, "Type to search."));
      statusEl.textContent = "";
      return;
    }
    const scope = scopeSelect.value;
    if (scope === "document" && !currentDocId()) {
      results.replaceChildren(el("div", { class: "search-empty" }, "No document is open."));
      return;
    }
    statusEl.textContent = "Searching…";
    try {
      const payload = {
        query,
        scope,
        selection:
          scope === "document"
            ? { folders: [], documents: [currentDocId()] }
            : null,
        options: { caseSensitive: caseBox.checked, wholeWord: wordBox.checked },
      };
      const result = await api.projects.search(projectId, payload);
      if (id !== requestId) return;
      renderResults(result);
      statusEl.textContent = "";
    } catch (err) {
      if (id !== requestId) return;
      statusEl.textContent = "";
      toast(err.message, "error");
    }
  }

  // The fields shared by the preview search and the replace itself.
  function replaceBase() {
    const scope = scopeSelect.value;
    return {
      query: input.value.trim(),
      scope,
      selection:
        scope === "document"
          ? { folders: [], documents: [currentDocId()] }
          : null,
      options: { caseSensitive: caseBox.checked, wholeWord: wordBox.checked },
    };
  }

  async function replaceAll() {
    const query = input.value.trim();
    if (!query) {
      input.focus();
      return;
    }
    if (scopeSelect.value === "document" && !currentDocId()) {
      toast("No document is open", "error");
      return;
    }
    statusEl.textContent = "Previewing…";
    try {
      // Make sure the open document's latest text is on disk before the sweep.
      await flushSave();
      const preview = await api.projects.search(projectId, replaceBase());
      statusEl.textContent = "";
      if (!preview.totalMatches) {
        toast("Nothing to replace");
        return;
      }
      const docs = preview.documentsMatched;
      const ok = await confirmDialog({
        title: "Replace all?",
        message:
          `Replace ${formatNumber(preview.totalMatches)} occurrence${preview.totalMatches === 1 ? "" : "s"} ` +
          `in ${formatNumber(docs)} document${docs === 1 ? "" : "s"} with “${replaceInput.value}”. ` +
          "Each document is snapshotted first, so a mistake can be undone from History.",
        confirmText: "Replace all",
        danger: false,
      });
      if (!ok) return;
      statusEl.textContent = "Replacing…";
      const result = await api.projects.replace(projectId, {
        ...replaceBase(),
        replacement: replaceInput.value,
      });
      statusEl.textContent = "";
      toast(
        `Replaced ${formatNumber(result.totalReplacements)} in ${formatNumber(result.documentsChanged)} document${result.documentsChanged === 1 ? "" : "s"}`
      );
      await refreshAfterReplace(result.results.map((entry) => entry.docId));
      run();
    } catch (err) {
      statusEl.textContent = "";
      toast(err.message, "error");
    }
  }

  const jump = async (docId, hit) => {
    close();
    await openDocument(docId);
    if (!revealText(hit.match, hit.occurrence)) toast("Opened the document");
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(timer);
      run();
    }
  });
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceAll();
    }
  });
  caseBox.addEventListener("change", run);
  wordBox.addEventListener("change", run);
  scopeSelect.addEventListener("change", run);

  const { backdrop, modal, close } = showModal([
    el("h3", {}, "Find & replace"),
    el("div", { class: "search-bar" }, [
      input,
      el("button", { class: "icon-btn primary", onclick: run }, "Search"),
    ]),
    el("div", { class: "search-bar search-replace-bar" }, [
      replaceInput,
      el("button", { class: "icon-btn", onclick: replaceAll }, "Replace all"),
    ]),
    el("div", { class: "search-options" }, [
      el("label", { class: "export-check-label" }, [caseBox, " Case sensitive"]),
      el("label", { class: "export-check-label" }, [wordBox, " Whole word"]),
      el("label", { class: "search-scope-label" }, ["In", scopeSelect]),
    ]),
    results,
    el("div", { class: "modal-actions" }, [
      statusEl,
      el("button", { class: "icon-btn", onclick: () => close() }, "Close"),
    ]),
  ]);
  backdrop.classList.add("search-modal");
  modal.style.maxWidth = "640px";
  input.focus();
  run();
}
