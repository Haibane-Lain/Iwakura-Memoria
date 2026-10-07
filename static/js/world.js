// The world page: its series (each a container that grows to fit its books)
// and an "Unsorted" shelf for books that are not in a series. A book is a
// project; clicking one opens the writing workspace.
import { api } from "./api.js";
import * as router from "./router.js";
import * as theme from "./themes.js";
import { el, toast, promptDialog, confirmDialog, formatNumber, showModal } from "./ui.js";
import { showContextMenu } from "./context-menu.js";
import { afterMidpoint, reorderById } from "./drag-order.js";

let world = null;
let dragBookId = null;
let dragSeriesId = null;

// --- small helpers ----------------------------------------------------------

function coverNode(url, className) {
  if (url) {
    return el("img", { class: className, src: url, alt: "", loading: "lazy" });
  }
  return el("div", { class: `${className} cover-placeholder` });
}

function pickImage(onFile) {
  const input = el("input", { type: "file", accept: "image/*", style: { display: "none" } });
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (file) onFile(file);
    input.remove();
  });
  document.body.append(input);
  input.click();
}

function countLabel(count, noun) {
  return `${formatNumber(count)} ${count === 1 ? noun : `${noun}s`}`;
}

function totalBooks(w) {
  return w.books.length + w.series.reduce((n, s) => n + s.books.length, 0);
}

// A flat list of destinations for "Move to…": the current world's series and
// Unsorted shelf, then every other world's Unsorted shelf.
async function chooseDestination(book) {
  const worlds = await api.worlds.list();
  const options = [];
  for (const series of world.series) {
    options.push({
      label: `${world.title} › ${series.title}`,
      value: { worldId: world.id, seriesId: series.id },
    });
  }
  options.push({ label: `${world.title} › Unsorted`, value: { worldId: world.id, seriesId: null } });
  for (const other of worlds) {
    if (other.id !== world.id) {
      options.push({ label: `${other.title} › Unsorted`, value: { worldId: other.id, seriesId: null } });
    }
  }
  return new Promise((resolve) => {
    const { close } = showModal(
      [
        el("h3", {}, `Move "${book.title}"`),
        el(
          "div",
          { class: "chooser" },
          options.map((opt) =>
            el(
              "button",
              {
                class: "icon-btn chooser-item",
                onclick: () => {
                  close();
                  resolve(opt.value);
                },
              },
              opt.label
            )
          )
        ),
        el(
          "div",
          { class: "modal-actions" },
          [el("button", { class: "icon-btn", onclick: () => { close(); resolve(null); } }, "Cancel")]
        ),
      ],
      { onDismiss: () => resolve(null) }
    );
  });
}

// --- mutations --------------------------------------------------------------

async function withWorld(promise) {
  try {
    world = await promise;
    renderPage();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function createSeries() {
  const name = await promptDialog({
    title: "New series",
    label: "Series name",
    placeholder: "e.g. The Warden Chronicles",
    confirmText: "Create",
  });
  if (name === null || !name.trim()) return;
  await withWorld(api.worlds.addSeries(world.id, name.trim()));
}

async function renameSeries(series) {
  const name = await promptDialog({
    title: "Rename series",
    label: "Series name",
    value: series.title,
    confirmText: "Rename",
  });
  if (name === null || !name.trim() || name.trim() === series.title) return;
  await withWorld(api.worlds.renameSeries(world.id, series.id, name.trim()));
}

async function deleteSeries(series) {
  const ok = await confirmDialog({
    title: `Delete "${series.title}"?`,
    message: "The series container is removed; its books move to Unsorted.",
    confirmText: "Delete series",
  });
  if (!ok) return;
  await withWorld(api.worlds.removeSeries(world.id, series.id));
}

async function addBook(seriesId) {
  const name = await promptDialog({
    title: "New book",
    label: "Book title",
    placeholder: "e.g. The Amber Crown",
    confirmText: "Create",
  });
  if (name === null || !name.trim()) return;
  await withWorld(api.worlds.addBook(world.id, name.trim(), seriesId));
}

async function renameBook(book) {
  const name = await promptDialog({
    title: "Rename book",
    label: "Book title",
    value: book.title,
    confirmText: "Rename",
  });
  if (name === null || !name.trim() || name.trim() === book.title) return;
  try {
    await api.projects.rename(book.id, name.trim());
    world = await api.worlds.get(world.id);
    renderPage();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function deleteBook(book) {
  const ok = await confirmDialog({
    title: `Delete "${book.title}"?`,
    message: "This removes the book (its project folder and all its writing). This cannot be undone.",
    confirmText: "Delete book",
  });
  if (!ok) return;
  try {
    await api.projects.remove(book.id);
    toast("Book deleted");
    await withWorld(api.worlds.get(world.id));
  } catch (err) {
    toast(err.message, "error");
  }
}

async function setBookCover(book) {
  pickImage(async (file) => {
    try {
      await api.projects.setCover(book.id, file);
      await withWorld(api.worlds.get(world.id));
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

async function moveBook(book) {
  const target = await chooseDestination(book);
  if (!target) return;
  await withWorld(api.worlds.moveBook(target.worldId, book.id, target.seriesId));
}

async function setWorldCover() {
  pickImage(async (file) => {
    try {
      await withWorld(api.worlds.setCover(world.id, file));
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

async function renameWorld() {
  const name = await promptDialog({
    title: "Rename world",
    label: "World name",
    value: world.title,
    confirmText: "Rename",
  });
  if (name === null || !name.trim() || name.trim() === world.title) return;
  await withWorld(api.worlds.rename(world.id, name.trim()));
}

async function deleteWorld() {
  const ok = await confirmDialog({
    title: `Delete "${world.title}"?`,
    message:
      "This removes the world and its series. The books inside are kept and move to your first world's Unsorted shelf.",
    confirmText: "Delete world",
  });
  if (!ok) return;
  try {
    await api.worlds.remove(world.id);
    toast("World deleted");
    router.navigate("library");
  } catch (err) {
    toast(err.message, "error");
  }
}

// --- drag & drop ------------------------------------------------------------

function booksInSeries(seriesId) {
  if (!seriesId) return world.books;
  const series = world.series.find((s) => s.id === seriesId);
  return series ? series.books : [];
}

function seriesIdOfBook(bookId) {
  if (world.books.some((b) => b.id === bookId)) return null;
  const series = world.series.find((s) => s.books.some((b) => b.id === bookId));
  return series ? series.id : null;
}

async function onBookDrop(bookId, targetSeriesId, overCard, event) {
  const from = seriesIdOfBook(bookId);
  try {
    if (from === targetSeriesId) {
      const ids = booksInSeries(targetSeriesId).map((b) => b.id);
      if (!overCard || overCard.dataset.projectid === bookId) return;
      const next = reorderById(ids, bookId, overCard.dataset.projectid, afterMidpoint(overCard, event));
      if (next !== ids) await withWorld(api.worlds.reorderBooks(world.id, next, targetSeriesId));
    } else {
      await withWorld(api.worlds.moveBook(world.id, bookId, targetSeriesId));
    }
  } catch (err) {
    toast(err.message, "error");
  }
}

async function onSeriesDrop(dragId, targetId, after) {
  const ids = reorderById(world.series.map((s) => s.id), dragId, targetId, after);
  if (ids === world.series.map((s) => s.id)) return;
  await withWorld(api.worlds.reorderSeries(world.id, ids));
}

// --- rendering --------------------------------------------------------------

function bookMenu(book, seriesId) {
  const items = [
    { label: "Open", action: () => router.navigate("project", { id: book.id }) },
    { label: "Rename", action: () => renameBook(book) },
    { label: "Change cover", action: () => setBookCover(book) },
    { label: "Move to…", action: () => moveBook(book) },
  ];
  if (seriesId) items.push({ label: "Move to Unsorted", action: () => moveBookToUnsorted(book) });
  items.push(null, { label: "Delete", action: () => deleteBook(book) });
  return items;
}

async function moveBookToUnsorted(book) {
  await withWorld(api.worlds.moveBook(world.id, book.id, null));
}

function bookCard(book, seriesId) {
  const card = el(
    "div",
    {
      class: "book-card",
      dataset: { projectid: book.id },
      onclick: () => router.navigate("project", { id: book.id }),
      oncontextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, bookMenu(book, seriesId));
      },
    },
    [
      el("div", { class: "book-cover-frame" }, [coverNode(book.cover, "book-cover")]),
      el("div", { class: "book-title" }, book.title),
      el("div", { class: "book-meta" }, [
        `${formatNumber(book.words)} words`,
        el("span", { class: "dot-sep" }, "·"),
        countLabel(book.documents, "doc"),
      ]),
    ]
  );
  card.draggable = true;
  card.addEventListener("dragstart", (e) => {
    dragBookId = book.id;
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", book.id);
    } catch {
      /* ignore */
    }
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    dragBookId = null;
  });
  return card;
}

function booksGrid(books, seriesId) {
  const grid = el(
    "div",
    {
      class: "book-grid",
      dataset: seriesId ? { seriesid: seriesId } : {},
    },
    books.length
      ? books.map((book) => bookCard(book, seriesId))
      : [el("div", { class: "book-empty" }, "No books yet")]
  );
  grid.addEventListener("dragover", (e) => {
    if (!dragBookId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  grid.addEventListener("drop", (e) => {
    if (!dragBookId || dragSeriesId) return;
    e.preventDefault();
    e.stopPropagation();
    const overCard = e.target.closest(".book-card");
    onBookDrop(dragBookId, seriesId || null, overCard, e);
  });
  return grid;
}

function seriesPanel(series) {
  const grip = el("span", { class: "series-grip", draggable: "true", title: "Drag to reorder" }, "≣");
  grip.addEventListener("dragstart", (e) => {
    dragSeriesId = series.id;
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", series.id);
    } catch {
      /* ignore */
    }
  });
  grip.addEventListener("dragend", () => {
    dragSeriesId = null;
  });

  const panel = el(
    "section",
    { class: "series-panel", dataset: { seriesid: series.id } },
    [
      el("div", { class: "series-head" }, [
        grip,
        el("h2", { class: "series-title" }, series.title),
        el("span", { class: "series-count" }, countLabel(series.books.length, "book")),
        el("div", { class: "series-actions" }, [
          el("button", { class: "icon-btn", onclick: () => addBook(series.id) }, "+ Book"),
          el("button", {
            class: "icon-btn",
            title: "Rename series",
            onclick: () => renameSeries(series),
          }, "Rename"),
          el("button", {
            class: "icon-btn danger",
            title: "Delete series",
            onclick: () => deleteSeries(series),
          }, "Delete"),
        ]),
      ]),
      booksGrid(series.books, series.id),
    ]
  );

  panel.addEventListener("dragover", (e) => {
    if (!dragSeriesId || dragSeriesId === series.id) return;
    e.preventDefault();
    panel.classList.toggle("drop-after", afterMidpoint(panel, e));
    panel.classList.toggle("drop-before", !afterMidpoint(panel, e));
  });
  panel.addEventListener("dragleave", () => panel.classList.remove("drop-before", "drop-after"));
  panel.addEventListener("drop", (e) => {
    if (!dragSeriesId || dragSeriesId === series.id) return;
    e.preventDefault();
    e.stopPropagation();
    const after = afterMidpoint(panel, e);
    panel.classList.remove("drop-before", "drop-after");
    onSeriesDrop(dragSeriesId, series.id, after);
  });
  return panel;
}

function unsortedPanel() {
  return el("section", { class: "series-panel unsorted" }, [
    el("div", { class: "series-head" }, [
      el("h2", { class: "series-title" }, "Unsorted"),
      el("span", { class: "series-count" }, countLabel(world.books.length, "book")),
      el("div", { class: "series-actions" }, [
        el("button", { class: "icon-btn", onclick: () => addBook(null) }, "+ Book"),
      ]),
    ]),
    booksGrid(world.books, null),
  ]);
}

function page() {
  const seriesList =
    world.series.length || world.books.length
      ? el("div", { class: "series-list" }, [
          ...world.series.map(seriesPanel),
          unsortedPanel(),
        ])
      : el("div", { class: "empty-state" }, [
          el("h2", {}, "Nothing here yet"),
          el("p", {}, "Add a series, or a book to start writing."),
          el("button", { class: "icon-btn primary", onclick: createSeries }, "+ New series"),
        ]);

  return el("div", { class: "world-page" }, [
    el("div", { class: "world-hero" }, [
      el(
        "div",
        {
          class: "world-hero-cover",
          title: "Change cover",
          onclick: setWorldCover,
        },
        [coverNode(world.cover, "world-cover")]
      ),
      el("div", { class: "world-hero-info" }, [
        el("a", { class: "world-back", href: "#/" }, "← Worlds"),
        el("h1", { class: "world-hero-title" }, world.title),
        el("div", { class: "world-counts" }, [
          countLabel(world.series.length, "series"),
          el("span", { class: "dot-sep" }, "·"),
          countLabel(totalBooks(world), "book"),
        ]),
        el("div", { class: "world-hero-actions" }, [
          el("button", { class: "icon-btn primary", onclick: createSeries }, "+ Series"),
          el("button", { class: "icon-btn", onclick: () => addBook(null) }, "+ Book"),
          el("button", { class: "icon-btn", onclick: setWorldCover }, "Cover"),
          el("button", { class: "icon-btn", onclick: renameWorld }, "Rename"),
          el("button", { class: "icon-btn danger", onclick: deleteWorld }, "Delete"),
        ]),
      ]),
    ]),
    seriesList,
  ]);
}

function renderPage() {
  const root = document.getElementById("app");
  root.replaceChildren(
    el("div", { class: "topbar" }, [
      el("a", { class: "brand", href: "#/" }, [
        el("span", { class: "dot" }),
        el("span", {}, "Iwakura Memoria"),
      ]),
      el("div", { class: "topbar-spacer" }),
      theme.themeSelect(),
    ]),
    page()
  );
}

async function render(params) {
  try {
    world = await api.worlds.get(params.id);
  } catch (err) {
    toast(err.message, "error");
    router.navigate("library");
    return;
  }
  renderPage();
}

export function init() {
  router.on("world", render);
}
