"use strict";

// Pure helpers for the auto-updater and the About panel. Kept out of
// updater.js / main.js so they can be exercised without booting Electron.

const path = require("path");
const os = require("os");

const APP_DIR_NAME = "IwakuraMemoria";
const DATA_DIR_NAME = "data";
const RELEASES_URL = "https://github.com/Haibane-Lain/Iwakura-Memoria/releases/latest";
const FALLBACK_FEED_URL =
  "https://github.com/Haibane-Lain/Iwakura-Memoria/releases/latest/download";

function truthy(value) {
  if (value === undefined || value === null) return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

/** Same resolution order as app/config.py, so About shows the real folder. */
function resolveDataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const override = env.IWAKURA_DATA_DIR;
  if (override) {
    // Python's Path.expanduser() handles a leading ~; Node does not.
    return pathImpl.resolve(override.replace(/^~(?=$|[\\/])/, home));
  }
  if (platform === "win32" && env.LOCALAPPDATA) {
    return pathImpl.join(env.LOCALAPPDATA, APP_DIR_NAME, DATA_DIR_NAME);
  }
  return pathImpl.join(home, ".iwakura", DATA_DIR_NAME);
}

/** Backups live next to the data folder (see README), not inside it. */
function resolveBackupsDir(dataDir, platform = process.platform) {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  return pathImpl.join(pathImpl.dirname(dataDir), "backups");
}

function isUpdateDisabled(env = process.env, isPackaged = true) {
  return !isPackaged || truthy(env.IWAKURA_DISABLE_UPDATES);
}

/**
 * A packaged build reads the feed URL from app-update.yml. The env override is
 * for local end-to-end testing (point it at a folder that serves latest.yml).
 */
function resolveFeedUrl(env = process.env, fallback = FALLBACK_FEED_URL) {
  const override = env.IWAKURA_UPDATE_FEED;
  if (override && /^https?:\/\//i.test(override)) {
    return override.replace(/\/+$/, "");
  }
  return fallback;
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** Release notes can be a string, an array of {version,note}, or absent. */
function cleanReleaseNotes(notes) {
  if (!notes) return "";
  let text = "";
  if (typeof notes === "string") {
    text = notes;
  } else if (Array.isArray(notes)) {
    text = notes
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const version = entry && entry.version ? `v${entry.version}\n` : "";
        return version + (entry && entry.note ? String(entry.note) : "");
      })
      .join("\n\n");
  } else if (typeof notes === "object" && notes.note) {
    text = String(notes.note);
  }
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
}

module.exports = {
  APP_DIR_NAME,
  DATA_DIR_NAME,
  RELEASES_URL,
  FALLBACK_FEED_URL,
  truthy,
  resolveDataDir,
  resolveBackupsDir,
  isUpdateDisabled,
  resolveFeedUrl,
  formatBytes,
  clampPercent,
  cleanReleaseNotes,
};
