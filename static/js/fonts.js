export const FONTS = [
  { id: "serif", label: "Georgia", stack: 'Georgia, Cambria, "Times New Roman", "Songti SC", "SimSun", serif' },
  { id: "times", label: "Times New Roman", stack: '"Times New Roman", Times, "Songti SC", "SimSun", serif' },
  { id: "garamond", label: "Garamond", stack: 'Garamond, "EB Garamond", Georgia, serif' },
  { id: "palatino", label: "Palatino", stack: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif' },
  { id: "sans", label: "Sans-serif (Segoe UI)", stack: '"Segoe UI", "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif' },
  { id: "arial", label: "Arial", stack: 'Arial, Helvetica, "Helvetica Neue", sans-serif' },
  { id: "helvetica", label: "Helvetica", stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: "verdana", label: "Verdana", stack: 'Verdana, Geneva, "DejaVu Sans", sans-serif' },
  { id: "typewriter", label: "Typewriter (Courier New)", stack: '"Courier New", Courier, "Noto Sans Mono", monospace' },
  { id: "consolas", label: "Consolas", stack: 'Consolas, "Courier New", "Noto Sans Mono", monospace' },
  { id: "comic", label: "Comic Sans", stack: '"Comic Sans MS", "Comic Sans", cursive' },
];

export const CUSTOM_ID = "__custom__";

export function customName(value) {
  if (value && FONTS.some((f) => f.id === value)) return "";
  return (value || "").trim();
}

export function fontStack(value) {
  const preset = FONTS.find((f) => f.id === value);
  if (preset) return preset.stack;
  const name = (value || "").trim();
  if (name) {
    const needsQuote = /\s/.test(name) || /[^A-Za-z0-9 _-]/.test(name);
    const fam = needsQuote ? `"${name}"` : name;
    return `${fam}, Georgia, "Times New Roman", serif`;
  }
  return FONTS[0].stack;
}

export function labelFor(value) {
  const preset = FONTS.find((f) => f.id === value);
  if (preset) return preset.label;
  if (value && value.trim()) return value;
  return FONTS[0].label;
}
