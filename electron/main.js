// Electron shell for Iwakura Memoria.
//
// Spawns the existing FastAPI server as a child process and renders the
// existing static frontend unmodified. A preload shim exposes the same
// `window.pywebview.api` contract the frontend already feature-detects, so the
// frontend needed no changes.
//
// Two modes:
//   - Dev:  `run.bat` -> runs the venv Python from the workspace (main.py)
//            with `IWAKURA_PYTHON`/`IWAKURA_RESOURCES_DIR` unset.
//   - Packaged: `scripts\build\build.bat` freezes the server with PyInstaller
//            and electron-builder ships it (plus LanguageTool + JRE) as
//            extraResources; the server exe is located under
//            resources/server/ and LanguageTool/JRE via the env the child is
//            given here. Packaged builds auto-update from GitHub Releases via
//            electron-updater (see updater.js); code signing is still out of
//            scope, so the first manual download is unsigned.

"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// The packaged executable is "Iwakura Memoria", but Electron's default app name
// comes from package.json. Don't rely on that for anything the user sees: logs
// live beside the writing data, and the About panel reads that same path.
const { RELEASES_URL, resolveBackupsDir, resolveDataDir } = require("./update-utils");
const APP_DATA_ROOT = path.dirname(resolveDataDir(process.env, process.platform, os.homedir()));
let LOG_DIR = path.join(APP_DATA_ROOT, "logs");
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // A read-only data location must not stop the app from opening. Fall back to
  // the temp folder; if that also fails electron-log will complain on the
  // console and the rest of the app keeps running.
  LOG_DIR = path.join(os.tmpdir(), "IwakuraMemoria-logs");
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* file logging will be unavailable */
  }
}

const log = require("electron-log/main");
const { BASE_PORT, pickFreePort, killTree } = require("./lifecycle");
const { createUpdater } = require("./updater");

// One log file for both the shell and the updater; support can ask a tester for
// it without needing a dev console. 5 MB is plenty for a session and keeps the
// folder small. electron-log rotates the previous file automatically.
log.transports.file.level = "info";
log.transports.console.level = "info";
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.file.resolvePathFn = () => path.join(LOG_DIR, "main.log");
// The renderer has its own console and does not need electron-log's injected
// preload; keep the bridge surface to our own preload.js.
log.initialize({ preload: false });


// Repo root in dev; under a packaged build the server exe + LanguageTool/JRE
// are shipped as extraResources into process.resourcesPath (see package.json).
const ROOT = path.resolve(__dirname, "..");
const RES = app.isPackaged ? process.resourcesPath : ROOT;

function resolvePythonExe() {
  if (process.env.IWAKURA_PYTHON) return process.env.IWAKURA_PYTHON;
  if (app.isPackaged) {
    // Bundled server exe from PyInstaller, placed under resources/server/.
    const exe = path.join(RES, "server", "Iwakura-Memoria-server.exe");
    if (fs.existsSync(exe)) return exe;
    // Fall back to the dev venv (shouldn't happen in a packaged build).
    return path.join(ROOT, ".venv", "Scripts", "python.exe");
  }
  return path.join(ROOT, ".venv", "Scripts", "python.exe");
}

const PYTHON = resolvePythonExe();
let serverProc = null;
let serverPort = BASE_PORT;
let win = null;
let updater = null;

function appInfo() {
  const dataDir = resolveDataDir(process.env, process.platform, os.homedir());
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    dataDir,
    backupsDir: resolveBackupsDir(dataDir),
    logsDir: LOG_DIR,
    releasesUrl: RELEASES_URL,
  };
}

function startUpdater() {
  try {
    updater = createUpdater({ app, log, isPackaged: app.isPackaged, env: process.env });
    updater.events.on("status", (status) => {
      if (win && !win.isDestroyed()) win.webContents.send("update:status", status);
    });
    updater.init();
  } catch (err) {
    log.warn(`[updater] initialization failed: ${(err && err.message) || err}`);
    if (updater) {
      try {
        updater.destroy();
      } catch {
        /* best effort */
      }
    }
    updater = null;
  }
}

function fallbackUpdateStatus() {
  return {
    state: "disabled",
    currentVersion: app.getVersion(),
    message: "Updates are not available yet.",
    update: null,
    progress: null,
    error: "",
    checkedAt: null,
  };
}


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
  const port = await pickFreePort(isUp);

  // Dev: python main.py --server-only --port N
  // Packaged: server.exe --server-only --port N (the exe is the entry point)
  const args = app.isPackaged
    ? ["--server-only", "--port", String(port)]
    : ["main.py", "--server-only", "--port", String(port)];

  // Tell the server where the bundled LanguageTool + JRE live so grammar works
  // without a system Java. Under dev these env vars are unset and the server
  // falls back to its own `LanguageTool 6.8/` + system `java` (see grammar.py).
  // Same idea for Lookup: a packaged build may ship WordNet as
  // extraResources/wordnet; dev falls back to `WordNet 3.0/` (see lookup.py).
  const env = {
    ...process.env,
    IWAKURA_RESOURCES_DIR: RES,
    IWAKURA_LT_DIR: path.join(RES, "languagetool"),
    IWAKURA_JRE_DIR: path.join(RES, "jre"),
    IWAKURA_DICT_DIR: path.join(RES, "wordnet"),
  };

  // cwd: dev uses the repo root; packaged uses the writable user-data dir
  // (a path inside app.asar is not a real directory and can't be a cwd).
  const baseCwd = app.isPackaged ? app.getPath("userData") : ROOT;

  serverProc = spawn(PYTHON, args, {
    cwd: baseCwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  serverProc.stdout.on("data", (d) => process.stdout.write("[server] " + d));
  serverProc.stderr.on("data", (d) => {
    process.stderr.write("[server] " + d);
    log.warn("[server] " + String(d).trim());
  });
  serverProc.on("error", (err) => {
    log.error(`[server] failed to spawn: ${err.message}`);
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
  killTree(execSync, serverProc.pid);
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
  win.webContents.on("did-finish-load", () => {
    // A reload loses the renderer's last status; give it the current one.
    if (updater && win && !win.isDestroyed()) {
      win.webContents.send("update:status", updater.getStatus());
    }
  });
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

// --- app info / About -------------------------------------------------------

ipcMain.handle("app:info", () => appInfo());

ipcMain.handle("app:open-path", async (_evt, which) => {
  const info = appInfo();
  const target = { data: info.dataDir, backups: info.backupsDir, logs: info.logsDir }[which];
  if (!target) return { ok: false, error: "Unknown folder." };
  try {
    fs.mkdirSync(target, { recursive: true });
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle("app:open-releases", async () => {
  try {
    await shell.openExternal(RELEASES_URL);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// --- updates ----------------------------------------------------------------

ipcMain.handle("update:get-status", () => (updater ? updater.getStatus() : fallbackUpdateStatus()));

ipcMain.handle("update:check", async () => {
  if (!updater) return fallbackUpdateStatus();
  return updater.check({ manual: true });
});

ipcMain.handle("update:install", () => {
  if (!updater) return { ok: false, error: "Updates are not available in this build." };
  return updater.install();
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
  app.on("before-quit", () => {
    try {
      if (updater) updater.destroy();
    } finally {
      killServer();
    }
  });
  app.on("window-all-closed", () => app.quit());

  app.whenReady().then(async () => {
    log.info(`[app] starting Iwakura Memoria ${app.getVersion()} (${app.isPackaged ? "packaged" : "dev"})`);
    try {
      serverPort = await startServer();
      // Create the updater before the window loads so a status event that
      // arrives early is kept and replayed on did-finish-load.
      startUpdater();
      await createWindow(serverPort);
    } catch (err) {
      log.error(`[app] failed to start: ${(err && err.message) || err}`);
      killServer();
      if (updater) updater.destroy();
      dialog.showErrorBox("Iwakura Memoria", `Failed to start: ${err.message}`);
      app.quit();
    }
  });
}