// Repetition check dialog. A leaf module: it reads the project tree and asks
// the API to run the check. Jumping to a hit needs the shell (open a document,
// then select the match), so that behaviour is injected through `ctx` rather
// than imported back from project.js.
import { api } from "./api.js";
import { el, toast, showModal, formatNumber } from "./ui.js";

// Which findings the results panel shows. Remembered across runs, like the
// stats tab's daily-list toggle.
const LS_REP_FILTER = "im.repetition.filter";

function repInt(input, fallback) {
  const value = parseInt(input.value, 10);
  return Number.isFinite(value) ? value : fallback;
}

export async function renderRepetitionDialog({ projectId, openDocument, revealText }) {
  const existing = document.querySelector(".modal-backdrop.repetition-modal");
  if (existing) { existing.remove(); return; }

  let tree;
  try {
    tree = await api.projects.tree(projectId, "all");
  } catch (err) {
    toast(err.message, "error");
    return;
  }

  // --- scope tree -----------------------------------------------------
  // Default to the Write scope: the wiki's lore entries would otherwise flood
  // the prose results, and it is one click to include them.
  const allDocBoxes = [];
  const folderEntries = [];
  const masterBox = el("input", { type: "checkbox", id: "rep-sel-all" });

  function nodeRow(box, label, depth, className) {
    return el("div", { class: `rep-node${className ? ` ${className}` : ""}`, style: { paddingLeft: `${10 + depth * 16}px` } }, [
      el("label", { class: "export-check-label" }, [box, ` ${label}`]),
    ]);
  }

  function setFolderChecked(entry, checked) {
    entry.cb.checked = checked;
    entry.cb.indeterminate = false;
    for (const child of entry.children) setFolderChecked(child, checked);
  }

  function syncMaster() {
    const total = allDocBoxes.length;
    const checked = allDocBoxes.filter((box) => box.checked).length;
    masterBox.checked = total > 0 && checked === total;
    masterBox.indeterminate = checked > 0 && checked < total;
  }

  function refreshUp(entry) {
    while (entry) {
      if (entry.cb) {
        const checked = entry.docs.filter((box) => box.checked).length;
        entry.cb.checked = entry.docs.length > 0 && checked === entry.docs.length;
        entry.cb.indeterminate = checked > 0 && checked < entry.docs.length;
      }
      entry = entry.parent;
    }
    syncMaster();
  }

  function buildNode(node, depth, parent, checked) {
    const entry = { cb: el("input", { type: "checkbox" }), own: [], docs: [], children: [], parent };
    entry.cb.checked = checked;
    const rows = [nodeRow(entry.cb, node.name, depth, "rep-folder")];
    for (const doc of node.documents || []) {
      const box = el("input", { type: "checkbox", value: doc.id });
      box.checked = checked;
      allDocBoxes.push(box);
      entry.own.push(box);
      rows.push(nodeRow(box, doc.title, depth + 1));
      box.addEventListener("change", () => refreshUp(entry));
    }
    entry.docs.push(...entry.own);
    for (const childFolder of node.folders || []) {
      const child = buildNode(childFolder, depth + 1, entry, checked);
      entry.children.push(child);
      entry.docs.push(...child.docs);
      rows.push(...child.rows);
    }
    entry.cb.addEventListener("change", () => {
      setFolderChecked(entry, entry.cb.checked);
      for (const box of entry.docs) box.checked = entry.cb.checked;
      refreshUp(parent);
    });
    folderEntries.push(entry);
    entry.rows = rows;
    return entry;
  }

  const rootEntry = { cb: null, own: [], docs: [], children: [], parent: null };
  const scopeRows = [];
  for (const doc of tree.documents || []) {
    const box = el("input", { type: "checkbox", value: doc.id });
    box.checked = true;
    allDocBoxes.push(box);
    rootEntry.own.push(box);
    rootEntry.docs.push(box);
    scopeRows.push(nodeRow(box, doc.title, 0));
    box.addEventListener("change", () => refreshUp(rootEntry));
  }
  for (const folder of tree.folders || []) {
    const include = folder.id !== "worldbuilding";
    const child = buildNode(folder, 1, rootEntry, include);
    rootEntry.children.push(child);
    rootEntry.docs.push(...child.docs);
    scopeRows.push(...child.rows);
  }
  syncMaster();
  masterBox.addEventListener("change", () => {
    for (const box of allDocBoxes) box.checked = masterBox.checked;
    for (const entry of folderEntries) {
      entry.cb.checked = masterBox.checked;
      entry.cb.indeterminate = false;
    }
    masterBox.indeterminate = false;
  });

  // --- options --------------------------------------------------------
  const optMinCount = el("input", { type: "number", min: 2, max: 1000, value: 4 });
  const optMinLength = el("input", { type: "number", min: 1, max: 40, value: 4 });
  const optWindow = el("input", { type: "number", min: 1, max: 1000, value: 50 });
  const optPhraseMin = el("input", { type: "number", min: 2, max: 10, value: 2 });
  const optPhraseMax = el("input", { type: "number", min: 2, max: 12, value: 5 });
  const optPhraseCount = el("input", { type: "number", min: 2, max: 1000, value: 3 });
  const optSentence = el("input", { type: "number", min: 1, max: 1000, value: 6 });
  const optStop = el("input", { type: "checkbox" });
  optStop.checked = true;
  const optProper = el("input", { type: "checkbox" });
  optProper.checked = true;
  const optionRow = (label, control) =>
    el("div", { class: "rep-option" }, [el("span", { class: "rep-option-label" }, label), control]);
  const options = el("details", { class: "rep-options" }, [
    el("summary", {}, "Options"),
    el("div", { class: "rep-options-grid" }, [
      optionRow("Flag words used at least", optMinCount),
      optionRow("Ignore words shorter than", optMinLength),
      optionRow("Flag repeats within (words)", optWindow),
      optionRow("Shortest phrase (words)", optPhraseMin),
      optionRow("Longest phrase (words)", optPhraseMax),
      optionRow("Flag phrases used at least", optPhraseCount),
      optionRow("Ignore repeated sentences under", optSentence),
      optionRow("Ignore common words", optStop),
      optionRow("Ignore proper nouns", optProper),
    ]),
  ]);

  // --- results --------------------------------------------------------
  const statusEl = el("span", { class: "export-status" });
  const results = el("div", { class: "rep-results" });

  function wordRows(items, kind) {
    return items.map((item) =>
      el("div", { class: "rep-row" }, [
        el("span", { class: "rep-word" }, item.word),
        el("span", { class: "rep-count" }, kind === "echo" ? `${item.count}× (gap ${item.minGap})` : `${item.count}×`),
        el("span", { class: "rep-per10k" }, kind === "echo" ? "" : `${item.per10k}/10k`),
        el("span", { class: "rep-docs", title: item.documents.join(", ") }, item.documents.join(", ")),
      ])
    );
  }

  function section(title, note, children) {
    return el("div", { class: "rep-section" }, [
      el("div", { class: "export-section-title" }, [title, note ? el("span", { class: "rep-note" }, ` — ${note}`) : null]),
      children.length ? el("div", { class: "rep-list" }, children) : el("div", { class: "rep-empty" }, "None."),
    ]);
  }

  function renderResults(result) {
    const wordSection = section("Overused words", "count · per 10k · documents", wordRows(result.overused, "overuse"));
    const echoSection = section("Nearby echoes", "same word reused close together", wordRows(result.echoes, "echo"));
    const jump = (docId, text) => async () => {
      close();
      await openDocument(docId);
      if (!revealText(text)) toast("Opened the document");
    };
    const phraseItems = result.phrases.map((item) =>
      el("div", { class: "rep-phrase" }, [
        el("div", { class: "rep-phrase-text" }, `“${item.phrase}”`),
        el("div", { class: "rep-phrase-meta" }, [
          el("span", { class: "rep-count" }, `${item.count}×`),
          el("span", { class: "rep-per10k" }, `${item.per10k}/10k`),
          ...item.occurrences.map((occ) =>
            el("button", { class: "rep-chip", title: "Open this document", onclick: jump(occ.docId, item.phrase) }, occ.title)
          ),
        ]),
      ])
    );
    const phraseSection = section("Repeated phrases", "longest repeated form", phraseItems);
    const sentenceItems = result.sentences.map((item) =>
      el("div", { class: "rep-sentence" }, [
        el("div", { class: "rep-sentence-text" }, `“${item.text}”`),
        el("div", { class: "rep-sentence-meta" }, [
          el("span", { class: "rep-count" }, `${item.count}×`),
          ...item.occurrences.map((occ) =>
            el("button", { class: "rep-chip", title: "Open this document", onclick: jump(occ.docId, occ.text) }, occ.title)
          ),
        ]),
      ])
    );
    const sentenceSection = section("Repeated sentences", "exact matches", sentenceItems);

    // "Words" covers both word sections so choosing it never hides the echoes.
    const sections = {
      words: [wordSection, echoSection],
      phrases: [phraseSection],
      sentences: [sentenceSection],
    };
    const allSections = Object.values(sections).flat();
    const stored = localStorage.getItem(LS_REP_FILTER);
    const filterSelect = el(
      "select",
      { class: "rep-filter", id: "rep-filter", title: "Which findings to show" },
      [["all", "All"], ["words", "Words"], ["phrases", "Phrases"], ["sentences", "Sentences"]].map(
        ([value, label]) => el("option", { value }, label)
      )
    );
    filterSelect.value = sections[stored] ? stored : "all";
    const applyFilter = () => {
      const visible = filterSelect.value === "all" ? allSections : sections[filterSelect.value];
      for (const node of allSections) node.hidden = !visible.includes(node);
    };
    filterSelect.addEventListener("change", () => {
      localStorage.setItem(LS_REP_FILTER, filterSelect.value);
      applyFilter();
    });
    const filterRow = el("div", { class: "rep-filter-row" }, [
      el("label", { class: "rep-filter-label", for: "rep-filter" }, "Show:"),
      filterSelect,
    ]);

    results.replaceChildren(
      el("div", { class: "rep-summary" }, `${formatNumber(result.words)} words across ${result.documents} document${result.documents === 1 ? "" : "s"}`),
      filterRow,
      wordSection,
      echoSection,
      phraseSection,
      sentenceSection
    );
    applyFilter();
  }

  // --- run ------------------------------------------------------------
  const runBtn = el("button", {
    class: "icon-btn primary",
    async onclick() {
      const selection = masterBox.checked
        ? null
        : { folders: [], documents: allDocBoxes.filter((box) => box.checked).map((box) => box.value) };
      if (selection && selection.documents.length === 0) {
        toast("Select at least one chapter or folder", "error");
        return;
      }
      const payload = {
        selection,
        options: {
          words: {
            minCount: repInt(optMinCount, 4),
            minLength: repInt(optMinLength, 4),
            proximityWindow: repInt(optWindow, 50),
            ignoreStopwords: optStop.checked,
            ignoreDictionary: true,
            ignoreProperNouns: optProper.checked,
          },
          phrases: {
            minWords: repInt(optPhraseMin, 2),
            maxWords: repInt(optPhraseMax, 5),
            minCount: repInt(optPhraseCount, 3),
          },
          sentences: { minWords: repInt(optSentence, 6) },
        },
      };
      runBtn.disabled = true;
      statusEl.textContent = "Checking…";
      try {
        const result = await api.projects.repetition(projectId, payload);
        renderResults(result);
        statusEl.textContent = "Done";
      } catch (err) {
        toast(err.message, "error");
        statusEl.textContent = "";
      } finally {
        runBtn.disabled = false;
      }
    },
  }, "Check");

  const { backdrop, modal, close } = showModal([
    el("h3", {}, "Repetition check"),
    el("div", { class: "export-section-title" }, "Include"),
    el("div", { class: "rep-scope" }, [
      el("div", { class: "export-check-row export-check-all" }, [
        el("label", { class: "export-check-label" }, [masterBox, " Select all (whole project)"]),
      ]),
      ...scopeRows,
    ]),
    options,
    el("div", { class: "modal-actions" }, [
      statusEl,
      el("button", { class: "icon-btn", onclick: () => close() }, "Close"),
      runBtn,
    ]),
    results,
  ]);
  backdrop.classList.add("repetition-modal");
  modal.style.maxWidth = "640px";
}
