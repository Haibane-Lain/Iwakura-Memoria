// Unit tests for the Electron updater's pure helpers and its state machine.
// The updater is driven with a fake autoUpdater so no Electron app is needed.
//
// Run: node tests/update-utils.test.mjs  (or `npm run test:updater`)
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import updateUtils from "../electron/update-utils.js";
import { createUpdater } from "../electron/updater.js";

const {
  resolveDataDir,
  resolveBackupsDir,
  isUpdateDisabled,
  resolveFeedUrl,
  formatBytes,
  clampPercent,
  cleanReleaseNotes,
} = updateUtils;

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.checkForUpdates = async () => ({});
    this.setFeedURL = (cfg) => {
      this.feed = cfg;
    };
    this.quitAndInstall = (silent, relaunch) => {
      this.installed = { silent, relaunch };
    };
  }
}

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}\n      ${err.message}`);
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("update-utils:");

await check("resolves the Windows data folder like app/config.py", () => {
  const dir = resolveDataDir(
    { LOCALAPPDATA: "C:\\Users\\Lain\\AppData\\Local" },
    "win32",
    "C:\\Users\\Lain"
  );
  assert.equal(dir, "C:\\Users\\Lain\\AppData\\Local\\IwakuraMemoria\\data");
});

await check("honours IWAKURA_DATA_DIR and expands a leading ~", () => {
  assert.equal(
    resolveDataDir({ IWAKURA_DATA_DIR: "D:\\Writing\\Iw" }, "win32", "C:\\Users\\Lain"),
    "D:\\Writing\\Iw"
  );
  assert.equal(
    resolveDataDir({ IWAKURA_DATA_DIR: "~/writing" }, "linux", "/home/lain"),
    "/home/lain/writing"
  );
});

await check("falls back to ~/.iwakura/data off Windows", () => {
  assert.equal(resolveDataDir({}, "linux", "/home/lain"), "/home/lain/.iwakura/data");
});

await check("puts backups beside the data folder", () => {
  assert.equal(
    resolveBackupsDir("C:\\Users\\Lain\\AppData\\Local\\IwakuraMemoria\\data", "win32"),
    "C:\\Users\\Lain\\AppData\\Local\\IwakuraMemoria\\backups"
  );
  assert.equal(
    resolveBackupsDir("/home/lain/.iwakura/data", "linux"),
    "/home/lain/.iwakura/backups"
  );
});

await check("disables updates in dev and via IWAKURA_DISABLE_UPDATES", () => {
  assert.equal(isUpdateDisabled({}, false), true);
  assert.equal(isUpdateDisabled({ IWAKURA_DISABLE_UPDATES: "1" }, true), true);
  assert.equal(isUpdateDisabled({ IWAKURA_DISABLE_UPDATES: "no" }, true), false);
  assert.equal(isUpdateDisabled({}, true), false);
});

await check("honours a valid feed override, ignores an invalid one", () => {
  assert.equal(
    resolveFeedUrl({ IWAKURA_UPDATE_FEED: "http://127.0.0.1:9000/feed/" }),
    "http://127.0.0.1:9000/feed"
  );
  assert.match(resolveFeedUrl({ IWAKURA_UPDATE_FEED: "file:///nope" }), /github\.com/);
  assert.match(resolveFeedUrl({}), /Iwakura-Memoria\/releases\/latest\/download/);
});

await check("formats download sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.00 KB");
  assert.equal(formatBytes(10 * 1024 * 1024), "10.0 MB");
  assert.equal(formatBytes(500 * 1024 * 1024), "500 MB");
});

await check("clamps percentages", () => {
  assert.equal(clampPercent(-5), 0);
  assert.equal(clampPercent(42.6), 42.6);
  assert.equal(clampPercent(200), 100);
  assert.equal(clampPercent("nope"), 0);
});

await check("cleans release notes into plain text", () => {
  assert.equal(cleanReleaseNotes("<p>Fixed <b>things</b></p>"), "Fixed things");
  assert.equal(
    cleanReleaseNotes([{ version: "0.3.0", note: "One" }, { version: "0.2.0", note: "Two" }]),
    "v0.3.0\nOne\n\nv0.2.0\nTwo"
  );
  assert.equal(cleanReleaseNotes(null), "");
});

console.log("updater:");

await check("stays disabled in a dev build", () => {
  const updater = createUpdater({
    app: { getVersion: () => "0.2.0" },
    log: silentLog,
    isPackaged: false,
    env: {},
    autoUpdater: new FakeUpdater(),
  });
  assert.equal(updater.init(), false);
  assert.equal(updater.getStatus().state, "disabled");
  updater.destroy();
});

await check("checks, downloads and exposes a ready update", async () => {
  const fake = new FakeUpdater();
  fake.checkForUpdates = async () => {
    fake.emit("checking-for-update");
    fake.emit("update-available", { version: "0.3.0" });
    fake.emit("download-progress", {
      percent: 42,
      transferred: 420,
      total: 1000,
      bytesPerSecond: 100,
    });
    fake.emit("update-downloaded", { version: "0.3.0", releaseNotes: "<p>Fixed things</p>" });
    return { updateInfo: { version: "0.3.0" } };
  };

  const updater = createUpdater({
    app: { getVersion: () => "0.2.0" },
    log: silentLog,
    isPackaged: true,
    env: {},
    autoUpdater: fake,
  });
  assert.equal(updater.init(), true);
  assert.equal(fake.autoDownload, true);
  assert.equal(fake.autoInstallOnAppQuit, false);

  const status = await updater.check({ manual: true });
  assert.equal(status.state, "downloaded");
  assert.equal(status.update.version, "0.3.0");
  assert.equal(status.update.releaseNotes, "Fixed things");
  assert.equal(status.progress.percent, 100);
  updater.destroy();
});

await check("reports an offline check as an error without throwing", async () => {
  const fake = new FakeUpdater();
  fake.checkForUpdates = async () => {
    throw new Error("getaddrinfo ENOTFOUND github.com");
  };
  const updater = createUpdater({
    app: { getVersion: () => "0.2.0" },
    log: silentLog,
    isPackaged: true,
    env: {},
    autoUpdater: fake,
  });
  updater.init();
  const status = await updater.check();
  assert.equal(status.state, "error");
  assert.match(status.error, /ENOTFOUND/);
  updater.destroy();
});

await check("install is only allowed after a download, then quits and relaunches", async () => {
  const fake = new FakeUpdater();
  fake.checkForUpdates = async () => {
    fake.emit("update-available", { version: "0.3.0" });
    fake.emit("update-downloaded", { version: "0.3.0" });
    return {};
  };
  const updater = createUpdater({
    app: { getVersion: () => "0.2.0" },
    log: silentLog,
    isPackaged: true,
    env: {},
    autoUpdater: fake,
  });
  updater.init();
  assert.deepEqual(updater.install(), {
    ok: false,
    error: "No update is ready to install yet.",
  });
  await updater.check();
  assert.deepEqual(updater.install(), { ok: true });
  await tick(220);
  assert.deepEqual(fake.installed, { silent: true, relaunch: true });
  updater.destroy();
});

await check("uses the local feed override for testing", () => {
  const fake = new FakeUpdater();
  const updater = createUpdater({
    app: { getVersion: () => "0.2.0" },
    log: silentLog,
    isPackaged: true,
    env: { IWAKURA_UPDATE_FEED: "http://127.0.0.1:9000/feed/" },
    autoUpdater: fake,
  });
  updater.init();
  assert.deepEqual(fake.feed, { provider: "generic", url: "http://127.0.0.1:9000/feed" });
  updater.destroy();
});

if (failures) {
  console.log(`update-utils: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("update-utils: all checks passed");
