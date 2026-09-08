# Lain (AI assistant) — code review

A review of the AI stack (`app/ai/**`, `app/routes/ai.py`, `static/js/lain.js`,
`electron/main.js` window hardening) performed ahead of making the app
distributable. Findings are ranked; the first three bugs were fixed in this
round and are marked **[FIXED]**.

---

## Bugs fixed this round

### 1. Deleted sessions leak their attachment storage on disk **[FIXED]**
`app/ai/sessions.py::delete` unlinked only the session's `.json`. Each session
also owns a sibling directory (`data/ai-sessions/<project>/<session>/`) holding
raw uploads, extracted text, and `metadata.json`. Deleting a session left that
directory behind forever, slowly accumulating files (including potentially large
25 MB PDFs/DOCX files) under the project.

**Fix:** `delete()` now also `shutil.rmtree(session_dir(...), ignore_errors=True)`
and cleans up the empty per-project dir. Test added (`tests/test_sessions.py`).

### 2. The 25 MB attachment cap was unreachable (10 MB body limit wins) **[FIXED]**
`app/main.py::_limit_body_size` rejected every request with `Content-Length`
over **10 MB** (`MAX_REQUEST_BYTES`), while `app/ai/attachments.py` documented a
**25 MB** max. In practice an upload over 10 MB was 413'd by the global
middleware before the route's own `MAX_FILE_BYTES` (25 MB) check could ever run —
so the real ceiling was 10 MB, and the "25 MB" limit/config was pure dead config.

**Fix:** `MAX_REQUEST_BYTES` raised to 27 MB (just above the 25 MB attachment
cap), so a full-size upload is expressible and the route-level 25 MB check stays
authoritative. 413 message now states 25 MB. Tests added
(`tests/test_body_limit.py`), including one asserting `MAX_REQUEST_BYTES >
attachments.MAX_FILE_BYTES` so the contradiction can't silently regress.

### 3. Lain chat renders unsanitized raw HTML (XSS from document content) **[FIXED]**
`static/js/lain.js` rendered assistant bubbles and compressed summaries with
`window.marked.parse(...)` assigned through `.innerHTML`. Markdown carries raw
HTML, and Lain reads and quotes the project's own `.md` documents — so a crafted
document (or a Lain reply) could inject `<script>`, `onerror=`, `javascript:`
links, or `<iframe>` into the chat panel. This is a **real** reachable XSS
surface whose source is project-controlled content.

**Fix:** added `static/js/sanitize.js` — an allow-list sanitizer that drops
`script/style/iframe/object/embed/form/svg/math/video/audio` and unknown tags
(keeping their text as inert content), removes `on*` handlers and
`javascript:`/`data:`/`vbscript:` URLs on `<a href>` / `<img src>`, and is applied
in `mdToHTML()` so both bubbles and the compressed summary are covered. Tests in
`tests/sanitize.test.mjs` (run with `npm run test:sanitize`).

Note: chat is an **inert echo** concern, not a code-execution primitive into the
host — Electron already runs with `contextIsolation: true`, `nodeIntegration:
false`, and `sandbox: true`, so a compromised chat panel cannot reach Node. But
it *could* forge UI, steal a typed API key from the settings form, or act on the
user's behalf — the sanitizer closes that hole.

---

## Sound design (no change needed) — worth knowing

- **Context budget guard** — `_estimated_input_tokens` past `MAX_CONTEXT_TOKENS`
  (600k) returns a helpful "compress / new session" message instead of an opaque
  API failure; empty-responses retry (`EMPTY_RESPONSE_RETRIES = 2`) and the
  per-session run guard (`stream.begin_run`) prevent interleaved history writes.
- **Confirmation can't be hallucinated** — edit/rename/move/delete tool *plans*
  are computed from the actual files (real before/after diff, real from→to), and
  execution happens only after the user decides. Good.
- **Scope enforced server-side** — `_validate_plan_scope`/`_require_scope` check
  every planned action against the session's folder allow-list independently of
  the model.
- **`stop_lt_server` semantics** — adopted (already-listening on 8081) LanguageTool
  servers are never killed on exit; only a JVM this app spawned is terminated.
  Correct, avoids orphaning a shared server.
- **System prompt stability** — the fixed instruction block is kept byte-identical
  across sessions/turns so DeepSeek's automatic prefix cache can hit on it; all
  variable content is appended last. **Don't reorder or edit that block casually**
  — any change silently forfeits the cache hit for every future session.

---

## Suggestions / notes (not acted on)

- **Token accounting, labeled** — `_record_turn_usage` sums `prompt/completion`
  while `_effective_tokens` divides cache hits by 50 to approximate spend. This
  "effective" figure deliberately mixes already-summed totals and per-turn counts;
  it's intentional. Add a one-line comment so a future reader doesn't "fix" it.
- **`settings.json` stores keys in plaintext** — already mitigated (responses are
  masked with a sentinel, key-clearing semantics exist, and nothing ever echoes
  a key back). A future keyring/DPAPI store is a nice-to-have, not required.
- **Non-streaming `/ai/chat` route** — kept alongside the SSE stream route; the
  panel uses the stream. Fine to retain for headless/testing consumers.
- **`archived[]` growth** — compression moves older messages into `archived[]`
  forever; each pre-compress history slice is saved in the session JSON, so very
  long conversations grow the file. Not a bug (bounded by session lifetime, and
  `_MAX_SESSIONS` caps the count), but a future "delete archived" would help.
- **`MAX_OUTPUT_TOKENS` = 65536 vs provider ceilings** — DeepSeek/OpenAI cap
  around 200k (DeepSeek v3.2/r.1), so the hard 65k ceiling is safely under the
  provider maximum; leave as-is.

---

## Distribution considerations this review surfaced (addressed in Workstream A)

- Hardened `webPreferences` in `electron/main.js` are already correct for a
  packaged app; do **not** relax `sandbox`/`contextIsolation` when moving to
  electron-builder — a packaged app is a higher-value target.
- Grammar's bundled Java discovery must become layout-aware once the JRE is
  shipped alongside LanguageTool (see `A4`).
- The PyInstaller server must bundle `static/dist/editor.bundle.js` (build the
  frontend before packaging) and the uvicorn hidden imports (`A1`).
