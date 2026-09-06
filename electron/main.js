// Electron shell spike for Iwakura Memoria.
//
// Spawns the existing FastAPI server (`python main.py --server-only`) as a
// child process and renders the existing static frontend unmodified. A preload
// shim exposes the same `window.pywebview.api` contract the frontend already
// feature-detects, so the frontend needed no changes.
//
// This is a proof-of-concept for the sidecar seam, not the final product:
// it runs the venv Python from the workspace in dev mode. Embedded Python,
// auto-update, code signing and an installer are deliberately out of scope.

"use strict";

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PYTHON =
  process.env.IWAKURA_PYTHON || path.join(ROOT, ".venv", "Scripts", "python.exe");
const BASE_PORT = 8000;
const PORT_TRIES = 10;

let serverProc = null;
let serverPort = BASE_PORT;
let win = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isUp(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: 1500 },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function startServer() {
  let port = BASE_PORT;
  for (let i = 0; i < PORT_TRIES; i++) {
    if (!(await isUp(port))) break;
    port += 1;
    if (i === PORT_TRIES - 1) throw new Error(`no free port in 8000-${BASE_PORT + PORT_TRIES - 1}`);
  }

  serverProc = spawn(PYTHON, ["main.py", "--server-only", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  serverProc.stdout.on("data", (d) => process.stdout.write("[server] " + d));
  serverProc.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  serverProc.on("error", (err) => {
    console.error("[server] failed to spawn:", err.message);
    serverProc = null;
  });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (serverProc === null || serverProc.exitCode !== null) {
      throw new Error("server exited before becoming ready");
    }
    if (await isUp(port)) return port;
    await sleep(250);
  }
  throw new Error("server did not become ready in time");
}

function killServer() {
  if (!serverProc) return;
  // Tree-kill: terminates the python process AND its java (LanguageTool) child,
  // which a plain terminate would orphan (Windows has no process groups here).
  try {
    execSync(`taskkill /PID ${serverProc.pid} /T /F`, { stdio: "ignore" });
  } catch (e) {
    /* already gone */
  }
  serverProc = null;
}

async function createWindow(port) {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false, // frameless — native windows + existing title-bar CSS handle it
    title: "Iwakura Memoria",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(`http://127.0.0.1:${port}`);
  win.on("closed", () => {
    win = null;
  });
}

// --- window controls (same contract as main.py:_WindowApi) -----------------

ipcMain.handle("win:minimize", () => win && win.minimize());
ipcMain.handle("win:toggle-maximize", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle("win:toggle-fullscreen", () => {
  if (!win) return;
  win.setFullScreen(!win.isFullScreen());
});
ipcMain.handle("win:close", () => win && win.close());

// --- native save dialog for exports ----------------------------------------

ipcMain.handle("export:with-dialog", async (_evt, { projectId, fmt, folders }) => {
  const ext = { zip: ".zip", docx: ".docx", pdf: ".pdf", epub: ".epub" }[fmt] || ".zip";
  const result = await dialog.showSaveDialog(win, {
    title: "Export",
    defaultPath: path.join(app.getPath("documents"), `${projectId}-writing${ext}`),
    filters: [{ name: "Export", extensions: [fmt] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };

  try {
    const res = await fetch(
      `http://127.0.0.1:${serverPort}/api/projects/${encodeURIComponent(projectId)}/export`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: fmt, folders: folders || null }),
      }
    );
    if (!res.ok) throw new Error(`export failed (${res.status})`);
    fs.writeFileSync(result.filePath, Buffer.from(await res.arrayBuffer()));
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// --- lifecycle -------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on("before-quit", killServer);
  app.on("window-all-closed", () => app.quit());

  app.whenReady().then(async () => {
    try {
      serverPort = await startServer();
      await createWindow(serverPort);
    } catch (err) {
      killServer();
      dialog.showErrorBox("Iwakura Memoria", `Failed to start: ${err.message}`);
      app.quit();
    }
  });
}