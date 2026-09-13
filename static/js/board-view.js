// Board views: Outline / Corkboard / Beats.
//
// A planning surface over the real project tree. Metadata edits go through the
// document PATCH endpoint (frontmatter), so the Markdown body and exports stay
// in sync. Reordering hands the folder's complete mixed entry list back to the
// existing reorder endpoint, which renumbers the files and fixes wikilinks.
//
// The board is Write-scoped and lives in its own sidebar tab; the pure
// transforms are in board-model.js and unit tested there.

import { state, shell } from "./project-context.js";
import { api } from "./api.js";
import { el, toast, formatNumber, showModal } from "./ui.js";
import { openDocument } from "./editor-workspace.js";
import { folderNodeIn } from "./doc-tree.js";
import {
  STATUS_OPTIONS,
  LABELS,
  labelColor,
  scopeEntries,
  folderOptions,
  moveItem,
  beatColumns,
  findDocObject,
  folderWordCount,
  descendantDocs,
  progressPercent,
  synopsisSnippet,
} from "./board-model.js";

const VIEWS = [
  ["outline", "Outline"],
  ["corkboard", "Corkboard"],
  ["beats", "Beats"],
];

// Drag payload. Reorder rows/cards carry an index; beat cards carry a doc id.
let dragIndex = null;
let dragDocId = null;

export async function renderBoardTab() {
  await ensureBeats();
  renderBoard();
}

function renderBoard() {
  const main = document.getElementById("main-content");
  if (!main) return;
  main.classList.remove("no-scroll");
  if (!VIEWS.some(([id]) => id === state.boardView)) state.boardView = "outline";
  const toolbar = el("div", { class: "board-toolbar" }, [
    el(
      "div",
      { class: "board-switch" },
      VIEWS.map(([id, label]) =>
        el(
          "button",
          {
            class: `board-switch-btn ${state.boardView === id ? "active" : ""}`,
            onclick: () => {
              state.boardView = id;
              renderBoard();
            },
          },
          label
        )
      )
    ),
    el("div", { class: "topbar-spacer" }),
    scopeControl(),
    ...viewActions(state.boardView),
  ]);

  let body;
  if (state.boardView === "corkboard") body = renderCorkboard();
  else if (state.boardView === "beats") body = renderBeatBoard();
  else body = renderOutline();

  main.replaceChildren(el("div", { class: "board-view" }, [toolbar, body]));
}

function scopeControl() {
  const options = folderOptions(state.tree || {}, "", "Project root");
  if (!options.some((o) => o.id === state.boardFolder)) state.boardFolder = "";
  return el(
    "select",
    {
      class: "board-scope",
      title: "Scope the board to a folder",
      onchange: (e) => {
        state.boardFolder = e.target.value;
        renderBoard();
      },
    },
    options.map((o) =>
      el(
        "option",
        { value: o.id, selected: o.id === state.boardFolder },
        `${"\u00a0\u00a0".repeat(o.depth)}${o.name}`
      )
    )
  );
}

function viewActions(view) {
  if (view === "beats") {
    return [
      el("button", { class: "icon-btn", title: "Edit beat columns", onclick: editBeats }, "Edit beats"),
    ];
  }
  return [
    el(
      "button",
      { class: "icon-btn", onclick: () => shell.newDocument && shell.newDocument("chapter", state.boardFolder) },
      "+ Chapter"
    ),
    el(
      "button",
      { class: "icon-btn", onclick: () => shell.newDocument && shell.newDocument("note", state.boardFolder) },
      "+ Note"
    ),
    el("button", { class: "icon-btn", onclick: addFolder }, "+ Folder"),
  ];
}

async function addFolder() {
  if (!shell.newFolder) return;
  await shell.newFolder(state.boardFolder);
  renderBoard();
}

/* ---------------- data helpers ---------------- */

async function ensureBeats() {
  if (Array.isArray(state.project.beats) && state.project.beats.length) return;
  try {
    const res = await api.projects.beats.get(state.project.id);
    state.project.beats = res.beats || [];
  } catch {
    state.project.beats = state.project.beats || [];
  }
}

async function patchDoc(docId, patch) {
  try {
    const updated = await api.docs.update(state.project.id, docId, patch);
    const local =
      findDocObject(state.tree, docId) || findDocObject(state.wikiTree, docId);
    if (local) Object.assign(local, updated);
    return updated;
  } catch (err) {
    toast(err.message, "error");
    return null;
  }
}

async function reorderScope(ids) {
  try {
    // The shell's reorder also remaps expanded folders, rekeys warm editors and
    // reconciles tabs against the new ids; fall back to the raw endpoint only
    // when the board is driven without the full shell (tests).
    if (typeof shell.performReorder === "function") {
      await shell.performReorder(state.boardFolder, ids);
    } else {
      await api.docs.reorder(state.project.id, ids, state.boardFolder || null);
      await shell.refreshTree();
    }
    renderBoard();
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ---------------- outline ---------------- */

function renderOutline() {
  const { entries } = scopeEntries(state.tree, state.boardFolder, "");
  if (!entries.length) return emptyBoard("No chapters, notes, or folders in this folder yet.");
  const rows = entries.map((entry, index) =>
    entry.isFolder ? folderRow(entry, index, entries) : outlineRow(entry, index, entries)
  );
  return el("div", { class: "outline-table", role: "table" }, [
    el("div", { class: "outline-head", role: "row" }, [
      el("span", { class: "drag-col" }),
      el("span", {}, "Title"),
      el("span", {}, "Synopsis"),
      el("span", {}, "Status"),
      el("span", {}, "POV"),
      el("span", {}, "Label"),
      el("span", { class: "num" }, "Words"),
      el("span", {}, "Target"),
      el("span", {}),
    ]),
    ...rows,
  ]);
}

function outlineRow(doc, index, entries) {
  const row = el("div", { class: "outline-row", role: "row" }, [
    dragHandle(),
    titleInput(doc),
    synopsisField(doc),
    statusSelect(doc),
    textField(doc, "pov", "POV"),
    labelSelect(doc),
    el("span", { class: "num" }, formatNumber(doc.words || 0)),
    targetInput(doc),
    el(
      "button",
      { class: "icon-btn small", title: "Open in the editor", onclick: () => openDocument(doc.id) },
      "Open"
    ),
  ]);
  attachReorder(row, index, () => entries.map((e) => e.id));
  return row;
}

function folderRow(entry, index, entries) {
  const node = folderNodeIn(state.tree, entry.id);
  const row = el("div", { class: "outline-row folder-row", role: "row" }, [
    dragHandle(),
    el(
      "button",
      {
        class: "folder-open",
        title: "Open this folder",
        onclick: () => {
          state.boardFolder = entry.id;
          renderBoard();
        },
      },
      entry.name
    ),
    el("span", { class: "muted" }, "Folder"),
    el("span"),
    el("span"),
    el("span"),
    el("span", { class: "num" }, formatNumber(folderWordCount(node))),
    el("span"),
    el("span"),
  ]);
  attachReorder(row, index, () => entries.map((e) => e.id));
  return row;
}

function titleInput(doc) {
  return el("input", {
    class: "cell-input title",
    value: doc.title || "",
    placeholder: "Untitled",
    title: "Rename",
    onchange: async (e) => {
      const value = e.target.value.trim();
      if (!value || value === doc.title) {
        e.target.value = doc.title || "";
        return;
      }
      const updated = await patchDoc(doc.id, { title: value });
      if (!updated) {
        e.target.value = doc.title || "";
        return;
      }
      doc.title = updated.title;
      shell.renderSidebar();
    },
  });
}

function synopsisField(doc) {
  return textarea(
    {
      class: "cell-input synopsis",
      placeholder: "Add synopsis…",
      onchange: (e) => patchDoc(doc.id, { synopsis: e.target.value }),
    },
    doc.synopsis || ""
  );
}

function textField(doc, key, placeholder) {
  return el("input", {
    class: "cell-input",
    value: doc[key] || "",
    placeholder,
    onchange: (e) => {
      if ((doc[key] || "") === e.target.value) return;
      patchDoc(doc.id, { [key]: e.target.value });
    },
  });
}

function statusSelect(doc) {
  const options = [""].concat(STATUS_OPTIONS);
  if (doc.status && !options.includes(doc.status)) options.push(doc.status);
  return el(
    "select",
    { class: "cell-input status-select", title: "Status", onchange: (e) => patchDoc(doc.id, { status: e.target.value }) },
    options.map((s) => el("option", { value: s, selected: (doc.status || "") === s }, s || "—"))
  );
}

function labelSelect(doc) {
  const options = [{ id: "", color: "" }].concat(LABELS);
  if (doc.label && !options.some((l) => l.id === doc.label)) {
    options.push({ id: doc.label, color: "" });
  }
  return el(
    "select",
    { class: "cell-input label-select", title: "Label", onchange: (e) => patchDoc(doc.id, { label: e.target.value }) },
    options.map((l) => el("option", { value: l.id, selected: (doc.label || "") === l.id }, l.id || "—"))
  );
}

function targetInput(doc) {
  return el("input", {
    class: "cell-input target",
    type: "number",
    min: "0",
    value: doc.target || "",
    placeholder: "—",
    title: "Word target",
    onchange: (e) => patchDoc(doc.id, { target: e.target.value }),
  });
}

/* ---------------- corkboard ---------------- */

function renderCorkboard() {
  const { entries } = scopeEntries(state.tree, state.boardFolder, "");
  if (!entries.length) return emptyBoard("No chapters, notes, or folders in this folder yet.");
  const grid = el("div", { class: "corkboard" });
  entries.forEach((entry, index) => {
    const card = entry.isFolder ? folderCard(entry) : corkCard(entry);
    attachReorder(card, index, () => entries.map((e) => e.id));
    grid.append(card);
  });
  grid.append(
    addCard("+ Chapter", () => shell.newDocument && shell.newDocument("chapter", state.boardFolder)),
    addCard("+ Note", () => shell.newDocument && shell.newDocument("note", state.boardFolder))
  );
  return grid;
}

function corkCard(doc) {
  const card = el("div", {
    class: `cork-card${doc.label ? " labeled" : ""}`,
    style: { "--label-color": labelColor(doc.label) },
  });
  card.append(
    el("div", { class: "cork-title", title: "Open in the editor", onclick: () => openDocument(doc.id) }, doc.title || "Untitled"),
    el("div", { class: "cork-meta" }, [
      el("span", { class: `chip status-${doc.status || "none"}` }, doc.status || "—"),
      el("span", { class: "cork-words" }, `${formatNumber(doc.words || 0)} words`),
    ]),
    textarea(
      {
        class: "cork-synopsis",
        placeholder: "Add synopsis…",
        onchange: (e) => patchDoc(doc.id, { synopsis: e.target.value }),
      },
      doc.synopsis || ""
    ),
    doc.target ? targetBar(doc) : null
  );
  return card;
}

function folderCard(entry) {
  const node = folderNodeIn(state.tree, entry.id);
  return el("div", { class: "cork-card folder-card" }, [
    el(
      "div",
      {
        class: "cork-title",
        title: "Open this folder",
        onclick: () => {
          state.boardFolder = entry.id;
          renderBoard();
        },
      },
      `📁 ${entry.name}`
    ),
    el("div", { class: "cork-meta" }, [
      el("span", { class: "cork-words" }, `${formatNumber(folderWordCount(node))} words`),
    ]),
  ]);
}

function addCard(label, action) {
  return el("button", { class: "cork-card add-card", onclick: action }, label);
}

function targetBar(doc) {
  const pct = progressPercent(doc.words, doc.target);
  return el("div", { class: "cork-target", title: `${doc.words}/${doc.target} words` }, [
    el("div", { class: "cork-target-fill", style: { width: `${pct}%` } }),
    el("span", { class: "cork-target-label" }, `${pct}%`),
  ]);
}

/* ---------------- beat board ---------------- */

function renderBeatBoard() {
  const node = folderNodeIn(state.tree, state.boardFolder, "");
  const docs = descendantDocs(node);
  const columns = beatColumns(docs, state.project.beats || []);
  const board = el("div", { class: "beat-board" });
  for (const col of columns) {
    const body = el("div", { class: "beat-cards" });
    for (const doc of col.docs) body.append(beatCard(doc));
    body.addEventListener("dragover", (e) => {
      if (dragDocId) {
        e.preventDefault();
        body.classList.add("drop-target");
      }
    });
    body.addEventListener("dragleave", () => body.classList.remove("drop-target"));
    body.addEventListener("drop", async (e) => {
      e.preventDefault();
      body.classList.remove("drop-target");
      const docId = dragDocId;
      dragDocId = null;
      if (!docId) return;
      const doc = docs.find((d) => d.id === docId);
      if (!doc || (doc.beat || "") === col.id) return;
      await patchDoc(docId, { beat: col.id });
      renderBoard();
    });
    board.append(
      el("div", { class: `beat-column${col.unassigned ? " unassigned" : ""}${col.orphan ? " orphan" : ""}` }, [
        el("div", { class: "beat-head" }, [
          el("span", { class: "beat-name" }, col.name),
          el("span", { class: "beat-count" }, String(col.docs.length)),
        ]),
        body,
      ])
    );
  }
  return board;
}

function beatCard(doc) {
  const card = el("div", {
    class: "beat-card",
    draggable: "true",
    style: { "--label-color": labelColor(doc.label) },
  });
  card.append(
    el("div", { class: "beat-card-title", title: "Open in the editor", onclick: () => openDocument(doc.id) }, doc.title || "Untitled"),
    doc.synopsis ? el("div", { class: "beat-card-syn" }, synopsisSnippet(doc.synopsis, 90)) : null,
    el("div", { class: "beat-card-words" }, `${formatNumber(doc.words || 0)} words`)
  );
  card.addEventListener("dragstart", (e) => {
    dragDocId = doc.id;
    card.classList.add("dragging");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragend", () => {
    dragDocId = null;
    card.classList.remove("dragging");
    document.querySelectorAll(".drop-target").forEach((n) => n.classList.remove("drop-target"));
  });
  return card;
}

function editBeats() {
  const beats = (state.project.beats || []).map((b) => ({ ...b }));
  const list = el("div", { class: "beat-editor-list" });
  const draw = () => {
    list.replaceChildren(
      ...beats.map((beat, i) =>
        el("div", { class: "beat-editor-row" }, [
          el("input", { type: "text", value: beat.name || "", oninput: (e) => { beat.name = e.target.value; } }),
          el(
            "button",
            { class: "icon-btn small", title: "Move up", disabled: i === 0, onclick: () => { [beats[i - 1], beats[i]] = [beats[i], beats[i - 1]]; draw(); } },
            "↑"
          ),
          el(
            "button",
            { class: "icon-btn small", title: "Move down", disabled: i === beats.length - 1, onclick: () => { [beats[i + 1], beats[i]] = [beats[i], beats[i + 1]]; draw(); } },
            "↓"
          ),
          el(
            "button",
            { class: "icon-btn small danger", title: "Delete beat", onclick: () => { beats.splice(i, 1); draw(); } },
            "×"
          ),
        ])
      )
    );
  };
  draw();
  const { close } = showModal([
    el("h3", {}, "Beats"),
    el("p", { class: "muted" }, "Columns for the beat board. Renaming keeps a scene assigned; deleting moves its scenes to Unassigned."),
    list,
    el("div", { class: "modal-actions" }, [
      el("button", { class: "icon-btn", onclick: () => { beats.push({ id: "", name: "New beat" }); draw(); } }, "Add beat"),
      el("div", { class: "topbar-spacer" }),
      el("button", { class: "icon-btn", onclick: close }, "Cancel"),
      el(
        "button",
        {
          class: "icon-btn primary",
          onclick: async () => {
            await saveBeats(beats);
            close();
          },
        },
        "Save"
      ),
    ]),
  ]);
}

async function saveBeats(beats) {
  try {
    const res = await api.projects.beats.update(state.project.id, beats);
    state.project.beats = res.beats || [];
    renderBoard();
    toast("Beats saved");
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ---------------- shared bits ---------------- */

function emptyBoard(message) {
  return el("div", { class: "empty-state" }, [el("p", {}, message)]);
}

function dragHandle() {
  return el("span", { class: "drag-col", title: "Drag to reorder" }, "⠿");
}

function attachReorder(node, index, getIds) {
  node.classList.add("draggable");
  node.setAttribute("draggable", "true");
  node.addEventListener("dragstart", (e) => {
    dragIndex = index;
    node.classList.add("dragging");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  node.addEventListener("dragend", () => {
    dragIndex = null;
    node.classList.remove("dragging");
    document.querySelectorAll(".drop-target").forEach((n) => n.classList.remove("drop-target"));
  });
  node.addEventListener("dragover", (e) => {
    if (dragIndex === null) return;
    e.preventDefault();
    node.classList.add("drop-target");
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop-target"));
  node.addEventListener("drop", (e) => {
    e.preventDefault();
    node.classList.remove("drop-target");
    const from = dragIndex;
    dragIndex = null;
    if (from === null || from === index) return;
    reorderScope(moveItem(getIds(), from, index));
  });
}

function textarea(attrs, value) {
  const node = el("textarea", attrs);
  node.value = value == null ? "" : value;
  return node;
}
