// Unit test for the import planning rules (static/js/import-plan.js).
// Run: node tests/import-plan.test.mjs  (or `npm run test:importplan`)
import assert from "node:assert/strict";

import {
  IMPORT_LIMIT_BYTES,
  bundleName,
  bundleSize,
  describeBundle,
  detectSource,
  formatBytes,
  normalizePath,
  overLimit,
  relativePaths,
  titleFromName,
} from "../static/js/import-plan.js";

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      ${err && err.message}`);
  }
}

check("a picked path is made relative and forward-slashed", () => {
  assert.equal(normalizePath("My Novel\\Ch 1\\a.md"), "My Novel/Ch 1/a.md");
  assert.equal(normalizePath("../escape/./a.md"), "escape/a.md");
  assert.equal(normalizePath("/root/a.md"), "root/a.md");
  assert.equal(normalizePath(""), "");
});

check("a folder pick keeps its structure, a file pick keeps its name", () => {
  const files = [
    { name: "a.md", webkitRelativePath: "My Novel/Ch 1/a.md" },
    { name: "b.md", webkitRelativePath: "" },
  ];
  assert.deepEqual(relativePaths(files), ["My Novel/Ch 1/a.md", "b.md"]);
  assert.deepEqual(relativePaths(null), []);
});

check("the source is recognised from the extensions", () => {
  assert.equal(detectSource([]), "empty");
  assert.equal(detectSource(["a.md"]), "markdown");
  assert.equal(detectSource(["Vault/note.markdown"]), "markdown");
  assert.equal(detectSource(["a.txt"]), "text");
  assert.equal(detectSource(["a.docx"]), "unsupported");
  // Markdown wins when a bundle holds both kinds.
  assert.equal(detectSource(["a.txt", "b.md"]), "markdown");
});

check("titles come from file names", () => {
  assert.equal(titleFromName("03-the-old-house.md"), "The Old House");
  assert.equal(titleFromName("Act One"), "Act One");
  assert.equal(titleFromName("my_note.txt"), "My Note");
  assert.equal(titleFromName(".md"), "");
});

check("a bundle is named after its single root", () => {
  assert.equal(bundleName(["My Novel/Ch 1/a.md", "My Novel/Ch 2/b.md"]), "My Novel");
  assert.equal(bundleName(["novel.zip"]), "Novel");
  assert.equal(bundleName(["a.md", "b.md"]), "");
  assert.equal(bundleName([]), "");
});

check("the summary counts documents and folders", () => {
  const info = describeBundle(["Novel/Ch 1/a.md", "Novel/Ch 1/b.md", "Novel/c.txt", "Novel/cover.png"]);
  assert.equal(info.documents, 3);
  assert.equal(info.folders, 2); // "Novel" and "Novel/Ch 1"
  assert.equal(info.files, 4);
  assert.equal(info.source, "markdown");
});

check("size, limit and formatting", () => {
  assert.equal(bundleSize([{ size: 100 }, { size: 24 }]), 124);
  assert.equal(bundleSize(null), 0);
  assert.equal(overLimit([{ size: IMPORT_LIMIT_BYTES }]), false);
  assert.equal(overLimit([{ size: IMPORT_LIMIT_BYTES + 1 }]), true);
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});

if (failures) {
  console.log(`import-plan: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("import-plan: all checks passed");
