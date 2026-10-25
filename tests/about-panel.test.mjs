// jsdom test for the About & updates panel: the browser fallback, the desktop
// version/folder view, the status rendering and the explicit restart action.
//
// Run: node tests/about-panel.test.mjs  (or `npm run test:about`)
import assert from "node:assert/strict";

import { JSDOM } from "jsdom";

function defineGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    globalThis[name] = value;
  }
}

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/" });
const w = dom.window;
for (const [name, value] of Object.entries({
  window: w,
  document: w.document,
  location: w.location,
  HTMLElement: w.HTMLElement,
  Element: w.Element,
  Node: w.Node,
  Event: w.Event,
  MouseEvent: w.MouseEvent,
  KeyboardEvent: w.KeyboardEvent,
  CustomEvent: w.CustomEvent,
})) {
  defineGlobal(name, value);
}

const { openAboutDialog } = await import("../static/js/about.js");

const doc = w.document;
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const click = (node) => node.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const button = (label) =>
  [...doc.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const closeAbout = () => {
  const close = button("Close");
  if (close) click(close);
};

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

console.log("about-panel:");

await check("browser/preview mode explains that updates need the desktop app", async () => {
  delete w.desktop;
  openAboutDialog();
  await tick(5);
  assert.ok(doc.querySelector(".about-modal"), "the modal opens");
  assert.match(doc.querySelector(".about-version").textContent, /Browser preview/);
  assert.match(doc.querySelector(".about-status-title").textContent, /Updates are handled/);
  assert.equal(doc.querySelector(".about-folder"), null, "no folder buttons without the bridge");
  closeAbout();
  assert.equal(doc.querySelector(".about-modal"), null, "Close removes the modal");
});

await check("desktop mode shows version, folders, release notes and restart", async () => {
  const bridge = {
    getInfo: async () => ({
      version: "0.2.0",
      electron: "44.0.0",
      chrome: "140.0.0",
      platform: "win32",
      arch: "x64",
      packaged: true,
      dataDir: "C:\\Users\\Lain\\AppData\\Local\\IwakuraMemoria\\data",
      backupsDir: "C:\\Users\\Lain\\AppData\\Local\\IwakuraMemoria\\backups",
      logsDir: "C:\\Users\\Lain\\AppData\\Roaming\\Iwakura Memoria\\logs",
      releasesUrl: "https://example.test/releases",
    }),
    openDataFolder: async () => ({ ok: true }),
    openBackupsFolder: async () => ({ ok: true }),
    openLogsFolder: async () => ({ ok: true }),
    openReleases: async () => ({ ok: true }),
    updates: {
      getStatus: async () => ({
        state: "downloaded",
        currentVersion: "0.2.0",
        update: { version: "0.3.0", releaseNotes: "Fixed a save bug." },
        progress: { percent: 100 },
        checkedAt: Date.now(),
      }),
      check: async () => ({
        state: "current",
        currentVersion: "0.2.0",
        checkedAt: Date.now(),
      }),
      install: async () => ({ ok: true }),
      onStatus: () => () => {},
    },
  };
  w.desktop = bridge;
  openAboutDialog();
  await tick(5);

  assert.match(doc.querySelector(".about-version").textContent, /Version 0\.2\.0/);
  assert.match(doc.querySelector(".about-version").textContent, /Windows/);
  assert.match(doc.querySelector(".about-status-title").textContent, /Version 0\.3\.0 is ready/);
  assert.match(doc.querySelector(".about-release-notes").textContent, /Fixed a save bug/);
  assert.equal(doc.querySelectorAll(".about-folder").length, 3);
  assert.match(doc.querySelector(".about-path").textContent, /IwakuraMemoria/);

  const restart = button("Restart & update");
  assert.ok(restart && !restart.hidden, "the restart button is available");
  const backup = doc.querySelector(".about-check input");
  assert.equal(backup.checked, true, "backing up is on by default");
  backup.checked = false;
  click(restart);
  await tick(5);
  assert.match(restart.textContent, /Restarting/);
  closeAbout();
});

await check("the check button updates the visible status", async () => {
  let checked = 0;
  w.desktop = {
    getInfo: async () => ({
      version: "0.2.0",
      platform: "win32",
      arch: "x64",
      packaged: true,
      dataDir: "C:\\data",
      backupsDir: "C:\\backups",
      logsDir: "C:\\logs",
      releasesUrl: "https://example.test/releases",
    }),
    openDataFolder: async () => ({ ok: true }),
    openBackupsFolder: async () => ({ ok: true }),
    openLogsFolder: async () => ({ ok: true }),
    openReleases: async () => ({ ok: true }),
    updates: {
      getStatus: async () => ({ state: "idle", currentVersion: "0.2.0" }),
      check: async () => {
        checked += 1;
        return { state: "current", currentVersion: "0.2.0", checkedAt: Date.now() };
      },
      install: async () => ({ ok: true }),
      onStatus: () => () => {},
    },
  };
  openAboutDialog();
  await tick(5);
  click(button("Check for updates"));
  await tick(5);
  assert.equal(checked, 1);
  assert.match(doc.querySelector(".about-status-title").textContent, /up to date/);
  closeAbout();
});

if (failures) {
  console.log(`about-panel: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("about-panel: all checks passed");
