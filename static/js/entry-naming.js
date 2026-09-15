// Naming a freshly created entry in the sidebar tree.
//
// A new chapter/note/entry is created as UNTITLED and the user types its real
// name straight into the tree row. These are the pure commit rules, kept out of
// project.js so they can be unit tested.

export const UNTITLED = "Untitled";

/**
 * The title to save when the user commits the inline name field.
 *
 * Returns null when there is nothing to do: an empty/whitespace draft (keep the
 * placeholder) or a draft identical to the current title (nothing changed).
 *
 * @param {string} draft the text in the field
 * @param {string} current the entry's current title
 * @returns {string|null}
 */
export function renameTarget(draft, current) {
  const next = String(draft ?? "").trim();
  if (!next || next === current) return null;
  return next;
}
