import { escapeHtmlAttr, imageHtmlTag } from "../static/js/image-utils.js";

// Inline content as raw HTML, shared by the editor's bespoke blocks (the wiki
// character table and the vertical timeline). Their interiors are stored as raw
// HTML — the one shape both Markdown parsers agree on — so a picture inside one
// must be an `<img>` tag (never `![alt](src)`, which would be literal text) and
// formatting must be spelled out with tags the parsers pass through.

export function escText(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Marks this editor can carry into a raw block. A mark that is not listed keeps
// its text and loses its formatting rather than emitting markup we cannot parse.
export function markTag(mark) {
  switch (mark.type.name) {
    case "bold":
      return ["<strong>", "</strong>"];
    case "italic":
      return ["<em>", "</em>"];
    case "underline":
      return ["<u>", "</u>"];
    case "strike":
      return ["<s>", "</s>"];
    case "code":
      return ["<code>", "</code>"];
    case "link": {
      const href = String((mark.attrs && mark.attrs.href) || "");
      return href ? [`<a href="${escapeHtmlAttr(href)}">`, "</a>"] : null;
    }
    case "fontSize":
      return mark.attrs && mark.attrs.size
        ? [`<span style="font-size:${parseInt(mark.attrs.size, 10)}px">`, "</span>"]
        : null;
    case "fontFamily":
      return mark.attrs && mark.attrs.family
        ? [`<span style="font-family:${escapeHtmlAttr(mark.attrs.family)}">`, "</span>"]
        : null;
    case "textColor":
      return mark.attrs && mark.attrs.color
        ? [`<span style="color:${escapeHtmlAttr(mark.attrs.color)}">`, "</span>"]
        : null;
    case "highlight":
      return ["<mark>", "</mark>"];
    case "subscript":
      return ["<sub>", "</sub>"];
    case "superscript":
      return ["<sup>", "</sup>"];
    case "comment":
      return mark.attrs && mark.attrs.cid
        ? [`<span data-cid="${escapeHtmlAttr(mark.attrs.cid)}">`, "</span>"]
        : null;
    default:
      return null;
  }
}

export function markedText(node) {
  let html = escText(node.text || "");
  for (const mark of node.marks || []) {
    const tag = markTag(mark);
    if (tag) html = tag[0] + html + tag[1];
  }
  return html;
}

// Inline content of one cell/heading/paragraph, as raw HTML.
export function inlineHtml(content) {
  let html = "";
  content.forEach((child) => {
    if (child.isText) {
      html += markedText(child);
    } else if (child.type.name === "image") {
      html += imageHtmlTag(child.attrs || {});
    } else if (child.type.name === "hardBreak") {
      html += "<br>";
    } else if (child.isTextblock || child.isInline) {
      html += inlineHtml(child.content);
    }
  });
  return html;
}
