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
    ],
    content,
    editorProps: {
      attributes: { spellcheck: "true" },
    },
    onUpdate: ({ editor }) => {
      if (onChange) onChange(toMarkdown(editor));
    },
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
