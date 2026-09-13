"""Long-running Lain jobs: chunked map -> strict JSON records -> reduce -> write.

A job processes a selection of entries that is far larger than one context
window. Instead of reading everything into one conversation, it:

1. resolves the source entries (ordered, scope-checked),
2. packs them into bounded character chunks (:func:`plan_chunks`),
3. runs one *map* call per chunk with a strict JSON contract, persisting the
   validated records after every chunk (idempotent, resumable), and
4. *reduces* the compact records into a final artifact, which is rendered
   deterministically (never model-authored HTML) and written through the normal
   tool/confirmation path.

The raw prose never accumulates, so a 100-chapter corpus costs ~10 bounded
calls instead of one impossible ~450k-token request. Job state lives at
``data/ai-sessions/<project>/<session>/jobs/<jobId>.json``, inside the session
directory, so it is removed when the session is.
"""
from __future__ import annotations

import json
import re
import uuid
from collections.abc import Iterator
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from app import config
from app.ai import providers, sessions, tools
from app.services import documents as documents_service
from app.services import settings as settings_service

_JOB_ID_RE = re.compile(r"^[a-f0-9]{32}$")

# Chunking / budget limits. Chunks are small enough for a local 32k model and
# large enough that 100 short chapters are ~8-12 map calls.
JOB_CHUNK_CHARS = 24_000
JOB_CHUNK_OVERLAP = 500
JOB_MAX_INPUT_TOKENS = 2_000_000
JOB_CHUNK_MAX_OUTPUT_TOKENS = 4_096
JOB_CHUNK_RETRIES = 2
JOB_MAX_ITEMS_PER_ENTRY = 200
JOB_MAX_CHUNKS = 400
JOB_MAX_JOBS = 20

VALID_KINDS = ("extract", "timeline")
TERMINAL_STATUS = ("done", "failed", "cancelled")


class JobError(Exception):
    pass


class RecordError(Exception):
    """Raised when a map response is not usable JSON / the expected shape."""


# ---------------------------------------------------------------------------
# Record models (the strict JSON contract)
# ---------------------------------------------------------------------------


class RecordItem(BaseModel):
    label: str = ""
    detail: str = ""
    date: str | None = None
    quote: str | None = None
    confidence: float = 1.0
    extra: dict[str, Any] = Field(default_factory=dict)


class EntryRecords(BaseModel):
    entryId: str
    items: list[RecordItem] = Field(default_factory=list)


class TimelineEvent(BaseModel):
    date: str = ""
    event: str = ""
    detail: str | None = None
    section: str | None = None
    chronology: str | None = None
    source: str = ""


class TimelineRecords(BaseModel):
    entryId: str
    items: list[TimelineEvent] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Recipes
# ---------------------------------------------------------------------------

_JSON_RULES = (
    "Output ONLY a single JSON object — no prose, no explanations, no markdown "
    "code fences. If you are unsure, still return valid JSON."
)


class Recipe:
    kind = ""

    def system_prompt(self, job: dict[str, Any]) -> str:
        raise NotImplementedError

    def chunk_user(self, job: dict[str, Any], text: str) -> str:
        raise NotImplementedError

    def repair_user(self, text: str, raw: str, error: str) -> str:
        return (
            "Your previous response was not valid for the required JSON shape.\n"
            f"Error: {error}\n\n"
            f"Previous response:\n{raw[:4000]}\n\n"
            "Return the corrected JSON only, using this source material:\n\n" + text
        )

    def parse(self, raw: str, valid_ids: set[str]) -> list[BaseModel]:
        data = _extract_json(raw)
        if data is None:
            raise RecordError("response was not valid JSON")
        if not isinstance(data, dict):
            raise RecordError("top-level JSON must be an object")
        raw_entries = data.get("entries")
        if not isinstance(raw_entries, list):
            raise RecordError("JSON is missing the 'entries' array")
        out: list[BaseModel] = []
        for raw_entry in raw_entries:
            if not isinstance(raw_entry, dict):
                continue
            entry_id = str(raw_entry.get("entryId") or "").strip()
            if entry_id not in valid_ids:
                continue
            try:
                record = self.record_model.model_validate({**raw_entry, "entryId": entry_id})
            except ValidationError:
                continue
            items = []
            for item in record.items[:JOB_MAX_ITEMS_PER_ENTRY]:
                cleaned = self.clean_item(item)
                if cleaned is not None:
                    items.append(cleaned)
            if items:
                out.append(record.model_copy(update={"items": items}))
        return out

    def clean_item(self, item: BaseModel) -> BaseModel | None:
        raise NotImplementedError

    def reduce(self, job: dict[str, Any], records: list[dict[str, Any]]) -> dict[str, Any]:
        raise NotImplementedError

    def render(self, job: dict[str, Any], artifact: dict[str, Any]) -> str:
        raise NotImplementedError

    def output_title(self, job: dict[str, Any]) -> str:
        return str(job["options"].get("outputTitle") or f"Lain {self.kind}")


class ExtractRecipe(Recipe):
    kind = "extract"
    record_model = EntryRecords

    def system_prompt(self, job: dict[str, Any]) -> str:
        instruction = (job.get("instruction") or "Extract the notable facts.").strip()
        return (
            "You are a precise information extractor for a writer's project. You read "
            "the provided entries and return structured records. You never invent facts "
            "that are not supported by the text.\n\n"
            f"The user's extraction request: {instruction}\n\n"
            "Return this exact shape:\n"
            '{"entries": [{"entryId": "<id exactly as given>", "items": ['
            '{"label": "<short name>", "detail": "<one or two sentences>", '
            '"date": null, "quote": null, "confidence": 1.0}]}]}\n\n'
            "Rules:\n"
            "- Use one object per entry that has relevant content; omit irrelevant entries.\n"
            "- entryId must be copied exactly from the <entry id=\"...\"> tag.\n"
            "- label is a short name (entity, event, concept); detail is one or two sentences.\n"
            "- date is the date/time exactly as written, or null. quote is a short verbatim "
            "snippet, or null. confidence is 0.0-1.0.\n"
            "- Never include anything not supported by the text.\n"
            f"- {_JSON_RULES}"
        )

    def chunk_user(self, job: dict[str, Any], text: str) -> str:
        return "Extract records from these entries.\n\n" + text

    def clean_item(self, item: RecordItem) -> RecordItem | None:
        label = " ".join((item.label or "").split())
        detail = " ".join((item.detail or "").split())
        if not label and not detail:
            return None
        try:
            confidence = min(1.0, max(0.0, float(item.confidence)))
        except (TypeError, ValueError):
            confidence = 1.0
        return item.model_copy(
            update={
                "label": label,
                "detail": detail,
                "date": _clean_optional(item.date),
                "quote": _clean_optional(item.quote),
                "confidence": confidence,
            }
        )

    def reduce(self, job: dict[str, Any], records: list[dict[str, Any]]) -> dict[str, Any]:
        titles = job.get("source", {}).get("titles") or {}
        lines: list[str] = []
        for record in records:
            entry_id = record.get("entryId", "")
            lines.append(f"## {titles.get(entry_id) or entry_id}")
            for item in record.get("items", []):
                date = f" ({item['date']})" if item.get("date") else ""
                label = item.get("label") or ""
                detail = item.get("detail") or ""
                bullet = f"- **{label}**{date} — {detail}" if label else f"- {detail}{date}"
                lines.append(bullet.strip())
                if item.get("quote"):
                    lines.append(f"  > {item['quote']}")
            lines.append("")
        markdown = "\n".join(lines).strip() or "_No records were extracted._"
        return {"markdown": markdown}

    def render(self, job: dict[str, Any], artifact: dict[str, Any]) -> str:
        title = self.output_title(job)
        return f"# {title}\n\n{artifact.get('markdown', '').strip()}\n"


class TimelineRecipe(Recipe):
    kind = "timeline"
    record_model = TimelineRecords

    def system_prompt(self, job: dict[str, Any]) -> str:
        return (
            "You are a precise chronology extractor for a writer's project. You read the "
            "provided entries and extract every dated or time-ordered event. You never "
            "invent events that are not supported by the text.\n\n"
            "Return this exact shape:\n"
            '{"entries": [{"entryId": "<id exactly as given>", "items": ['
            '{"date": "<as written>", "event": "<one line>", "detail": null, '
            '"section": "<era/act/book or null>", "chronology": "<sortable key or null>"}]}]}\n\n'
            "Rules:\n"
            "- Use one object per entry; omit entries with no events.\n"
            "- entryId must be copied exactly from the <entry id=\"...\"> tag.\n"
            "- date is the date/time exactly as written (e.g. 'TA 300', 'three days after "
            "the fall'). event is one line. detail is optional context.\n"
            "- section groups events (an era, act, or book); use null when unsure.\n"
            "- chronology is your best sortable key for the event (e.g. 'TA 300.2'); use "
            "null when the event cannot be ordered.\n"
            "- Never include an event that is not in the text.\n"
            f"- {_JSON_RULES}"
        )

    def chunk_user(self, job: dict[str, Any], text: str) -> str:
        return "Extract every dated or time-ordered event from these entries.\n\n" + text

    def clean_item(self, item: TimelineEvent) -> TimelineEvent | None:
        event = " ".join((item.event or "").split())
        date = " ".join((item.date or "").split())
        if not event and not date:
            return None
        return item.model_copy(
            update={
                "event": event or date,
                "date": date,
                "detail": _clean_optional(item.detail),
                "section": _clean_optional(item.section),
                "chronology": _clean_optional(item.chronology),
            }
        )

    def reduce(self, job: dict[str, Any], records: list[dict[str, Any]]) -> dict[str, Any]:
        section_events: dict[str, list[dict[str, Any]]] = {}
        order: list[str] = []
        seen: set[tuple[str, str]] = set()
        for record in records:
            for item in record.get("items", []):
                event = " ".join((item.get("event") or "").split())
                if not event:
                    continue
                section = " ".join((item.get("section") or "").split())
                key = (section.lower(), re.sub(r"\W+", " ", event.lower()).strip())
                if key in seen:
                    continue
                seen.add(key)
                if section not in section_events:
                    section_events[section] = []
                    order.append(section)
                section_events[section].append(
                    {
                        "date": " ".join((item.get("date") or "").split()),
                        "body": event,
                        "_chrono": item.get("chronology") or item.get("date") or "",
                    }
                )
        chronological = bool(job["options"].get("chronological", True))
        sections: list[dict[str, Any]] = []
        for section in order:
            events = section_events[section]
            if chronological:
                events = sorted(events, key=_chrono_sort_key)
            for event in events:
                event.pop("_chrono", None)
            sections.append({"name": section, "events": events})
        return {"title": self.output_title(job), "sections": sections}

    def render(self, job: dict[str, Any], artifact: dict[str, Any]) -> str:
        return render_timeline(artifact)


RECIPES: dict[str, Recipe] = {
    "extract": ExtractRecipe(),
    "timeline": TimelineRecipe(),
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text or None


def _extract_json(raw: str) -> Any:
    """Parse JSON from a model reply, tolerating fences and surrounding prose."""
    if not raw:
        return None
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
    return None


def _chrono_sort_key(event: dict[str, Any]) -> tuple[int, int, int]:
    match = re.search(r"\d+", str(event.get("_chrono") or ""))
    if match:
        return (0, int(match.group()), 0)
    return (1, 0, 0)


def _inline_html(text: str) -> str:
    """Escape one cell's text for the raw-HTML timeline block.

    The interior of a timeline is not parsed as Markdown, so text is escaped and
    newlines become ``<br>``. No blank lines are ever produced (they would end
    the block).
    """
    escaped = (
        str(text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    return escaped.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>")


def render_timeline(artifact: dict[str, Any]) -> str:
    """Render a timeline artifact to the editor's raw-HTML contract.

    Mirrors ``client/timeline.js`` exactly: same tags, same class names, no blank
    lines, ``colspan="2"`` headings, ``<td>`` event cells.
    """
    lines = ['<aside class="timeline">', '<table class="tl-rows">']
    lines.append(
        f'<tr class="tl-title"><th colspan="2">{_inline_html(artifact.get("title") or "Timeline")}</th></tr>'
    )
    for section in artifact.get("sections", []):
        if section.get("name"):
            lines.append(
                f'<tr class="tl-section"><th colspan="2">{_inline_html(section["name"])}</th></tr>'
            )
        for event in section.get("events", []):
            lines.append(
                '<tr class="tl-event"><td class="tl-date">'
                f'{_inline_html(event.get("date"))}</td><td class="tl-body">'
                f'{_inline_html(event.get("body"))}</td></tr>'
            )
    lines.append("</table>")
    lines.append("</aside>")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def _jobs_dir(project_id: str, session_id: str) -> Any:
    return sessions.session_dir(project_id, session_id) / "jobs"


def _job_path(project_id: str, session_id: str, job_id: str) -> Any:
    if not _JOB_ID_RE.match(job_id):
        raise ValueError("Invalid job id")
    return _jobs_dir(project_id, session_id) / f"{job_id}.json"


def save_job(project_id: str, session_id: str, job: dict[str, Any]) -> None:
    job["updatedAt"] = _now()
    path = _job_path(project_id, session_id, job["jobId"])
    path.parent.mkdir(parents=True, exist_ok=True)
    config._write_atomic(path, json.dumps(job, ensure_ascii=False, indent=2))


def load_job(project_id: str, session_id: str, job_id: str) -> dict[str, Any] | None:
    path = _job_path(project_id, session_id, job_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def list_jobs(project_id: str, session_id: str) -> list[dict[str, Any]]:
    directory = _jobs_dir(project_id, session_id)
    if not directory.exists():
        return []
    jobs: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            jobs.append(json.loads(path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            continue
    return jobs


def delete_job(project_id: str, session_id: str, job_id: str) -> bool:
    path = _job_path(project_id, session_id, job_id)
    if not path.exists():
        return False
    path.unlink()
    return True


def _public_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for record in records:
        for item in record.get("items", []):
            merged = dict(item)
            merged["entryId"] = record.get("entryId", "")
            out.append(merged)
    return out


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    """Serializable snapshot for the API (raw per-chunk records omitted)."""
    chunks = job.get("chunks") or []
    results = job.get("chunkResults") or {}
    done = sum(1 for c in chunks if (results.get(str(c["index"])) or {}).get("status") == "done")
    failed = sum(1 for c in chunks if (results.get(str(c["index"])) or {}).get("status") == "failed")
    records = _all_records(job)
    return {
        "jobId": job.get("jobId"),
        "kind": job.get("kind"),
        "status": job.get("status"),
        "createdAt": job.get("createdAt"),
        "updatedAt": job.get("updatedAt"),
        "instruction": job.get("instruction", ""),
        "options": job.get("options", {}),
        "source": {
            "folders": (job.get("source") or {}).get("folders", []),
            "entries": (job.get("source") or {}).get("entries", []),
        },
        "progress": {
            "chunksTotal": len(chunks),
            "chunksDone": done,
            "chunksFailed": failed,
            "items": len(records),
        },
        "reduce": {
            "status": (job.get("reduce") or {}).get("status"),
            "artifact": (job.get("reduce") or {}).get("artifact"),
        },
        "output": job.get("output"),
        "error": job.get("error"),
    }


def _all_records(job: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for index in sorted((job.get("chunkResults") or {}), key=lambda k: int(k)):
        result = job["chunkResults"][index]
        if result.get("status") == "done":
            records.extend(result.get("records") or [])
    return records


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------


def resolve_entries(
    project_id: str,
    scope: list[str] | None,
    folders: list[str] | None = None,
    entries: list[str] | None = None,
    fallback_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Ordered, scope-checked entries (with bodies) for a job's source."""
    if entries:
        docs = documents_service.iter_documents(project_id, folders=[], documents=list(entries))
    elif folders:
        mapped = ["." if root == "" else root for root in folders]
        docs = documents_service.iter_documents(project_id, folders=mapped, documents=[])
    elif fallback_ids:
        docs = documents_service.iter_documents(project_id, folders=[], documents=list(fallback_ids))
    else:
        mapped = ["." if root == "" else root for root in (scope or [])]
        docs = documents_service.iter_documents(project_id, folders=mapped, documents=[])
    out: list[dict[str, Any]] = []
    for doc in docs:
        if not tools._scope_ok(scope, doc["id"]):
            continue
        body = doc.get("body") or ""
        out.append(
            {
                "id": doc["id"],
                "title": doc.get("title") or doc["id"],
                "chars": len(body),
                "words": documents_service.count_words(body),
                "body": body,
            }
        )
    return out


def plan_chunks(entries: list[dict[str, Any]], chunk_chars: int = JOB_CHUNK_CHARS) -> list[dict[str, Any]]:
    """Pack entries into bounded chunks, splitting only oversized entries."""
    chunk_chars = max(1, int(chunk_chars))
    overlap = min(JOB_CHUNK_OVERLAP, chunk_chars - 1) if chunk_chars > 1 else 0
    chunks: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    current_chars = 0

    def flush() -> None:
        nonlocal current, current_chars
        if current:
            chunks.append({"index": len(chunks), "items": current, "chars": current_chars})
            current = []
            current_chars = 0

    for entry in entries:
        body = entry["body"]
        size = len(body)
        if size <= chunk_chars:
            if current and current_chars + size > chunk_chars:
                flush()
            current.append({"id": entry["id"], "start": 0, "end": None})
            current_chars += size
            continue
        flush()
        start = 0
        while start < size:
            end = min(size, start + chunk_chars)
            chunks.append(
                {
                    "index": len(chunks),
                    "items": [{"id": entry["id"], "start": start, "end": end}],
                    "chars": end - start,
                }
            )
            if end >= size:
                break
            start = end - overlap
    flush()
    return chunks


def create_job(
    project_id: str,
    session: dict[str, Any],
    kind: str,
    *,
    folders: list[str] | None = None,
    entries: list[str] | None = None,
    instruction: str = "",
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if kind not in VALID_KINDS:
        raise JobError(f"Unknown job kind '{kind}'")
    if kind == "extract" and not (instruction or "").strip():
        raise JobError("An extraction instruction is required")
    opts = dict(options or {})
    opts.setdefault("chunkChars", JOB_CHUNK_CHARS)
    opts.setdefault("maxInputTokens", JOB_MAX_INPUT_TOKENS)
    try:
        chunk_chars = max(1, int(opts["chunkChars"]))
    except (TypeError, ValueError):
        chunk_chars = JOB_CHUNK_CHARS
    try:
        max_input_tokens = max(1, int(opts["maxInputTokens"]))
    except (TypeError, ValueError):
        max_input_tokens = JOB_MAX_INPUT_TOKENS
    opts["chunkChars"] = chunk_chars
    opts["maxInputTokens"] = max_input_tokens
    if kind == "timeline":
        opts.setdefault("chronological", True)

    scope = session.get("scope")
    fallback = sessions.session_selected_entries(session) if sessions.session_mode(session) == "simple" else None
    resolved = resolve_entries(project_id, scope, folders, entries, fallback_ids=fallback)
    if not resolved:
        raise JobError("No entries matched — pick a folder or entries that Lain can access.")

    chunks = plan_chunks(resolved, chunk_chars)
    if len(chunks) > JOB_MAX_CHUNKS:
        raise JobError(
            f"That selection needs {len(chunks)} chunks (limit {JOB_MAX_CHUNKS}). "
            "Choose a smaller folder."
        )
    estimated = sum(c["chars"] for c in chunks) // 4
    if estimated > max_input_tokens:
        raise JobError(
            f"That selection is about {estimated:,} tokens of input, over the "
            f"{max_input_tokens:,} budget. Choose a smaller folder."
        )

    now = _now()
    job = {
        "jobId": uuid.uuid4().hex,
        "kind": kind,
        "status": "pending",
        "createdAt": now,
        "updatedAt": now,
        "instruction": (instruction or "").strip(),
        "options": opts,
        "source": {
            "folders": list(folders or []),
            "entries": [e["id"] for e in resolved],
            "titles": {e["id"]: e["title"] for e in resolved},
            "fingerprint": {e["id"]: e["words"] for e in resolved},
        },
        "chunks": chunks,
        "chunkResults": {},
        "reduce": {"status": "pending", "artifact": None},
        "output": None,
        "usage": {},
        "error": None,
    }
    save_job(project_id, session["sessionId"], job)
    _cleanup(project_id, session["sessionId"])
    return job


def _cleanup(project_id: str, session_id: str) -> None:
    directory = _jobs_dir(project_id, session_id)
    if not directory.exists():
        return
    paths = sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in paths[JOB_MAX_JOBS:]:
        try:
            path.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------


def _load_bodies(project_id: str, ids: list[str]) -> dict[str, dict[str, Any]]:
    bodies: dict[str, dict[str, Any]] = {}
    for entry_id in ids:
        try:
            doc = documents_service.get_document(project_id, entry_id)
        except (FileNotFoundError, ValueError):
            continue
        body = doc.get("content") or ""
        bodies[entry_id] = {
            "title": doc.get("title") or entry_id,
            "body": body,
            "words": documents_service.count_words(body),
        }
    return bodies


def _chunk_text(chunk: dict[str, Any], bodies: dict[str, dict[str, Any]]) -> str:
    parts: list[str] = []
    for item in chunk["items"]:
        body = bodies.get(item["id"])
        if body is None:
            continue
        text = body["body"]
        start = item.get("start") or 0
        end = item.get("end")
        segment = text[start:end] if end is not None else text[start:]
        parts.append(f'<entry id="{item["id"]}" title="{body["title"]}">\n{segment}\n</entry>')
    return "\n\n".join(parts)


def _call_json(
    client: providers.AIClient,
    system: str,
    user: str,
    max_tokens: int,
) -> tuple[str, dict[str, Any] | None]:
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    kwargs: dict[str, Any] = {}
    if getattr(client, "supports_json_mode", False):
        kwargs["response_format"] = {"type": "json_object"}
    response = client.chat(messages, temperature=0.1, max_tokens=max_tokens, **kwargs)
    return (response.get("content") or "").strip(), response.get("usage")


def _extract_chunk(
    client: providers.AIClient,
    recipe: Recipe,
    job: dict[str, Any],
    chunk: dict[str, Any],
    bodies: dict[str, dict[str, Any]],
) -> tuple[list[BaseModel], dict[str, Any] | None]:
    text = _chunk_text(chunk, bodies)
    valid_ids = {item["id"] for item in chunk["items"]}
    system = recipe.system_prompt(job)
    user = recipe.chunk_user(job, text)
    last_error = "unknown error"
    usage: dict[str, Any] | None = None
    for attempt in range(JOB_CHUNK_RETRIES + 1):
        raw, usage = _call_json(client, system, user, JOB_CHUNK_MAX_OUTPUT_TOKENS)
        try:
            return recipe.parse(raw, valid_ids), usage
        except RecordError as exc:
            last_error = str(exc)
            if attempt < JOB_CHUNK_RETRIES:
                user = recipe.repair_user(text, raw, last_error)
    raise RecordError(last_error)


def _apply_output(
    project_id: str,
    session: dict[str, Any],
    job: dict[str, Any],
    content: str,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Write a finished artifact. Returns (pending_payload, action).

    On Plan access nothing is written: the artifact is stored and the job waits
    for Write access. In Write access a new entry is created immediately, or an
    existing ``outputEntryId`` is appended to via the normal confirmation.
    """
    recipe = RECIPES[job["kind"]]
    title = recipe.output_title(job)
    access = sessions.session_access(session)
    if access != "write":
        job["output"] = {"status": "pending_access", "title": title, "entryId": None}
        return None, None

    scope = session.get("scope")
    mode = sessions.session_mode(session)
    session_id = session.get("sessionId")
    target = job["options"].get("outputEntryId")
    if target:
        args: dict[str, Any] = {"entryId": target, "content": content, "append": True}
        name = "edit_entry"
    else:
        folder = job["options"].get("outputFolder")
        if folder is None:
            scope_list = scope or []
            folder = "" if "" in scope_list else (scope_list[0] if scope_list else "")
        args = {"title": title, "kind": "note", "folder": folder, "content": content}
        name = "create_entry"
    result = tools.dispatch(
        name,
        args,
        project_id,
        scope,
        session_id=session_id,
        mode=mode,
        access=access,
    )
    if isinstance(result, tools.PendingAction):
        session["agentState"] = {
            "messages": [],
            "pending": {
                "name": name,
                "args": args,
                "payload": result.payload,
                "toolCallId": f"job-{job['jobId']}",
                "message": None,
            },
            "deferred": [],
        }
        sessions.save(project_id, session)
        job["output"] = {"status": "pending_confirmation", "title": title, "entryId": target}
        return result.payload, None
    _, action = result
    job["output"] = {
        "status": "written",
        "title": title,
        "entryId": (action or {}).get("id") or target,
    }
    return None, action


def apply_job(project_id: str, session: dict[str, Any], job: dict[str, Any]) -> dict[str, Any]:
    """Apply an already-reduced job (used after switching to Write access)."""
    if (job.get("reduce") or {}).get("status") != "done":
        raise JobError("The job has not finished reducing yet")
    recipe = RECIPES[job["kind"]]
    content = recipe.render(job, job["reduce"]["artifact"])
    pending, action = _apply_output(project_id, session, job, content)
    if job.get("output", {}).get("status") == "pending_access":
        raise JobError("Switch Access to Write to apply this job's result.")
    save_job(project_id, session["sessionId"], job)
    return {"pending": pending, "action": action, "job": public_job(job)}


def run_job(
    project_id: str,
    session: dict[str, Any],
    job: dict[str, Any],
    cancelled: Any = None,
) -> Iterator[dict[str, Any]]:
    """Run (or resume) a job, yielding progress events; the last is ``job_done``."""
    session_id = session["sessionId"]
    recipe = RECIPES[job["kind"]]
    settings = settings_service.get_settings()
    client = providers.get_client(settings, session_id=str(session_id))

    def _cancelled() -> bool:
        return bool(cancelled is not None and cancelled.is_set())

    yield {"type": "job_start", "job": public_job(job)}
    if job["status"] in TERMINAL_STATUS:
        job["status"] = "paused"

    source_ids = list((job.get("source") or {}).get("entries") or [])
    bodies = _load_bodies(project_id, source_ids)

    # Invalidate chunks whose entries changed since they were extracted.
    old_fingerprint = (job.get("source") or {}).get("fingerprint") or {}
    changed = {
        entry_id
        for entry_id, body in bodies.items()
        if old_fingerprint.get(entry_id) not in (None, body["words"])
    }
    if changed:
        for chunk in job["chunks"]:
            if any(item["id"] in changed for item in chunk["items"]):
                job["chunkResults"].pop(str(chunk["index"]), None)
    job["source"]["fingerprint"] = {entry_id: body["words"] for entry_id, body in bodies.items()}

    job["status"] = "running"
    job["error"] = None
    save_job(project_id, session_id, job)

    try:
        for chunk in job["chunks"]:
            if _cancelled():
                job["status"] = "paused"
                save_job(project_id, session_id, job)
                yield {"type": "job_paused", "job": public_job(job)}
                return
            index = str(chunk["index"])
            if (job["chunkResults"].get(index) or {}).get("status") == "done":
                continue
            yield {
                "type": "job_chunk_start",
                "index": chunk["index"],
                "total": len(job["chunks"]),
                "entryIds": [item["id"] for item in chunk["items"]],
            }
            try:
                records, usage = _extract_chunk(client, recipe, job, chunk, bodies)
            except Exception as exc:  # noqa: BLE001 — one bad chunk must not kill the job
                job["chunkResults"][index] = {"status": "failed", "error": str(exc)}
                _record_usage(job, usage=None)
                save_job(project_id, session_id, job)
                yield {
                    "type": "job_chunk_failed",
                    "index": chunk["index"],
                    "total": len(job["chunks"]),
                    "error": str(exc),
                }
                continue
            job["chunkResults"][index] = {
                "status": "done",
                "records": [record.model_dump() for record in records],
            }
            _record_usage(job, usage)
            save_job(project_id, session_id, job)
            yield {
                "type": "job_chunk_done",
                "index": chunk["index"],
                "total": len(job["chunks"]),
                "items": sum(len(record.items) for record in records),
            }

            if _cancelled():
                job["status"] = "paused"
                save_job(project_id, session_id, job)
                yield {"type": "job_paused", "job": public_job(job)}
                return

        if _cancelled():
            job["status"] = "paused"
            save_job(project_id, session_id, job)
            yield {"type": "job_paused", "job": public_job(job)}
            return

        records = _all_records(job)
        yield {"type": "job_reduce_start", "total": len(records)}
        artifact = recipe.reduce(job, records)
        job["reduce"] = {"status": "done", "artifact": artifact}
        content = recipe.render(job, artifact)
        pending, action = _apply_output(project_id, session, job, content)
        job["status"] = "done"
        save_job(project_id, session_id, job)
        yield {
            "type": "job_done",
            "job": public_job(job),
            "artifact": artifact,
            "pending": pending,
            "actions": [action] if action else [],
        }
    except Exception as exc:  # noqa: BLE001 — surface any failure as a job error
        job["status"] = "failed"
        job["error"] = str(exc)
        save_job(project_id, session_id, job)
        yield {"type": "job_error", "message": str(exc), "job": public_job(job)}


def _record_usage(job: dict[str, Any], usage: dict[str, Any] | None) -> None:
    if not usage:
        return
    current = job.get("usage") or {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        current[key] = int(current.get(key, 0)) + int(usage.get(key) or 0)
    job["usage"] = current
