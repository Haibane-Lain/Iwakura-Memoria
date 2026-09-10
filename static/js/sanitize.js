// Allow-list sanitizer for Lain's rendered Markdown.
//
// Lain quotes the project's own documents, and Markdown can carry raw HTML, so
// a crafted file (or a Lain reply) must never inject script/styles/iframes into
// the chat panel. The renderer already HTML-escapes plain text; this is a
// second, structural guard that walks the produced DOM and only keeps a safe
// tag + attribute allow-list. Everything else is dropped. Inline elements keep
// their text content, so writing content is never lost to the user — only the
// dangerous markup is.
//
// Pure DOM: works in the browser and in Node under jsdom (see tests/sanitize.test.mjs).

// Tags stripped entirely (with their content).
const STRIP_TAGS = new Set(["script", "style", "iframe", "object", "embed", "form", "svg", "math", "video", "audio"]);
// Tags whose content is kept but whose attributes are removed (except the
// URL attributes, which are additionally checked against script schemes).
const ALLOW_EMPTY_ATTRS = new Set([
  "a", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong", "del", "u",
  "table", "thead", "tbody", "tr", "th", "td", "span", "div", "img",
  // A character table is one of these (see client/character-table.js); keeping
  // the element means a document quoted into the chat panel shows its rows
  // instead of collapsing them into a run of bare text.
  "aside",
]);

const SCRIPTY_URL = /^\s*(javascript|data|vbscript):/i;

export function sanitizeChatHTML(html) {
  const root = document.createElement("div");
  root.innerHTML = String(html || "");
  // Snapshot the live descendant list (children get removed/replaced as we
  // walk, so iterate over a static copy and skip anything already detached).
  const nodes = root.querySelectorAll("*");
  for (const node of nodes) {
    if (!root.contains(node)) continue; // an ancestor was stripped already
    const tag = (node.tagName || "").toLowerCase();
    if (!tag) continue;
    if (STRIP_TAGS.has(tag)) {
      node.remove(); // drop the whole subtree (no script/style/iframe content)
      continue;
    }
    if (!ALLOW_EMPTY_ATTRS.has(tag)) {
      node.replaceWith(document.createTextNode(node.textContent || ""));
      continue;
    }
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        node.removeAttribute(attr.name);
        continue;
      }
      if ((tag === "a" && name === "href") || (tag === "img" && name === "src")) {
        if (SCRIPTY_URL.test(attr.value)) node.removeAttribute(attr.name);
      }
    }
  }
  return root.innerHTML;
}
