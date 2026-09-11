// Document history (snapshots) dialog. A leaf module: it lists, previews,
// restores and deletes snapshots through the API. Restoring changes the file on
// disk, so reloading the on-screen editor is delegated to `ctx`.
import { api } from "./api.js";
import { el, toast, showModal, confirmDialog, formatNumber } from "./ui.js";

const SNAPSHOT_REASON_LABELS = {
  auto: "Auto",
  manual: "Manual",
  "before-restore": "Before restore",
  ai: "Lain",
  replace: "Before replace",
};

function snapshotReasonLabel(reason) {
  return SNAPSHOT_REASON_LABELS[reason] || reason || "Snapshot";
}

function snapshotWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function renderSnapshotsDialog({ projectId, currentDocId, flushSave, afterSnapshotRestore }) {
  const existing = document.querySelector(".modal-backdrop.snapshot-modal");
  if (existing) { existing.remove(); return; }

  const docId = currentDocId;
  const list = el("div", { class: "snap-list" });
  const statusEl = el("span", { class: "export-status" });
  const snapshotNow = el("button", { class: "icon-btn primary" }, "Snapshot now");

  function renderList(items) {
    if (!items.length) {
      list.replaceChildren(
        el("div", { class: "snap-empty" }, "No snapshots yet. One is saved automatically as you write.")
      );
      return;
    }
    list.replaceChildren(...items.map((s) =>
      el("div", { class: "snap-item" }, [
        el("div", { class: "snap-info" }, [
          el("span", { class: "snap-when" }, snapshotWhen(s.createdAt)),
          el("span", { class: "snap-meta" },
            `${snapshotReasonLabel(s.reason)} · ${formatNumber(s.words || 0)} words`),
        ]),
        el("span", { class: "snap-actions" }, [
          el("button", { class: "link-btn", onclick: () => preview(s.id) }, "preview"),
          el("button", { class: "link-btn", onclick: () => restore(s) }, "restore"),
          el("button", { class: "link-btn", onclick: () => remove(s) }, "delete"),
        ]),
      ])
    ));
  }

  async function refresh() {
    if (!docId) return;
    statusEl.textContent = "Loading…";
    try {
      const items = await api.snapshots.list(projectId, docId);
      statusEl.textContent = "";
      renderList(items);
    } catch (err) {
      statusEl.textContent = "";
      list.replaceChildren(
        el("div", { class: "snap-empty" }, `Couldn't load history: ${err.message}`)
      );
    }
  }

  async function preview(id) {
    statusEl.textContent = "Loading…";
    try {
      const snap = await api.snapshots.get(projectId, id, docId);
      statusEl.textContent = "";
      const body = el("pre", { class: "snap-preview" });
      body.textContent = snap.body || "";
      list.replaceChildren(
        el("div", { class: "snap-preview-head" }, [
          el("span", {},
            `${snapshotWhen(snap.meta.createdAt)} · ${snapshotReasonLabel(snap.meta.reason)} · ${formatNumber(snap.meta.words || 0)} words`),
          el("button", { class: "link-btn", onclick: () => refresh() }, "back to list"),
        ]),
        body
      );
    } catch (err) {
      statusEl.textContent = "";
      toast(err.message, "error");
    }
  }

  async function restore(s) {
    const ok = await confirmDialog({
      title: "Restore this snapshot?",
      message: `Replace the current text with the version from ${snapshotWhen(s.createdAt)}. Your current text is snapshotted first, so you can put it back.`,
      confirmText: "Restore",
      danger: false,
    });
    if (!ok) return;
    statusEl.textContent = "Restoring…";
    try {
      await flushSave();
      await api.snapshots.restore(projectId, s.id, docId);
      statusEl.textContent = "";
      close();
      await afterSnapshotRestore(docId);
      toast("Snapshot restored");
    } catch (err) {
      statusEl.textContent = "";
      toast(err.message, "error");
    }
  }

  async function remove(s) {
    const ok = await confirmDialog({
      title: "Delete this snapshot?",
      message: "This removes the snapshot for good.",
      confirmText: "Delete",
    });
    if (!ok) return;
    try {
      await api.snapshots.remove(projectId, s.id, docId);
      refresh();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  snapshotNow.addEventListener("click", async () => {
    if (!docId) return;
    try {
      await flushSave();
      await api.snapshots.create(projectId, docId);
      toast("Snapshot saved");
      refresh();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  const { backdrop, modal, close } = showModal([
    el("h3", {}, "Document history"),
    el("p", { class: "desc" },
      docId
        ? "Snapshots are saved automatically while you write. Restoring keeps your document's title and styling."
        : "Open a document to see its history."),
    el("div", { class: "snap-bar" }, [snapshotNow, statusEl]),
    list,
  ]);
  backdrop.classList.add("snapshot-modal");
  modal.style.maxWidth = "620px";
  if (!docId) {
    snapshotNow.disabled = true;
    list.replaceChildren(
      el("div", { class: "snap-empty" }, "Open a document to see its history.")
    );
    return;
  }
  refresh();
}
