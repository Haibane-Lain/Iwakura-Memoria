import { api } from "./api.js";
import { el, toast, promptDialog, confirmDialog, escapeHtml, formatNumber } from "./ui.js";
import { sanitizeChatHTML } from "./sanitize.js";

const SUGGESTIONS = [
  "Review the current entry for inconsistencies",
  "Suggest a folder layout for my lore",
  "Find contradictions across the wiki",
  "Summarize what we've covered so far",
];

// The prompt the ribbon's Critique button seeds. It asks for anchored comments
// (each confirmed by the user) rather than prose edits.
const CRITIQUE_PROMPT =
  "Act as a developmental editor. Review the selected entries and attach comments with the " +
  "add_comment tool: for each problem, quote a short, exact, contiguous span of the entry's " +
  "plain text (copied verbatim, without formatting markers) and give a concise note. Aim for " +
  "3–8 comments per entry, most important first, and do not rewrite or edit the prose. When you " +
  "are done, summarize the main issues briefly.";

// Bottom panel geometry. The drag handle sets the panel height; the value is
// clamped and remembered so a reopened panel keeps its size.
const PANEL_DEFAULT_H = 320;
const PANEL_MIN_H = 160;
const PANEL_MAX_FRACTION = 0.85;
const PANEL_H_KEY = "lain-panel-h";

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
let accessPlanBtn = null;
let accessWriteBtn = null;
let accessHintEl = null;
let modeSimpleBtn = null;
let modeAdvancedBtn = null;
let modeHintEl = null;
let contextSection = null;
let contextFilterEl = null;
let contextListEl = null;
let contextChipsEl = null;
let contextCountEl = null;
let entryCache = { write: [], wiki: [] };
let jobsSection = null;
let jobsListEl = null;
let jobFormEl = null;
let jobKindEl = null;
let jobTitleEl = null;
let jobInstructionEl = null;
let jobChronoEl = null;
let jobChronoWrapEl = null;
let jobRunEl = null;
let jobs = [];
let jobStreamCtl = null;
let resizeBound = false;

/* ---------------- helpers ---------------- */

function mdToHTML(text) {
  return sanitizeChatHTML(window.marked.parse(String(text || ""), { breaks: true }));
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

function currentAccess() {
  return (session && session.access) || "plan";
}

function currentMode() {
  return (session && session.mode) || "advanced";
}

function currentEntries() {
  return (session && session.selectedEntries) || [];
}

async function setAccess(access) {
  if (!session || !session.sessionId || busy || pending) return;
  if (currentAccess() === access) return;
  const prev = session.access;
  session.access = access;
  renderToggles();
  try {
    session = await api.ai.sessions.setAccess(ctx.projectId(), session.sessionId, access);
    renderToggles();
  } catch (err) {
    session.access = prev;
    renderToggles();
    toast(err.message, "error");
  }
}

async function setMode(mode) {
  if (!session || !session.sessionId || busy || pending) return;
  if (currentMode() === mode) return;
  const prev = session.mode;
  session.mode = mode;
  renderToggles();
  renderContext();
  try {
    session = await api.ai.sessions.setMode(ctx.projectId(), session.sessionId, mode);
    renderToggles();
    renderContext();
  } catch (err) {
    session.mode = prev;
    renderToggles();
    renderContext();
    toast(err.message, "error");
  }
}

async function persistEntries(ids, rebuildList) {
  const prev = currentEntries();
  session.selectedEntries = ids;
  renderContextChips();
  if (rebuildList) renderContextList();
  try {
    session = await api.ai.sessions.setEntries(ctx.projectId(), session.sessionId, ids);
    renderContextChips();
  } catch (err) {
    session.selectedEntries = prev;
    renderContextChips();
    renderContextList();
    toast(err.message, "error");
  }
}

function toggleEntry(id) {
  if (!session || !session.sessionId || busy || pending) return;
  const set = new Set(currentEntries());
  if (set.has(id)) set.delete(id);
  else set.add(id);
  persistEntries([...set], false);
}

function renderToggles() {
  if (!accessPlanBtn) return;
  const access = currentAccess();
  const mode = currentMode();
  const locked = busy || !!pending;
  accessPlanBtn.classList.toggle("active", access === "plan");
  accessWriteBtn.classList.toggle("active", access === "write");
  modeSimpleBtn.classList.toggle("active", mode === "simple");
  modeAdvancedBtn.classList.toggle("active", mode === "advanced");
  for (const btn of [accessPlanBtn, accessWriteBtn, modeSimpleBtn, modeAdvancedBtn]) {
    btn.disabled = locked;
  }
  if (accessHintEl) accessHintEl.hidden = access !== "plan";
  if (modeHintEl) modeHintEl.hidden = mode !== "simple";
}

/* ---------------- context picker (Simple mode) ---------------- */

function renderContext() {
  if (!contextSection) return;
  const simple = currentMode() === "simple";
  contextSection.hidden = !simple;
  if (!simple) return;
  renderContextList();
  renderContextChips();
}

function renderContextList() {
  if (!contextListEl) return;
  const filter = (contextFilterEl ? contextFilterEl.value : "").trim().toLowerCase();
  const selected = new Set(currentEntries());
  const all = [
    ...entryCache.write.map((e) => ({ ...e, group: "Write" })),
    ...entryCache.wiki.map((e) => ({ ...e, group: "Wiki" })),
  ].filter(
    (e) => !filter || e.title.toLowerCase().includes(filter) || e.id.toLowerCase().includes(filter)
  );
  if (!all.length) {
    contextListEl.replaceChildren(
      el("div", { class: "lain-ctx-empty" }, "No matching entries in the allowed folders.")
    );
    return;
  }
  contextListEl.replaceChildren(
    ...all.map((e) =>
      el("label", { class: "lain-ctx-item", title: e.id }, [
        el("input", {
          type: "checkbox",
          checked: selected.has(e.id),
          disabled: busy || !!pending,
          onchange: () => toggleEntry(e.id),
        }),
        el("span", { class: "lain-ctx-name" }, e.title),
        el("span", { class: "lain-ctx-path" }, e.folder || e.group),
      ])
    )
  );
}

function renderContextChips() {
  if (!contextChipsEl) return;
  const titles = new Map(
    [...entryCache.write, ...entryCache.wiki].map((e) => [e.id, e.title])
  );
  const selected = currentEntries();
  contextChipsEl.replaceChildren(
    ...selected.map((id) =>
      el("span", { class: "lain-ctx-chip", title: id }, [
        titles.get(id) || id,
        el("button", {
          class: "lain-ctx-x",
          title: "Remove",
          onclick: () => persistEntries(currentEntries().filter((x) => x !== id), true),
        }, "✕"),
      ])
    )
  );
  if (contextCountEl) {
    contextCountEl.textContent = selected.length ? `${selected.length} selected` : "none selected";
  }
}

// Every entry Lain could review, as {id, title, folder, group}. The critique
// dialog lists these; the group only labels the source tab.
function listEntries() {
  return [
    ...entryCache.write.map((e) => ({ ...e, group: "Write" })),
    ...entryCache.wiki.map((e) => ({ ...e, group: "Wiki" })),
  ];
}

// Run a critique over the picked entries. Simple mode injects exactly those
// entries (and no browsing); Plan access still permits the annotate tool, so
// Lain proposes comments without touching the prose.
async function startCritique(ids) {
  if (!Array.isArray(ids) || !ids.length || busy || pending) return;
  await ensureSession();
  if (!session || !session.sessionId) return;
  session.mode = "simple";
  session.access = "plan";
  session.selectedEntries = [...new Set(ids)];
  renderToggles();
  renderContextChips();
  renderContextList();
  open();
  inputEl.value = CRITIQUE_PROMPT;
  await sendMessage();
}

/* ---------------- long jobs ---------------- */

function jobKindLabel(kind) {
  return kind === "timeline" ? "Timeline" : "Extraction";
}

async function loadJobs() {
  const sid = session && session.sessionId;
  if (!sid) {
    jobs = [];
    renderJobs();
    return;
  }
  try {
    jobs = await api.ai.jobs.list(ctx.projectId(), sid);
  } catch {
    jobs = [];
  }
  renderJobs();
}

function renderJobs() {
  if (!jobsListEl) return;
  if (!jobs.length) {
    jobsListEl.replaceChildren(el("div", { class: "lain-job-empty" }, "No long jobs yet."));
    return;
  }
  jobsListEl.replaceChildren(...jobs.map(jobCard));
}

function jobCard(job) {
  const progress = job.progress || {};
  const total = progress.chunksTotal || 0;
  const done = progress.chunksDone || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const title = (job.options && job.options.outputTitle) || jobKindLabel(job.kind);
  const actions = [];
  if (job.status === "running") {
    actions.push(el("button", { class: "mini-add", title: "Pause", disabled: busy, onclick: () => pauseJob(job) }, "⏸"));
  } else if (["pending", "paused", "failed"].includes(job.status)) {
    actions.push(el("button", { class: "mini-add", title: "Run or resume", disabled: busy, onclick: () => runJob(job) }, "▶"));
  }
  if (job.output && job.output.status === "pending_access") {
    actions.push(el("button", { class: "mini-add", title: "Apply (needs Write access)", disabled: busy, onclick: () => applyJob(job) }, "✓"));
  }
  actions.push(el("button", { class: "mini-add", title: "Delete", disabled: busy, onclick: () => removeJob(job) }, "✕"));
  return el("div", { class: `lain-job lain-job-${job.status}` }, [
    el("div", { class: "lain-job-head" }, [
      el("span", { class: "lain-job-title" }, title),
      el("span", { class: `lain-job-status status-${job.status}` }, job.status),
    ]),
    el("div", { class: "lain-job-sub" }, `${jobKindLabel(job.kind)} · ${done}/${total} chunks · ${progress.items || 0} items`),
    el("div", { class: "lain-job-bar" }, el("div", { class: "lain-job-bar-fill", style: { width: `${pct}%` } })),
    el("div", { class: "lain-job-actions" }, actions),
  ]);
}

function toggleJobForm() {
  if (!jobFormEl) return;
  jobFormEl.hidden = !jobFormEl.hidden;
}

function syncJobForm() {
  const timeline = jobKindEl && jobKindEl.value === "timeline";
  if (jobInstructionEl) jobInstructionEl.hidden = !!timeline;
  if (jobChronoWrapEl) jobChronoWrapEl.hidden = !timeline;
}

function jobScopes() {
  const scope = currentScope();
  return scope && scope.length ? scope : ["", "worldbuilding"];
}

async function submitJob() {
  const sid = session && session.sessionId;
  if (!sid) {
    toast("Start a session first", "error");
    return;
  }
  const kind = jobKindEl.value;
  const options = {};
  if (jobTitleEl.value.trim()) options.outputTitle = jobTitleEl.value.trim();
  if (kind === "timeline") options.chronological = jobChronoEl.checked;
  const instruction = jobInstructionEl.value.trim();
  if (kind === "extract" && !instruction) {
    toast("Describe what Lain should extract", "error");
    return;
  }
  const simple = currentMode() === "simple";
  const picked = currentEntries();
  if (simple && !picked.length) {
    toast("Pick entries in the Context list first", "error");
    return;
  }
  try {
    const job = await api.ai.jobs.create(ctx.projectId(), sid, {
      kind,
      folders: jobScopes(),
      entries: simple ? picked : null,
      instruction,
      options,
    });
    jobs = [job, ...jobs];
    renderJobs();
    jobFormEl.hidden = true;
    runJob(job);
  } catch (err) {
    toast(err.message, "error");
  }
}

function jobProgress(text, isError) {
  if (!jobRunEl) return;
  jobRunEl.hidden = !text;
  jobRunEl.textContent = text || "";
  jobRunEl.classList.toggle("error", !!isError);
}

async function runJob(job) {
  const sid = session && session.sessionId;
  if (!sid || busy || pending) return;
  setBusy(true);
  const ctl = new AbortController();
  jobStreamCtl = ctl;
  jobProgress("Starting…");
  try {
    const body = await api.ai.jobs.stream(ctx.projectId(), sid, job.jobId, ctl.signal);
    await readSSE(body, (ev) => {
      if (ev.type === "job_chunk_start") {
        jobProgress(`Chunk ${ev.data.index + 1}/${ev.data.total}…`);
      } else if (ev.type === "job_chunk_done") {
        jobProgress(`Chunk ${ev.data.index + 1}/${ev.data.total} — ${ev.data.items} items`);
      } else if (ev.type === "job_chunk_failed") {
        jobProgress(`Chunk ${ev.data.index + 1} failed: ${ev.data.error}`, true);
      } else if (ev.type === "job_reduce_start") {
        jobProgress(`Reducing ${ev.data.total} records…`);
      } else if (ev.type === "job_paused") {
        jobProgress("Paused", true);
      } else if (ev.type === "error") {
        jobProgress(ev.data.message, true);
        toast(ev.data.message, "error");
      }
    });
  } catch (err) {
    if (!(err && err.name === "AbortError")) {
      jobProgress(err.message, true);
      toast(err.message, "error");
    }
  }
  if (jobStreamCtl === ctl) jobStreamCtl = null;
  setBusy(false);
  await loadJobs();
}

async function pauseJob(job) {
  const sid = session && session.sessionId;
  if (!sid) return;
  try {
    await api.ai.jobs.pause(ctx.projectId(), sid, job.jobId);
    jobProgress("Pausing…");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function removeJob(job) {
  const sid = session && session.sessionId;
  if (!sid) return;
  try {
    await api.ai.jobs.remove(ctx.projectId(), sid, job.jobId);
    jobs = jobs.filter((j) => j.jobId !== job.jobId);
    renderJobs();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function applyJob(job) {
  const sid = session && session.sessionId;
  if (!sid) return;
  try {
    const resp = await api.ai.jobs.apply(ctx.projectId(), sid, job.jobId);
    if (resp.session) session = resp.session;
    pending = resp.pending || session.pending || null;
    renderChat(resp.actions || []);
    await loadJobs();
  } catch (err) {
    toast(err.message, "error");
  }
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

function flattenEntries(tree) {
  const out = [];
  const walk = (node, path) => {
    for (const d of node.documents || []) {
      out.push({ id: d.id, title: d.title || d.id, folder: path.join(" / ") });
    }
    for (const f of node.folders || []) {
      walk(f, [...path, f.name]);
    }
  };
  walk(tree || { folders: [], documents: [] }, []);
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
    loadJobs();
    saveLastSession();
  } catch (err) {
    toast(err.message, "error");
    if (!sid) {
      session = {
        sessionId: null,
        title: "New session",
        history: [],
        scope: ["", "worldbuilding"],
        access: "plan",
        mode: "advanced",
        selectedEntries: [],
      };
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
    entryCache = { write: flattenEntries(writeTree), wiki: flattenEntries(wikiTree) };
    renderScope();
    renderContext();
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
  } else if (p.tool === "add_comment") {
    body = el("div", { class: "lain-confirm-detail" }, [
      details.title ? el("div", { class: "lain-confirm-sub" }, escapeHtml(details.title)) : null,
      el("div", { class: "lain-comment-quote" }, `“${escapeHtml(details.quote || "")}”`),
      el("div", {}, escapeHtml(details.body || "")),
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
  renderToggles();
  renderContext();
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
      access: currentAccess(),
      mode: currentMode(),
      selectedEntries: currentEntries(),
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
  renderToggles();
  renderContext();
  renderJobs();
}

/* ---------------- panel resize ---------------- */

function clampPanelHeight(px) {
  const max = Math.max(PANEL_MIN_H, Math.round(window.innerHeight * PANEL_MAX_FRACTION));
  return Math.max(PANEL_MIN_H, Math.min(px, max));
}

function applyPanelHeight(px, persist = true) {
  const h = clampPanelHeight(px);
  if (panel) panel.style.setProperty("--lain-h", `${h}px`);
  if (persist) {
    try {
      localStorage.setItem(PANEL_H_KEY, String(h));
    } catch {
      /* ignore */
    }
  }
  return h;
}

function storedPanelHeight() {
  try {
    const raw = parseInt(localStorage.getItem(PANEL_H_KEY) || "", 10);
    if (Number.isFinite(raw)) return raw;
  } catch {
    /* ignore */
  }
  return PANEL_DEFAULT_H;
}

function initResize(handle) {
  let startY = 0;
  let startH = 0;
  let lastH = 0;
  let dragging = false;

  const onMove = (e) => {
    if (!dragging) return;
    lastH = applyPanelHeight(startH + (startY - e.clientY), false);
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    if (handle.hasPointerCapture && handle.hasPointerCapture(e.pointerId)) {
      handle.releasePointerCapture(e.pointerId);
    }
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    applyPanelHeight(lastH, true);
  };

  handle.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startH = panel ? panel.getBoundingClientRect().height || storedPanelHeight() : storedPanelHeight();
    lastH = startH;
    if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId);
    e.preventDefault();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  // Double-click restores the default height; arrows nudge it for keyboard use.
  handle.addEventListener("dblclick", () => applyPanelHeight(PANEL_DEFAULT_H));
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const current = panel ? panel.getBoundingClientRect().height || storedPanelHeight() : storedPanelHeight();
    applyPanelHeight(current + (e.key === "ArrowUp" ? 16 : -16));
  });
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

  accessPlanBtn = el("button", { class: "lain-mode-btn", title: "Plan — Lain can only read", onclick: () => setAccess("plan") }, "Plan");
  accessWriteBtn = el("button", { class: "lain-mode-btn", title: "Write — Lain can create and change files", onclick: () => setAccess("write") }, "Write");
  accessHintEl = el("div", { class: "lain-mode-hint", hidden: true }, "Plan access — Lain can read but not change files.");
  const accessRow = el("div", { class: "lain-mode-row" }, [
    el("span", { class: "lain-mode-label" }, "Access"),
    el("div", { class: "lain-mode" }, [accessPlanBtn, accessWriteBtn]),
  ]);

  modeSimpleBtn = el("button", { class: "lain-mode-btn", title: "Simple — you pick the entries; Lain only writes", onclick: () => setMode("simple") }, "Simple");
  modeAdvancedBtn = el("button", { class: "lain-mode-btn", title: "Advanced — full tool suite", onclick: () => setMode("advanced") }, "Advanced");
  modeHintEl = el("div", { class: "lain-mode-hint", hidden: true }, "Simple mode — Lain uses only the entries you select.");
  const modeRow = el("div", { class: "lain-mode-row" }, [
    el("span", { class: "lain-mode-label" }, "Mode"),
    el("div", { class: "lain-mode" }, [modeSimpleBtn, modeAdvancedBtn]),
  ]);

  contextFilterEl = el("input", {
    class: "lain-ctx-filter",
    type: "search",
    placeholder: "Filter entries…",
    oninput: () => renderContextList(),
  });
  contextListEl = el("div", { class: "lain-ctx-list" });
  contextChipsEl = el("div", { class: "lain-ctx-chips" });
  contextCountEl = el("span", { class: "lain-ctx-count" });
  contextSection = el("div", { class: "lain-ctx", hidden: true }, [
    el("div", { class: "lain-ctx-head" }, [
      el("span", { class: "lain-ctx-label" }, "Context"),
      contextCountEl,
    ]),
    contextFilterEl,
    contextListEl,
    contextChipsEl,
  ]);

  jobKindEl = el("select", { class: "lain-job-kind", onchange: () => syncJobForm() }, [
    el("option", { value: "timeline" }, "Timeline"),
    el("option", { value: "extract" }, "Extraction"),
  ]);
  jobTitleEl = el("input", { class: "lain-ctx-filter", type: "text", placeholder: "Output title (optional)" });
  jobInstructionEl = el("textarea", {
    class: "lain-job-instruction",
    placeholder: "What should Lain extract? (e.g. every named character and where they appear)",
  });
  jobChronoEl = el("input", { type: "checkbox", checked: true });
  jobChronoWrapEl = el("label", { class: "lain-job-check" }, [jobChronoEl, el("span", {}, "Sort chronologically")]);
  jobFormEl = el("div", { class: "lain-job-form", hidden: true }, [
    jobKindEl,
    jobTitleEl,
    jobInstructionEl,
    jobChronoWrapEl,
    el("div", { class: "lain-job-form-actions" }, [
      el("button", { class: "icon-btn", onclick: () => toggleJobForm() }, "Cancel"),
      el("button", { class: "icon-btn primary", onclick: () => submitJob() }, "Start"),
    ]),
  ]);
  jobRunEl = el("div", { class: "lain-job-run", hidden: true });
  jobsListEl = el("div", { class: "lain-job-list" });
  jobsSection = el("div", { class: "lain-jobs" }, [
    el("div", { class: "lain-jobs-head" }, [
      el("span", { class: "lain-ctx-label" }, "Jobs"),
      el("button", { class: "mini-add", title: "New long job", onclick: () => toggleJobForm() }, "+"),
    ]),
    jobFormEl,
    jobRunEl,
    jobsListEl,
  ]);
  syncJobForm();
  renderJobs();

  const resizeHandle = el("div", {
    class: "lain-resize",
    role: "separator",
    "aria-orientation": "horizontal",
    "aria-label": "Resize Lain panel",
    tabindex: "0",
    title: "Drag to resize",
  });
  initResize(resizeHandle);

  // Wide, short panel: controls live in a left rail, while the conversation
  // and its input take the rest of the width.
  const rail = el("div", { class: "lain-rail" }, [
    accessRow,
    accessHintEl,
    modeRow,
    modeHintEl,
    contextSection,
    el("div", { class: "lain-sessions-row" }, [
      sessionsSelect,
      el("button", { class: "mini-add", title: "New session", onclick: newSession }, "+"),
      el("button", { class: "mini-add", title: "Rename session", onclick: renameCurrentSession }, "✎"),
      el("button", { class: "mini-add", title: "Delete session", onclick: deleteCurrentSession }, "✕"),
      el("button", { class: "mini-add", title: "Compress older messages", onclick: compressCurrent }, "⟲"),
    ]),
    jobsSection,
    scopeBodyEl,
  ]);
  const mainCol = el("div", { class: "lain-main" }, [
    messagesEl,
    suggestionsEl,
    attachRowEl,
    el("div", { class: "lain-input-row" }, [attachInput, attachBtn, inputEl, stopBtn, sendBtn]),
  ]);

  return el("div", { class: "lain-panel" }, [
    resizeHandle,
    el("div", { class: "lain-head" }, [
      el("span", { class: "lain-title" }, "Lain"),
      statusDot,
      statusLabel,
      el("div", { class: "spacer" }),
      el("button", { class: "icon-btn", title: "Close", onclick: close }, "✕"),
    ]),
    bannerEl,
    el("div", { class: "lain-body" }, [rail, mainCol]),
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
  entryCache = { write: [], wiki: [] };
  jobs = [];
  jobStreamCtl = null;
  abortCtl = null;
  loaded = false;
  panel = buildPanel();
  host.appendChild(panel);
  applyPanelHeight(storedPanelHeight(), false);
  renderToggles();
  renderContext();
  if (!resizeBound) {
    resizeBound = true;
    // Keep the stored height legal if the window shrinks under it.
    window.addEventListener("resize", () => {
      const raw = panel ? parseInt(panel.style.getPropertyValue("--lain-h"), 10) : NaN;
      applyPanelHeight(Number.isFinite(raw) ? raw : storedPanelHeight(), false);
    });
  }
  return { toggle, open, close, isOpen, refresh, refreshScope, listEntries, startCritique };
}
