// Unit test for the background critique run: it must drive the turn to
// completion, auto-accepting every proposal, and report how many comments
// landed. The module is pure (no DOM, no api), so `chat`/`confirm` are fakes.
//
// Run: node tests/critique-run.test.mjs  (or `npm run test:critiquerun`)
import assert from "node:assert/strict";

import {
  CRITIQUE_PROMPT,
  MAX_CRITIQUE_ROUNDS,
  runCritiquePass,
} from "../static/js/critique-run.js";

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      ${err && err.message}`);
  }
}

await check("the prompt targets prose craft, not story", () => {
  assert.match(CRITIQUE_PROMPT, /grammar/i);
  assert.match(CRITIQUE_PROMPT, /sentence structure/i);
  assert.match(CRITIQUE_PROMPT, /flow/i);
  assert.match(CRITIQUE_PROMPT, /add_comment/);
  // Told to leave plot/characters alone, and no longer a developmental edit.
  assert.match(CRITIQUE_PROMPT, /plot/i);
  assert.doesNotMatch(CRITIQUE_PROMPT, /developmental editor/i);
});

await check("a settled turn with no proposals reports nothing", async () => {
  const calls = [];
  const result = await runCritiquePass({
    chat: async (payload) => {
      calls.push(payload);
      return { pending: null, actions: [] };
    },
    confirm: async () => {
      throw new Error("confirm should not be called");
    },
    payload: { message: CRITIQUE_PROMPT, selectedEntries: ["a"] },
  });
  assert.equal(result.comments, 0);
  assert.equal(result.settled, true);
  assert.deepEqual(result.actions, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message, CRITIQUE_PROMPT);
});

await check("a pending proposal is accepted with confirm_all", async () => {
  const decisions = [];
  const result = await runCritiquePass({
    chat: async () => ({ pending: { tool: "add_comment" }, actions: [] }),
    confirm: async (decision) => {
      decisions.push(decision);
      return { pending: null, actions: [{ tool: "add_comment", ok: true, summary: "c1" }] };
    },
    payload: {},
  });
  assert.deepEqual(decisions, ["confirm_all"]);
  assert.equal(result.comments, 1);
  assert.equal(result.settled, true);
});

await check("actions already returned by chat are counted", async () => {
  const result = await runCritiquePass({
    chat: async () => ({
      pending: null,
      actions: [
        { tool: "add_comment", ok: true },
        { tool: "edit_entry", ok: true },
      ],
    }),
    confirm: async () => ({}),
    payload: {},
  });
  assert.equal(result.comments, 1, "only add_comment actions count");
});

await check("a failed comment action is not counted", async () => {
  const result = await runCritiquePass({
    chat: async () => ({ pending: null, actions: [{ tool: "add_comment", ok: false }] }),
    confirm: async () => ({}),
    payload: {},
  });
  assert.equal(result.comments, 0);
});

await check("the loop stops at maxRounds and reports the turn as unsettled", async () => {
  let confirms = 0;
  const result = await runCritiquePass({
    chat: async () => ({ pending: { tool: "add_comment" }, actions: [] }),
    confirm: async () => {
      confirms += 1;
      return { pending: { tool: "add_comment" }, actions: [] };
    },
    payload: {},
    maxRounds: 3,
  });
  assert.equal(confirms, 3);
  assert.equal(result.settled, false);
  assert.equal(result.comments, 0);
});

await check("MAX_CRITIQUE_ROUNDS is a sane positive cap", () => {
  assert.ok(Number.isInteger(MAX_CRITIQUE_ROUNDS) && MAX_CRITIQUE_ROUNDS > 0);
});

if (failures) {
  console.log(`critique-run: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("critique-run: all checks passed");
