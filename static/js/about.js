// About & updates panel. Shared by the library topbar and the project topbar
// so version/update controls are reachable even before a project exists.
//
// The panel only enables update controls when the Electron preload exposed
// `window.desktop`; the browser and legacy pywebview shells still get the
// version/folder/diagnostics information they can provide.

import { api } from "./api.js";
import { confirmDialog, el, showModal, toast } from "./ui.js";
import { flushAllSaves } from "./save-hooks.js";
import {
  clampPercent,
  diagnosticsText,
  formatWhen,
  progressText,
  statusSummary,
} from "./update-format.js";

const RELEASES_URL = "https://github.com/Haibane-Lain/Iwakura-Memoria/releases/latest";

let aboutOpen = false;
let updateWatcherStarted = false;
const promptedUpdates = new Set();

function desktopBridge() {
  return window.desktop || null;
}

function updateBridge() {
  return desktopBridge() && desktopBridge().updates ? desktopBridge().updates : null;
}

function platformLabel(info) {
  const platform =
    info.platform === "win32" ? "Windows" : info.platform === "darwin" ? "macOS" : info.platform || "";
  return [platform, info.arch, info.electron ? `Electron ${info.electron}` : ""]
    .filter(Boolean)
    .join(" · ");
}

function announceUpdate(status) {
  if (!status || status.state !== "downloaded" || aboutOpen) return;
  const version = (status.update && status.update.version) || "a new version";
  if (promptedUpdates.has(version)) return;
  promptedUpdates.add(version);
  toast(`Version ${version} is ready to install.`, "info", {
    action: { label: "Update", onClick: () => openAboutDialog() },
  });
}

export function initUpdateNotifications() {
  if (updateWatcherStarted) return;
  const updates = updateBridge();
  if (!updates) return;
  updateWatcherStarted = true;
  updates.onStatus(announceUpdate);
  updates
    .getStatus()
    .then(announceUpdate)
    .catch(() => {
      /* status is also loaded when About opens */
    });
}

function folderRow(label, pathText, onOpen) {
  return el("div", { class: "about-folder" }, [
    el("div", {}, [
      el("div", { class: "about-folder-label" }, label),
      el("div", { class: "about-path" }, pathText),
    ]),
    el("button", { class: "icon-btn", type: "button", onclick: onOpen }, "Open"),
  ]);
}

export function openAboutDialog() {
  if (aboutOpen) return;
  aboutOpen = true;

  const info = {
    version: "",
    platform: "",
    arch: "",
    packaged: false,
    dataDir: "",
    backupsDir: "",
    logsDir: "",
    releasesUrl: RELEASES_URL,
  };
  let latestStatus = { state: "disabled" };
  let unsubscribe = null;

  const versionText = el("div", { class: "about-version" }, "Loading version…");
  const statusTitle = el("div", { class: "about-status-title" }, "Loading update status…");
  const statusDetail = el("div", { class: "about-status-detail" });
  const checkedLabel = el("div", { class: "about-checked" });
  const progressBar = el("div", { class: "update-progress-bar" });
  const progressTrack = el("div", { class: "update-progress" }, progressBar);
  const progressLabel = el("div", { class: "about-status-detail" });
  const notes = el("pre", { class: "about-release-notes" });
  const backupCheck = el("input", { type: "checkbox" });
  const backupRow = el("label", { class: "about-check" }, [
    backupCheck,
    " Back up my library before restarting",
  ]);
  const checkBtn = el("button", { class: "icon-btn", type: "button" }, "Check for updates");
  const installBtn = el("button", { class: "icon-btn primary", type: "button" }, "Restart & update");
  const releasesBtn = el("button", { class: "icon-btn", type: "button" }, "Download latest installer");
  const diagnosticsBtn = el("button", { class: "icon-btn", type: "button" }, "Copy diagnostics");
  const closeBtn = el("button", { class: "icon-btn", type: "button" }, "Close");

  progressTrack.hidden = true;
  progressLabel.hidden = true;
  notes.hidden = true;
  backupRow.hidden = true;
  installBtn.hidden = true;
  backupCheck.checked = true;

  const folders = el("div", { class: "about-folders" });
  const aboutNote = el("p", { class: "about-note" });

  const content = [
    el("h3", {}, "About Iwakura Memoria"),
    versionText,
    el("div", { class: "about-update" }, [
      statusTitle,
      statusDetail,
      checkedLabel,
      progressTrack,
      progressLabel,
      notes,
      backupRow,
      el("div", { class: "about-actions" }, [checkBtn, installBtn, releasesBtn]),
    ]),
    folders,
    aboutNote,
    el("div", { class: "about-actions" }, [diagnosticsBtn]),
    el("div", { class: "modal-actions" }, [closeBtn]),
  ];

  const { modal, close } = showModal(content, {
    onDismiss: () => {
      aboutOpen = false;
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
  });
  modal.classList.add("about-modal");

  function closeDialog() {
    aboutOpen = false;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    close();
  }

  function setFolders() {
    const hasDesktop = Boolean(desktopBridge());
    folders.replaceChildren();
    aboutNote.hidden = hasDesktop;
    aboutNote.textContent = hasDesktop
      ? ""
      : "Folder and automatic-update controls are available in the installed desktop app.";
    if (!hasDesktop) return;
    folders.append(
      folderRow("Your work", info.dataDir || "—", () => openFolder("data")),
      folderRow("Backups", info.backupsDir || "—", () => openFolder("backups")),
      folderRow("Logs", info.logsDir || "—", () => openFolder("logs"))
    );
  }

  function renderStatus(status) {
    latestStatus = status || { state: "disabled" };
    const summary = statusSummary(latestStatus);
    statusTitle.textContent = summary.title;
    statusDetail.textContent = summary.detail;
    checkedLabel.textContent = latestStatus.checkedAt
      ? `Last checked ${formatWhen(latestStatus.checkedAt)}`
      : "";

    const downloading = latestStatus.state === "downloading";
    progressTrack.hidden = !downloading;
    progressLabel.hidden = !downloading;
    if (downloading) {
      const percent = clampPercent(latestStatus.progress && latestStatus.progress.percent);
      progressBar.style.width = `${percent}%`;
      progressLabel.textContent = progressText(latestStatus);
    }

    const downloaded = latestStatus.state === "downloaded";
    const installing = latestStatus.state === "installing";
    backupRow.hidden = !downloaded;
    installBtn.hidden = !downloaded;
    installBtn.disabled = installing;
    installBtn.textContent = installing ? "Restarting…" : "Restart & update";

    const busy = ["checking", "downloading", "installing"].includes(latestStatus.state);
    checkBtn.hidden = latestStatus.state === "disabled";
    checkBtn.disabled = busy;
    checkBtn.textContent =
      latestStatus.state === "checking"
        ? "Checking…"
        : latestStatus.state === "downloading"
          ? "Downloading…"
          : latestStatus.state === "installing"
            ? "Restarting…"
            : "Check for updates";

    const releaseNotes = (latestStatus.update && latestStatus.update.releaseNotes) || "";
    notes.hidden = !downloaded || !releaseNotes;
    notes.textContent = releaseNotes;
  }

  async function openFolder(kind) {
    const bridge = desktopBridge();
    const fn = bridge && { data: bridge.openDataFolder, backups: bridge.openBackupsFolder, logs: bridge.openLogsFolder }[kind];
    if (!fn) {
      toast("Folder access is only available in the desktop app.", "error");
      return;
    }
    try {
      const res = await fn();
      if (!res || !res.ok) throw new Error((res && res.error) || "Couldn't open the folder.");
    } catch (err) {
      toast(err.message || "Couldn't open the folder.", "error");
    }
  }

  async function doCheck() {
    const updates = updateBridge();
    if (!updates) return;
    checkBtn.disabled = true;
    checkBtn.textContent = "Checking…";
    try {
      renderStatus(await updates.check());
    } catch (err) {
      renderStatus({ state: "error", error: err.message || String(err) });
    }
  }

  async function doInstall() {
    const updates = updateBridge();
    if (!updates) return;
    installBtn.disabled = true;
    installBtn.textContent = "Saving your work…";
    try {
      await flushAllSaves();
      if (backupCheck.checked) {
        installBtn.textContent = "Backing up…";
        try {
          await api.backups.create();
        } catch (err) {
          installBtn.textContent = "Restart & update";
          installBtn.disabled = false;
          const proceed = await confirmDialog({
            title: "Backup failed",
            message: `Couldn't create a backup: ${err.message}. Restart and install without one?`,
            confirmText: "Restart without backup",
          });
          if (!proceed) return;
          installBtn.disabled = true;
        }
      }
      installBtn.textContent = "Restarting…";
      const res = await updates.install();
      if (!res || !res.ok) throw new Error((res && res.error) || "The update could not start.");
    } catch (err) {
      toast(err.message || "Couldn't start the update.", "error");
      installBtn.disabled = false;
      installBtn.textContent = "Restart & update";
    }
  }

  async function openReleases() {
    const bridge = desktopBridge();
    try {
      if (bridge && bridge.openReleases) {
        const res = await bridge.openReleases();
        if (!res || !res.ok) throw new Error((res && res.error) || "Couldn't open the releases page.");
      } else {
        window.open(info.releasesUrl || RELEASES_URL, "_blank", "noopener");
      }
    } catch (err) {
      toast(err.message || "Couldn't open the releases page.", "error");
    }
  }

  async function copyDiagnostics() {
    const text = diagnosticsText({ info, status: latestStatus });
    try {
      await navigator.clipboard.writeText(text);
      toast("Diagnostics copied to the clipboard.");
    } catch {
      // Clipboard access can be denied (or absent in an embedded view); fall
      // back to the old selection trick rather than failing silently.
      const area = el("textarea", { style: { position: "fixed", left: "-9999px" } });
      area.value = text;
      document.body.append(area);
      area.select();
      try {
        document.execCommand("copy");
        toast("Diagnostics copied to the clipboard.");
      } catch {
        toast("Couldn't copy diagnostics.", "error");
      } finally {
        area.remove();
      }
    }
  }

  checkBtn.addEventListener("click", doCheck);
  installBtn.addEventListener("click", doInstall);
  releasesBtn.addEventListener("click", openReleases);
  diagnosticsBtn.addEventListener("click", copyDiagnostics);
  closeBtn.addEventListener("click", closeDialog);

  if (updateBridge()) {
    unsubscribe = updateBridge().onStatus(renderStatus);
  }

  (async () => {
    if (!desktopBridge()) {
      versionText.textContent = "Browser preview";
      setFolders();
      renderStatus({
        state: "disabled",
        message: "Automatic updates are available in the installed desktop app.",
      });
      return;
    }
    try {
      const loaded = await desktopBridge().getInfo();
      Object.assign(info, loaded);
      const details = platformLabel(info);
      versionText.textContent = info.version
        ? `Version ${info.version}${details ? ` · ${details}` : ""}`
        : "Version unavailable";
      setFolders();
      const updates = updateBridge();
      if (updates) renderStatus(await updates.getStatus());
    } catch (err) {
      versionText.textContent = "Version unavailable";
      statusTitle.textContent = "Couldn't read app information";
      statusDetail.textContent = err.message || String(err);
      setFolders();
    }
  })();
}
