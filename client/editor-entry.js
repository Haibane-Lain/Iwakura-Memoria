import { Editor, Extension, Mark, Node, mergeAttributes } from "@tiptap/core";
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
import {
  ASSET_PREFIX,
  clampImageWidth,
  imageAltFromFileName,
  isImageFile,
  parseImageWidth,
  serializeImageMarkdown,
  toServedSrc,
  toStoredSrc,
} from "../static/js/image-utils.js";
import {
  insertCharacterTable as insertCharacterTableAt,
  makeCharacterTableNodes,
  portraitTargetAt,
  setPortraitFromFiles,
} from "./character-table.js";
import {
  makeTableExtensions,
  makeTaskListExtensions,
  makeInlineMarkExtensions,
} from "./editor-primitives.js";
import { makeSlashMenuExtension } from "./slash-menu.js";

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
let _grammarBusy = false;

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

const GRAMMAR_FETCH_TIMEOUT_MS = 30000;

async function _grammarFetch(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAMMAR_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch("/api/grammar/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language: "en-US", dictionaryWords: _grammarDictionaryWords }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    return resp.json();
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn("grammar check timed out");
      throw new Error("grammar check timed out", { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  const checkedHash = hash;
  _grammarTimer = setTimeout(async () => {
    if (_grammarBusy) return;
    // Bind the request to the view it was scheduled for. With more than one
    // editor kept alive (undo history), the *active* view can change while a
    // check is in flight; its offsets must never be painted onto another
    // document.
    const currentView = view;
    const t0 = performance.now();
    _grammarBusy = true;
    try {
      const data = await _grammarFetch(docText.text);
      if (currentView !== _grammarView || currentView.isDestroyed) return;
      _grammarUpdate(currentView, docText, data.matches || []);
    } catch (err) {
      console.warn(`[diag] grammar check failed ${(performance.now() - t0).toFixed(0)}ms`, err.message);
    } finally {
      _grammarBusy = false;
      if (currentView === _grammarView && !currentView.isDestroyed) {
        const latest = _grammarDocText(currentView.state.doc);
        if (_grammarHash(latest.text) !== checkedHash) _grammarSchedule(currentView);
      }
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
          const currentView = _grammarView;
          const docText = _grammarDocText(newState.doc);
          _grammarTimer = setTimeout(async () => {
            if (_grammarBusy) return;
            _grammarBusy = true;
            try {
              const data = await _grammarFetch(docText.text);
              if (!currentView || currentView.isDestroyed) return;
              _grammarUpdate(currentView, docText, data.matches || []);
            } catch { /* unavailable */ }
            finally {
              _grammarBusy = false;
            }
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
        try {
          _grammarSkipping = true;
          _grammarReplaceRange = { from, to };
          tr.replaceWith(from, to, view.state.schema.text(r));
          view.dispatch(tr);
        } finally {
          _grammarSkipping = false;
        }
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

/* ---------------- inline images ---------------- */

// A picture is stored as `assets/<name>` in the Markdown and rendered through
// the app's asset route. The stored form is what the node keeps in its attrs,
// so the Markdown round-trips untouched; the served form only ever appears in
// the DOM, and the attribute-level parse rule maps it back — which is what
// keeps an internal copy/paste (or a hand-edited absolute URL) from writing
// the served URL into the file.
function makeAssetImage(imageOpts) {
  const { projectId, onOpenImage } = imageOpts;

  return Node.create({
    name: "image",
    inline: true,
    group: "inline",
    draggable: true,
    selectable: true,

    addAttributes() {
      return {
        src: {
          default: null,
          parseHTML: (el) => toStoredSrc(el.getAttribute("src")),
        },
        alt: { default: null },
        title: { default: null },
        // Set by the resize handle; a plain Markdown image has no width.
        width: {
          default: null,
          parseHTML: (el) => parseImageWidth(el.getAttribute("width")),
        },
      };
    },

    parseHTML() {
      return [{ tag: "img[src]" }];
    },

    renderHTML({ HTMLAttributes }) {
      const attrs = { ...HTMLAttributes };
      return [
        "img",
        {
          ...attrs,
          src: toServedSrc(projectId, attrs.src),
          class: "doc-image",
          loading: "lazy",
        },
      ];
    },

    addStorage() {
      return {
        markdown: {
          serialize(state, node) {
            state.write(serializeImageMarkdown(node.attrs));
          },
        },
      };
    },

    addNodeView() {
      return ({ node, getPos, editor }) => {
        const wrapper = document.createElement("span");
        wrapper.className = "image-node";

        const img = document.createElement("img");
        img.className = "doc-image";
        img.draggable = true;
        img.setAttribute("loading", "lazy");

        const missing = document.createElement("span");
        missing.className = "image-missing";

        const reset = document.createElement("span");
        reset.className = "image-reset";
        reset.title = "Reset to the picture's natural size";
        reset.setAttribute("role", "button");
        reset.textContent = "↺";

        const handle = document.createElement("span");
        handle.className = "image-resize-handle";
        handle.title = "Drag to resize";
        handle.setAttribute("role", "button");

        wrapper.append(img, missing, reset, handle);

        const apply = (next) => {
          const src = toServedSrc(projectId, next.attrs.src);
          img.setAttribute("src", src || "");
          img.setAttribute("alt", next.attrs.alt || "");
          if (next.attrs.title) img.setAttribute("title", next.attrs.title);
          else img.removeAttribute("title");
          const width = parseImageWidth(next.attrs.width);
          if (width) {
            img.style.width = `${width}px`;
            img.style.height = "auto";
          } else {
            img.style.width = "";
            img.style.height = "";
          }
          wrapper.classList.toggle("can-reset", !!width);
          wrapper.classList.remove("missing", "resizing");
        };
        apply(node);

        img.addEventListener("error", () => {
          missing.textContent = node.attrs.src ? `Missing image: ${node.attrs.src}` : "Missing image";
          wrapper.classList.add("missing");
        });

        const currentAttrs = () => {
          const pos = getPos();
          if (pos == null) return null;
          const found = editor.state.doc.nodeAt(pos);
          if (!found || found.type.name !== "image") return null;
          return { pos, attrs: found.attrs };
        };

        const onReset = (event) => {
          event.preventDefault();
          event.stopPropagation();
          const current = currentAttrs();
          if (!current || current.attrs.width == null) return;
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(current.pos, undefined, { ...current.attrs, width: null })
          );
        };
        reset.addEventListener("mousedown", onReset);
        reset.addEventListener("click", (event) => event.preventDefault());

        const onHandleDown = (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          const startX = event.clientX;
          const box = img.getBoundingClientRect();
          const startWidth = box.width || parseImageWidth(node.attrs.width) || img.naturalWidth || 0;
          const maxWidth = Math.max(40, editor.view.dom.clientWidth);
          let width = startWidth;

          wrapper.classList.add("resizing");
          try {
            handle.setPointerCapture(event.pointerId);
          } catch {
            /* capture is a nicety; the drag still works without it */
          }

          const onMove = (moveEvent) => {
            width = clampImageWidth(startWidth + (moveEvent.clientX - startX), maxWidth);
            img.style.width = `${width}px`;
            img.style.height = "auto";
          };
          const onUp = (upEvent) => {
            handle.removeEventListener("pointermove", onMove);
            handle.removeEventListener("pointerup", onUp);
            handle.removeEventListener("pointercancel", onUp);
            try {
              handle.releasePointerCapture(upEvent.pointerId);
            } catch {
              /* already released */
            }
            wrapper.classList.remove("resizing");
            const current = currentAttrs();
            if (!current) return;
            // A click that never moved must not turn a natural-size picture
            // into an explicitly sized one.
            if (Math.abs(width - startWidth) < 2 && current.attrs.width == null) return;
            const next = clampImageWidth(width, maxWidth);
            if (next === current.attrs.width && next === width) return;
            if (current.attrs.width === next) return;
            editor.view.dispatch(
              editor.state.tr.setNodeMarkup(current.pos, undefined, { ...current.attrs, width: next })
            );
          };
          handle.addEventListener("pointermove", onMove);
          handle.addEventListener("pointerup", onUp);
          handle.addEventListener("pointercancel", onUp);
        };
        handle.addEventListener("mousedown", (event) => event.preventDefault());
        handle.addEventListener("pointerdown", onHandleDown);

        img.addEventListener("dblclick", (event) => {
          if (!onOpenImage) return;
          event.preventDefault();
          onOpenImage({
            src: node.attrs.src,
            url: toServedSrc(projectId, node.attrs.src),
            alt: node.attrs.alt || "",
          });
        });

        return {
          dom: wrapper,
          // Only the controls swallow events; clicks on the picture itself
          // must still place the caret like any other inline node.
          stopEvent: (event) => !!event.target.closest(".image-resize-handle, .image-reset"),
          ignoreMutation: () => true,
          update: (next) => {
            if (next.type.name !== "image") return false;
            apply(next);
            return true;
          },
        };
      };
    },
  });
}

// Where an inline node can legally be inserted: inside a textblock at (or
// adjacent to) the requested position. A drop between two blocks lands at a
// position where an inline node would be invalid.
function inlineInsertPos(view, pos) {
  const doc = view.state.doc;
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);
  if ($pos.parent.inlineContent) return clamped;
  if ($pos.nodeAfter && $pos.nodeAfter.isTextblock) return clamped + 1;
  if ($pos.nodeBefore && $pos.nodeBefore.isTextblock) return clamped - 1;
  let fallback = null;
  doc.descendants((node, nodePos) => {
    if (fallback === null && node.isTextblock) fallback = nodePos + 1;
    return fallback === null;
  });
  return fallback;
}

// Whether a paste slice already carries one of the project's stored pictures
// (an internal copy). The clipboard then holds both that slice and the image
// file Chromium attaches alongside it, and the slice is the better source: it
// keeps the picture's saved width.
function sliceHasStoredImage(slice) {
  if (!slice || !slice.content) return false;
  let found = false;
  slice.content.descendants((node) => {
    if (
      node.type &&
      node.type.name === "image" &&
      String((node.attrs && node.attrs.src) || "").startsWith(ASSET_PREFIX)
    ) {
      found = true;
    }
    return !found;
  });
  return found;
}

async function insertImageFiles(view, files, pos, imageOpts) {
  const wanted = (files || []).filter(isImageFile);
  if (!wanted.length || !imageOpts.uploadImage) return;
  // A picture aimed at a character table's portrait slot replaces whatever is
  // in the slot instead of becoming a second picture next to it.
  const portrait = portraitTargetAt(view.state, pos);
  if (portrait != null) {
    await setPortraitFromFiles(view, portrait, wanted, imageOpts);
    return;
  }
  if (imageOpts.onUploadState) imageOpts.onUploadState(true);
  try {
    let at = pos;
    for (const file of wanted) {
      let info = null;
      try {
        info = await imageOpts.uploadImage(file);
      } catch (err) {
        if (imageOpts.onImageError) {
          imageOpts.onImageError((err && err.message) || String(err));
        }
        continue;
      }
      if (!view || view.isDestroyed || !info || !info.path) continue;
      const type = view.state.schema.nodes.image;
      if (!type) continue;
      const insertAt = inlineInsertPos(view, at);
      if (insertAt == null) continue;
      const node = type.create({
        src: info.path,
        alt: imageAltFromFileName(file.name),
        title: null,
        width: null,
      });
      view.dispatch(view.state.tr.insert(insertAt, node));
      at = insertAt + node.nodeSize;
    }
  } finally {
    if (imageOpts.onUploadState) imageOpts.onUploadState(false);
  }
}

function toMarkdown(editor) {
  let md = editor.storage.markdown.getMarkdown();
  md = md.replace(/\\\[/g, "[").replace(/\\\]/g, "]");
  return md;
}

function makeEditor({ element, content, placeholder, onChange, onWikilinkClick, navWidget, imageOpts }) {
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
      makeAssetImage(imageOpts),
      ...makeTableExtensions(),
      ...makeTaskListExtensions(),
      ...makeInlineMarkExtensions(),
      makeSlashMenuExtension(),
      ...makeCharacterTableNodes(imageOpts),
    ],
    content,
    editorProps: {
      attributes: {},
      // Pictures dropped or pasted into the document. Anything else (moving an
      // existing node, dropping text, pasting text) is left to ProseMirror —
      // returning false is what keeps ordinary drag & drop working.
      handleDrop(view, event) {
        // A drag that started inside the editor — moving a picture or a block
        // of text — belongs to ProseMirror. Chromium puts a dragged <img> into
        // dataTransfer.files as well as into the drag slice, so without this
        // the drop looks exactly like a fresh file drop and the picture ends
        // up *copied* instead of moved. (Ctrl+drag is ProseMirror's copy too.)
        if (view.dragging) return false;
        const dt = event.dataTransfer;
        if (!dt || !dt.files || !dt.files.length) return false;
        const files = Array.from(dt.files);
        if (!files.some(isImageFile)) {
          if (imageOpts.onImageError) {
            imageOpts.onImageError("Only PNG, JPEG, GIF and WebP images can be inserted.");
          }
          return true;
        }
        event.preventDefault();
        // Dropped into the character table's picture slot? Then it fills the
        // slot; otherwise it is placed where it was dropped.
        const slot = event.target && event.target.closest && event.target.closest(".ct-portrait");
        let at = null;
        if (slot) {
          try {
            at = view.posAtDOM(slot, 0);
          } catch {
            at = null;
          }
        }
        if (at == null) {
          let hit = null;
          try {
            hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
          } catch {
            /* no geometry available (e.g. a dropped event without layout) */
          }
          at = hit ? hit.pos : view.state.selection.from;
        }
        insertImageFiles(view, files, at, imageOpts);
        return true;
      },
      handlePaste(view, event, slice) {
        const dt = event.clipboardData;
        if (!dt || !dt.files || !dt.files.length) return false;
        const files = Array.from(dt.files);
        if (!files.some(isImageFile)) return false;
        // A copy from inside the editor carries the picture as a document
        // slice — with its width — alongside the file Chromium attaches to the
        // clipboard. Let ProseMirror paste that instead of re-uploading it.
        if (sliceHasStoredImage(slice)) return false;
        event.preventDefault();
        insertImageFiles(view, files, view.state.selection.from, imageOpts);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      if (onChange) onChange(toMarkdown(editor));
    },
  });

  _grammarView = editor.view;

  editor._grammarClick = (e) => {
    const target = e.target.closest(".grammar-error");
    if (target) {
      e.preventDefault();
      e.stopPropagation();
      _grammarShowTooltip(target);
    }
  };
  editor.view.dom.addEventListener("click", editor._grammarClick);

  if (onWikilinkClick) {
    editor._wikilinkClick = (e) => {
      const target = e.target.closest(".wikilink");
      if (target) {
        e.preventDefault();
        onWikilinkClick(target.getAttribute("data-wikilink"));
      }
    };
    editor.view.dom.addEventListener("click", editor._wikilinkClick);
  }

  return editor;
}

window.LainEditor = {
  create(opts) {
    const navWidget = opts.showNav ? document.createElement("div") : null;
    if (navWidget) navWidget.className = "nav-box";
    const imageOpts = {
      projectId: opts.projectId || null,
      uploadImage: opts.uploadImage || null,
      onImageError: opts.onImageError || null,
      onUploadState: opts.onUploadState || null,
      onOpenImage: opts.onOpenImage || null,
      onPickPortrait: opts.onPickPortrait || null,
    };
    const editor = makeEditor({ ...opts, navWidget, imageOpts });
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
      // A color string (``#rrggbb``) sets the mark; a falsy value clears it.
      setTextColor(color) {
        if (color) editor.chain().focus().setMark("textColor", { color }).run();
        else editor.chain().focus().unsetMark("textColor").run();
      },
      // Grammar decorations share one "active view" slot. A freshly created
      // editor takes it; a cached one reclaims it when it is re-mounted, and
      // its existing decorations (plus the setGrammarEnabled call that follows)
      // keep it in step. The parked editors keep their ProseMirror state,
      // undo history included.
      activate() {
        _grammarView = editor.view;
      },
      deactivate() {
        if (_grammarView === editor.view) {
          clearTimeout(_grammarTimer);
          _grammarHideTooltip();
          _grammarView = null;
        }
      },
      destroy() {
        // Only clear the shared grammar state when this editor owns it, so
        // destroying a parked editor can't blank the active one's state.
        if (_grammarView === editor.view) {
          clearTimeout(_grammarTimer);
          _grammarHideTooltip();
          _grammarView = null;
          _grammarSkipping = false;
          _grammarBusy = false;
          _grammarReplaceRange = null;
          _lastDocOffsets = null;
          _lastDocText = null;
        }
        editor.view.dom.removeEventListener("click", editor._grammarClick);
        if (editor._wikilinkClick) {
          editor.view.dom.removeEventListener("click", editor._wikilinkClick);
        }
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
      // Used by the toolbar's picture button and by a drop that lands on the
      // editor's padding (outside the ProseMirror surface itself): the picture
      // goes in at the caret.
      async insertImage(file) {
        const files = Array.isArray(file) ? file : [file];
        await insertImageFiles(
          editor.view,
          files.filter(isImageFile),
          editor.state.selection.from,
          imageOpts
        );
      },
      // The ribbon's character-table button: a right-hand info box, inserted
      // after the block the caret is in (never inside another box).
      insertCharacterTable(options) {
        return insertCharacterTableAt(editor, options || {});
      },
      // Fills a character table's picture slot, used by the click-to-choose
      // picker and by a drop on the slot.
      async setPortrait(pos, files) {
        const list = Array.isArray(files) ? files : [files];
        return setPortraitFromFiles(editor.view, pos, list, imageOpts);
      },
      setGrammarEnabled(enabled) {
        editor.view.dispatch(editor.state.tr.setMeta("grammarEnabled", !!enabled));
        if (enabled) _grammarSchedule(editor.view);
      },
      setDictionaryWords(words) {
        _grammarDictionaryWords = Array.isArray(words) ? words : [];
        if (_grammarView === editor.view && !editor.view.isDestroyed) {
          editor.view.dispatch(editor.view.state.tr.setMeta("forceGrammar", true));
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
        else if (command === "table") {
          chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true });
        }
        else if (command === "taskList") chain.toggleTaskList();
        else if (command === "highlight") chain.toggleHighlight();
        else if (command === "subscript") chain.toggleSubscript();
        else if (command === "superscript") chain.toggleSuperscript();
        else if (command === "h1") chain.toggleHeading({ level: 1 });
        else if (command === "h2") chain.toggleHeading({ level: 2 });
        else if (command === "h3") chain.toggleHeading({ level: 3 });
        else return;
        chain.run();
      },
    };
  },
};
