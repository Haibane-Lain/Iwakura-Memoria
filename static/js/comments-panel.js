// The comments panel for a pane: the review notes anchored in the focused
// document. A leaf module — it owns the list UI and the CRUD calls, and drives
// the editor-side marker commands through the pane's controller.
//
// The comment *bodies* live in a data-root sidecar; the document carries only
// `<span data-cid>` markers. This panel is the bridge: it lists the bodies,
// and when one is added/deleted it keeps the matching marker in step.
import { api } from "./api.js";
import { el, toast, confirmDialog } from "./ui.js";

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function quoteExcerpt(text, max = 110) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// True when [from, to) intersects any of `ranges` ({from, to}).
function overlaps(from, to, ranges) {
  return (ranges || []).some((r) => from < r.to && to > r.from);
}

// The first exact occurrence of `quote` in any textblock that does not already
// sit inside a comment anchor, as a document range. Used when the captured
// selection has drifted (the user edited while the composer was open) and to
// keep a new note from landing on top of an existing one.
function findQuote(doc, quote, occupied = []) {
  if (!quote) return null;
  let found = null;
  doc.descendants((node, pos) => {
    if (found || !node.isTextblock) return found == null;
    const text = node.textContent;
    let index = text.indexOf(quote);
    while (index >= 0) {
      const from = pos + 1 + index;
      const to = from + quote.length;
      if (!overlaps(from, to, occupied)) {
        found = { from, to };
        return false;
      }
      index = text.indexOf(quote, index + 1);
    }
    return true;
  });
  return found;
}

export function commentsPanel({ projectId, pane, syncComments, onCount }) {
  const panel = el("div", { class: "side-panel comments-panel" });
  let items = [];
  let composing = null; // { from, to, quote }
  let editingId = null;
  let draft = "";
  let busy = false;
  let reviewing = false;

  const ctrl = () => pane.ctrl;
  const docId = () => pane.docId;

  function anchoredMap() {
    const map = new Map();
    if (!ctrl()) return map;
    for (const range of ctrl().getCommentRanges()) map.set(range.cid, range);
    return map;
  }

  function notify() {
    if (syncComments) syncComments(items);
    if (onCount) onCount(items);
  }

  function sorted(itemsIn) {
    const anchored = anchoredMap();
    return [...itemsIn].sort((a, b) => {
      const ra = anchored.get(a.id);
      const rb = anchored.get(b.id);
      if (ra && rb) return ra.from - rb.from;
      if (ra) return -1;
      if (rb) return 1;
      return 0;
    });
  }

  async function reload() {
    const id = docId();
    if (!id) {
      items = [];
      render();
      notify();
      return;
    }
    try {
      items = (await api.comments.list(projectId, id)) || [];
    } catch (err) {
      items = [];
      toast(err.message, "error");
    }
    render();
    notify();
  }

  /* ---------------- actions ---------------- */

  function wrapMarker(cid, selection) {
    const controller = ctrl();
    if (!controller) return false;
    const editor = controller.editor;
    const doc = editor.state.doc;
    // Anchors already in the document; only used to pick a free occurrence when
    // the captured selection has drifted.
    const occupied = controller.getCommentRanges().map((r) => ({ from: r.from, to: r.to }));
    const { from, to, quote } = selection;
    const matches = from >= 0 && to <= doc.content.size && doc.textBetween(from, to, " ") === quote;
    const target = matches ? { from, to } : findQuote(doc, quote, occupied);
    if (!target) return false;
    editor.chain().focus().setTextSelection(target).run();
    // The mark command skips text already inside an anchor, so verify the anchor
    // actually landed (a selection entirely inside existing anchors marks
    // nothing) before the caller keeps the note.
    controller.setComment(cid);
    return controller.getCommentRanges().some((r) => r.cid === cid);
  }

  async function submitComposer() {
    if (busy || !composing) return;
    const body = draft.trim();
    if (!body) return;
    const id = docId();
    const controller = ctrl();
    if (!id || !controller) return;
    busy = true;
    const selection = composing;
    let record;
    try {
      record = await api.comments.create(projectId, {
        docId: id,
        body,
        quote: selection.quote,
      });
    } catch (err) {
      toast(err.message, "error");
      busy = false;
      return;
    }
    busy = false;
    composing = null;
    draft = "";
    const anchored = wrapMarker(record.id, selection);
    if (!anchored) {
      // Never leave a body with no marker behind: the server-side annotate path
      // deletes a note it could not anchor, and the panel should do the same.
      try {
        await api.comments.remove(projectId, record.id, id);
      } catch {
        /* the note stays; the user can delete it from the list */
      }
      toast("That text is missing or already part of a comment — the note wasn't anchored.", "error");
    }
    await reload();
  }

  function cancelComposer() {
    composing = null;
    draft = "";
    render();
  }

  async function toggleResolved(comment) {
    const advancing = reviewing && !comment.resolved;
    const nextId = advancing ? nextOpenId(comment.id) : null;
    try {
      await api.comments.update(projectId, comment.id, {
        docId: docId(),
        resolved: !comment.resolved,
      });
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    await reload();
    if (advancing) {
      if (nextId) revealById(nextId);
      else render();
    }
  }

  function openComments() {
    return sorted(items.filter((c) => !c.resolved));
  }

  function nextOpenId(afterId) {
    const open = openComments();
    if (open.length <= 1) return null;
    const index = open.findIndex((c) => c.id === afterId);
    return open[(index + 1) % open.length].id;
  }

  function revealById(id) {
    const comment = items.find((c) => c.id === id);
    if (comment) reveal(comment);
    return !!comment;
  }

  function startReview() {
    reviewing = true;
    const open = openComments();
    if (open.length) reveal(open[0]);
    else render();
  }

  function stopReview() {
    reviewing = false;
    render();
  }

  function stepReview(delta) {
    const open = openComments();
    if (!open.length) {
      render();
      return;
    }
    const index = open.findIndex((c) => c.id === pane.activeCommentId);
    const nextIndex = index < 0 ? 0 : (index + delta + open.length) % open.length;
    reveal(open[nextIndex]);
  }

  async function saveEdit(comment, value) {
    const body = value.trim();
    if (!body) return;
    try {
      await api.comments.update(projectId, comment.id, { docId: docId(), body });
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    editingId = null;
    await reload();
  }

  async function removeComment(comment) {
    const ok = await confirmDialog({
      title: "Delete comment?",
      message: "The note is removed; the anchored text stays.",
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.comments.remove(projectId, comment.id, docId());
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    if (ctrl()) ctrl().removeComment(comment.id);
    await reload();
  }

  async function clearResolved() {
    const resolved = items.filter((c) => c.resolved).map((c) => c.id);
    if (!resolved.length) return;
    const ok = await confirmDialog({
      title: "Delete resolved comments?",
      message: `Remove ${resolved.length} resolved comment${resolved.length === 1 ? "" : "s"}?`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.comments.clear(projectId, docId(), { resolvedOnly: true });
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    if (ctrl()) ctrl().removeComments(resolved);
    await reload();
  }

  function aiCommentIds() {
    return items
      .filter((c) => String(c.author || "").toLowerCase() === "lain")
      .map((c) => c.id);
  }

  async function clearAiNotes() {
    const ids = aiCommentIds();
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: "Remove Lain's comments?",
      message: `Delete ${ids.length} comment${ids.length === 1 ? "" : "s"} proposed by Lain? The anchored text stays.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.comments.clear(projectId, docId(), { author: "Lain" });
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    if (ctrl()) ctrl().removeComments(ids);
    await reload();
  }

  function removeMarker(cid) {
    if (!ctrl()) return;
    ctrl().removeComment(cid);
    render();
    notify();
  }

  // Re-link a note whose anchor was lost (the text moved or the document was
  // rewritten externally) by finding its stored quote again.
  function locate(comment) {
    const controller = ctrl();
    if (!controller) return null;
    const occupied = controller.getCommentRanges().map((r) => ({ from: r.from, to: r.to }));
    return findQuote(controller.editor.state.doc, comment.quote || "", occupied);
  }

  function reanchor(comment) {
    const controller = ctrl();
    const target = locate(comment);
    if (!controller || !target) {
      toast("That text is gone or already inside another comment.", "info");
      return;
    }
    controller.editor.chain().focus().setTextSelection(target).run();
    controller.setComment(comment.id);
    render();
    notify();
  }

  async function reanchorAll() {
    let restored = 0;
    for (const comment of items) {
      const controller = ctrl();
      if (!controller) break;
      if (controller.getCommentRanges().some((r) => r.cid === comment.id)) continue;
      const target = locate(comment);
      if (!target) continue;
      controller.editor.chain().focus().setTextSelection(target).run();
      controller.setComment(comment.id);
      restored += 1;
    }
    render();
    notify();
    toast(
      restored
        ? `Re-anchored ${restored} comment${restored === 1 ? "" : "s"}.`
        : "Nothing to re-anchor — those quotes are gone or already commented.",
      "info"
    );
  }

  function reveal(comment) {
    pane.activeCommentId = comment.id;
    if (ctrl()) ctrl().revealComment(comment.id);
    render();
    notify();
  }

  /* ---------------- rendering ---------------- */

  function composerEl() {
    const box = el("textarea", {
      class: "comment-composer",
      rows: "3",
      placeholder: "Write a comment…  (Ctrl+Enter to save)",
    });
    box.value = draft;
    box.addEventListener("input", () => {
      draft = box.value;
    });
    box.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        submitComposer();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelComposer();
      }
    });
    return el("div", { class: "comment-composer-wrap" }, [
      el("div", { class: "comment-quote" }, quoteExcerpt(composing && composing.quote) || "(selection)"),
      box,
      el("div", { class: "composer-actions" }, [
        el("button", { class: "mini-btn", onclick: cancelComposer }, "Cancel"),
        el("button", { class: "mini-btn primary", onclick: submitComposer }, "Comment"),
      ]),
    ]);
  }

  function editBox(comment) {
    const box = el("textarea", { class: "comment-edit", rows: "3" });
    box.value = comment.body;
    return el("div", { class: "comment-edit-wrap" }, [
      box,
      el("div", { class: "composer-actions" }, [
        el("button", { class: "mini-btn", onclick: () => { editingId = null; render(); } }, "Cancel"),
        el("button", { class: "mini-btn primary", onclick: () => saveEdit(comment, box.value) }, "Save"),
      ]),
    ]);
  }

  function itemEl(comment, range) {
    const classes = ["comment-item"];
    if (comment.resolved) classes.push("resolved");
    if (pane.activeCommentId === comment.id) classes.push("active");
    if (!range) classes.push("detached");
    const meta = [
      comment.author || "you",
      formatTime(comment.updatedAt || comment.createdAt),
      range ? "" : "text changed — anchor lost",
    ].filter(Boolean).join(" · ");
    return el("div", {
      class: classes.join(" "),
      onclick: (event) => {
        if (!event.target.closest("button, textarea")) reveal(comment);
      },
    }, [
      el("div", { class: "comment-quote" }, quoteExcerpt(comment.quote) || quoteExcerpt(range && range.text) || "(no quote)"),
      editingId === comment.id ? editBox(comment) : el("div", { class: "comment-body" }, comment.body),
      el("div", { class: "comment-meta" }, meta),
      el("div", { class: "comment-actions" }, [
        el("button", { class: "mini-btn", onclick: () => toggleResolved(comment) }, comment.resolved ? "Reopen" : "Resolve"),
        el("button", { class: "mini-btn", onclick: () => { editingId = comment.id; render(); } }, "Edit"),
        !range
          ? el("button", { class: "mini-btn", onclick: () => reanchor(comment) }, "Re-anchor")
          : null,
        el("button", { class: "mini-btn danger", onclick: () => removeComment(comment) }, "Delete"),
      ]),
    ]);
  }

  function render() {
    const anchored = anchoredMap();
    const openCount = items.filter((c) => !c.resolved).length;
    const hasResolved = items.some((c) => c.resolved);
    const hasAi = items.some((c) => String(c.author || "").toLowerCase() === "lain");
    const detached = items.filter((c) => !anchored.get(c.id));
    const head = el("div", { class: "panel-head" }, [
      el("span", { class: "panel-title" }, items.length ? `Comments · ${openCount} open` : "Comments"),
      el("span", { class: "panel-head-spacer" }),
      detached.length
        ? el("button", {
            class: "mini-btn",
            title: "Re-link notes whose quoted text is still in the document",
            onclick: reanchorAll,
          }, "Re-anchor all")
        : null,
      hasAi
        ? el("button", {
            class: "mini-btn",
            title: "Delete the comments Lain proposed (the anchored text stays)",
            onclick: clearAiNotes,
          }, "Clear AI notes")
        : null,
      hasResolved
        ? el("button", { class: "mini-btn", onclick: clearResolved }, "Clear resolved")
        : null,
    ]);

    const children = [head];
    if (reviewing) {
      const open = openComments();
      const position = open.findIndex((c) => c.id === pane.activeCommentId);
      children.push(el("div", { class: "review-bar" }, [
        el(
          "span",
          { class: "review-count" },
          open.length ? `Open comment ${position + 1} of ${open.length}` : "No open comments"
        ),
        el("span", { class: "panel-head-spacer" }),
        el("button", { class: "mini-btn", title: "Previous open comment", onclick: () => stepReview(-1) }, "‹"),
        el("button", { class: "mini-btn", title: "Next open comment", onclick: () => stepReview(1) }, "›"),
      ]));
    }
    if (composing) children.push(composerEl());

    if (!docId()) {
      children.push(el("p", { class: "empty-hint" }, "Open a document to see its comments."));
    } else if (!items.length && !ctrl()) {
      children.push(el("p", { class: "empty-hint" }, "No comments here."));
    }

    if (items.length) {
      children.push(el("div", { class: "comment-list" }, sorted(items).map((comment) =>
        itemEl(comment, anchored.get(comment.id) || null)
      )));
    } else if (docId()) {
      children.push(el("p", { class: "empty-hint" }, "No comments yet. Select text and press Comment."));
    }

    // Markers with no sidecar body (a hand-edited or externally changed file).
    const known = new Set(items.map((c) => c.id));
    const orphans = ctrl() ? ctrl().getCommentRanges().filter((r) => !known.has(r.cid)) : [];
    if (orphans.length) {
      children.push(el("div", { class: "panel-title", style: { marginTop: "16px" } }, "Unlinked anchors"));
      for (const range of orphans) {
        children.push(el("div", { class: "comment-item orphan" }, [
          el("div", { class: "comment-quote" }, quoteExcerpt(range.text) || "(empty)"),
          el("div", { class: "comment-actions" }, [
            el("button", { class: "mini-btn danger", onclick: () => removeMarker(range.cid) }, "Remove marker"),
          ]),
        ]));
      }
    }

    panel.replaceChildren(...children);
  }

  panel._render = render;
  panel._reload = reload;
  panel.startReview = startReview;
  panel.stopReview = stopReview;
  panel.beginComment = (selection) => {
    composing = selection;
    editingId = null;
    panel.classList.add("open");
    render();
    const box = panel.querySelector(".comment-composer");
    if (box) box.focus();
  };
  return panel;
}
