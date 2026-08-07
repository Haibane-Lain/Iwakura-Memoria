import { Editor, Extension, Mark, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Paragraph from "@tiptap/extension-paragraph";
import Heading from "@tiptap/extension-heading";
import { Markdown } from "tiptap-markdown";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { DOMSerializer } from "@tiptap/pm/model";

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function wikilinkDecorations(state) {
  const decorations = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const text = node.text || "";
    const regex = new RegExp(WIKILINK_RE.source, "g");
    let match;
    while ((match = regex.exec(text)) !== null) {
      const from = pos + match.index;
      const target = (match[1] || "").trim();
      const alias = match[2] != null ? match[2].trim() : target;
      const to = from + match[0].length;
      decorations.push(Decoration.inline(from, from + 2, { class: "wikilink-bracket" }));
      decorations.push(Decoration.inline(to - 2, to, { class: "wikilink-bracket" }));
      if (alias === target) {
        decorations.push(
          Decoration.inline(from + 2, to - 2, {
            class: "wikilink",
            "data-wikilink": target,
          })
        );
      } else {
        const hideEnd = from + 2 + target.length + 1;
        decorations.push(Decoration.inline(from + 2, hideEnd, { class: "wikilink-bracket" }));
        decorations.push(
          Decoration.inline(hideEnd, to - 2, {
            class: "wikilink",
            "data-wikilink": target,
          })
        );
      }
    }
  });
  return DecorationSet.create(state.doc, decorations);
}

const wikilinkPlugin = new Plugin({
  key: new PluginKey("lain-wikilinks"),
  state: {
    init: (_config, state) => wikilinkDecorations(state),
    apply: (tr, old, _config, newState) => {
      if (tr.docChanged) return wikilinkDecorations(newState);
      return old;
    },
  },
  props: {
    decorations(state) {
      return this.getState(state);
    },
  },
});

const Wikilink = Extension.create({
  name: "wikilink",
  addProseMirrorPlugins() {
    return [wikilinkPlugin];
  },
});

function navWidgetPlugin(navWidget) {
  return new Plugin({
    key: new PluginKey("lain-nav"),
    state: {
      init: (_config, state) =>
        DecorationSet.create(state.doc, [Decoration.widget(0, navWidget, { key: "lain-nav" })]),
      apply: (tr, old, _config, newState) => {
        if (!tr.docChanged) return old;
        return DecorationSet.create(newState.doc, [Decoration.widget(0, navWidget, { key: "lain-nav" })]);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

const NavBox = Extension.create({
  name: "navbox",
  addProseMirrorPlugins() {
    return [navWidgetPlugin(this.options.navWidget)];
  },
  addOptions() {
    return { navWidget: null };
  },
});

function sectionStylesDecorations(state, stylesMap) {
  const decos = [];
  let current = null;
  state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      const text = node.textContent.trim();
      current = stylesMap[text] != null ? { style: stylesMap[text] } : null;
      if (current && !node.attrs.textAlign) {
        decos.push(Decoration.node(pos, pos + node.nodeSize, { style: current.style }));
      }
    } else if (current && node.isBlock && !node.attrs.textAlign) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { style: current.style }));
    }
    return true;
  });
  return DecorationSet.create(state.doc, decos);
}

function makeSectionStylesPlugin() {
  return new Plugin({
    key: new PluginKey("lain-section-styles"),
    state: {
      init: (_config, state) => ({
        set: sectionStylesDecorations(state, {}),
        map: {},
      }),
      apply: (tr, value, _config, newState) => {
        const incoming = tr.getMeta("sectionStylesMap");
        if (tr.docChanged || tr.getMeta("forceSectionStyles") || (incoming && incoming !== value.map)) {
          const map = incoming || value.map;
          return { set: sectionStylesDecorations(newState, map), map };
        }
        return value;
      },
    },
    props: {
      decorations(state) {
        const v = this.getState(state);
        return v ? v.set : DecorationSet.empty;
      },
    },
  });
}

const SectionStyles = Extension.create({
  name: "sectionStyles",
  addProseMirrorPlugins() {
    return [makeSectionStylesPlugin()];
  },
});

/* ---------------- Grammar decorations ---------------- */

const grammarPluginKey = new PluginKey("lain-grammar");
let _grammarTimer = null;
let _grammarView = null;
let _grammarSkipping = false;
let _grammarReplaceRange = null;
let _lastDocOffsets = null;
let _lastDocText = null;
let _grammarDictionaryWords = [];
let _grammarAddToDictCallback = null;

function _grammarHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return String(h);
}

function _grammarDocText(doc) {
  let text = "";
  const offsets = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      const prev = offsets.length > 0 ? offsets[offsets.length - 1] : null;
      if (!prev || prev.ltPos + prev.len !== text.length) {
        offsets.push({ ltPos: text.length, docPos: pos });
        offsets[offsets.length - 1].len = node.text.length;
      } else {
        prev.len += node.text.length;
      }
      text += node.text;
      return false;
    }
    if (node.isBlock && offsets.length > 0) {
      text += "\n";
    }
    return true;
  });
  return { text, offsets };
}

function _ltToDocPos(offsets, target) {
  if (!offsets || !offsets.length) return Math.min(target, 999999);
  let lo = 0, hi = offsets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const o = offsets[mid];
    if (target >= o.ltPos && (mid === offsets.length - 1 || target < offsets[mid + 1].ltPos)) {
      return o.docPos + (target - o.ltPos);
    }
    if (target < o.ltPos) hi = mid - 1;
    else lo = mid + 1;
  }
  const last = offsets[offsets.length - 1];
  return last.docPos + last.len;
}

async function _grammarFetch(text) {
  const resp = await fetch("/api/grammar/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, language: "en-US", dictionaryWords: _grammarDictionaryWords }),
  });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
}

function _grammarUpdate(view, docText, matches) {
  const offsets = docText.offsets;
  const decos = [];
  for (const m of matches) {
    if (m.length <= 0) continue;
    const from = _ltToDocPos(offsets, m.offset);
    const to = _ltToDocPos(offsets, m.offset + m.length);
    if (from < 0 || to <= from || to > view.state.doc.content.size) continue;
    decos.push(
      Decoration.inline(from, to, {
        class: "grammar-error",
        "data-grammar": JSON.stringify(m),
      })
    );
  }
  const set = DecorationSet.create(view.state.doc, decos);
  const textHash = _grammarHash(docText.text);
  _grammarSkipping = true;
  view.dispatch(view.state.tr.setMeta("grammarDecorations", { set, textHash }));
  _grammarSkipping = false;
}

function _grammarSchedule(view) {
  if (!view || view.isDestroyed) return;
  clearTimeout(_grammarTimer);
  const pluginState = grammarPluginKey.getState(view.state);
  if (!pluginState || !pluginState.enabled) return;
  const docText = _grammarDocText(view.state.doc);
  const hash = _grammarHash(docText.text);
  if (hash === pluginState.textHash) return;
  _lastDocOffsets = docText.offsets;
  _lastDocText = docText.text;
  _grammarTimer = setTimeout(async () => {
    try {
      const data = await _grammarFetch(docText.text);
      if (view.isDestroyed) return;
      _grammarUpdate(view, docText, data.matches || []);
    } catch {
      /* grammar server unavailable */
    }
  }, 1500);
}

function makeGrammarPlugin() {
  const plugin = new Plugin({
    key: grammarPluginKey,
    state: {
      init: () => ({ set: DecorationSet.empty, enabled: true, textHash: "" }),
      apply: (tr, value, _config, newState) => {
        const enabled = tr.getMeta("grammarEnabled");
        const newEnabled = enabled !== undefined ? enabled : value.enabled;
        const incoming = tr.getMeta("grammarDecorations");
        let set = incoming ? incoming.set : value.set;
        if (tr.docChanged && !incoming) {
          set = set.map(tr.mapping, tr.doc);
          if (_grammarReplaceRange) {
            set = set.remove(set.find(_grammarReplaceRange.from, _grammarReplaceRange.to));
            _grammarReplaceRange = null;
          }
        }
        const textHash = incoming ? incoming.textHash : (tr.docChanged ? "" : value.textHash);

        if (tr.docChanged && newEnabled && !_grammarSkipping) {
          _grammarSchedule(_grammarView);
        }

        if (tr.getMeta("forceGrammar") && newEnabled && _grammarView && !_grammarView.isDestroyed) {
          clearTimeout(_grammarTimer);
          _grammarTimer = setTimeout(async () => {
            const docText = _grammarDocText(newState.doc);
            try {
              const data = await _grammarFetch(docText.text);
              if (_grammarView.isDestroyed) return;
              _grammarUpdate(_grammarView, docText, data.matches || []);
            } catch { /* unavailable */ }
          }, 300);
        }

        return { set, enabled: newEnabled, textHash };
      },
    },
    props: {
      decorations(state) {
        const v = this.getState(state);
        return v ? v.set : DecorationSet.empty;
      },
    },
    spec: { view: null },
  });
  return plugin;
}

const GrammarExtension = Extension.create({
  name: "grammar",
  addProseMirrorPlugins() {
    return [makeGrammarPlugin()];
  },
});

const FontSize = Mark.create({
  name: "fontSize",
  inclusive: false,
  addAttributes() {
    return { size: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "span[style]",
        getAttrs(node) {
          const m = /font-size:\s*([\d.]+)px/i.exec(node.getAttribute("style") || "");
          return m ? { size: m[1] } : false;
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return HTMLAttributes.size
      ? ["span", { style: `font-size:${HTMLAttributes.size}px` }, 0]
      : ["span", {}, 0];
  },
});

const FontFamily = Mark.create({
  name: "fontFamily",
  inclusive: false,
  addAttributes() {
    return { family: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "span[style]",
        getAttrs(node) {
          const m = /font-family:\s*([^;]+)/i.exec(node.getAttribute("style") || "");
          return m ? { family: m[1].trim() } : false;
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return HTMLAttributes.family
      ? ["span", { style: `font-family:${HTMLAttributes.family}` }, 0]
      : ["span", {}, 0];
  },
});

const textAlignAttr = {
  default: null,
  parseHTML: (el) => el.style.textAlign || null,
  renderHTML: (attrs) => (attrs.textAlign ? { style: `text-align:${attrs.textAlign}` } : {}),
};

function serializeStyledBlock(state, node, tag) {
  const align = node.attrs.textAlign;
  if (!align) {
    if (node.type.name === "heading") {
      state.write(`${"#".repeat(node.attrs.level)} `);
    }
    state.renderInline(node);
    state.closeBlock(node);
    return;
  }
  const container = document.createElement("div");
  container.appendChild(
    DOMSerializer.fromSchema(this.editor.schema).serializeFragment(node.content, { document })
  );
  state.write(`<${tag} style="text-align:${align}">`);
  state.write(container.innerHTML);
  state.write(`</${tag}>`);
  state.closeBlock(node);
}

const StyledParagraph = Paragraph.extend({
  addAttributes() {
    return { textAlign: textAlignAttr };
  },
  addStorage() {
    return {
      markdown: {
        serialize: function serialize(state, node) {
          serializeStyledBlock.call(this, state, node, "p");
        },
      },
    };
  },
});

const StyledHeading = Heading.extend({
  addOptions() {
    return { levels: [1, 2, 3] };
  },
  addAttributes() {
    return {
      level: { default: 1, rendered: false },
      textAlign: textAlignAttr,
    };
  },
  parseHTML() {
    return this.options.levels.map((level) => ({ tag: `h${level}`, attrs: { level } }));
  },
  renderHTML({ node, HTMLAttributes }) {
    const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes);
    if (node.attrs.textAlign) attrs.style = `text-align:${node.attrs.textAlign}`;
    return [`h${node.attrs.level}`, attrs, 0];
  },
  addStorage() {
    return {
      markdown: {
        serialize: function serialize(state, node) {
          serializeStyledBlock.call(this, state, node, `h${node.attrs.level}`);
        },
      },
    };
  },
});

/* ---------------- Grammar tooltip ---------------- */

let _grammarTooltip = null;

function _grammarHideTooltip() {
  if (_grammarTooltip) {
    _grammarTooltip.remove();
    _grammarTooltip = null;
  }
}

function _grammarShowTooltip(errorEl) {
  _grammarHideTooltip();
  const raw = errorEl.getAttribute("data-grammar");
  if (!raw) return;
  let match;
  try { match = JSON.parse(raw); } catch { return; }

  const tip = document.createElement("div");
  tip.className = "grammar-tooltip";
  const msg = document.createElement("div");
  msg.className = "grammar-tooltip-msg";
  msg.textContent = match.message;
  tip.appendChild(msg);

  if (match.replacements && match.replacements.length) {
    const rl = document.createElement("div");
    rl.className = "grammar-tooltip-reps";
    for (const r of match.replacements.slice(0, 6)) {
      const chip = document.createElement("button");
      chip.className = "grammar-rep-chip";
      chip.textContent = r;
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        const view = _grammarView;
        const offsets = _lastDocOffsets;
        if (!view || view.isDestroyed || !offsets) return;
        const from = _ltToDocPos(offsets, match.offset);
        const to = _ltToDocPos(offsets, match.offset + match.length);
        if (from < 0 || to > view.state.doc.content.size) return;
        const tr = view.state.tr;
        _grammarSkipping = true;
        _grammarReplaceRange = { from, to };
        tr.replaceWith(from, to, view.state.schema.text(r));
        view.dispatch(tr);
        _grammarSkipping = false;
        _grammarHideTooltip();
        _grammarSchedule(view);
      });
      rl.appendChild(chip);
    }
    tip.appendChild(rl);
  }

  const matchedWord = (_lastDocText || "").substring(match.offset, match.offset + match.length).trim();
  if (matchedWord && _grammarAddToDictCallback && matchedWord.length > 1) {
    const alreadyIn = _grammarDictionaryWords.some((w) => w.toLowerCase() === matchedWord.toLowerCase());
    const sep = document.createElement("div");
    sep.className = "grammar-tooltip-sep";
    tip.appendChild(sep);
    const addBtn = document.createElement("button");
    addBtn.className = "grammar-dict-btn";
    if (alreadyIn) {
      addBtn.textContent = `"${matchedWord}" in dictionary`;
      addBtn.disabled = true;
    } else {
      addBtn.textContent = `Add "${matchedWord}" to dictionary`;
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _grammarAddToDictCallback(matchedWord);
        _grammarHideTooltip();
      });
    }
    tip.appendChild(addBtn);
  }

  document.body.appendChild(tip);

  const rect = errorEl.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.left + rect.width / 2;
  if (top + 160 > window.innerHeight) top = rect.top - tip.offsetHeight - 4;
  if (left + 150 > window.innerWidth) left = window.innerWidth - 155;
  if (left < 10) left = 10;
  tip.style.top = top + "px";
  tip.style.left = left + "px";

  _grammarTooltip = tip;
}

document.addEventListener("click", (e) => {
  if (_grammarTooltip && !e.target.closest(".grammar-error") && !e.target.closest(".grammar-tooltip")) {
    _grammarHideTooltip();
  }
});

function toMarkdown(editor) {
  let md = editor.storage.markdown.getMarkdown();
  md = md.replace(/\\\[/g, "[").replace(/\\\]/g, "]");
  return md;
}

function makeEditor({ element, content, placeholder, onChange, onWikilinkClick, navWidget }) {
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ heading: false, paragraph: false }),
      StyledParagraph,
      StyledHeading,
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({ placeholder }),
      CharacterCount,
      Markdown.configure({ html: true, tightLists: true, linkify: true, breaks: false }),
      Wikilink,
      FontSize,
      FontFamily,
      ...(navWidget ? [NavBox.configure({ navWidget })] : []),
      SectionStyles,
      GrammarExtension,
    ],
    content,
    editorProps: { attributes: {} },
    onUpdate: ({ editor }) => {
      if (onChange) onChange(toMarkdown(editor));
    },
  });

  _grammarView = editor.view;

  editor.view.dom.addEventListener("click", (e) => {
    const target = e.target.closest(".grammar-error");
    if (target) {
      e.preventDefault();
      e.stopPropagation();
      _grammarShowTooltip(target);
    }
  });

  if (onWikilinkClick) {
    editor.view.dom.addEventListener("click", (e) => {
      const target = e.target.closest(".wikilink");
      if (target) {
        e.preventDefault();
        onWikilinkClick(target.getAttribute("data-wikilink"));
      }
    });
  }

  return editor;
}

window.LainEditor = {
  create(opts) {
    const navWidget = opts.showNav ? document.createElement("div") : null;
    if (navWidget) navWidget.className = "nav-box";
    const editor = makeEditor({ ...opts, navWidget });
    return {
      editor,
      navEl: navWidget,
      setSectionStyles(map) {
        editor.view.dispatch(editor.state.tr.setMeta("sectionStylesMap", map || {}));
      },
      setBlockTextAlign(align) {
        const { state } = editor;
        const { from, to } = state.selection;
        const tr = state.tr;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.isTextblock && (node.type.name === "paragraph" || node.type.name === "heading")) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: align });
          }
        });
        editor.view.dispatch(tr);
      },
      destroy() {
        clearTimeout(_grammarTimer);
        _grammarView = null;
        editor.destroy();
      },
      getMarkdown() {
        return toMarkdown(editor);
      },
      getText() {
        return editor.getText();
      },
      focus() {
        editor.commands.focus();
      },
      setContent(md) {
        editor.commands.setContent(md, false);
      },
      insertText(text) {
        editor.chain().focus().insertContent(text).run();
      },
      insertWikilink(title) {
        this.insertText(`[[${title}]]`);
      },
      setGrammarEnabled(enabled) {
        editor.view.dispatch(editor.state.tr.setMeta("grammarEnabled", !!enabled));
        if (enabled) _grammarSchedule(_grammarView);
      },
      setDictionaryWords(words) {
        _grammarDictionaryWords = Array.isArray(words) ? words : [];
        if (_grammarView && !_grammarView.isDestroyed) {
          _grammarView.dispatch(_grammarView.state.tr.setMeta("forceGrammar", true));
        }
      },
      setOnAddToDictionary(callback) {
        _grammarAddToDictCallback = callback;
      },
      run(command) {
        const chain = editor.chain().focus();
        if (command === "undo") chain.undo();
        else if (command === "redo") chain.redo();
        else if (command === "bold") chain.toggleBold();
        else if (command === "italic") chain.toggleItalic();
        else if (command === "underline") chain.toggleUnderline();
        else if (command === "strike") chain.toggleStrike();
        else if (command === "blockquote") chain.toggleBlockquote();
        else if (command === "bulletList") chain.toggleBulletList();
        else if (command === "orderedList") chain.toggleOrderedList();
        else if (command === "codeBlock") chain.toggleCodeBlock();
        else if (command === "horizontalRule") chain.setHorizontalRule();
        else if (command === "h1") chain.toggleHeading({ level: 1 });
        else if (command === "h2") chain.toggleHeading({ level: 2 });
        else if (command === "h3") chain.toggleHeading({ level: 3 });
        else return;
        chain.run();
      },
    };
  },
};
