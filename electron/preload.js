// Preload shim: exposes the same `window.pywebview.api` shape the frontend
// already feature-detects (static/js/app.js, static/js/project.js), so the
// frontend needed no functional changes. Window controls become native
// BrowserWindow calls; exports use the native save dialog in the main process.

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