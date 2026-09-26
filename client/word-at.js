// Find the word under a plain-text offset.
//
// Deliberately DOM- and ProseMirror-free: the right-click handler resolves the
// document position, then this decides which characters make up the word, so
// the fiddly boundary rules — and the mapping from a *document* offset (which
// counts inline images) to a *text* offset — can be unit-tested without a live
// editor.

const WORD_CHAR = /[\p{L}\p{N}'’-]/u;
const EDGE = /^['’-]+|['’-]+$/g;

// A placeholder for a non-text inline node (an image, a hard break). It is not a
// word character, so a word never spans one, but it keeps the offset map in
// step: document positions count these nodes, a plain text string does not.
const OBJECT = "\uFFFC";

export function wordRange(text, offset) {
  if (typeof text !== "string" || !text) return null;
  const at = Math.max(0, Math.min(offset, text.length));
  const isWord = (ch) => WORD_CHAR.test(ch);
  let start = at;
  let end = at;
  while (start > 0 && isWord(text[start - 1])) start -= 1;
  while (end < text.length && isWord(text[end])) end += 1;
  if (end <= start) return null;
  const word = text.slice(start, end).replace(EDGE, "");
  // Single letters are noise to look up; treat them as "no word here".
  if (word.length < 2) return null;
  return { word, start, end };
}

// Flatten a textblock's inline children to `{ text, docOffsets }`, where
// `docOffsets[i]` is the offset (within the block) of `text[i]` and the final
// entry is the block's end. `children` is `[{ isText, text, size }]` in document
// order; non-text nodes become a single OBJECT placeholder.
export function inlineText(children) {
  let text = "";
  const docOffsets = [];
  let at = 0;
  for (const child of children) {
    if (child.isText) {
      for (let i = 0; i < child.text.length; i += 1) docOffsets.push(at + i);
      text += child.text;
      at += child.size;
    } else {
      docOffsets.push(at);
      text += OBJECT;
      at += child.size;
    }
  }
  docOffsets.push(at);
  return { text, docOffsets };
}

// Find the word under a document offset within one textblock's inline content.
// Returns `{ word, from, to }` with block-relative document offsets, or null.
export function wordRangeAt(children, offset) {
  const { text, docOffsets } = inlineText(children);
  // The text index of the cursor: how many characters start at or before it.
  let at = 0;
  while (at < text.length && docOffsets[at] < offset) at += 1;
  // The pointer sits on a non-text node (an image, a break): no word there.
  if (at < text.length && text[at] === OBJECT) return null;
  const found = wordRange(text, at);
  if (!found) return null;
  return { word: found.word, from: docOffsets[found.start], to: docOffsets[found.end] };
}
