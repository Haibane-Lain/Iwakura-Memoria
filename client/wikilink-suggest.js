// Pure helpers for `[[wikilink]]` autocomplete.
//
// DOM- and ProseMirror-free, the way `client/word-at.js` is: the editor plugin
// resolves the caret to the surrounding block text and these functions decide
// whether a popup should open and which titles match. Keeping them separate
// means the fiddly trigger rules can be unit-tested without jsdom.

// The text before the caret ends in an unclosed `[[`. Returns the target's
// start offset (relative to `textBefore`) and the typed query, or null when no
// completion should appear.
export function matchWikilinkTrigger(textBefore) {
  if (typeof textBefore !== "string") return null;
  const start = textBefore.lastIndexOf("[[");
  if (start < 0) return null;
  // Three or more brackets in a row are not a clean trigger.
  if (start > 0 && textBefore[start - 1] === "[") return null;
  const query = textBefore.slice(start + 2);
  // A `]]`, another bracket, an alias separator, or a line break means this is
  // a finished link (or not a target) rather than a fresh `[[`.
  if (query.includes("]") || query.includes("[") || query.includes("\n") || query.includes("|")) {
    return null;
  }
  return { start, query };
}

// True when the caret sits between an open `[[` and a later `]]` — i.e. inside
// a link that is already closed. Completing there would leave the trailing
// brackets behind (`[[Title]]]]`), so the popup stays shut.
export function isInsideWikilink(textAfter) {
  if (typeof textAfter !== "string") return false;
  const close = textAfter.indexOf("]]");
  if (close < 0) return false;
  const open = textAfter.indexOf("[[");
  return open < 0 || close < open;
}

// Rank titles that match the query: prefix matches first, then substring
// matches (title or id). An empty query lists everything, capped for sanity.
export function filterWikilinkItems(items, query, limit = 50) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query || "").trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  const prefix = [];
  const rest = [];
  for (const item of list) {
    const title = String(item.title || "").toLowerCase();
    if (title.startsWith(q)) prefix.push(item);
    else if (title.includes(q) || String(item.id || "").toLowerCase().includes(q)) rest.push(item);
  }
  return [...prefix, ...rest].slice(0, limit);
}

// The Markdown for a completed link.
export function wikilinkText(title) {
  return `[[${String(title == null ? "" : title).trim()}]]`;
}
