// Pure helpers for inline document images.
//
// A picture inserted into a document lives in a visible `assets/` folder at the
// project root and is referenced **project-root-relative**:
//
//     ![Mara](assets/mara-portrait-47896fe724.png)
//
// That path never changes when the app moves, reorders or renames a chapter,
// so no link rewriting is ever needed. The editor still has to display it, so
// the served form is derived at render time — and normalised back on the way
// in, which is what keeps an internal copy/paste or a hand-written absolute URL
// from being saved into the file.
//
// A *resized* picture is stored as inline HTML (`<img … width="300">`) rather
// than `{width=300}`: the export path (python-markdown) understands attr-list,
// but the editor's parser (markdown-it) does not, so attr-list braces would be
// shown and saved as literal text. Inline HTML round-trips through both, and
// matches this app's existing convention that styling lives in the Markdown as
// HTML (`<span style="…">`, `<p style="text-align:…">`).
//
// Pure and DOM-free: works in the browser, in the esbuild bundle and in Node
// under jsdom (see tests/image-utils.test.mjs).

export const ASSET_PREFIX = "assets/";
export const ASSET_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MIN_IMAGE_WIDTH = 40;

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const SERVED_ASSET_RE = /^\/api\/projects\/[^/]+\/assets\/(.+)$/;

// What the server renders: /api/projects/<id>/assets/<name> -> assets/<name>
export function toStoredSrc(src) {
  const value = src == null ? "" : String(src);
  const match = SERVED_ASSET_RE.exec(value);
  if (!match) return value;
  let name = match[1];
  try {
    name = decodeURIComponent(name);
  } catch {
    /* a malformed escape: keep the raw segment */
  }
  return ASSET_PREFIX + name;
}

// What the browser needs: assets/<name> -> /api/projects/<id>/assets/<name>
export function toServedSrc(projectId, src) {
  const value = src == null ? "" : String(src);
  if (!projectId || !value.startsWith(ASSET_PREFIX)) return value;
  const name = value.slice(ASSET_PREFIX.length);
  // Only the flat store is served; anything else is left alone.
  if (!name || name.includes("/")) return value;
  return `/api/projects/${encodeURIComponent(projectId)}/${ASSET_PREFIX}${encodeURIComponent(name)}`;
}

export function isImageFile(file) {
  if (!file) return false;
  if (IMAGE_MIME_TYPES.has(String(file.type || "").toLowerCase())) return true;
  // Some drag sources report an empty type; fall back to the extension so a
  // dropped .png is not silently ignored when the MIME type is missing.
  const name = String(file.name || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && IMAGE_EXTENSIONS.has(name.slice(dot));
}

export function parseImageWidth(raw) {
  if (raw == null || raw === "") return null;
  const value = parseInt(String(raw).trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function clampImageWidth(px, max) {
  const value = Math.round(Number(px) || 0);
  const limit = Math.round(Number(max) || 0);
  const upper = Math.max(MIN_IMAGE_WIDTH, limit);
  if (value <= MIN_IMAGE_WIDTH) return MIN_IMAGE_WIDTH;
  return Math.min(value, upper);
}

export function imageAltFromFileName(name) {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).trim();
}

function escapeMarkdownAlt(text) {
  return String(text).replace(/([\\[\]])/g, "\\$1");
}

function escapeMarkdownUrl(url) {
  return String(url).replace(/[()]/g, "\\$&");
}

export function escapeHtmlAttr(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The HTML form of one image node. Needed wherever Markdown is *not* parsed
// back: a resized picture, and any picture inside a character table — that
// block is raw HTML, so the `![…]()` form would be shown as literal text
// instead of rendering as a picture.
export function imageHtmlTag(attrs = {}) {
  const src = String(attrs.src == null ? "" : attrs.src);
  const alt = String(attrs.alt == null ? "" : attrs.alt);
  const title = String(attrs.title == null ? "" : attrs.title);
  const width = parseImageWidth(attrs.width);
  const parts = [`src="${escapeHtmlAttr(src)}"`];
  if (alt) parts.push(`alt="${escapeHtmlAttr(alt)}"`);
  if (title) parts.push(`title="${escapeHtmlAttr(title)}"`);
  if (width) parts.push(`width="${width}"`);
  return `<img ${parts.join(" ")}>`;
}

// The Markdown form of one image node. Mirrors prosemirror-markdown's own
// image serializer for the plain case (so unsized pictures are byte-identical
// to what the editor produced before width existed).
export function serializeImageMarkdown(attrs = {}) {
  const src = String(attrs.src == null ? "" : attrs.src);
  const alt = String(attrs.alt == null ? "" : attrs.alt);
  const title = String(attrs.title == null ? "" : attrs.title);
  if (parseImageWidth(attrs.width)) return imageHtmlTag(attrs);
  const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
  return `![${escapeMarkdownAlt(alt)}](${escapeMarkdownUrl(src)}${titlePart})`;
}
