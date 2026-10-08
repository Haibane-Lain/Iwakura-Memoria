import { api } from "./api.js";
import { el } from "./ui.js";
import {
  APPEARANCE_DEFAULTS,
  applyAppearance,
  pickAppearance,
} from "./appearance.js";

// A theme's `kind` is only used to label and sort the picker; the palette
// itself lives in static/css/themes.css.
export const themes = [
  { id: "paper", label: "Paper", kind: "light" },
  { id: "ink", label: "Ink", kind: "dark" },
  { id: "typewriter", label: "Typewriter", kind: "light" },
  { id: "gothic", label: "Gothic", kind: "dark" },
  { id: "horror", label: "Horror", kind: "dark" },
  { id: "fantasy", label: "Fantasy", kind: "light" },
  { id: "sci-fi", label: "Sci-Fi", kind: "dark" },
  { id: "sepia", label: "Sepia", kind: "light" },
  { id: "vellum", label: "Vellum", kind: "light" },
  { id: "terminal", label: "Terminal", kind: "dark" },
  { id: "noir", label: "Noir", kind: "dark" },
];

// First launch only — a stored theme always wins. Kept in step with
// DEFAULT_SETTINGS["theme"] in app/config.py and the data-theme in index.html
// (which paints before this module loads).
export const DEFAULT_THEME = "gothic";

let current = DEFAULT_THEME;
let appearance = { ...APPEARANCE_DEFAULTS };

export function apply(name) {
  if (!themes.some((t) => t.id === name)) name = DEFAULT_THEME;
  current = name;
  document.body.dataset.theme = name;
}

export function getCurrent() {
  return current;
}

export function getAppearance() {
  return { ...appearance };
}

export async function setTheme(name) {
  apply(name);
  try {
    await api.settings.update({ theme: name });
  } catch (err) {
    console.error("Failed to save theme", err);
  }
}

// The full theme + appearance layer for a settings payload. Called at boot and
// whenever settings are (re)read, so a partial payload never resets the rest.
export function applySettings(settings) {
  appearance = { ...APPEARANCE_DEFAULTS, ...pickAppearance(settings) };
  applyAppearance(document.body, appearance);
}

export async function setAppearance(patch) {
  previewAppearance(patch);
  try {
    await api.settings.update(appearance);
  } catch (err) {
    console.error("Failed to save appearance", err);
  }
}

// Apply without persisting — for live feedback while dragging a color picker.
export function previewAppearance(patch) {
  appearance = { ...appearance, ...pickAppearance(patch) };
  applyAppearance(document.body, appearance);
}

export async function load() {
  try {
    const settings = await api.settings.get();
    apply(settings.theme);
    applySettings(settings);
    return settings;
  } catch {
    return { theme: DEFAULT_THEME };
  }
}

export function themeSelect(onChange) {
  const select = document.createElement("select");
  select.className = "select-mini";
  for (const t of themes) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.label;
    select.append(opt);
  }
  select.value = current;
  select.addEventListener("change", () => {
    setTheme(select.value);
    if (onChange) onChange(select.value);
  });
  return select;
}

// A visual picker: one card per theme, each painting a miniature of the real
// palette through the shared [data-theme] variables, labelled light/dark.
export function themePicker(onChange) {
  const grid = el("div", { class: "theme-grid", role: "radiogroup", "aria-label": "Theme" });

  const pick = async (id) => {
    await setTheme(id);
    render();
    if (onChange) onChange(id);
  };

  const card = (t) =>
    el(
      "button",
      {
        type: "button",
        class: `theme-card${t.id === current ? " active" : ""}`,
        dataset: { themeId: t.id },
        role: "radio",
        "aria-checked": t.id === current ? "true" : "false",
        title: `${t.label} — ${t.kind}`,
        onclick: () => pick(t.id),
      },
      [
        el("span", { class: "theme-thumb", dataset: { theme: t.id } }, [
          el("span", { class: "theme-thumb-bar" }),
          el("span", { class: "theme-thumb-text" }),
          el("span", { class: "theme-thumb-accent" }),
        ]),
        el("span", { class: "theme-card-name" }, t.label),
        el("span", { class: "theme-card-kind" }, t.kind === "dark" ? "Dark" : "Light"),
      ]
    );

  function render() {
    grid.replaceChildren(...themes.map(card));
  }
  render();
  return grid;
}
