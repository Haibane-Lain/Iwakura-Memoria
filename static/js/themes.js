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

let current = "paper";

export function apply(name) {
  if (!themes.some((t) => t.id === name)) name = "paper";
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
  } catch (err) {
    return { theme: "paper" };
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
