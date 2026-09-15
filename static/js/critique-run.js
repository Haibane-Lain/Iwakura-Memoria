// The background critique pass. Lain reviews one or more entries and proposes
// anchored comments; the run applies them without opening the Lain panel and
// without asking the user to confirm each note.
//
// This module is deliberately free of DOM and api imports so the run/accept
// loop is unit-testable: lain.js injects the `chat` and `confirm` calls (see
// `runCritique` there) and project.js triggers it from the Review ribbon.

// The brief the Critique button sends. It targets prose craft — the app already
// has a grammar/spelling checker, so the notes cover what that cannot see. The
// opening line doubles as the session title (the server titles a session from
// the first 40 characters of its first message).
export const CRITIQUE_PROMPT =
  "Line-edit the selected entries for grammar, sentence structure and flow.\n\n" +
  "The app already flags spelling and basic grammar, so focus on what a checker " +
  "cannot see: sentence structure and variety, rhythm and pacing, clarity, " +
  "wordiness, weak or repeated words, and how smoothly sentences and paragraphs " +
  "flow into one another. Stay off plot, characters and story ideas.\n\n" +
  "Use the add_comment tool: for each issue, quote a short, exact, contiguous " +
  "span of the entry's plain text (copied verbatim, without formatting markers) " +
  "and give a concise note that names the problem and suggests the fix. Aim for " +
  "3-8 notes per entry, most important first. Do not rewrite the prose — " +
  "describe the change in the note.";

// The most confirm rounds one pass may take. Each round accepts the pending
// note plus every note deferred from the same model reply, so a normal run
// settles after a single round; the cap only stops a runaway loop.
export const MAX_CRITIQUE_ROUNDS = 8;

// Drive one critique turn to completion.
//
//   chat(payload)      -> { pending, actions }   start the turn
//   confirm(decision)  -> { pending, actions }   resolve a pending action
//
// Accepts every proposal with `confirm_all` (which also applies the notes the
// model deferred in the same reply) and returns the applied actions, the number
// of comments that landed, and whether the session settled.
export async function runCritiquePass({
  chat,
  confirm,
  payload,
  maxRounds = MAX_CRITIQUE_ROUNDS,
}) {
  let resp = await chat(payload);
  const actions = [...((resp && resp.actions) || [])];
  let rounds = 0;
  while (resp && resp.pending && rounds < maxRounds) {
    rounds += 1;
    resp = await confirm("confirm_all");
    actions.push(...((resp && resp.actions) || []));
  }
  const comments = actions.filter(
    (a) => a && a.tool === "add_comment" && a.ok !== false
  ).length;
  return { actions, comments, settled: !(resp && resp.pending) };
}
