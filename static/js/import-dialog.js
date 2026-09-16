// Import dialog. A leaf module like export-dialog.js: it talks to the API and
// the shared UI helpers, and knows nothing about the project shell — callers
// pass `projectId` (import into an open project) or leave it null (a new
// project is created first).
//
//   onChanged()              the project tree changed (import, or an undo)
//   onDone(summary, pid)     an import finished (the library navigates)
import { api } from "./api.js";
import { el, toast, showModal } from "./ui.js";
import {
  IMPORT_ACCEPT,
  IMPORT_LIMIT_BYTES,
  SOURCE_LABELS,
  bundleName,
  bundleSize,
  describeBundle,
  formatBytes,
  hasDocx,
  overLimit,
  relativePaths,
} from "./import-plan.js";

/** Flatten a tree into `{id, label}` options, indented by depth. */
function folderOptions(tree) {
  const out = [{ id: "", label: "Project root" }];
  const walk = (folders, depth) => {
    for (const folder of folders || []) {
      out.push({ id: folder.id, label: `${"— ".repeat(depth)}${folder.name}` });
      walk(folder.folders, depth + 1);
    }
  };
  walk(tree && tree.folders, 0);
  return out;
}

/** Undo: trash whatever the import created (a folder, or a single document). */
async function undoImport(projectId, summary) {
  if (summary.isFolder) await api.folders.remove(projectId, summary.folder);
  else await api.docs.remove(projectId, summary.folder);
}

export async function renderImportDialog({
  projectId = null,
  folder = "",
  onDone = null,
  onChanged = null,
} = {}) {
  let targetTree = null;
  if (projectId) {
    try {
      targetTree = await api.projects.tree(projectId, "all");
    } catch (err) {
      toast(err.message, "error");
      return;
    }
  }

  let picked = []; // File objects from either picker
  let paths = []; // and their relative paths — import-plan.js decides these

  const fileInput = el("input", { type: "file", multiple: true, accept: IMPORT_ACCEPT, hidden: true });
  const folderInput = el("input", { type: "file", webkitdirectory: "", hidden: true });

  const summaryEl = el("p", { class: "desc import-summary" }, "Nothing chosen yet.");

  const projectNameInput = el("input", { type: "text", placeholder: "e.g. The Amber Kingdom" });
  const projectField = projectId
    ? null
    : el("div", { class: "field" }, [el("label", {}, "New project name"), projectNameInput]);

  const bundleNameInput = el("input", { type: "text", placeholder: "e.g. Act One" });
  const bundleField = el("div", { class: "field" }, [
    el("label", {}, "Import into a folder named"),
    bundleNameInput,
  ]);

  const asSelect = el("select", {}, [
    el("option", { value: "chapter" }, "Chapters"),
    el("option", { value: "note" }, "Notes"),
  ]);

  // Word manuscripts usually separate chapters with Heading 1; the option only
  // appears when a .docx is actually picked, and does nothing when the file has
  // no Heading 1 at all.
  const splitCheck = el("input", { type: "checkbox", checked: true });
  const splitField = el("div", { class: "field checkbox" }, [
    el("label", {}, [splitCheck, " Split Word documents at Heading 1"]),
  ]);
  splitField.style.display = "none";

  let folderSelect = null;
  const targetField = projectId
    ? el("div", { class: "field" }, [
        el("label", {}, "Place inside"),
        (folderSelect = el(
          "select",
          {},
          folderOptions(targetTree).map((option) => el("option", { value: option.id }, option.label))
        )),
      ])
    : null;
  if (folderSelect && folder) folderSelect.value = folder;

  const importBtn = el("button", { class: "icon-btn primary", disabled: true }, "Import");
  const statusEl = el("span", { class: "export-status" });

  /** What the pick amounts to, and whether it can be sent as-is. */
  const assess = () => {
    const info = describeBundle(paths);
    // A zip hides its contents from the browser, so it is never "empty".
    const hasZip = paths.some((path) => /\.zip$/i.test(path));
    return { info, hasZip };
  };

  const refresh = () => {
    const { info, hasZip } = assess();
    const tooBig = overLimit(picked);
    if (!picked.length) {
      summaryEl.textContent = "Nothing chosen yet.";
    } else {
      const parts = [`${SOURCE_LABELS[info.source]} — ${info.documents} document${info.documents === 1 ? "" : "s"}`];
      if (info.folders) parts.push(`${info.folders} folder${info.folders === 1 ? "" : "s"}`);
      parts.push(formatBytes(bundleSize(picked)));
      if (hasZip) parts.push("archive unpacked on import");
      summaryEl.textContent = parts.join(" · ");
      if (tooBig) summaryEl.textContent += ` — larger than the ${formatBytes(IMPORT_LIMIT_BYTES)} limit`;
    }
    importBtn.disabled = !picked.length || tooBig || (info.documents === 0 && !hasZip);
    splitField.style.display = hasDocx(paths) ? "" : "none";
    // One loose file becomes one document in the target folder, so naming a
    // folder for it would be a lie (the server drops it).
    const single = info.files === 1 && info.documents === 1 && !info.folders;
    if (bundleField) bundleField.style.display = single ? "none" : "";
    if (projectField) projectNameInput.placeholder = bundleName(paths) || "e.g. The Amber Kingdom";
  };

  const take = (files) => {
    picked = Array.from(files || []);
    paths = relativePaths(picked);
    refresh();
  };

  fileInput.addEventListener("change", (e) => {
    take(e.target.files);
    e.target.value = "";
  });
  folderInput.addEventListener("change", (e) => {
    take(e.target.files);
    e.target.value = "";
  });

  const { modal, close } = showModal([
    el("h3", {}, projectId ? "Import" : "Import project"),
    el(
      "p",
      { class: "desc" },
      "Bring Markdown, plain-text, or zipped writing in. Folders become folders, files become " +
        "chapters or notes, and nothing already in the project is touched."
    ),
    el("div", { class: "modal-actions import-pick" }, [
      el("button", { class: "icon-btn", onclick: () => fileInput.click() }, "Choose files…"),
      el("button", { class: "icon-btn", onclick: () => folderInput.click() }, "Choose folder…"),
    ]),
    summaryEl,
    projectField,
    bundleField,
    el("div", { class: "field" }, [el("label", {}, "Import as"), asSelect]),
    splitField,
    targetField,
    el("div", { class: "modal-actions" }, [
      statusEl,
      el("button", { class: "icon-btn", onclick: () => close() }, "Cancel"),
      importBtn,
    ]),
  ]);
  modal.style.maxWidth = "520px";
  modal.append(fileInput, folderInput);

  importBtn.addEventListener("click", async () => {
    importBtn.disabled = true;
    statusEl.textContent = "Importing…";
    try {
      let pid = projectId;
      if (!pid) {
        const name = projectNameInput.value.trim() || bundleName(paths) || "Imported";
        const project = await api.projects.create(name);
        pid = project.id;
      }
      const summary = await api.projects.importBundle(pid, {
        files: picked,
        paths,
        folder: folderSelect ? folderSelect.value : folder,
        name: bundleNameInput.value.trim(),
        as: asSelect.value,
        split: splitCheck.checked,
        source: "auto",
      });
      const what = `${summary.documents} document${summary.documents === 1 ? "" : "s"}`;
      const into = summary.folderTitle ? ` into "${summary.folderTitle}"` : "";
      toast(`Imported ${what}${into}`, "info", {
        action: summary.folder
          ? {
              label: "Undo",
              onClick: async () => {
                try {
                  await undoImport(pid, summary);
                  toast("Import undone");
                  if (typeof onChanged === "function") await onChanged();
                } catch (err) {
                  toast(err.message, "error");
                }
              },
            }
          : null,
      });
      close();
      if (typeof onChanged === "function") await onChanged();
      if (typeof onDone === "function") await onDone(summary, pid);
    } catch (err) {
      toast(err.message, "error");
      importBtn.disabled = false;
      statusEl.textContent = "";
    }
  });

  refresh();
}
