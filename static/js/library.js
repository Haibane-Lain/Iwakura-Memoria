import { api } from "./api.js";
import * as router from "./router.js";
import * as theme from "./themes.js";
import { renderImportDialog } from "./import-dialog.js";
import { el, toast, promptDialog, confirmDialog, formatNumber } from "./ui.js";
import { enableDragOrder, reorderById } from "./drag-order.js";

let worlds = [];

async function createWorld() {
  const name = await promptDialog({
    title: "New world",
    label: "World name",
    placeholder: "e.g. The Amber Kingdom",
    confirmText: "Create",
  });
  if (name === null) return;
  if (!name.trim()) {
    toast("A name is required", "error");
    return;
  }
  try {
    const world = await api.worlds.create(name.trim());
    router.navigate("world", { id: world.id });
  } catch (err) {
    toast(err.message, "error");
  }
}

async function renameWorld(world) {
  const name = await promptDialog({
    title: "Rename world",
    label: "World name",
    value: world.title,
    confirmText: "Rename",
  });
  if (name === null || !name.trim() || name.trim() === world.title) return;
  try {
    await api.worlds.rename(world.id, name.trim());
    await render();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function deleteWorld(world) {
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
    await render();
  } catch (err) {
    toast(err.message, "error");
  }
}

// A hidden file input is the only way to open the OS picker without a form.
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

async function setWorldCover(world) {
  pickImage(async (file) => {
    try {
      await api.worlds.setCover(world.id, file);
      await render();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

function coverNode(url, className) {
  if (url) {
    return el("img", { class: className, src: url, alt: "", loading: "lazy" });
  }
  // Plain white until a cover is uploaded.
  return el("div", { class: `${className} cover-placeholder` });
}

function countLabel(count, noun) {
  return `${formatNumber(count)} ${count === 1 ? noun : `${noun}s`}`;
}

function worldCard(world) {
  const actions = el("div", { class: "world-card-actions" }, [
    el("button", {
      class: "icon-btn",
      title: "Change cover",
      onclick: (e) => {
        e.stopPropagation();
        setWorldCover(world);
      },
    }, "Cover"),
    el("button", {
      class: "icon-btn",
      title: "Rename world",
      onclick: (e) => {
        e.stopPropagation();
        renameWorld(world);
      },
    }, "Rename"),
    el("button", {
      class: "icon-btn danger",
      title: "Delete world",
      onclick: (e) => {
        e.stopPropagation();
        deleteWorld(world);
      },
    }, "Delete"),
  ]);

  const node = el(
    "div",
    {
      class: "world-card",
      dataset: { worldid: world.id },
      onclick: () => router.navigate("world", { id: world.id }),
    },
    [
      el("div", { class: "world-cover-frame" }, [coverNode(world.cover, "world-cover"), actions]),
      el("div", { class: "world-card-info" }, [
        el("h3", { class: "world-title" }, world.title),
        el("div", { class: "world-counts" }, [
          countLabel(world.series, "series"),
          el("span", { class: "dot-sep" }, "·"),
          countLabel(world.books, "book"),
        ]),
      ]),
    ]
  );
  return node;
}

function importWorld() {
  renderImportDialog({
    onDone: (summary, projectId) => {
      if (projectId) router.navigate("project", { id: projectId });
    },
  });
}

async function render() {
  const root = document.getElementById("app");
  let failed = false;
  try {
    worlds = await api.worlds.list();
  } catch (err) {
    failed = true;
    toast(err.message, "error");
  }

  let grid;
  if (failed) {
    grid = el("div", { class: "empty-state" }, [
      el("h2", {}, "Couldn't load worlds"),
      el("p", {}, "Check that the server is running."),
    ]);
  } else if (worlds.length === 0) {
    grid = el("div", { class: "empty-state" }, [
      el("h2", {}, "No worlds yet"),
      el("p", {}, "Create a world to gather your series and books."),
      el("button", { class: "icon-btn primary", onclick: createWorld }, "New world"),
    ]);
  } else {
    const cards = worlds.map(worldCard);
    grid = el("div", { class: "world-grid" }, cards);
    enableDragOrder(
      grid,
      cards,
      (node) => node.dataset.worldid,
      async (dragId, targetId, after) => {
        const ids = reorderById(worlds.map((w) => w.id), dragId, targetId, after);
        try {
          worlds = await api.worlds.reorderWorlds(ids);
          await render();
        } catch (err) {
          toast(err.message, "error");
        }
      }
    );
  }

  root.replaceChildren(
    el("div", { class: "topbar" }, [
      el("a", { class: "brand", href: "#/" }, [
        el("span", { class: "dot" }),
        el("span", {}, "Iwakura Memoria"),
      ]),
      el("div", { class: "topbar-spacer" }),
      theme.themeSelect(),
    ]),
    el("div", { class: "library" }, [
      el("div", { class: "library-header" }, [
        el("h1", {}, "Worlds"),
        el("button", { class: "icon-btn", onclick: importWorld }, "Import…"),
        el("button", { class: "icon-btn primary", onclick: createWorld }, "+ New world"),
      ]),
      grid,
    ])
  );
}

export function init() {
  router.on("library", render);
}
