"use strict";

// Auto-update controller for the packaged Electron shell.
//
// The renderer never talks to electron-updater directly: this module owns the
// check/download lifecycle, keeps a small serialisable status object, and the
// main process forwards status changes over IPC. Installing is deliberately
// explicit (the About panel's Restart button) rather than auto-install-on-quit,
// so an update can never replace the app while a document is still unsaved.

const { EventEmitter } = require("events");

const {
  cleanReleaseNotes,
  clampPercent,
  formatBytes,
  isUpdateDisabled,
  resolveFeedUrl,
} = require("./update-utils");

const AUTO_CHECK_DELAY_MS = 10 * 1000;
const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const PROGRESS_EMIT_MS = 500;

function summariseUpdate(info) {
  if (!info) return null;
  return {
    version: String(info.version || ""),
    releaseName: String(info.releaseName || ""),
    releaseDate: String(info.releaseDate || ""),
    releaseNotes: cleanReleaseNotes(info.releaseNotes),
  };
}

function createUpdater({
  app,
  log = console,
  isPackaged = app.isPackaged,
  env = process.env,
  autoUpdater = require("electron-updater").autoUpdater,
}) {
  const events = new EventEmitter();
  const currentVersion = app.getVersion();
  const disabled = isUpdateDisabled(env, isPackaged);
  const feedUrl = resolveFeedUrl(env);

  let status = {
    state: disabled ? "disabled" : "idle",
    currentVersion,
    message: disabled
      ? isPackaged
        ? "Updates are disabled for this build."
        : "Updates are only available in an installed build."
      : "Updates are checked automatically.",
    update: null,
    progress: null,
    error: "",
    checkedAt: null,
    updatedAt: Date.now(),
  };

  let initialized = false;
  let lastProgressEmit = 0;
  let autoTimer = null;
  let intervalTimer = null;
  let installTimer = null;
  let handlers = null;

  function getStatus() {
    return {
      ...status,
      update: status.update ? { ...status.update } : null,
      progress: status.progress ? { ...status.progress } : null,
    };
  }

  function setStatus(patch, { emit = true } = {}) {
    status = { ...status, ...patch, updatedAt: Date.now() };
    if (emit) events.emit("status", getStatus());
  }

  function describeError(err) {
    return String((err && err.message) || err || "Unknown update error").replace(/\s+/g, " ").trim();
  }

  function fail(err) {
    const message = describeError(err);
    const hadUpdate = Boolean(status.update);
    log.warn(`[updater] ${message}`);
    setStatus({
      state: "error",
      error: message,
      message: hadUpdate
        ? "Couldn't download the update. Try again or download the installer."
        : "Couldn't check for updates. You can still use the app.",
      checkedAt: Date.now(),
    });
  }

  function onChecking() {
    if (status.state !== "checking") {
      setStatus({ state: "checking", message: "Checking for updates…" });
    }
  }

  function onAvailable(info) {
    const update = summariseUpdate(info);
    log.info(`[updater] update available: ${update && update.version}`);
    setStatus({
      state: "downloading",
      update,
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      message: update && update.version ? `Downloading version ${update.version}…` : "Downloading update…",
      error: "",
      checkedAt: Date.now(),
    });
  }

  function onNotAvailable() {
    log.info(`[updater] already current at ${currentVersion}`);
    setStatus({
      state: "current",
      update: null,
      progress: null,
      error: "",
      message: "You're up to date.",
      checkedAt: Date.now(),
    });
  }

  function onProgress(progress) {
    const percent = clampPercent(progress && progress.percent);
    const transferred = Number(progress && progress.transferred) || 0;
    const total = Number(progress && progress.total) || 0;
    const bytesPerSecond = Number(progress && progress.bytesPerSecond) || 0;
    const nextProgress = { percent, transferred, total, bytesPerSecond };
    const message =
      total > 0
        ? `Downloading update — ${formatBytes(transferred)} of ${formatBytes(total)}`
        : "Downloading update…";
    setStatus({ state: "downloading", progress: nextProgress, message }, { emit: false });

    const now = Date.now();
    if (now - lastProgressEmit >= PROGRESS_EMIT_MS || percent >= 100) {
      lastProgressEmit = now;
      events.emit("status", getStatus());
    }
  }

  function onDownloaded(info) {
    const update = summariseUpdate(info);
    const progress = status.progress || {};
    const transferred = Number(progress.transferred) || 0;
    const total = Number(progress.total) || 0;
    const sizeNote =
      total > 0 ? ` (${formatBytes(transferred)} of ${formatBytes(total)})` : "";
    log.info(`[updater] update downloaded: ${update && update.version}${sizeNote}`);
    setStatus({
      state: "downloaded",
      update,
      progress: { percent: 100, transferred, total, bytesPerSecond: 0 },
      error: "",
      message: update && update.version ? `Version ${update.version} is ready to install.` : "Update ready to install.",
      checkedAt: Date.now(),
    });
  }

  function onError(err) {
    const message = describeError(err);
    const hadUpdate = Boolean(status.update);
    log.warn(`[updater] ${message}`);
    setStatus({
      state: "error",
      error: message,
      message: hadUpdate
        ? "Couldn't download the update. Try again or download the installer."
        : "Couldn't check for updates. You can still use the app.",
      checkedAt: Date.now(),
    });
  }

  function wireEvents() {
    handlers = { onChecking, onAvailable, onNotAvailable, onProgress, onDownloaded, onError };
    autoUpdater.on("checking-for-update", handlers.onChecking);
    autoUpdater.on("update-available", handlers.onAvailable);
    autoUpdater.on("update-not-available", handlers.onNotAvailable);
    autoUpdater.on("download-progress", handlers.onProgress);
    autoUpdater.on("update-downloaded", handlers.onDownloaded);
    autoUpdater.on("error", handlers.onError);
  }

  function unwireEvents() {
    if (!handlers) return;
    autoUpdater.removeListener("checking-for-update", handlers.onChecking);
    autoUpdater.removeListener("update-available", handlers.onAvailable);
    autoUpdater.removeListener("update-not-available", handlers.onNotAvailable);
    autoUpdater.removeListener("download-progress", handlers.onProgress);
    autoUpdater.removeListener("update-downloaded", handlers.onDownloaded);
    autoUpdater.removeListener("error", handlers.onError);
    handlers = null;
  }

  function init() {
    if (initialized) return !disabled;
    initialized = true;
    if (disabled) {
      setStatus({
        state: "disabled",
        message: isPackaged
          ? "Updates are disabled for this build."
          : "Updates are only available in an installed build.",
      });
      return false;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = log;

    // A generic feed override is useful for testing a local latest.yml. Normal
    // packaged builds read the feed from resources/app-update.yml, generated by
    // electron-builder from build.publish in electron/package.json.
    if (env.IWAKURA_UPDATE_FEED && /^https?:\/\//i.test(env.IWAKURA_UPDATE_FEED)) {
      autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
      log.info(`[updater] feed override: ${feedUrl}`);
    }

    wireEvents();
    log.info(`[updater] ready: version ${currentVersion}, feed ${feedUrl}`);
    setStatus({ state: "idle", message: "Updates are checked automatically." });

    autoTimer = setTimeout(() => {
      check({ manual: false }).catch((err) => log.warn(`[updater] auto check failed: ${describeError(err)}`));
    }, AUTO_CHECK_DELAY_MS);
    if (typeof autoTimer.unref === "function") autoTimer.unref();

    intervalTimer = setInterval(() => {
      check({ manual: false }).catch((err) => log.warn(`[updater] periodic check failed: ${describeError(err)}`));
    }, AUTO_CHECK_INTERVAL_MS);
    if (typeof intervalTimer.unref === "function") intervalTimer.unref();

    return true;
  }

  async function check({ manual = false } = {}) {
    if (disabled) {
      setStatus({
        state: "disabled",
        message: isPackaged
          ? "Updates are disabled for this build."
          : "Updates are only available in an installed build.",
      });
      return getStatus();
    }
    if (["checking", "downloading", "downloaded", "installing"].includes(status.state)) {
      return getStatus();
    }

    setStatus({
      state: "checking",
      message: manual ? "Checking for updates…" : "Checking for updates in the background…",
      error: "",
    });
    try {
      const result = await autoUpdater.checkForUpdates();
      // A null result means no feed is configured (for example a dev checkout
      // that somehow reached this point). The event handlers own the rest.
      if (!result && status.state === "checking") {
        setStatus({
          state: "idle",
          message: "Update checks are not configured for this build.",
          checkedAt: Date.now(),
        });
      }
    } catch (err) {
      fail(err);
    }
    return getStatus();
  }

  function install() {
    if (disabled) {
      return { ok: false, error: "Updates are not available in this build." };
    }
    if (status.state !== "downloaded") {
      return { ok: false, error: "No update is ready to install yet." };
    }
    log.info(`[updater] installing ${status.update && status.update.version}`);
    setStatus({ state: "installing", message: "Restarting to install the update…" });
    // Let the IPC reply and the status event reach the renderer before the
    // process starts shutting down. The renderer flushes saves before calling
    // this, so quitting here is safe.
    installTimer = setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(true, true);
      } catch (err) {
        installTimer = null;
        fail(err);
        setStatus({ state: "downloaded", message: "Couldn't start the update. Try again or download the installer." });
      }
    }, 150);
    return { ok: true };
  }

  function destroy() {
    if (autoTimer) clearTimeout(autoTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    if (installTimer) clearTimeout(installTimer);
    autoTimer = null;
    intervalTimer = null;
    installTimer = null;
    unwireEvents();
  }

  return {
    events,
    init,
    check,
    install,
    getStatus,
    destroy,
    get currentVersion() {
      return currentVersion;
    },
  };
}

module.exports = {
  createUpdater,
  summariseUpdate,
  AUTO_CHECK_DELAY_MS,
  AUTO_CHECK_INTERVAL_MS,
  PROGRESS_EMIT_MS,
};
