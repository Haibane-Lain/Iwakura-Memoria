// Latest-task tokens for long-running async UI actions.
//
// Opening a document or switching a tab can be started again before the first
// run finishes. The newest start should win, but a plain boolean guard is the
// wrong shape: dropping the newer run would leave the UI on the *older* request
// (click chapter A, then B, and the early return keeps A). Instead the site
// takes a token per start and, after each `await`, stops if a newer start has
// superseded it — so stale runs never touch shared state and the last click
// always wins.
//
// The arithmetic is pure, so it is unit-tested on its own (tests/latest-task).

/**
 * A monotonic "which start is newest" token.
 *
 * @returns {{ begin: () => number, isCurrent: (token: number) => boolean }}
 */
export function createLatestTask() {
  let seq = 0;
  return {
    /** Start a run and return its token. */
    begin() {
      return ++seq;
    },
    /** True while `token` is still the newest run. */
    isCurrent(token) {
      return token === seq;
    },
  };
}
