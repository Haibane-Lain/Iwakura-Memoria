// Node test for the inline-image helpers (static/js/image-utils.js).
// Run: node tests/image-utils.test.mjs  (or `npm run test:image`)
import assert from "node:assert/strict";

import {
  ASSET_ACCEPT,
  ASSET_PREFIX,
  MAX_IMAGE_BYTES,
  clampImageWidth,
  escapeHtmlAttr,
  imageAltFromFileName,
  imageHtmlTag,
  isImageFile,
  parseImageWidth,
  serializeImageMarkdown,
  toServedSrc,
  toStoredSrc,
} from "../static/js/image-utils.js";

const PID = "my-project";

/* ---------------- stored <-> served src ---------------- */

// A document stores the project-root-relative form, and the served form only
// ever exists in the DOM.
assert.equal(toServedSrc(PID, "assets/mara.png"), `/api/projects/${PID}/assets/mara.png`);
assert.equal(toStoredSrc(`/api/projects/${PID}/assets/mara.png`), "assets/mara.png");

// An internal copy/paste carries the served URL, so it has to round-trip.
const served = toServedSrc(PID, "assets/mara.png");
assert.equal(toStoredSrc(served), "assets/mara.png");
assert.equal(toStoredSrc(served), toStoredSrc(toServedSrc(PID, toStoredSrc(served))));

// Names with characters that need escaping survive the trip both ways.
const awkward = "mara portrait (final) #2.png";
const servedAwkward = toServedSrc(PID, ASSET_PREFIX + awkward);
assert.ok(!servedAwkward.includes(" "));
assert.equal(toStoredSrc(servedAwkward), ASSET_PREFIX + awkward);

// Anything that is not one of our assets is left exactly as it was: remote
// URLs, other API paths, and nested paths we do not serve.
for (const foreign of [
  "https://example.com/x.png",
  "http://example.com/x.png",
  "images/local.png",
  "/static/logo.png",
  "data:image/png;base64,AAAA",
  "assets/sub/x.png",
  "",
]) {
  assert.equal(toServedSrc(PID, foreign), foreign, `toServedSrc passthrough: ${foreign}`);
}
assert.equal(toStoredSrc("https://example.com/assets/x.png"), "https://example.com/assets/x.png");
assert.equal(toStoredSrc("/api/projects/other/assets/x.png"), "assets/x.png");

/* ---------------- accepted file types ---------------- */

for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "IMAGE/PNG"]) {
  assert.equal(isImageFile({ type, name: "x" }), true, type);
}
// No MIME type (some drag sources): the extension decides.
assert.equal(isImageFile({ type: "", name: "Mara.PNG" }), true);
assert.equal(isImageFile({ type: "", name: "shot.jpeg" }), true);
// Rejected formats — SVG is deliberately not supported.
for (const file of [
  { type: "image/svg+xml", name: "art.svg" },
  { type: "image/bmp", name: "art.bmp" },
  { type: "application/pdf", name: "doc.pdf" },
  { type: "text/plain", name: "notes.txt" },
  { type: "", name: "noextension" },
  null,
]) {
  assert.equal(isImageFile(file), false, JSON.stringify(file));
}
assert.equal(ASSET_ACCEPT, "image/png,image/jpeg,image/gif,image/webp");

/* ---------------- width ---------------- */

assert.equal(parseImageWidth("300"), 300);
assert.equal(parseImageWidth(300), 300);
assert.equal(parseImageWidth("300px"), 300);
assert.equal(parseImageWidth(""), null);
assert.equal(parseImageWidth(null), null);
assert.equal(parseImageWidth(undefined), null);
assert.equal(parseImageWidth("wide"), null);
assert.equal(parseImageWidth("0"), null);
assert.equal(parseImageWidth("-40"), null);

assert.equal(clampImageWidth(300, 760), 300);
assert.equal(clampImageWidth(900, 760), 760);
assert.equal(clampImageWidth(5, 760), 40); // never smaller than the minimum
assert.equal(clampImageWidth(300, 20), 40); // a tiny column still leaves a usable handle
assert.equal(clampImageWidth(NaN, 760), 40);

/* ---------------- markdown ---------------- */

// Unsized images stay plain Markdown — byte-identical to what the editor wrote
// before width existed, so existing documents are untouched.
assert.equal(serializeImageMarkdown({ src: "assets/mara.png", alt: "Mara Portrait" }), "![Mara Portrait](assets/mara.png)");
assert.equal(serializeImageMarkdown({ src: "assets/mara.png" }), "![](assets/mara.png)");
assert.equal(
  serializeImageMarkdown({ src: "assets/mara.png", alt: "Mara", title: "Portrait" }),
  '![Mara](assets/mara.png "Portrait")'
);

// A resized image is stored as inline HTML: the export path (python-markdown)
// understands attr-list but the editor's parser (markdown-it) does not, so
// `{width=300}` would show up as literal text in the document.
assert.equal(
  serializeImageMarkdown({ src: "assets/mara.png", alt: "Mara", width: 300 }),
  '<img src="assets/mara.png" alt="Mara" width="300">'
);
assert.equal(
  serializeImageMarkdown({ src: "assets/mara.png", alt: "Mara", title: "Portrait", width: "300px" }),
  '<img src="assets/mara.png" alt="Mara" title="Portrait" width="300">'
);
// A zero/invalid width is not a width.
assert.equal(serializeImageMarkdown({ src: "assets/x.png", width: 0 }), "![](assets/x.png)");

// Escaping: Markdown brackets/brackets in alt, parens in the URL, quotes and
// angle brackets in HTML attributes.
assert.equal(serializeImageMarkdown({ src: "assets/a(1).png" }), "![](assets/a\\(1\\).png)");
assert.equal(serializeImageMarkdown({ src: "assets/x.png", alt: "a [b] c" }), "![a \\[b\\] c](assets/x.png)");
assert.equal(
  serializeImageMarkdown({ src: "assets/x.png", alt: 'a "b" & <c>', width: 100 }),
  '<img src="assets/x.png" alt="a &quot;b&quot; &amp; &lt;c&gt;" width="100">'
);

/* ---------------- the HTML form ---------------- */

// Used wherever Markdown is not parsed back: a resized picture, and every
// picture inside a character table (that block is raw HTML, so `![alt](src)`
// would be saved — and shown — as literal text).
assert.equal(imageHtmlTag({ src: "assets/mara.png" }), '<img src="assets/mara.png">');
assert.equal(
  imageHtmlTag({ src: "assets/mara.png", alt: "Mara", title: "Portrait" }),
  '<img src="assets/mara.png" alt="Mara" title="Portrait">'
);
assert.equal(
  imageHtmlTag({ src: "assets/mara.png", alt: "Mara", width: "240px" }),
  '<img src="assets/mara.png" alt="Mara" width="240">'
);
assert.equal(imageHtmlTag({ src: "assets/x.png", width: 0 }), '<img src="assets/x.png">');
assert.equal(imageHtmlTag({}), '<img src="">');
assert.equal(escapeHtmlAttr('a "b" & <c>'), "a &quot;b&quot; &amp; &lt;c&gt;");
// The sized Markdown form delegates to it, so both stay identical.
assert.equal(
  serializeImageMarkdown({ src: "assets/mara.png", alt: "Mara", width: 300 }),
  imageHtmlTag({ src: "assets/mara.png", alt: "Mara", width: 300 })
);

/* ---------------- alt from a file name ---------------- */
assert.equal(imageAltFromFileName("Mara Portrait.png"), "Mara Portrait");
assert.equal(imageAltFromFileName("C:\\Users\\lain\\shot.jpg"), "shot");
assert.equal(imageAltFromFileName("noextension"), "noextension");
assert.equal(imageAltFromFileName(""), "");
assert.equal(imageAltFromFileName(undefined), "");

/* ---------------- limits ---------------- */

assert.equal(MAX_IMAGE_BYTES, 10 * 1024 * 1024);

console.log("image-utils: all assertions passed");
