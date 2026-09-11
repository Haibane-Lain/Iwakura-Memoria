// Find the word under a plain-text offset.
//
// Deliberately DOM- and ProseMirror-free: the right-click handler resolves the
// document position, then this decides which characters make up the word, so
// the fiddly boundary rules can be unit-tested without a live editor.

const WORD_CHAR = /[\p{L}\p{N}'’-]/u;
const EDGE = /^['’-]+|['’-]+$/g;

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
