// Project export dialog. A leaf module: it talks to the API and the shared UI
// helpers, and knows nothing about the project shell's state. In the desktop
// shell the save-as dialog is handled by pywebview; in the browser the archive
// is downloaded directly.
import { api, triggerDownload } from "./api.js";
import { el, toast, showModal } from "./ui.js";

const EXPORT_FORMATS = [
  { value: "zip", label: "ZIP", desc: "Original Markdown files + project metadata." },
  { value: "docx", label: "DOCX", desc: "Formatted Word document (.docx)." },
  { value: "pdf", label: "PDF", desc: "Print-ready PDF with styled formatting." },
  { value: "epub", label: "EPUB", desc: "E-book (.epub) with auto-generated table of contents." },
];

export async function renderExportDialog(projectId) {
  let tree;
  try {
    tree = await api.projects.tree(projectId, "all");
  } catch (err) {
    toast(err.message, "error");
    return;
  }

  const topFolders = (tree && tree.folders) || [];
  const rootDocCount = (tree && tree.documents) ? tree.documents.length : 0;

  const selectAllCb = el("input", { type: "checkbox", id: "exp-sel-all" });
  selectAllCb.checked = true;

  const folderChecks = topFolders.map((f) => {
    const cb = el("input", { type: "checkbox", value: f.id || f.name });
    cb.checked = true;
    return { cb, folder: f, row: null };
  });

  let rootCheck = null;
  if (rootDocCount > 0) {
    const cb = el("input", { type: "checkbox", value: "." });
    cb.checked = true;
    rootCheck = { cb };
  }

  function _syncMaster() {
    const all = selectAllCb.checked;
    folderChecks.forEach((f) => { f.cb.checked = all; f.cb.disabled = all; });
    if (rootCheck) { rootCheck.cb.checked = all; rootCheck.cb.disabled = all; }
  }

  function _syncChild() {
    const allChecked = folderChecks.every((f) => f.cb.checked)
      && (rootCheck ? rootCheck.cb.checked : true);
    const noneChecked = folderChecks.every((f) => !f.cb.checked)
      && (rootCheck ? !rootCheck.cb.checked : true);
    selectAllCb.checked = allChecked;
    selectAllCb.indeterminate = !allChecked && !noneChecked;
  }

  selectAllCb.addEventListener("change", _syncMaster);
  folderChecks.forEach((fc) => fc.cb.addEventListener("change", _syncChild));
  if (rootCheck) rootCheck.cb.addEventListener("change", _syncChild);

  const folderListItems = [];
  const selAllLabel = el("label", { class: "export-check-label" }, [selectAllCb, " Select all folders"]);
  folderListItems.push(el("div", { class: "export-check-row export-check-all" }, [selAllLabel]));

  for (const fc of folderChecks) {
    const label = el("label", { class: "export-check-label" }, [fc.cb, ` ${fc.folder.name}`]);
    fc.row = el("div", { class: "export-check-row" }, [label]);
    folderListItems.push(fc.row);
  }

  if (rootCheck) {
    const label = el("label", { class: "export-check-label" }, [rootCheck.cb, ` Top-level documents (${rootDocCount})`]);
    folderListItems.push(el("div", { class: "export-check-row" }, [label]));
  }

  const folderList = el("div", { class: "export-folder-list" }, folderListItems);

  let selectedFormat = "zip";
  const formatRadios = EXPORT_FORMATS.map((f) => {
    const radio = el("input", { type: "radio", name: "export-format", value: f.value });
    if (f.value === "zip") radio.checked = true;
    radio.addEventListener("change", () => { selectedFormat = f.value; });
    return el("label", { class: "export-radio-label" }, [
      radio,
      el("span", { class: "export-radio-text" }, [el("strong", {}, f.label), ` — ${f.desc}`]),
    ]);
  });

  const formatSection = el("div", { class: "export-format-section" }, [
    el("div", { class: "export-section-title" }, "Format"),
    el("div", { class: "export-radio-group" }, formatRadios),
  ]);

  const statusEl = el("span", { class: "export-status" });

  const { modal, close } = showModal([
    el("h3", {}, "Export Project"),
    formatSection,
    el("div", { class: "export-section-title" }, "Folders"),
    folderList,
    el("div", { class: "modal-actions" }, [
      statusEl,
      el("button", { class: "icon-btn", onclick: () => close() }, "Cancel"),
      el("button", {
        class: "icon-btn primary",
        async onclick() {
          const btn = this;
          btn.disabled = true;
          statusEl.textContent = "Exporting…";
          try {
            let folders;
            if (selectAllCb.checked) {
              folders = null;
            } else {
              folders = [];
              folderChecks.forEach((fc) => { if (fc.cb.checked && fc.folder.id) folders.push(fc.folder.id); });
              if (rootCheck && rootCheck.cb.checked) folders.push(".");
            }

            if (window.pywebview && window.pywebview.api) {
              const result = await window.pywebview.api.export_with_dialog(projectId, selectedFormat, folders);
              if (result.cancelled) {
                close();
                return;
              }
              if (result.error) throw new Error(result.error);
            } else {
              const resp = await api.projects.export(projectId, { format: selectedFormat, folders });
              triggerDownload(resp);
            }
            statusEl.textContent = "Done!";
            setTimeout(close, 800);
          } catch (err) {
            toast(err.message, "error");
            btn.disabled = false;
            statusEl.textContent = "";
          }
        },
      }, "Export"),
    ]),
  ]);

  modal.style.maxWidth = "520px";
}
