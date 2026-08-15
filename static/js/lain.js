import { api } from "./api.js";
import { el, toast, promptDialog, confirmDialog, escapeHtml, formatNumber } from "./ui.js";

const SUGGESTIONS = [
  "Review the current entry for inconsistencies",
  "Suggest a folder layout for my lore",
  "Find contradictions across the wiki",
  "Summarize what we've covered so far",
];

let host = null;
let ctx = null;
let panel = null;
let session = null;
let pending = null;
let busy = false;
let allSessions = [];
let scopeCache = { write: [], wiki: [] };
let lsKey = "lain-last-session";
let abortCtl = null;
let stopBtn = null;

let messagesEl = null;
let inputEl = null;
let sendBtn = null;
let attachBtn = null;
let attachInput = null;
let attachRowEl = null;
let sessionsSelect = null;
let statusDot = null;
let statusLabel = null;
let bannerEl = null;
let scopeBodyEl = null;
let scopeBody = null;
let suggestionsEl = null;
let loaded = false;

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdToHTML(text) {
  return window.marked.parse(String(text || ""), { breaks: true });
}

function covers(o, r) {
  if (o === r) return true;
  if (o === "") return r !== "worldbuilding" && !r.startsWith("worldbuilding/");
  if (o === "worldbuilding") return r.startsWith("worldbuilding/");
  return r.startsWith(o + "/");
}

function normalizeScope(roots) {
  const sorted = [...roots].sort((a, b) => a.length - b.length);
  const out = [];
  for (const r of sorted) {
    if (!out.some((o) => covers(o, r))) out.push(r);
  }
  return out;
}

function currentScope() {
  const s = session && session.scope != null ? session.scope : ["", "worldbuilding"];
  return normalizeScope(s);
}

function scrollChat() {
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function saveLastSession() {
  if (session && session.sessionId) {
    try {
      localStorage.setItem(lsKey, session.sessionId);
    } catch {
      /* ignore */
    }
  }
}

function flattenFolders(tree) {
  const out = [];
  const walk = (node, depth) => {
    for (const f of node.folders || []) {
      out.push({ id: f.id, name: f.name, depth });
      walk(f, depth + 1);
    }
  };
  walk(tree || { folders: [], documents: [] }, 0);
  return out;
}

/* ---------------- status ---------------- */

async function refreshStatus() {
  try {
    const s = await api.ai.status();
    statusDot.classList.toggle("off", !s.enabled);
    const label = s.providerLabel || s.provider || "AI";
    statusDot.title = s.enabled ? `${label} · ${s.model}` : `${label} not configured — click to open Settings`;
    statusDot.onclick = s.enabled ? null : () => ctx.goSettings();
    statusLabel.textContent = s.enabled ? s.model || label : "not configured";
    bannerEl.hidden = s.enabled;
  } catch {
    statusDot.classList.add("off");
    statusDot.title = "AI unavailable";
    statusLabel.textContent = "unavailable";
    bannerEl.hidden = false;
  }
}

/* ---------------- sessions ---------------- */

async function loadSessions() {
  try {
    allSessions = await api.ai.sessions.list(ctx.projectId());
  } catch {
    allSessions = [];
  }
  renderSessionsPicker();
}

function renderSessionsPicker() {
  sessionsSelect.replaceChildren(
    ...allSessions.map((s) =>
      el("option", { value: s.sessionId }, `${s.title} · ${s.tokens} tok`)
    )
  );
  if (session && session.sessionId) sessionsSelect.value = session.sessionId;
}

async function loadSession(sid) {
  try {
    let resp;
    if (sid) resp = await api.ai.sessions.get(ctx.projectId(), sid);
    else {
      resp = await api.ai.sessions.create(ctx.projectId());
      await loadSessions();
    }
    session = resp;
    pending = session.pending || null;
    if (!session.scope || !session.scope.length) session.scope = ["", "worldbuilding"];
    renderChat();
    renderSessionsPicker();
    renderScope();
    saveLastSession();
  } catch (err) {
    toast(err.message, "error");
    if (!sid) {
      session = { sessionId: null, title: "New session", history: [], scope: ["", "worldbuilding"] };
      pending = null;
      renderChat();
    }
  }
}

async function newSession() {
  await loadSession(null);
}

async function deleteCurrentSession() {
  if (!session || !session.sessionId) return;
  const ok = await confirmDialog({
    title: "Delete this session?",
    message: "The conversation will be removed permanently.",
    confirmText: "Delete",
  });
  if (!ok) return;
  try {
    await api.ai.sessions.remove(ctx.projectId(), session.sessionId);
    try {
      localStorage.removeItem(lsKey);
    } catch {
      /* ignore */
    }
    await loadSessions();
    await loadSession(null);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function renameCurrentSession() {
  if (!session || !session.sessionId) return;
  const name = await promptDialog({
    title: "Rename session",
    label: "Name",
    value: session.title,
    confirmText: "Rename",
  });
  if (name === null) return;
  try {
    session = await api.ai.sessions.rename(ctx.projectId(), session.sessionId, name.trim());
    renderSessionsPicker();
    saveLastSession();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function compressCurrent() {
  if (!session || !session.sessionId || busy || pending) return;
  const ok = await confirmDialog({
    title: "Compress conversation?",
    message: "Earlier messages are replaced by a summary to save context. The last 8 messages stay; the originals are archived.",
    confirmText: "Compress",
  });
  if (!ok) return;
  setBusy(true);
  try {
    session = await api.ai.compress(ctx.projectId(), session.sessionId, 8);
    renderChat();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    setBusy(false);
  }
}

/* ---------------- scope selector ---------------- */

async function buildScope() {
  try {
    const [writeTree, wikiTree] = await Promise.all([
      api.projects.tree(ctx.projectId(), "write"),
      api.projects.tree(ctx.projectId(), "wiki"),
    ]);
    scopeCache = { write: flattenFolders(writeTree), wiki: flattenFolders(wikiTree) };
    renderScope();
  } catch {
    /* tree unavailable — leave current scope */
  }
}

function onScopeChange() {
  const checked = new Set();
  panel.querySelectorAll("input[data-scope-folder]").forEach((cb) => {
    if (cb.checked) checked.add(cb.dataset.scopeFolder);
  });
  let scope = normalizeScope([...checked]);
  if (session) session.scope = scope;
  renderScope();
}

function deselectScope(e) {
  if (e) e.stopPropagation();
  if (!session) return;
  session.scope = [];
  renderScope();
}

function renderScope() {
  if (!scopeBody) return;
  const scope = session && session.scope != null ? session.scope : ["", "worldbuilding"];
  const folders = [...scopeCache.write, ...scopeCache.wiki];
  const groups = [
    { root: "", title: "Write (project root)" },
    { root: "worldbuilding", title: "Wiki (worldbuilding)" },
  ];
  scopeBody.replaceChildren(
    ...groups.map((g) => {
      const groupFolders = folders.filter((f) =>
        g.root === "" ? !f.id.startsWith("worldbuilding/") : f.id.startsWith("worldbuilding/")
      );
      const allChecked = scope.includes(g.root);
      return el("div", { class: "lain-scope-group" }, [
        el("label", { class: "lain-scope-all" }, [
          el("input", { type: "checkbox", dataset: { scopeFolder: g.root }, checked: allChecked, onchange: onScopeChange }),
          `All of ${g.title}`,
        ]),
        el("div", { class: "lain-scope-list" }, [
          ...groupFolders.map((f) => {
            const covered = scope.some((o) => covers(o, f.id));
            return el("label", { class: "lain-scope-folder", style: { paddingLeft: `${10 + f.depth * 14}px` } }, [
              el("input", {
                type: "checkbox",
                dataset: { scopeFolder: f.id },
                checked: covered,
                disabled: allChecked,
                onchange: onScopeChange,
              }),
              f.name,
            ]);
          }),
        ]),
      ]);
    })
  );
}

/* ---------------- chat rendering ---------------- */

function pendingCard(p) {
  const details = p.details || {};
  let body;
  if (p.tool === "edit_entry") {
    body = el("div", { class: "lain-diff" }, [
      ...(details.diff || []).map((d) =>
        el("div", { class: `lain-diff-${d.type}` }, d.text === "" ? " " : d.text)
      ),
    ]);
  } else if (p.tool === "move_entry" || p.tool === "move_folder") {
    const label = details.name || details.title || "";
    body = el("div", { class: "lain-confirm-detail" }, [
      el("div", {}, `${escapeHtml(label)}  →  ${escapeHtml(details.to || "(project root)")}`),
    ]);
  } else if (p.tool === "rename_entry") {
    body = el("div", { class: "lain-confirm-detail" }, [
      el("div", {}, `${escapeHtml(details.oldTitle)}  →  ${escapeHtml(details.newTitle)}`),
    ]);
  } else {
    body = el("div", { class: "lain-confirm-detail" }, [
      el("div", {}, `"${escapeHtml(details.name || details.title || "")}"`),
      details.words != null
        ? el("span", {}, ` · ${details.words} words`)
        : details.count != null
          ? el("span", {}, ` · ${details.count} entries`)
          : el("span", {}, ` · ${details.folder ? escapeHtml(details.folder) : ""}`),
    ]);
  }
  return el("div", { class: "lain-confirm" }, [
    p.message ? el("div", { class: "lain-confirm-note" }, escapeHtml(p.message)) : null,
    el("div", { class: "lain-confirm-title" }, `Confirm ${(p.tool || "").replace(/_/g, " ")}`),
    el("div", { class: "lain-confirm-summary" }, escapeHtml(p.summary || "")),
    body,
    p.deferredCount > 0
      ? el("div", { class: "lain-confirm-more" }, `+ ${p.deferredCount} more planned action${p.deferredCount === 1 ? "" : "s"} will also be applied by Accept all`)
      : null,
    el("div", { class: "lain-confirm-actions" }, [
      el("button", { class: "icon-btn", onclick: () => decide("cancel") }, "Cancel"),
      el("button", { class: "icon-btn primary", onclick: () => decide("confirm") }, "Confirm"),
      p.deferredCount > 0
        ? el("button", { class: "icon-btn primary accept-all", onclick: () => decide("confirm_all") }, "Accept all")
        : null,
    ]),
  ]);
}

function renderChat(actions) {
  if (!messagesEl) return;
  messagesEl.replaceChildren();
  if (session && session.compressedSummary) {
    messagesEl.append(
      el("div", { class: "lain-compressed" }, [
        el("div", { class: "lain-compressed-title" }, "⟵ Earlier conversation compressed ⟶"),
        el("div", { class: "lain-compressed-body", html: mdToHTML(session.compressedSummary) }),
      ])
    );
  }
  for (const m of (session && session.history) || []) {
    if (m.role === "user") {
      messagesEl.append(el("div", { class: "lain-msg user" }, el("div", { class: "lain-bubble" }, String(m.content))));
    } else {
      const bubble = el("div", { class: "lain-bubble", html: mdToHTML(m.content) });
      if (m.tokens) bubble.append(el("span", { class: "lain-tok" }, `· ${formatNumber(m.tokens)} tok`));
      messagesEl.append(el("div", { class: "lain-msg lain" }, bubble));
    }
  }
  if (actions && actions.length) {
    messagesEl.append(
      el("div", { class: "lain-actions" }, [
        el("span", { class: "lain-actions-label" }, "Actions performed"),
        ...actions.map((a) => el("span", { class: "lain-action-chip" }, `✓ ${escapeHtml(a.summary)}`)),
      ])
    );
  }
  if (pending) messagesEl.append(pendingCard(pending));
  renderAttachments();
  renderSuggestions();
  scrollChat();
}

function renderAttachments() {
  if (!attachRowEl) return;
  const items = (session && session.attachments) || [];
  attachRowEl.replaceChildren(
    ...items.map((a) =>
      el("span", {
        class: "lain-attach-chip",
        title: a.error ? a.error : `${formatNumber(a.chars || 0)} chars extracted`,
      }, [
        a.name,
        a.error ? el("span", { class: "lain-attach-warn" }, " ⚠") : null,
        el("button", {
          class: "lain-attach-x",
          title: "Remove",
          onclick: () => removeAttachment(a.id),
        }, "✕"),
      ])
    )
  );
  attachRowEl.hidden = !items.length;
}

async function uploadFiles(files) {
  if (!files || !files.length) return;
  if (busy) return;
  if (!session || !session.sessionId) await loadSession(null);
  if (!session || !session.sessionId) return;
  setBusy(true);
  try {
    for (const file of files) {
      try {
        const resp = await api.ai.attach(ctx.projectId(), session.sessionId, file);
        session = resp.session;
      } catch (err) {
        toast(`${file.name}: ${err.message}`, "error");
      }
    }
    renderAttachments();
  } finally {
    setBusy(false);
  }
}

async function removeAttachment(aid) {
  if (!session || !session.sessionId) return;
  try {
    const resp = await api.ai.removeAttachment(ctx.projectId(), session.sessionId, aid);
    session = resp.session;
    renderAttachments();
  } catch (err) {
    toast(err.message, "error");
  }
}

function renderSuggestions() {
  const show = session && (!session.history || !session.history.length) && !pending;
  suggestionsEl.replaceChildren(
    ...(show
      ? SUGGESTIONS.map((s) =>
          el("button", {
            class: "lain-suggestion",
            onclick: () => {
              inputEl.value = s;
              sendMessage();
            },
          }, s)
        )
      : [])
  );
}

/* ---------------- send / confirm ---------------- */

function stopChat() {
  if (abortCtl) {
    abortCtl.abort();
    abortCtl = null;
  }
  if (session && session.sessionId) {
    // Ask the server to stop the agent loop at its next checkpoint too, so a
    // slow generation doesn't keep running invisibly after the stream closes.
    api.ai.cancel(session.sessionId).catch(() => {});
  }
}

function setStreaming(b) {
  if (stopBtn) stopBtn.hidden = !b;
}

function parseSSE(block) {
  let type = "message";
  const dataLines = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  try {
    return { type, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

async function readSSE(body, onEvent) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseSSE(block);
        if (ev) await onEvent(ev);
      }
    }
    if (buffer.trim()) {
      const ev = parseSSE(buffer);
      if (ev) await onEvent(ev);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function toolLogLine(logEl, cls, text) {
  const line = el("div", { class: cls }, text);
  logEl.append(line);
  return line;
}

async function sendMessage() {
  if (busy || pending) return;
  const text = inputEl.value.trim();
  if (!text) return;
  if (!session || !session.sessionId) await loadSession(null);
  if (!session || !session.sessionId) return;
  inputEl.value = "";
  messagesEl.append(el("div", { class: "lain-msg user" }, el("div", { class: "lain-bubble" }, text)));
  const bubble = el("div", { class: "lain-bubble lain-think" }, "Lain is thinking…");
  const think = el("div", { class: "lain-msg lain" }, bubble);
  messagesEl.append(think);
  scrollChat();
  setBusy(true);
  setStreaming(true);
  let resp = null;
  let streamError = null;
  let stopped = false;
  let logEl = null;
  let streamEl = null;
  const ctl = new AbortController();
  abortCtl = ctl;
  const ensureStream = () => {
    if (logEl) return;
    logEl = el("div", { class: "lain-tool-log" });
    streamEl = el("div", { class: "lain-stream", hidden: true });
    bubble.classList.remove("lain-think");
    bubble.replaceChildren(logEl, streamEl);
  };
  try {
    const body = await api.ai.chatStream(ctx.projectId(), {
      sessionId: session.sessionId,
      message: text,
      folders: currentScope(),
      currentDocId: ctx.currentDocId(),
    }, ctl.signal);
    const pendingLines = [];
    await readSSE(body, (ev) => {
      if (ev.type === "token") {
        ensureStream();
        streamEl.hidden = false;
        streamEl.textContent += ev.data.text;
      } else if (ev.type === "tool_start") {
        ensureStream();
        pendingLines.push(toolLogLine(logEl, "tool-start", `${ev.data.label}…`));
      } else if (ev.type === "tool_result") {
        ensureStream();
        const line = pendingLines.pop();
        if (line) {
          line.classList.remove("tool-start");
          line.classList.add("tool-done");
          line.textContent = `✓ ${ev.data.label}`;
        } else {
          toolLogLine(logEl, "tool-done", `✓ ${ev.data.label}`);
        }
      } else if (ev.type === "tool_error") {
        ensureStream();
        const line = pendingLines.pop();
        if (line) {
          line.classList.remove("tool-start");
          line.classList.add("tool-error");
          line.textContent = `✗ ${ev.data.label}`;
        } else {
          toolLogLine(logEl, "tool-error", `✗ ${ev.data.label}`);
        }
      } else if (ev.type === "done") {
        resp = ev.data;
      } else if (ev.type === "error") {
        streamError = new Error(ev.data.message);
      }
      scrollChat();
    });
  } catch (err) {
    if (err && err.name === "AbortError") stopped = true;
    else streamError = err;
  }
  if (abortCtl === ctl) abortCtl = null;
  setStreaming(false);
  if (stopped) {
    bubble.classList.remove("lain-think");
    if (logEl) {
      bubble.append(el("div", { class: "lain-stop-note" }, "⏹ Stopped"));
    } else {
      bubble.replaceChildren(el("div", { class: "lain-stop-note" }, "⏹ Stopped"));
    }
    scrollChat();
    setBusy(false);
    return;
  }
  if (streamError) {
    toast(streamError.message, "error");
    renderChat();
    setBusy(false);
    return;
  }
  if (resp) applyResponse(resp);
  setBusy(false);
}

async function decide(decision) {
  if (!session || !session.sessionId || !pending) return;
  const p = pending;
  pending = null;
  setBusy(true);
  try {
    const resp = await api.ai.confirm(ctx.projectId(), session.sessionId, decision);
    applyResponse(resp);
  } catch (err) {
    toast(err.message, "error");
    pending = p;
    renderChat();
  } finally {
    setBusy(false);
  }
}

function applyResponse(resp) {
  if (resp.session) session = resp.session;
  pending = resp.pending || session.pending || null;
  renderChat(resp.actions || []);
  saveLastSession();
  if (resp.actions && resp.actions.length && ctx && ctx.onActions) {
    ctx.onActions(resp.actions);
  }
}

function setBusy(b) {
  busy = b;
  if (sendBtn) sendBtn.disabled = b;
  if (inputEl) inputEl.disabled = b;
  if (panel) panel.classList.toggle("busy", b);
}

/* ---------------- panel lifecycle ---------------- */

function buildPanel() {
  statusDot = el("span", { class: "lain-status-dot" });
  statusLabel = el("span", { class: "lain-status-label" });
  bannerEl = el("button", { class: "lain-banner", onclick: () => ctx.goSettings() }, "AI not configured — open Settings");

  sessionsSelect = el("select", { class: "lain-sessions-select", onchange: (e) => loadSession(e.target.value) });

  scopeBody = el("div", { class: "lain-scope-body" });
  scopeBodyEl = el("div", { class: "lain-scope" }, [
    el("div", { class: "lain-scope-head", onclick: () => scopeBodyEl.classList.toggle("open") }, [
      el("span", { class: "lain-scope-label" }, "Lain can access"),
      el("div", { class: "lain-scope-actions" }, [
        el("button", { class: "lain-scope-deselect", title: "Deselect all folders (Lain can access nothing)", onclick: deselectScope }, "None"),
        el("span", { class: "lain-scope-toggle" }, "▾"),
      ]),
    ]),
    scopeBody,
  ]);
  scopeBodyEl.classList.add("open");

  messagesEl = el("div", { class: "lain-chat" });
  suggestionsEl = el("div", { class: "lain-suggestions" });

  inputEl = el("textarea", {
    class: "lain-input",
    rows: 3,
    placeholder: "Ask Lain to organize lore, find inconsistencies, or suggest improvements…",
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && busy && abortCtl) {
      e.preventDefault();
      stopChat();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  attachInput = el("input", {
    type: "file",
    multiple: true,
    accept: ".pdf,.docx,.txt,.md",
    hidden: true,
    onchange: (e) => {
      uploadFiles(e.target.files);
      e.target.value = "";
    },
  });
  attachBtn = el("button", {
    class: "icon-btn",
    title: "Attach a reference file (pdf, docx, txt, md)",
    onclick: () => attachInput.click(),
  }, "📎");
  stopBtn = el("button", {
    class: "icon-btn lain-stop",
    title: "Stop generation",
    hidden: true,
    onclick: stopChat,
  }, "⏹");
  sendBtn = el("button", { class: "icon-btn primary", onclick: sendMessage }, "Send");
  attachRowEl = el("div", { class: "lain-attach-row", hidden: true });

  return el("div", { class: "lain-panel" }, [
    el("div", { class: "lain-head" }, [
      el("span", { class: "lain-title" }, "Lain"),
      statusDot,
      statusLabel,
      el("div", { class: "spacer" }),
      el("button", { class: "icon-btn", title: "Close", onclick: close }, "✕"),
    ]),
    bannerEl,
    el("div", { class: "lain-sessions-row" }, [
      sessionsSelect,
      el("button", { class: "mini-add", title: "New session", onclick: newSession }, "+"),
      el("button", { class: "mini-add", title: "Rename session", onclick: renameCurrentSession }, "✎"),
      el("button", { class: "mini-add", title: "Delete session", onclick: deleteCurrentSession }, "✕"),
      el("button", { class: "mini-add", title: "Compress older messages", onclick: compressCurrent }, "⟲"),
    ]),
    scopeBodyEl,
    messagesEl,
    suggestionsEl,
    attachRowEl,
    el("div", { class: "lain-input-row" }, [attachInput, attachBtn, inputEl, stopBtn, sendBtn]),
  ]);
}

async function ensureSession() {
  if (session && session.sessionId) return;
  const stored = (() => {
    try {
      return localStorage.getItem(lsKey);
    } catch {
      return null;
    }
  })();
  if (stored && allSessions.some((s) => s.sessionId === stored)) {
    await loadSession(stored);
    if (session && session.sessionId) return;
  }
  await loadSession(null);
}

async function refresh() {
  await refreshStatus();
  await loadSessions();
  await ensureSession();
  await buildScope();
}

function toggle() {
  if (host.classList.contains("lain-open")) close();
  else open();
}

function open() {
  host.classList.add("lain-open");
  if (!loaded) {
    loaded = true;
    refresh();
  } else {
    refreshStatus();
  }
}

function close() {
  host.classList.remove("lain-open");
}

function isOpen() {
  return host.classList.contains("lain-open");
}

function refreshScope() {
  return buildScope();
}

export function mount(hostEl, context) {
  host = hostEl;
  ctx = context;
  lsKey = `lain-last-session-${ctx.projectId()}`;
  session = null;
  pending = null;
  busy = false;
  allSessions = [];
  scopeCache = { write: [], wiki: [] };
  abortCtl = null;
  loaded = false;
  panel = buildPanel();
  host.appendChild(panel);
  return { toggle, open, close, isOpen, refresh, refreshScope };
}
