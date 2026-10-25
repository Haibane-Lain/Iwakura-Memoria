// Pure formatting/status helpers for the About & updates panel. Kept separate
// from the DOM so they can be unit tested under plain node.

export function formatBytes(bytes) {
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

export function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

export function formatWhen(ms) {
  if (!ms) return "";
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 0) return "Just now";
  if (diff < 60 * 1000) return "Just now";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} min ago`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))} h ago`;
  return date.toLocaleString();
}

export function progressText(status) {
  const p = (status && status.progress) || {};
  const percent = clampPercent(p.percent);
  if (p.total > 0) {
    return `${Math.round(percent)}% · ${formatBytes(p.transferred)} of ${formatBytes(p.total)}`;
  }
  if (percent > 0) return `${Math.round(percent)}%`;
  return "Starting download…";
}

export function statusSummary(status) {
  const s = status || {};
  const state = s.state || "disabled";
  const version = (s.update && s.update.version) || "";
  const current = s.currentVersion || "this version";
  switch (state) {
    case "idle":
      return {
        title: "Not checked yet",
        detail: s.message || "Updates are checked automatically in the background.",
        tone: "muted",
      };
    case "checking":
      return { title: "Checking for updates…", detail: "This only takes a moment.", tone: "busy" };
    case "current":
      return {
        title: "You're up to date",
        detail: `Iwakura Memoria ${current} is the latest version.`,
        tone: "ok",
      };
    case "downloading":
      return {
        title: version ? `Downloading version ${version}` : "Downloading update",
        detail: progressText(s),
        tone: "busy",
      };
    case "downloaded":
      return {
        title: version ? `Version ${version} is ready` : "Update ready",
        detail: "Restart to install it. Your projects and settings are kept.",
        tone: "ready",
      };
    case "installing":
      return {
        title: "Restarting to install…",
        detail: "The app will reopen in a moment.",
        tone: "busy",
      };
    case "error":
      return {
        title: s.update ? "Couldn't download the update" : "Couldn't check for updates",
        detail: s.error || s.message || "Check your connection and try again.",
        tone: "error",
      };
    case "disabled":
    default:
      return {
        title: "Updates are handled by the installer",
        detail: s.message || "Auto-updates are available in the installed desktop app.",
        tone: "muted",
      };
  }
}

export function diagnosticsText({ info, status }) {
  const i = info || {};
  const s = status || {};
  const update = s.update || {};
  return [
    `Iwakura Memoria ${i.version || "unknown"}`,
    i.packaged === false ? "Build: development/browser preview" : "Build: installed",
    i.electron ? `Electron: ${i.electron}` : "",
    i.chrome ? `Chrome: ${i.chrome}` : "",
    i.platform ? `Platform: ${i.platform} ${i.arch || ""}`.trim() : "",
    `Data: ${i.dataDir || "unknown"}`,
    `Backups: ${i.backupsDir || "unknown"}`,
    `Logs: ${i.logsDir || "unknown"}`,
    `Update state: ${s.state || "unknown"}`,
    update.version ? `Available update: ${update.version}` : "",
    s.error ? `Last update error: ${s.error}` : "",
    `Generated: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join("\n");
}
