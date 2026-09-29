// The Language panel: every grammar and style issue found in the focused
// document, listed in reading order so a whole chapter can be reviewed at once
// instead of one squiggle at a time. The list is fed by the editor's grammar
// plugin (see editor-entry.js), so it can never disagree with the underlines.
//
// It docks to the right of the editor by default and can be undocked into a
// floating window; the mode, width and position are remembered per machine.
//
// A leaf module like comments-panel.js: it owns the list UI and drives the
// editor through the pane's controller, and never imports project.js.
import { el } from "./ui.js";

const LS_DOCKED = "im.language.docked";
const LS_WIDTH = "im.language.width";
const LS_POS = "im.language.pos";
const MIN_WIDTH = 240;
const DEFAULT_WIDTH = 320;
const SEVERITIES = ["error", "warning", "style"];
const SEVERITY_LABEL = { error: "Errors", warning: "Warnings", style: "Style" };
// How many replacement chips an item offers before the rest are dropped. A
// misspelling can carry dozens; three keeps the row scannable.
const MAX_REPS = 3;

function readBool(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function readInt(key, fallback) {
  try {
    const raw = parseInt(localStorage.getItem(key) || "", 10);
    return Number.isFinite(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

function readPos() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_POS) || "null");
    if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) return raw;
  } catch {
    /* ignore */
  }
  return null;
}

// The text a match covers, read from its context window rather than an offset
// that has since drifted. Keeping this is what lets the panel still find a hit
// after the writer edits above it.
function flaggedText(match) {
  const text = match.context_text || "";
  const offset = match.context_offset || 0;
  const length = match.length || 0;
  if (!text || length <= 0) return "";
  return text.slice(offset, offset + length);
}

export function grammarPanel({ pane, isEnabled, onCount, onAddWord, onClose }) {
  const panel = el("div", { class: "side-panel language-panel" });
  const resize = el("div", {
    class: "language-resize",
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize Language panel",
    title: "Drag to resize",
  });

  let entries = [];
  let filter = "all";
  let activeIndex = -1;
  let stale = false;
  let docked = readBool(LS_DOCKED, true);
  let width = Math.max(MIN_WIDTH, readInt(LS_WIDTH, DEFAULT_WIDTH));
  let pos = readPos();

  const ctrl = () => (pane ? pane.ctrl : null);

  /* ---------------- geometry ---------------- */

  function applyWidth() {
    panel.style.setProperty("--language-w", `${width}px`);
  }

  function applyPos() {
    if (docked) {
      panel.style.removeProperty("left");
      panel.style.removeProperty("top");
      return;
    }
    if (!pos) pos = { x: Math.max(8, window.innerWidth - width - 24), y: 72 };
    // offsetWidth is 0 while the panel is display:none, so fall back to the
    // remembered width; otherwise a reload would clamp it off the right edge.
    const maxX = Math.max(8, window.innerWidth - (panel.offsetWidth || width) - 8);
    const maxY = Math.max(8, window.innerHeight - 96);
    pos = {
      x: Math.min(Math.max(8, pos.x), maxX),
      y: Math.min(Math.max(8, pos.y), maxY),
    };
    panel.style.left = `${pos.x}px`;
    panel.style.top = `${pos.y}px`;
  }

  function saveGeometry() {
    try {
      localStorage.setItem(LS_DOCKED, docked ? "1" : "0");
      localStorage.setItem(LS_WIDTH, String(width));
      localStorage.setItem(LS_POS, JSON.stringify(pos));
    } catch {
      /* private mode / quota — geometry is a convenience */
    }
  }

  function setDocked(next, persist = true) {
    docked = !!next;
    panel.classList.toggle("docked", docked);
    panel.classList.toggle("floating", !docked);
    if (!docked && !pos) pos = { x: Math.max(8, window.innerWidth - width - 24), y: 72 };
    applyWidth();
    applyPos();
    if (persist) saveGeometry();
  }

  function initResize() {
    let dragging = false;
    let startX = 0;
    let startW = 0;
    let startLeft = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const delta = startX - e.clientX; // dragging the left edge left grows it
      width = Math.max(MIN_WIDTH, Math.min(startW + delta, window.innerWidth - 40));
      if (!docked) pos = { x: startLeft - (width - startW), y: pos.y };
      applyWidth();
      applyPos();
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      if (resize.hasPointerCapture && resize.hasPointerCapture(e.pointerId)) {
        resize.releasePointerCapture(e.pointerId);
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      saveGeometry();
    };
    resize.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width || width;
      startLeft = pos ? pos.x : 0;
      if (resize.setPointerCapture) resize.setPointerCapture(e.pointerId);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  // Floating only: drag the header to move the panel. Attached to the panel so
  // it survives the re-rendered header, but only the header starts a drag.
  function initDrag() {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startPos = { x: 0, y: 0 };

    const onMove = (e) => {
      if (!dragging) return;
      pos = { x: startPos.x + (e.clientX - startX), y: startPos.y + (e.clientY - startY) };
      applyPos();
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      if (panel.hasPointerCapture && panel.hasPointerCapture(e.pointerId)) {
        panel.releasePointerCapture(e.pointerId);
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      saveGeometry();
    };
    panel.addEventListener("pointerdown", (e) => {
      if (docked) return;
      if (e.button != null && e.button !== 0) return;
      if (!e.target.closest(".language-head")) return;
      if (e.target.closest("button")) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startPos = pos || { x: 0, y: 0 };
      if (panel.setPointerCapture) panel.setPointerCapture(e.pointerId);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  /* ---------------- locating an issue in the live document ---------------- */

  function findText(doc, text, around) {
    if (!text) return null;
    let first = null;
    let preferred = null;
    doc.descendants((node, nodePos) => {
      if (!node.isTextblock) return true;
      const content = node.textContent;
      let index = content.indexOf(text);
      while (index >= 0) {
        const hit = { from: nodePos + 1 + index, to: nodePos + 1 + index + text.length };
        if (!first) first = hit;
        if (
          !preferred &&
          Number.isFinite(around) &&
          hit.from <= around + 200 &&
          hit.to >= around - 200
        ) {
          preferred = hit;
        }
        index = content.indexOf(text, index + 1);
      }
      return true;
    });
    return preferred || first;
  }

  // Prefer the offsets captured at check time (still exact unless the writer
  // typed in between); otherwise re-find the flagged text near where it was.
  function locate(entry) {
    const controller = ctrl();
    if (!controller) return null;
    const editor = controller.editor;
    const doc = editor.state.doc;
    const size = doc.content.size;
    const expected = flaggedText(entry.match);
    const { from, to } = entry;
    if (Number.isFinite(from) && from >= 0 && to <= size && to > from) {
      let stillMatches = true;
      if (expected && typeof doc.textBetween === "function") {
        stillMatches = doc.textBetween(from, to, "") === expected;
      }
      if (stillMatches) return { from, to };
    }
    return findText(doc, expected, from);
  }

  /* ---------------- actions ---------------- */

  function reveal(index, entry) {
    activeIndex = index;
    const controller = ctrl();
    const target = locate(entry);
    if (controller && controller.revealRange && target) {
      controller.revealRange(target.from, target.to);
    }
    render();
  }

  function apply(entry, value) {
    const controller = ctrl();
    const target = controller && controller.applyGrammarReplacement ? locate(entry) : null;
    if (!controller || !target) return;
    controller.applyGrammarReplacement(target.from, target.to, value);
    stale = true;
    render();
  }

  function addWord(entry) {
    const word = flaggedText(entry.match).trim();
    if (word && onAddWord) onAddWord(word);
  }

  /* ---------------- rendering ---------------- */

  function counts() {
    const out = { all: entries.length, error: 0, warning: 0, style: 0 };
    for (const entry of entries) {
      const severity = entry.match.severity || "error";
      if (out[severity] != null) out[severity] += 1;
    }
    return out;
  }

  function visible() {
    if (filter === "all") return entries;
    return entries.filter((entry) => (entry.match.severity || "error") === filter);
  }

  function notify() {
    if (onCount) onCount(entries.length);
  }

  function metaEl(match) {
    const bits = [match.category, match.rule_description].filter(Boolean);
    if (!bits.length) return null;
    return el("div", { class: "language-item-meta", title: match.rule_url || "" }, bits.join(" · "));
  }

  function itemEl(entry, index) {
    const match = entry.match || {};
    const severity = match.severity || "error";
    const text = flaggedText(match);
    const classes =
      `language-item severity-${severity}` + (index === activeIndex ? " active" : "");
    const item = el("div", { class: classes }, [
      el("div", { class: "language-item-top" }, [
        el("span", { class: `language-dot severity-${severity}` }),
        el("span", { class: "language-flag" }, text || "(text changed)"),
      ]),
      el("div", { class: "language-msg" }, match.message || match.short_message || ""),
      metaEl(match),
      actionsEl(entry, match),
    ]);
    item.addEventListener("click", () => reveal(index, entry));
    return item;
  }

  function actionsEl(entry, match) {
    const children = [];
    for (const rep of (match.replacements || []).filter(Boolean).slice(0, MAX_REPS)) {
      const chip = el("button", {
        class: "language-rep",
        title: `Replace with “${rep}”`,
      }, rep);
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        apply(entry, rep);
      });
      children.push(chip);
    }
    const word = flaggedText(match);
    if (word.length > 1 && onAddWord) {
      const add = el("button", {
        class: "language-rep ghost",
        title: `Add “${word}” to the project spelling list`,
      }, "In spelling");
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        addWord(entry);
      });
      children.push(add);
    }
    return children.length ? el("div", { class: "language-actions" }, children) : null;
  }

  function filtersEl() {
    const tally = counts();
    const make = (key, label) => {
      const button = el("button", {
        class: "language-filter" + (filter === key ? " active" : ""),
        "data-severity": key,
      }, `${label} ${tally[key] ?? 0}`);
      button.addEventListener("click", () => {
        filter = key;
        render();
      });
      return button;
    };
    return el("div", { class: "language-filters" }, [
      make("all", "All"),
      ...SEVERITIES.map((severity) => make(severity, SEVERITY_LABEL[severity])),
    ]);
  }

  function headEl() {
    const dock = el("button", {
      class: "mini-btn language-dock",
      title: docked ? "Undock panel" : "Dock to the right",
    }, docked ? "⤢" : "⤡");
    dock.addEventListener("click", (e) => {
      e.stopPropagation();
      setDocked(!docked);
      render();
    });
    const close = el("button", { class: "mini-btn", title: "Close" }, "✕");
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      if (onClose) onClose();
    });
    return el("div", { class: "panel-head language-head" }, [
      el("span", { class: "panel-title" }, "Language"),
      el("span", { class: "language-total" }, String(entries.length)),
      el("span", { class: "panel-head-spacer" }),
      dock,
      close,
    ]);
  }

  function bodyEl() {
    if (isEnabled && !isEnabled()) {
      return [el("p", { class: "empty-hint" }, "Grammar check is off. Turn it on in the ribbon.")];
    }
    if (!ctrl()) {
      return [el("p", { class: "empty-hint" }, "Open a document to review its language.")];
    }
    if (!entries.length) {
      return [
        el("p", { class: "empty-hint" }, stale ? "Checking…" : "No issues found here."),
      ];
    }
    const children = [filtersEl()];
    if (stale) children.push(el("div", { class: "language-stale" }, "Document changed — checking…"));
    const shown = visible();
    const list = shown.length
      ? el("div", { class: "language-list" }, shown.map((entry) => itemEl(entry, entries.indexOf(entry))))
      : el("p", { class: "empty-hint" }, `No ${SEVERITY_LABEL[filter]?.toLowerCase() || "matching"} issues.`);
    children.push(list);
    return children;
  }

  function render() {
    const children = [resize, headEl(), ...bodyEl()];
    panel.replaceChildren(...children);
  }

  panel._render = render;
  panel._counts = counts;
  panel.setResults = (payload) => {
    entries = payload && Array.isArray(payload.matches) ? payload.matches : [];
    stale = false;
    activeIndex = -1;
    render();
    notify();
  };
  panel.markStale = () => {
    if (stale) return;
    stale = true;
    if (panel.classList.contains("open")) render();
  };
  panel.openPanel = () => {
    panel.classList.add("open");
    render();
  };
  panel.closePanel = () => panel.classList.remove("open");

  setDocked(docked, false);
  initResize();
  initDrag();
  return panel;
}
