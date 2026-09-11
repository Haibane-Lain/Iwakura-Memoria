import { api } from "./api.js";

export const themes = [
  { id: "paper", label: "Paper" },
  { id: "ink", label: "Ink" },
  { id: "typewriter", label: "Typewriter" },
  { id: "gothic", label: "Gothic" },
  { id: "horror", label: "Horror" },
  { id: "fantasy", label: "Fantasy" },
  { id: "sci-fi", label: "Sci-Fi" },
];

// First launch only — a stored theme always wins. Kept in step with
// DEFAULT_SETTINGS["theme"] in app/config.py and the data-theme in index.html
// (which paints before this module loads).
export const DEFAULT_THEME = "gothic";

let current = DEFAULT_THEME;

export function apply(name) {
  if (!themes.some((t) => t.id === name)) name = DEFAULT_THEME;
  current = name;
  document.body.dataset.theme = name;
}

export function getCurrent() {
  return current;
}

export async function setTheme(name) {
  apply(name);
  try {
    await api.settings.update({ theme: name });
  } catch (err) {
    console.error("Failed to save theme", err);
  }
}

export async function load() {
  try {
    const settings = await api.settings.get();
    apply(settings.theme);
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
