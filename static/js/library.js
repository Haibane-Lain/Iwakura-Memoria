import { api } from "./api.js";
import * as router from "./router.js";
import * as theme from "./themes.js";
import { renderExportDialog } from "./project.js";
import { el, toast, promptDialog, confirmDialog, formatNumber } from "./ui.js";

async function createProject() {
  const name = await promptDialog({
    title: "New project",
    label: "Project name",
    placeholder: "e.g. The Amber Kingdom",
    confirmText: "Create",
  });
  if (name === null) return;
  if (!name.trim()) {
    toast("A name is required", "error");
    return;
  }
  try {
    const project = await api.projects.create(name.trim());
    router.navigate("project", { id: project.id });
  } catch (err) {
    toast(err.message, "error");
  }
}

async function deleteProject(id, title) {
  const ok = await confirmDialog({
    title: `Delete "${title}"?`,
    message: "This removes the project folder and all its writing. This cannot be undone.",
    confirmText: "Delete project",
  });
  if (!ok) return;
  try {
    await api.projects.remove(id);
    toast("Project deleted");
    render();
  } catch (err) {
    toast(err.message, "error");
  }
}

function projectCard(project) {
  const updated = project.updatedAt ? new Date(project.updatedAt).toLocaleDateString() : "—";
  const words = formatNumber(project.words);
  const docs = project.documents;
  return el(
    "div",
    { class: "project-card" },
    [
      el(
        "div",
        { class: "project-meta" },
        [
          el("span", { class: "chip" }, `${words} words`),
          el("span", { class: "chip" }, `${docs} ${docs === 1 ? "doc" : "docs"}`),
          el("span", { class: "chip" }, `Updated ${updated}`),
        ]
      ),
      el("h3", {}, project.title),
      el(
        "div",
        { class: "project-actions" },
        [
          el("button", {
            class: "icon-btn",
            onclick: (e) => {
              e.stopPropagation();
              router.navigate("project", { id: project.id });
            },
          }, "Open"),
          el("button", {
            class: "icon-btn",
            onclick: (e) => {
              e.stopPropagation();
              renderExportDialog(project.id);
            },
          }, "Export"),
          el("button", {
            class: "icon-btn danger",
            onclick: (e) => {
              e.stopPropagation();
              deleteProject(project.id, project.title);
            },
          }, "Delete"),
        ]
      ),
    ]
  );
}

async function render() {
  const root = document.getElementById("app");
  let projects = [];
  let failed = false;
  try {
    projects = await api.projects.list();
  } catch (err) {
    failed = true;
    toast(err.message, "error");
  }

  const grid = failed
    ? el("div", { class: "empty-state" }, [
        el("h2", {}, "Couldn't load projects"),
        el("p", {}, "Check that the server is running."),
      ])
    : projects.length === 0
      ? el("div", { class: "empty-state" }, [
          el("h2", {}, "No projects yet"),
          el("p", {}, "Start a new writing project to begin."),
          el("button", { class: "icon-btn primary", onclick: createProject }, "New project"),
        ])
      : el("div", { class: "project-grid" }, projects.map(projectCard));

  root.replaceChildren(
    el("div", { class: "topbar" }, [
      el("a", { class: "brand", href: "#/" }, [
        el("span", { class: "dot" }),
        el("span", {}, "Iwakura Memoria"),
      ]),
      el("div", { class: "topbar-spacer" }),
      theme.themeSelect(),
    ]),
    el(
      "div",
      { class: "library" },
      [
        el("div", { class: "library-header" }, [
          el("h1", {}, "Projects"),
          el("button", { class: "icon-btn primary", onclick: createProject }, "+ New project"),
        ]),
        grid,
      ]
    )
  );
}

export function init() {
  router.on("library", render);
}
