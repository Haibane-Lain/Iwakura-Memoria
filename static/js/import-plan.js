// Import planning: everything the import dialog can decide *before* a request
// goes out. A leaf module with no DOM and no API, so the rules that shape an
// import (which paths a pick produces, what kind of bundle it is, what to call
// it, whether it is too big) are unit-testable on their own.

// What a file pick offers. A folder pick ignores `accept` (Chromium), so this
// is a filter, not a guarantee — the server drops anything it cannot read.
export const IMPORT_ACCEPT = ".md,.markdown,.txt,.text,.docx,.zip";

// Kept in step with app/services/import_docs.py MAX_BUNDLE_BYTES.
export const IMPORT_LIMIT_BYTES = 25 * 1024 * 1024;

// Everything the readers can turn into a document.
const DOC_EXT_RE = /\.(md|markdown|txt|text|docx)$/i;

/** Normalise a picked path to `/`-separated, relative form. */
export function normalizePath(raw) {
  return String(raw || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

/**
 * The import path for each picked file.
 *
 * A folder pick carries `webkitRelativePath` (``My Novel/Ch 1/a.md``); a plain
 * file pick only has a name. Both become the label the server turns into
 * folders, so this is where a bundle's structure is decided.
 */
export function relativePaths(files) {
  return Array.from(files || []).map((file) => normalizePath(file && (file.webkitRelativePath || file.name)));
}

/** A title from a file or folder name: ``03-the-old-house.md`` -> ``The Old House``. */
export function titleFromName(name) {
  const base = String(name || "").split("/").pop() || "";
  const stem = base.replace(/\.[^.]+$/, "");
  const title = stem
    .replace(/^\d+[-_. ]*/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!title) return "";
  return title
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The bundle kind, mirroring the server's `detect()`. */
export function detectSource(paths) {
  const list = Array.from(paths || []).map(normalizePath).filter(Boolean);
  if (!list.length) return "empty";
  if (list.some((p) => /\.(md|markdown)$/i.test(p))) return "markdown";
  if (list.some((p) => /\.docx$/i.test(p))) return "docx";
  if (list.some((p) => /\.(txt|text)$/i.test(p))) return "text";
  return "unsupported";
}

export const SOURCE_LABELS = {
  markdown: "Markdown",
  docx: "Word document",
  text: "plain text",
  empty: "no files",
  unsupported: "unrecognised files",
};

/** Whether a pick holds a Word document (the split option only applies then). */
export function hasDocx(paths) {
  return Array.from(paths || []).some((p) => /\.docx$/i.test(normalizePath(p)));
}

/** A default folder/project name for a bundle: its single shared root, else "". */
export function bundleName(paths) {
  const list = Array.from(paths || []).map(normalizePath).filter(Boolean);
  if (!list.length) return "";
  const tops = new Set(list.map((p) => p.split("/")[0]));
  if (tops.size !== 1) return "";
  const top = [...tops][0];
  // One zip is named after the archive; a single loose file after the file.
  if (list.length === 1 || /\.zip$/i.test(top)) return titleFromName(top);
  return top;
}

/** Human summary of a bundle: what will be imported and how big it is. */
export function describeBundle(paths) {
  const list = Array.from(paths || []).map(normalizePath).filter(Boolean);
  const docs = list.filter((p) => DOC_EXT_RE.test(p)).length;
  const folders = new Set();
  for (const path of list) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
  }
  return { documents: docs, folders: folders.size, files: list.length, source: detectSource(list) };
}

/** Total bytes across picked files (falls back to 0 for a file-less entry). */
export function bundleSize(files) {
  let total = 0;
  for (const file of Array.from(files || [])) total += Number((file && file.size) || 0);
  return total;
}

/** Whether a pick is past the import limit the server enforces. */
export function overLimit(files) {
  return bundleSize(files) > IMPORT_LIMIT_BYTES;
}

/** "1.4 MB" — for the dialog's summary line. */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
