// Project-wide find & replace, as a floating panel in the top-right corner.
//
// A leaf module: it runs the searches and the replace through the API, and
// steers the in-document highlights through the callbacks in `ctx`. Opening it
// again toggles it away. There is deliberately no backdrop: the document stays
// scrollable and editable while the panel is open, and the matches it paints
// stay visible until the panel is closed.
//
//   ctx.highlightMatches(query, options, occurrence) -> {total, active} | null
//   ctx.clearHighlights()
import { api } from "./api.js";
import { el, toast, confirmDialog, formatNumber } from "./ui.js";

// The one open panel. Rendering the dialog again — Ctrl+F, or the Find button —
// closes it, taking its highlights with it, like a toggle.
let activePanel = null;

export function renderSearchDialog({
  projectId,
  currentDocId,
  flushSave,
  refreshAfterReplace,
  openDocument,
  highlightMatches,
  clearHighlights,
}) {
  if (activePanel) {
    activePanel.close();
    activePanel = null;
    return;
  }

  const input = el("input", {
    type: "search",
    class: "search-input",
    placeholder: "Search all documents…",
    "aria-label": "Search all documents",
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
  const countEl = el("span", { class: "find-count" });
  const results = el("div", { class: "search-results" });
  const prevBtn = el("button", { class: "icon-btn find-step", title: "Previous match", onclick: () => step(-1) }, "▲");
  const nextBtn = el("button", { class: "icon-btn find-step", title: "Next match", onclick: () => step(1) }, "▼");
  const closeBtn = el("button", { class: "icon-btn find-close", title: "Close find (Esc)", onclick: () => close() }, "✕");

  let requestId = 0;
  let timer = null;
  // The last highlight painted for the open document: {total, active} from the
  // shell, or null when the document has no match. Drives the counter and the
  // ▲/▼ steps.
  let lastMatch = null;

  const query = () => input.value.trim();
  const options = () => ({ caseSensitive: caseBox.checked, wholeWord: wordBox.checked });

  function updateCounter(found) {
    lastMatch = found && found.total ? found : null;
    countEl.textContent = lastMatch ? `${lastMatch.active + 1} of ${lastMatch.total}` : "";
    prevBtn.disabled = !lastMatch;
    nextBtn.disabled = !lastMatch;
  }

  // Repaint the document's matches. `occurrence === null` clears instead.
  function paint(occurrence) {
    const text = query();
    if (!text || occurrence === null) {
      clearHighlights();
      updateCounter(null);
      return;
    }
    updateCounter(highlightMatches(text, options(), occurrence));
  }

  function step(delta) {
    if (!lastMatch) return;
    const next = (lastMatch.active + delta + lastMatch.total) % lastMatch.total;
    paint(next);
  }

  let activeHit = null;

  function markActiveHit(button) {
    if (activeHit) activeHit.classList.remove("active");
    activeHit = button || null;
    if (!activeHit) return;
    activeHit.classList.add("active");
    // jsdom has no scrollIntoView; a missing one must not break the jump.
    if (typeof activeHit.scrollIntoView === "function") {
      activeHit.scrollIntoView({ block: "nearest" });
    }
  }

  function renderResults(result) {
    activeHit = null;
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
      const hits = group.matches.map((hit) => {
        const button = el("button", {
          class: "search-hit",
          title: "Open and select this match",
          onclick: () => jump(group.docId, hit, button),
        }, [hit.before, el("mark", {}, hit.match), hit.after]);
        return button;
      });
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
    const text = query();
    const id = ++requestId;
    if (!text) {
      results.replaceChildren(el("div", { class: "search-empty" }, "Type to search."));
      statusEl.textContent = "";
      paint(null);
      return;
    }
    const scope = scopeSelect.value;
    if (scope === "document" && !currentDocId()) {
      results.replaceChildren(el("div", { class: "search-empty" }, "No document is open."));
      paint(null);
      return;
    }
    statusEl.textContent = "Searching…";
    try {
      const payload = {
        query: text,
        scope,
        selection:
          scope === "document"
            ? { folders: [], documents: [currentDocId()] }
            : null,
        options: options(),
      };
      const result = await api.projects.search(projectId, payload);
      if (id !== requestId) return;
      renderResults(result);
      statusEl.textContent = "";
      // Highlights are local to the document on screen, so they are painted
      // from the live editor rather than from the server's snippet offsets.
      paint(0);
    } catch (err) {
      if (id !== requestId) return;
      statusEl.textContent = "";
      paint(null);
      toast(err.message, "error");
    }
  }

  // The fields shared by the preview search and the replace itself.
  function replaceBase() {
    const scope = scopeSelect.value;
    return {
      query: query(),
      scope,
      selection:
        scope === "document"
          ? { folders: [], documents: [currentDocId()] }
          : null,
      options: options(),
    };
  }

  async function replaceAll() {
    if (!query()) {
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

  // Open the chapter a result belongs to, scroll its match into view and keep it
  // highlighted. The panel stays open so the next result is one click away.
  const jump = async (docId, hit, button) => {
    // A newer result click supersedes this one; don't paint its highlight onto
    // whatever document ended up on screen.
    if (!(await openDocument(docId))) return;
    const found = highlightMatches(query(), options(), hit.occurrence);
    markActiveHit(button);
    updateCounter(found);
    if (!found) toast("Opened the document");
  };

  function onKey(e) {
    if (e.key !== "Escape") return;
    // An overlay on top (the replace confirmation, a context menu) owns Escape
    // while it is open — dismissing it must not take the panel down too.
    if (document.querySelector(".modal-backdrop, .context-menu")) return;
    e.preventDefault();
    close();
  }

  function close() {
    document.removeEventListener("keydown", onKey, true);
    clearHighlights();
    panel.remove();
    if (activePanel && activePanel.panel === panel) activePanel = null;
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(timer);
    // Enter walks the matches of the open document once there are some (Google
    // Docs' behavior); before that it runs the search.
    if (lastMatch) step(e.shiftKey ? -1 : 1);
    else run();
  });
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceAll();
    }
  });
  caseBox.addEventListener("change", () => {
    run();
  });
  wordBox.addEventListener("change", () => {
    run();
  });
  scopeSelect.addEventListener("change", () => {
    run();
  });

  const panel = el("div", {
    class: "find-panel",
    role: "search",
    "aria-label": "Find & replace",
  }, [
    el("div", { class: "find-bar" }, [input, prevBtn, nextBtn, countEl, closeBtn]),
    el("div", { class: "search-options" }, [
      el("label", { class: "export-check-label" }, [caseBox, " Case sensitive"]),
      el("label", { class: "export-check-label" }, [wordBox, " Whole word"]),
      el("label", { class: "search-scope-label" }, ["In", scopeSelect]),
    ]),
    el("div", { class: "search-bar search-replace-bar" }, [
      replaceInput,
      el("button", { class: "icon-btn", onclick: replaceAll }, "Replace all"),
    ]),
    results,
    el("div", { class: "find-status" }, [statusEl]),
  ]);
  updateCounter(null);
  document.body.append(panel);
  document.addEventListener("keydown", onKey, true);
  activePanel = { panel, close };
  input.focus();
  run();
}
