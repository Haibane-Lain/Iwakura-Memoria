// Node test for the Lain chat HTML sanitizer (static/js/sanitize.js).
// Run: node tests/sanitize.test.mjs  (or `npm test`)
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;

const { sanitizeChatHTML } = await import("../static/js/sanitize.js");

function strip(html) {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.textContent;
}

// 1. Script and its content are removed entirely.
{
  const out = sanitizeChatHTML("hello <script>alert(1)</script> world");
  assert.equal(out.includes("script"), false, "script tag removed");
  assert.equal(strip(out).includes("alert(1)"), false, "script body removed too");
  assert.match(out, /hello/);
  assert.match(out, /world/);
}

// 2. Inline event handlers are stripped.
{
  const out = sanitizeChatHTML('<img src="x" onerror="alert(1)"> ok');
  assert.equal(out.includes("onerror"), false, "onerror attribute removed");
}

// 3. javascript: URLs on links are removed.
{
  const out = sanitizeChatHTML('<a href="javascript:alert(1)">click</a>');
  assert.equal(out.includes("javascript:"), false, "javascript: href removed");
  assert.match(out, />click</, "link text kept");
}

// 4. data: URLs on images removed.
{
  const out = sanitizeChatHTML('<img src="data:image/svg+xml,<svg onload=alert(1)>">');
  assert.equal(out.includes("data:image"), false, "data: src removed");
}

// 5. Unknown tags keep their text content, element dropped.
{
  const out = sanitizeChatHTML("<marquee>ticker</marquee> done");
  assert.equal(out.includes("marquee"), false, "unknown tag dropped");
  assert.match(strip(out), /ticker/, "text kept");
}

// 6. Safe markup passes through unchanged-ish.
{
  const out = sanitizeChatHTML("<p><strong>Bold</strong> and <a href=\"https://x.test\">link</a></p>");
  assert.match(out, /<strong>/);
  assert.match(out, /href="https:\/\/x\.test"/);
  assert.match(out, /<p>/);
}

// 7. Compressed-summary path (markdown-like) with an iframe is safe.
{
  const out = sanitizeChatHTML('Summary <iframe src="https://evil/x"></iframe> rest');
  assert.equal(out.includes("iframe"), false, "iframe removed");
  assert.match(out, /Summary/);
  assert.match(out, /rest/);
}

// 8. A quoted character table keeps its structure (and loses event handlers).
{
  const out = sanitizeChatHTML(
    '<aside class="character-table" data-width="340" onclick="alert(1)">' +
      '<table class="ct-rows"><tr class="ct-row"><td class="ct-label">Gender</td>' +
      '<td class="ct-value">Female</td></tr></table></aside>'
  );
  assert.match(out, /<aside/);
  assert.match(out, /<table/);
  assert.match(out, /<td class="ct-label">Gender<\/td>/);
  assert.equal(out.includes("onclick"), false, "event handler removed");
}

console.log("sanitize.test.mjs: all assertions passed");
