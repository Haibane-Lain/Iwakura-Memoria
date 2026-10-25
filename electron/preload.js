// Preload shim: exposes the same `window.pywebview.api` shape the frontend
// already feature-detects (static/js/app.js, static/js/project.js), so the
// frontend needed no functional changes. Window controls become native
// BrowserWindow calls; exports use the native save dialog in the main process.
//
// `window.desktop` is a separate, newer bridge for things that only make sense
// in the packaged Electron shell (version/About data and auto-updates). It is
// intentionally not folded into `pywebview.api`, whose shape is pinned to the
// legacy pywebview shell by tests/test_electron_contract.py.

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pywebview", {
  api: {
    minimize: () => ipcRenderer.invoke("win:minimize"),
    toggle_maximize: () => ipcRenderer.invoke("win:toggle-maximize"),
    toggle_fullscreen: () => ipcRenderer.invoke("win:toggle-fullscreen"),
    // Frameless windows on Windows resize natively at the edges (thickFrame);
    // the renderer's resize-handle divs become inert no-ops.
    start_resize: () => {},
    close: () => ipcRenderer.invoke("win:close"),
    export_with_dialog: (projectId, fmt, folders) =>
      ipcRenderer.invoke("export:with-dialog", {
        projectId,
        fmt,
        folders: folders || null,
      }),
  },
});

contextBridge.exposeInMainWorld("desktop", {
  getInfo: () => ipcRenderer.invoke("app:info"),
  openDataFolder: () => ipcRenderer.invoke("app:open-path", "data"),
  openBackupsFolder: () => ipcRenderer.invoke("app:open-path", "backups"),
  openLogsFolder: () => ipcRenderer.invoke("app:open-path", "logs"),
  openReleases: () => ipcRenderer.invoke("app:open-releases"),
  updates: {
    getStatus: () => ipcRenderer.invoke("update:get-status"),
    check: () => ipcRenderer.invoke("update:check"),
    install: () => ipcRenderer.invoke("update:install"),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on("update:status", listener);
      return () => ipcRenderer.removeListener("update:status", listener);
    },
  },
});
