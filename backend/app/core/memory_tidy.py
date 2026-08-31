"""Sleep-time memory tidying (Letta-style offline consolidation).

Add-time dedup only blocks cosine >= 0.92, so phrasing drift that slipped in
across sessions accumulates. This job runs off-hours on the shared scheduler
(default 03:30) or on demand from Settings:

1. cluster semantically near-duplicate memories (cosine >= TIDY_SIMILARITY);
2. ask the LLM to merge each cluster into one concise fact — or keep them all
   when they are genuinely distinct facts; the model may not invent anything;
3. apply merges: the oldest id in a cluster is updated in place (chat recall
   and the vector cache keep referring to a stable id), the rest are deleted.

The last run's report is persisted next to the db for the Settings page.
"""
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.core import memory
from app.core.llm import ProviderInfo, stream_chat
from app.core.prefs import load_config
from app.db import SessionLocal
from app.models import Memory

log = logging.getLogger(__name__)

TIDY_SIMILARITY = 0.86  # below the 0.92 add-time dedup: catch drifted phrasings
MAX_CLUSTERS_PER_RUN = 20  # bound the LLM spend of a single pass
MAX_MERGED_CHARS = 200

_TIDY_SYSTEM = (
    "你负责整理用户的长期记忆库。下面几条记忆被判定为语义高度相似。\n"
    "它们可能是同一事实的不同表述（应合并成一条），也可能是确实不同的两条事实（应全部保留）。\n"
    '只输出一个 JSON 对象，不要解释、不要代码块：\n'
    '  确为同一事实的不同表述：{"action": "merge", "content": "合并后的一句话陈述"}\n'
    '  确为不同的事实：{"action": "keep"}\n'
    "合并时只允许使用原句中出现过的信息，不要新增、推断或遗漏任何事实。"
)


def _cluster(rows: list[Memory], vecs: list[list[float] | None]) -> list[list[int]]:
    """Union-find over pairwise cosine; returns member index groups of size >= 2."""
    parent = list(range(len(rows)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            if vecs[i] is None or vecs[j] is None:
                continue
            if memory._cosine(vecs[i], vecs[j]) >= TIDY_SIMILARITY:
                parent[find(i)] = find(j)

    groups: dict[int, list[int]] = {}
    for i in range(len(rows)):
        groups.setdefault(find(i), []).append(i)
    multi = [g for g in groups.values() if len(g) >= 2]
    multi.sort(key=len, reverse=True)
    return multi


def _parse_merge(raw: str) -> str | None:
    """Extract the merged statement; None = keep / unparseable."""
    m = re.search(r"\{.*\}", raw or "", re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or data.get("action") != "merge":
        return None
    content = str(data.get("content") or "").strip()
    return content[:MAX_MERGED_CHARS] or None


async def _apply_merge(keep_id: int, merged: str, drop_ids: list[int]) -> None:
    async with SessionLocal() as db:
        row = await db.get(Memory, keep_id)
        if row:
            row.content = merged
        for did in drop_ids:
            obj = await db.get(Memory, did)
            if obj:
                await db.delete(obj)
        await db.commit()
    memory._vec_cache.pop(keep_id, None)
    for did in drop_ids:
        memory._vec_cache.pop(did, None)


async def run_tidy() -> dict:
    """One consolidation pass. Returns a report dict; never raises."""
    rows = await memory.list_memories()
    report: dict = {
        "ok": True,
        "ran_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "before": len(rows),
        "after": len(rows),
        "clusters": 0,
        "merged": 0,
        "skipped": 0,
        "details": [],
    }
    if len(rows) < 2:
        report["message"] = "记忆少于 2 条，无需整理"
        _save_report(report)
        return report

    vecs = await memory._vectors_for(rows)
    clusters = _cluster(rows, vecs)
    report["clusters"] = len(clusters)
    if not clusters:
        report["message"] = "没有发现语义相近的记忆簇"
        _save_report(report)
        return report

    writer = await _resolve_writer()
    if not writer:
        report["ok"] = False
        report["error"] = "没有已启用的 provider，无法执行合并"
        _save_report(report)
        return report
    info, model = writer

    for group in clusters[:MAX_CLUSTERS_PER_RUN]:
        members = [rows[i] for i in group]
        listing = "\n".join(f"{n}. {m.content}" for n, m in enumerate(members, 1))
        try:
            chunks = [
                c
                async for c in stream_chat(
                    info,
                    model,
                    [
                        {"role": "system", "content": _TIDY_SYSTEM},
                        {"role": "user", "content": f"记忆列表：\n{listing}"},
                    ],
                )
            ]
            merged = _parse_merge("".join(chunks))
        except Exception:  # noqa: BLE001 - one bad cluster must not stop the pass
            log.warning("tidy merge call failed for cluster %s", group, exc_info=True)
            merged = None

        if not merged:
            report["skipped"] += 1
            continue
        keep, drop = members[0], members[1:]
        await _apply_merge(keep.id, merged, [m.id for m in drop])
        report["merged"] += 1
        report["details"].append(
            {"ids": [m.id for m in members], "from": [m.content for m in members], "into": merged}
        )
        log.info("tidy: merged %d memories into #%d", len(members), keep.id)

    report["after"] = report["before"] - sum(len(d["ids"]) - 1 for d in report["details"])
    _save_report(report)
    return report


async def _resolve_writer() -> tuple[ProviderInfo, str] | None:
    """(ProviderInfo, model) for the tidy writer; None when no provider is on.

    Test seam: monkeypatch me to run merges without a real provider.
    """
    from app.core.digest import _resolve_model_id

    model_id = _resolve_model_id()
    if not model_id:
        return None
    from app.routers.chat import resolve_model

    resolved = await resolve_model(model_id)
    p = resolved.provider
    return ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key), resolved.model


def _report_path():
    """Next to the db so scratch/smoke environments stay isolated."""
    from app.config import settings

    return Path(settings.db_path).parent / "memory_tidy.json"


def _save_report(report: dict) -> None:
    try:
        _report_path().write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        log.warning("could not persist tidy report", exc_info=True)


def last_report() -> dict:
    try:
        return json.loads(_report_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def reschedule() -> None:
    """(Re)register the nightly tidy job from current config."""
    from app.core import scheduler as sched

    cfg = load_config()
    sched.set_daily(
        "memory_tidy",
        _run,
        bool(cfg.get("memory_tidy_enabled")),
        cfg.get("memory_tidy_time") or "03:30",
        default_hour=3,
    )


async def _run() -> None:
    try:
        result = await run_tidy()
        log.info("scheduled memory tidy result: %s", {k: result.get(k) for k in ("ok", "merged", "skipped")})
    except Exception:  # noqa: BLE001 - a failed run must not kill the scheduler
        log.exception("scheduled memory tidy failed")
