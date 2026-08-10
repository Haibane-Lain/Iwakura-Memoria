"""Writing statistics: daily word counts, goals, and streaks.

Daily totals are derived from the project's append-only ``history.jsonl``
log, written on every document save/creation.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from app import config
from app.services import documents as documents_service


def _history_path(project_id: str) -> Path:
    return config.DATA_DIR / project_id / config.STATS_DIRNAME / config.HISTORY_FILENAME


def _load_history(project_id: str) -> list[dict[str, Any]]:
    path = _history_path(project_id)
    entries: list[dict[str, Any]] = []
    if not path.exists():
        return entries
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries


def _daily_totals(entries: list[dict[str, Any]]) -> dict[str, int]:
    totals: dict[str, int] = defaultdict(int)
    for entry in entries:
        totals[entry.get("date", "")] += int(entry.get("delta", 0))
    return {k: max(0, v) for k, v in totals.items() if k}


def _streak(totals: dict[str, int], goal_per_day: int) -> int:
    if goal_per_day <= 0:
        return 0
    day = date.today()
    if totals.get(day.isoformat(), 0) < goal_per_day:
        day -= timedelta(days=1)
    streak = 0
    while totals.get(day.isoformat(), 0) >= goal_per_day:
        streak += 1
        day -= timedelta(days=1)
    return streak


def get_stats(
    project_id: str, mode: str = "auto", days: int = 30
) -> dict[str, Any]:
    project = documents_service_project(project_id)
    goal = project["goal"]
    goal_per_day = goal.get("wordsPerDay", 0) if goal.get("enabled") else 0

    entries = _load_history(project_id)
    totals = _daily_totals(entries)
    today = date.today().isoformat()
    today_words = totals.get(today, 0)

    total_stats = documents_service.project_word_stats(project_id, mode)
    total_words = total_stats["words"]
    total_docs = total_stats["documents"]

    last_days: list[dict[str, Any]] = []
    for offset in range(days - 1, -1, -1):
        day = (date.today() - timedelta(days=offset)).isoformat()
        last_days.append({"date": day, "words": totals.get(day, 0)})

    return {
        "projectId": project_id,
        "totalWords": total_words,
        "todayWords": today_words,
        "goal": {"enabled": bool(goal.get("enabled")), "wordsPerDay": goal_per_day},
        "goalMetToday": goal_per_day > 0 and today_words >= goal_per_day,
        "progress": round(min(100.0, today_words / goal_per_day * 100), 1)
        if goal_per_day
        else 0.0,
        "streak": _streak(totals, goal_per_day),
        "lastDays": last_days,
        "documents": total_docs,
    }


def documents_service_project(project_id: str) -> dict[str, Any]:
    from app.services import projects

    return projects.get_project(project_id)
