// jsdom test for the comments panel: the list, the composer, resolve, delete,
// and orphan-marker cleanup. The panel is a plain static/js module, so this
// drives it directly with a fake controller and a stubbed comments API rather
// than the editor bundle.
//
// Run: node tests/comments-panel.test.mjs  (or `npm run test:commentspanel`)
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

// --- a stubbed comments API -------------------------------------------------

let store = [];
let nextId = 1;
let requests = [];

globalThis.fetch = async (url, opts = {}) => {
  const parsed = new URL(String(url), "http://localhost");
  const method = (opts.method || "GET").toUpperCase();
  const pathname = parsed.pathname;
  requests.push(`${method} ${pathname}`);

  if (pathname === "/api/projects/p/comments" && method === "GET") {
    return jsonResponse(store);
  }
  if (pathname === "/api/projects/p/comments" && method === "POST") {
    const payload = JSON.parse(opts.body);
    const record = {
      id: `c_${String(nextId++).padStart(12, "0")}`,
      docId: payload.docId,
      body: payload.body,
      quote: payload.quote,
      author: "you",
      createdAt: "2026-09-11T10:00:00.000",
      updatedAt: "2026-09-11T10:00:00.000",
      resolved: false,
      resolvedAt: null,
    };
    store.push(record);
    return jsonResponse(record, 201);
  }
  if (pathname.startsWith("/api/projects/p/comments/") && method === "PUT") {
    const id = pathname.split("/").pop();
    const payload = JSON.parse(opts.body);
    const record = store.find((c) => c.id === id);
    if (payload.body !== undefined) record.body = payload.body;
    if (payload.resolved !== undefined) {
      record.resolved = payload.resolved;
      record.resolvedAt = payload.resolved ? "2026-09-11T11:00:00.000" : null;
    }
    record.updatedAt = "2026-09-11T11:00:00.000";
    return jsonResponse(record);
  }
  if (pathname.startsWith("/api/projects/p/comments/") && method === "DELETE") {
    const id = pathname.split("/").pop();
    store = store.filter((c) => c.id !== id);
    return jsonResponse({ ok: true });
  }
  if (pathname === "/api/projects/p/comments" && method === "DELETE") {
    const resolvedOnly = parsed.searchParams.get("resolvedOnly") === "true";
    const before = store.length;
    store = resolvedOnly ? store.filter((c) => !c.resolved) : [];
    return jsonResponse({ ok: true, removed: before - store.length });
  }
  return jsonResponse({}, 404);
};

// --- a fake editor controller ----------------------------------------------

const doc = {
  content: { size: 999 },
  // The captured range always still matches, so the anchor is used as-is.
  textBetween: () => "bravo",
  descendants: () => {},
};

function makeCtrl(rangesRef) {
  const calls = { setComment: [], removeComment: [], removeComments: [], reveal: [] };
  const chain = {
    focus() {
      return chain;
    },
    setTextSelection() {
      return chain;
    },
    run() {
      return chain;
    },
  };
  return {
    calls,
    editor: { state: { doc }, chain: () => chain },
    getCommentRanges: () => rangesRef.value,
    setComment: (cid) => calls.setComment.push(cid),
    removeComment: (cid) => calls.removeComment.push(cid),
    removeComments: (cids) => calls.removeComments.push(...cids),
    revealComment: (cid) => {
      calls.reveal.push(cid);
      return true;
    },
  };
}

const rangesRef = { value: [] };
const ctrl = makeCtrl(rangesRef);
const pane = { name: "primary", docId: "01-scene", ctrl, activeCommentId: null };

const { commentsPanel } = await import("../static/js/comments-panel.js");

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

function button(panel, label) {
  return [...panel.querySelectorAll("button")].find((b) => b.textContent === label);
}

const panel = commentsPanel({
  projectId: "p",
  pane,
  syncComments: (items) => {
    pane.comments = items;
  },
  onCount: () => {},
});
document.body.append(panel);

await check("an empty document shows the no-comments hint", async () => {
  store = [];
  await panel._reload();
  assert.match(panel.textContent, /No comments yet/);
});

await check("the composer creates a comment and wraps the selection", async () => {
  const before = nextId;
  panel.beginComment({ from: 7, to: 12, quote: "bravo" });
  const box = panel.querySelector(".comment-composer");
  assert.ok(box, "the composer is shown");
  box.value = "Trim this";
  box.dispatchEvent(new w.Event("input", { bubbles: true }));
  button(panel, "Comment").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

  await waitFor(() => ctrl.calls.setComment.length === 1);
  await waitFor(() => panel.textContent.includes("Trim this"));
  const record = store[0];
  assert.equal(record.body, "Trim this");
  assert.equal(record.quote, "bravo");
  assert.equal(nextId, before + 1);
  assert.deepEqual(ctrl.calls.setComment, [record.id], "the marker uses the new id");
  assert.match(panel.textContent, /Trim this/);
});

await check("resolving a comment updates it and dims the item", async () => {
  button(panel, "Resolve").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await waitFor(() => store[0].resolved === true);
  await waitFor(() => panel.querySelector(".comment-item.resolved"));
  assert.ok(panel.querySelector(".comment-item.resolved"));
});

await check("editing rewrites the body", async () => {
  button(panel, "Edit").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const box = panel.querySelector(".comment-edit");
  box.value = "Shorter.";
  button(panel, "Save").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await waitFor(() => store[0].body === "Shorter.");
  await waitFor(() => panel.textContent.includes("Shorter."));
});

await check("an unlinked marker is listed with a cleanup action", async () => {
  rangesRef.value = [{ cid: "c_orphan00000", from: 1, to: 5, text: "lost" }];
  panel._render();
  const orphan = panel.querySelector(".comment-item.orphan");
  assert.ok(orphan, "the orphan is shown");
  button(orphan, "Remove marker").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(ctrl.calls.removeComment, ["c_orphan00000"]);
  rangesRef.value = [];
});

await check("deleting a comment removes the marker too", async () => {
  const id = store[0].id;
  button(panel, "Delete").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const confirm = await waitFor(() => document.querySelector(".modal-backdrop .icon-btn.danger"));
  confirm.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await waitFor(() => store.length === 0);
  assert.deepEqual(ctrl.calls.removeComment, ["c_orphan00000", id]);
});

await check("clear resolved removes the backend rows and the markers", async () => {
  store = [
    { id: "c_aaaa", docId: "01-scene", body: "a", resolved: true },
    { id: "c_bbbb", docId: "01-scene", body: "b", resolved: false },
  ];
  await panel._reload();
  button(panel, "Clear resolved").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const confirm = await waitFor(() => document.querySelector(".modal-backdrop .icon-btn.danger"));
  confirm.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await waitFor(() => store.length === 1);
  assert.equal(store[0].id, "c_bbbb");
  assert.deepEqual(ctrl.calls.removeComments, ["c_aaaa"]);
});

if (failures) {
  console.log(`comments-panel: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("comments-panel: all checks passed");
