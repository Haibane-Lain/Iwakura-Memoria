// A tiny registry so global UI (the About/update panel) can ask the project
// workspace to flush unsaved edits before doing something disruptive.
//
// project.js registers the workspace's flushSave() at module load; when no
// project is open the registered function is a no-op because the pane list is
// empty. Keeping this in its own module avoids about.js importing project.js.

let flushFn = null;

export function registerSaveFlush(fn) {
  flushFn = typeof fn === "function" ? fn : null;
}

export function clearSaveFlush(fn) {
  if (flushFn === fn) flushFn = null;
}

export async function flushAllSaves() {
  if (!flushFn) return;
  await flushFn();
}

export function hasSaveFlush() {
  return Boolean(flushFn);
}
