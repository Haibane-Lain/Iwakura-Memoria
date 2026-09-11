// jsdom test for the lookup dialog: rendering senses/chips, click-to-replace,
// unknown words, and the "WordNet not installed" message. Drives the leaf
// module directly with a stubbed `/api/lookup`.
//
// Run: node tests/lookup-dialog.test.mjs  (or `npm run test:lookup`)
import assert from "node:assert/strict";

import { JSDOM } from "jsdom";

function defineGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    globalThis[name] = value;
  }
}

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/" });
const w = dom.window;
defineGlobal("window", w);
defineGlobal("document", w.document);
defineGlobal("location", w.location);
defineGlobal("HTMLElement", w.HTMLElement);
defineGlobal("Element", w.Element);
defineGlobal("Node", w.Node);
defineGlobal("Event", w.Event);
defineGlobal("MouseEvent", w.MouseEvent);
defineGlobal("KeyboardEvent", w.KeyboardEvent);

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "",
    headers: { get: () => null },
    async json() {
      return data;
    },
    async blob() {
      return new Blob([]);
    },
  };
}

let payload = { found: false, entries: [] };
let status = 200;
let requests = [];

globalThis.fetch = async (url) => {
  const parsed = new URL(String(url), "http://localhost");
  requests.push(parsed.pathname + parsed.search);
  if (parsed.pathname === "/api/lookup") return jsonResponse(payload, status);
  return jsonResponse({}, 404);
};

const { renderLookupDialog } = await import("../static/js/lookup-dialog.js");

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}\n      ${err.message}`);
  }
}

async function waitFor(predicate, timeout = 1500) {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function closeDialog() {
  document.querySelectorAll(".modal-backdrop.lookup-modal").forEach((node) => node.remove());
}

const GOOD = {
  word: "good",
  headword: "good",
  found: true,
  source: "wordnet",
  entries: [
    {
      pos: "adjective",
      senses: [
        {
          definition: "morally admirable",
          examples: ["a good person"],
          synonyms: ["virtuous", "upright"],
          antonyms: ["bad"],
        },
      ],
    },
  ],
};

await check("renders definitions, examples and synonym/antonym chips", async () => {
  closeDialog();
  payload = GOOD;
  status = 200;
  requests = [];
  renderLookupDialog({ word: "good", onReplace: () => {} });

  await waitFor(() => document.querySelector(".lookup-def"));
  assert.equal(document.querySelector(".lookup-def").textContent, "morally admirable");
  assert.equal(document.querySelector(".lookup-example").textContent, "a good person");
  const chips = [...document.querySelectorAll(".lookup-chip")].map((n) => n.textContent);
  assert.deepEqual(chips, ["virtuous", "upright", "bad"]);
  assert.ok(requests.some((r) => r.startsWith("/api/lookup?word=good")));
});

await check("clicking a chip reports the replacement", async () => {
  closeDialog();
  payload = GOOD;
  status = 200;
  const picks = [];
  renderLookupDialog({ word: "good", onReplace: (from, to) => picks.push([from, to]) });

  await waitFor(() => document.querySelector(".lookup-chip"));
  const antonym = [...document.querySelectorAll(".lookup-chip")].find((n) => n.textContent === "bad");
  antonym.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(picks, [["good", "bad"]]);
});

await check("shows the base form for an inflected lookup", async () => {
  closeDialog();
  payload = { ...GOOD, word: "dogs", headword: "dog" };
  status = 200;
  renderLookupDialog({ word: "dogs", onReplace: () => {} });

  await waitFor(() => document.querySelector(".lookup-headword"));
  assert.match(document.querySelector(".lookup-headword").textContent, /Showing “dog”/);
});

await check("reports a word with no entry", async () => {
  closeDialog();
  payload = { word: "zzzzz", headword: "zzzzz", found: false, entries: [] };
  status = 200;
  renderLookupDialog({ word: "zzzzz", onReplace: () => {} });

  await waitFor(() => document.querySelector(".lookup-empty"));
  assert.match(document.querySelector(".lookup-empty").textContent, /No entry for “zzzzz”/);
});

await check("explains when WordNet is not installed", async () => {
  closeDialog();
  payload = { detail: "WordNet data not installed" };
  status = 503;
  renderLookupDialog({ word: "good", onReplace: () => {} });

  await waitFor(() => document.querySelector(".lookup-status.error"));
  assert.match(document.querySelector(".lookup-status.error").textContent, /WordNet isn't installed/);
});

await check("searching another word reuses the dialog", async () => {
  closeDialog();
  payload = GOOD;
  status = 200;
  requests = [];
  renderLookupDialog({ word: "", onReplace: () => {} });
  const input = document.querySelector(".lookup-input");
  input.value = "good";
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  await waitFor(() => document.querySelector(".lookup-def"));
  assert.ok(requests.some((r) => r.startsWith("/api/lookup?word=good")));
});

if (failures) {
  console.log(`lookup-dialog: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("lookup-dialog: all checks passed");
