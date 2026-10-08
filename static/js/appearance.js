// Appearance overrides applied on top of the theme.
//
// A theme already decides color, shape and type (see static/css/themes.css).
// These are the user's extra knobs, stored in settings.json and translated
// into body attributes / CSS variables by applyAppearance(). The pure helpers
// are exported so they can be unit tested without a DOM.

export const APPEARANCE_DEFAULTS = {
  accentColor: "",
  cornerStyle: "default",
  uiFont: "",
  texturesEnabled: true,
  reducedMotion: false,
  editorWidth: "medium",
};

// Which settings keys this module owns, so callers can filter a patch.
export const APPEARANCE_KEYS = Object.keys(APPEARANCE_DEFAULTS);

export const CORNER_STYLES = [
  { id: "default", label: "Theme default" },
  { id: "rounded", label: "Rounded" },
  { id: "sharp", label: "Sharp" },
];

export const EDITOR_WIDTHS = [
  { id: "narrow", label: "Narrow", px: 620 },
  { id: "medium", label: "Medium", px: 760 },
  { id: "wide", label: "Wide", px: 960 },
];

export const UI_FONTS = [
  { id: "", label: "Theme default", stack: "" },
  {
    id: "system",
    label: "System (Segoe UI)",
    stack: '"Segoe UI", system-ui, -apple-system, sans-serif',
  },
  {
    id: "serif",
    label: "Serif (Georgia)",
    stack: 'Georgia, "Times New Roman", serif',
  },
  {
    id: "sans",
    label: "Sans (Arial)",
    stack: "Arial, Helvetica, sans-serif",
  },
  {
    id: "mono",
    label: "Monospace",
    stack: '"Cascadia Code", Consolas, "Courier New", monospace',
  },
];

/** The CSS pixel width of the Write column for a stored width id. */
export function editorWidthPx(id) {
  const w = EDITOR_WIDTHS.find((x) => x.id === id);
  return (w || EDITOR_WIDTHS[1]).px;
}

/** The font stack for a stored UI-font id ("" = let the theme decide). */
export function uiFontStack(id) {
  const f = UI_FONTS.find((x) => x.id === id);
  return (f && f.stack) || "";
}

/** Take only the appearance keys out of a settings object. */
export function pickAppearance(settings) {
  const out = {};
  const s = settings || {};
  for (const key of APPEARANCE_KEYS) {
    if (s[key] !== undefined && s[key] !== null) out[key] = s[key];
  }
  return out;
}

/**
 * Apply appearance settings to *target* (normally document.body). Unknown
 * fields are ignored; anything missing falls back to the built-in default.
 */
export function applyAppearance(target, settings) {
  if (!target) return;
  const s = { ...APPEARANCE_DEFAULTS, ...pickAppearance(settings) };

  // Accent: inline, because it must win over the theme block. The
  // body[data-accent] rule derives the soft/selection tints from it.
  const accent = String(s.accentColor || "").trim();
  if (accent) {
    target.style.setProperty("--accent", accent);
    target.dataset.accent = "";
  } else {
    target.style.removeProperty("--accent");
    delete target.dataset.accent;
  }

  // Corners: an attribute only for the explicit styles; "default" leaves the
  // radius to the theme.
  if (s.cornerStyle && s.cornerStyle !== "default") {
    target.dataset.corners = s.cornerStyle;
  } else {
    delete target.dataset.corners;
  }

  const ui = uiFontStack(s.uiFont);
  if (ui) target.style.setProperty("--font-ui", ui);
  else target.style.removeProperty("--font-ui");

  target.classList.toggle("no-texture", s.texturesEnabled === false);
  target.classList.toggle("reduced-motion", s.reducedMotion === true);

  target.style.setProperty("--editor-max-width", `${editorWidthPx(s.editorWidth)}px`);
}
