// Keeping a list's scroll position across a re-render.
//
// Replacing the children of a scrolled container makes Chromium re-pick its
// scroll anchor and nudge the offset, even when the list comes back with the
// same rows in the same places. Measured on the wiki sidebar of a real library
// (123 rows, 621px tall): identical content, no layout change, and the offset
// still moved +21px from 543 and from 1000, +63px from 2000 — while a shorter
// list that does not scroll stayed put, and a plain `replaceChildren` of cloned
// nodes reproduced it with no app code involved. On a long list that reads as
// the sidebar sliding when an entry is opened, which is what makes navigation
// jarring.
//
// So a re-render that is only moving a highlight keeps the offset: `render` is
// run, and the previous offset is restored if the browser moved it. `keep`
// stays false for re-renders that really change the list (expanding a folder, a
// search filter) so those keep the browser's own anchoring behaviour.

/**
 * Run `render` and hold `container`'s scroll position across it.
 *
 * @param {HTMLElement} container scroll container being re-rendered
 * @param {() => void} render the re-render itself
 * @param {boolean} keep false to leave the browser's own anchoring alone
 */
export function keepScrollTop(container, render, keep = true) {
  const before = keep ? container.scrollTop : 0;
  render();
  if (keep && container.scrollTop !== before) container.scrollTop = before;
}
