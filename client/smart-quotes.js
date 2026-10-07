// Smart quotes: turn a typed straight `"` / `'` into the curly character the
// context calls for, the way a word processor does. It hooks ProseMirror's
// `handleTextInput`, which only fires for characters the writer actually types
// in the editor — pasted text, multi-character input and IME composition go
// through other paths and are left alone.
//
// Whether a quote opens or closes is decided by the character before the caret:
// start of a block, whitespace or an opening bracket means opening; anything
// else means closing, so `don't` gets a right single quote (an apostrophe).
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

// What may sit just before a quote that should open rather than close. The
// curly openers are included so nested quotes keep opening.
const OPENS_AFTER = /[\s([{<»«“‘–—>]/;

function curlyQuote(char, before) {
  const opening = before === "" || OPENS_AFTER.test(before);
  if (char === '"') return opening ? "\u201c" : "\u201d";
  return opening ? "\u2018" : "\u2019";
}

function makeSmartQuotesPlugin() {
  return new Plugin({
    key: new PluginKey("lain-smart-quotes"),
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== '"' && text !== "'") return false;
        const $from = view.state.doc.resolve(from);
        // Leave code as typed: a `"` in source is a character, not prose.
        if ($from.parent.type.name === "codeBlock") return false;
        if ($from.marks().some((m) => m.type.name === "code")) return false;
        const before =
          from > $from.start() ? view.state.doc.textBetween(from - 1, from, "") : "";
        // An explicit backslash escape stays straight.
        if (before === "\\") return false;
        const curly = curlyQuote(text, before);
        view.dispatch(view.state.tr.insertText(curly, from, to));
        return true;
      },
    },
  });
}

export function makeSmartQuotesExtension() {
  return Extension.create({
    name: "smartQuotes",
    addProseMirrorPlugins() {
      return [makeSmartQuotesPlugin()];
    },
  });
}
