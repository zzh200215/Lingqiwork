"""回合账本（W5）：一次聊天回合为什么慢、为什么贵、为什么没落盘。

**它补的是缺口二。** 界面上看得到调了哪些工具，但**不落任何记录**：没有工具耗时/参数与
结果的大小、没有轮数、没有「这一轮为什么没存」。upgrade-plan 那一轮的每一个结论都是临时
脚本量出来的，量完就散 —— 光为了量一件事就临时搭了 `measure.py` + 一个 Playwright 脚本。

**红线（照 `quality.py`）**：这是**诊断工具，不是考核仪表**。不设目标、不催、不做排行榜。
所以这里的接口只做两件事：老老实实记一条、把它读出来。

**为什么用 `usage_ledger` 的 span 而不另造机制**（方案 §2.1 的缝二）：聊天本来就有自己的
账本（`messages.tokens_in/out`），所以 `note()` 在这条路上是空转 —— 那条缝特意留着的。
这里只需要在 span 里**挂一个开始时刻**，回合结束时把 trace 落一行。

**失败不许影响正在做的事**：落 trace 是 best-effort，和零柒说一句话同级。
"""
from __future__ import annotations

import json
import logging
import time
from contextlib import asynccontextmanager
from contextvars import ContextVar

log = logging.getLogger(__name__)

# 当前回合的 trace 草稿。`begin()` 放进去，`finish()` 取出来落库。
_pending: ContextVar[dict | None] = ContextVar("wb_turn_trace", default=None)


def _int(value) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def prompt_sha() -> str:
    """这一轮输出规矩的指纹 —— **和 `core/prompts.py` 同一个算法**（sha256 前 12 位）。

    同一把 key 才能让「回合行为」与 `ArtifactFeedback`（人点的满意率）对照起来，
    那是 upgrade-plan §2.1 明确要复用的缝。
    """
    try:
        from app.core import prompts

        for p in prompts.inventory():
            if p.module == "app.routers.chat" and p.name == "_OUTPUT_RULE":
                return p.sha
    except Exception:  # noqa: BLE001 - 指纹拿不到不该挡住记账
        log.debug("turn_trace prompt sha unavailable", exc_info=True)
    return ""


def begin(conversation_id: int | None = None, model_id: str = "") -> dict:
    """开一次记账（在 `usage_ledger.span` 里调）。返回草稿，供后面 `finish`。"""
    from app.core import usage_ledger

    draft = {
        "conversation_id": conversation_id,
        "model_id": model_id,
        "prompt_sha": prompt_sha(),
        "route_level": "",
        "route_kind": "",
        "rounds": 0,
        "tool_calls": [],
        "tokens_in": 0,
        "tokens_out": 0,
        "artifacts": [],
        "answer_chars": 0,
        "claim_checked": False,
        "claim_truthful": True,
        "retried": 0,
        "quality": {},
        "error": "",
        "_t0": time.monotonic(),
        "_usage_active": usage_ledger.active(),
    }
    _pending.set(draft)
    return draft


def current() -> dict | None:
    """当前回合的草稿（`llm.run_agentic_chat` 的 `trace=` 用它）。"""
    return _pending.get()


def claims_a_save_without_one(content: str, artifacts: list | None) -> bool:
    """薄壳，指向 `routers.chat` 里那**唯一一份**判定。

    不在这里重写一遍：那是同一个判断，两份实现迟早分叉，而分叉的那天「谎报率」这个数
    就没人敢信了。
    """
    from app.routers.chat import claims_a_save_without_one as judge

    return judge(content, artifacts)


def note_claim(draft: dict | None, content: str, artifacts: list | None) -> bool:
    """校验「声称存了」这件事，并把结论写进草稿。返回是否属实。"""
    if draft is None:
        return True
    truthful = not claims_a_save_without_one(content, artifacts)
    draft["claim_checked"] = True
    draft["claim_truthful"] = truthful
    return truthful


async def finish(draft: dict | None, *, usage: dict | None = None, error: str = "") -> dict | None:
    """落一行。**best-effort**：失败只记日志，绝不往上抛。"""
    if draft is None:
        return None
    try:
        row = await _write(draft, usage or {}, error)
        return row
    except Exception:  # noqa: BLE001 - 记账失败绝不能影响已经答完的那一轮
        log.warning("turn trace write failed", exc_info=True)
        return None
    finally:
        _pending.set(None)


async def _write(draft: dict, usage: dict, error: str) -> dict:
    from app.db import SessionLocal
    from app.models import TurnTrace

    tin = _int(usage.get("input")) or _int(draft.get("tokens_in"))
    tout = _int(usage.get("output")) or _int(draft.get("tokens_out"))
    seconds = round(time.monotonic() - float(draft.get("_t0") or time.monotonic()), 2)
    row = TurnTrace(
        conversation_id=draft.get("conversation_id"),
        model_id=(draft.get("model_id") or "")[:120],
        prompt_sha=draft.get("prompt_sha") or "",
        route_level=(draft.get("route_level") or "")[:20],
        route_kind=(draft.get("route_kind") or "")[:30],
        rounds=_int(draft.get("rounds")),
        tool_calls_json=json.dumps(draft.get("tool_calls") or [], ensure_ascii=False),
        tokens_in=tin,
        tokens_out=tout,
        artifacts_json=json.dumps(draft.get("artifacts") or [], ensure_ascii=False),
        answer_chars=_int(draft.get("answer_chars")),
        claim_checked=bool(draft.get("claim_checked")),
        claim_truthful=bool(draft.get("claim_truthful", True)),
        retried=_int(draft.get("retried")),
        quality_json=json.dumps(draft.get("quality") or {}, ensure_ascii=False),
        seconds=seconds,
        error=(error or draft.get("error") or "")[:500],
    )
    async with SessionLocal() as db:
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return _view(row)


def _view(row) -> dict:
    from app.models import iso_utc

    out = {
        "id": row.id,
        "at": iso_utc(row.created_at),
        "conversation_id": row.conversation_id,
        "message_id": row.message_id,
        "model_id": row.model_id,
        "prompt_sha": row.prompt_sha,
        "route_level": row.route_level,
        "route_kind": row.route_kind,
        "rounds": row.rounds,
        "tool_calls": _load(row.tool_calls_json, []),
        "tokens_in": row.tokens_in,
        "tokens_out": row.tokens_out,
        "artifacts": _load(row.artifacts_json, []),
        "answer_chars": row.answer_chars,
        "claim_checked": bool(row.claim_checked),
        "claim_truthful": bool(row.claim_truthful),
        "retried": row.retried,
        "quality": _load(getattr(row, "quality_json", None), {}),
        "seconds": row.seconds,
        "error": row.error,
    }
    # **毛病在这一处判定，界面只负责显示。** 让界面自己再算一遍「算不算谎报」，
    # 就是同一个判断的第二份实现 —— 两份分叉的那天，这个数就没人敢信了。
    out["flags"] = [f["key"] for f in FILTERS if _matches(out, f["key"])]
    return out


def _load(raw: str, fallback):
    try:
        out = json.loads(raw or "")
    except (TypeError, ValueError):
        return fallback
    return out if isinstance(out, type(fallback)) else fallback


@asynccontextmanager
async def turn(conversation_id: int | None = None, model_id: str = ""):
    """开一次记账，退出时落库 —— 用法与 `usage_ledger.span` 同一形状。

    回合中途抛异常也落（`error` 记着），「这一轮炸了」恰恰是最该留下记录的那一种。
    """
    draft = begin(conversation_id, model_id)
    try:
        yield draft
    finally:
        await finish(draft)


async def recent(limit: int = 50, only: str = "") -> dict:
    """最近若干回合。`only` 按**看得懂的那几种毛病**筛 —— 这是这一页存在的全部理由。

    筛选项就是升级计划里实测到的那几类：`lie`（声称存了没存）、`no_save`（长正文没落盘）、
    `multi`（一轮多份）、`slow`、`expensive`、`error`。不筛「好回合」——这里没有好回合，
    只有事实。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import TurnTrace

    n = max(1, min(int(limit or 50), 500))
    async with SessionLocal() as db:
        rows = (
            await db.execute(select(TurnTrace).order_by(TurnTrace.id.desc()).limit(n * 4 if only else n))
        ).scalars().all()

    items = [_view(r) for r in rows]
    if only:
        items = [t for t in items if _matches(t, only)][:n]
    return {"traces": items, "filters": FILTERS, "only": only}


# 每一条都是**实测到的**一类毛病（upgrade-plan 的缺口三 / 四），不是想象出来的。
FILTERS: list[dict] = [
    {"key": "lie", "label": "声称存了没存", "hint": "校验过的回合里，说了已存入但这一轮没落盘"},
    {"key": "no_save", "label": "长正文没落盘", "hint": "正文很长、却没有任何产出回执"},
    {"key": "retried", "label": "补跑过", "hint": "服务端判定没落盘，替它重跑了一次（W2a）"},
    {"key": "repaired", "label": "补跑补上了", "hint": "补跑那一轮真的落盘了（长文没留在对话里）"},
    {"key": "invented_path", "label": "报了个不存在的路径", "hint": "回复里写的产出路径不在这一轮的回执里（点开即 404）"},
    {"key": "dropped_receipt", "label": "回执没给出去", "hint": "回执路径过不了白名单（不在 vault 里 / 盘上没有），界面不渲染成链接"},
    {"key": "over", "label": "超了字数预算", "hint": "用户在那一句里给了字数，服务端数出来超过了（W4）"},
    {"key": "rewrote", "label": "为字数重写过", "hint": "同一轮里落盘 ≥2 次（每多一版都是多一次生成，要用户付钱）"},
    {"key": "multi", "label": "一轮多份", "hint": "同一轮落了不止一份产出"},
    {"key": "slow", "label": "慢", "hint": "这一轮超过 10 秒"},
    {"key": "expensive", "label": "贵", "hint": "输出 token 超过 1600"},
    {"key": "error", "label": "出错", "hint": "这一轮以错误结束"},
]

LONG_BODY_CHARS = 400  # 与 W2a 的判据同一个阈值（超过它还没有回执 = 该存没存）
SLOW_SECONDS = 10.0
EXPENSIVE_OUT = 1600


def _matches(t: dict, key: str) -> bool:
    if key == "lie":
        return bool(t["claim_checked"]) and not t["claim_truthful"]
    if key == "no_save":
        # **同一件判断只有一份实现**：W2a 之后，服务端当场判的结论记在 `quality.findings`
        # 里（与 W1 评测共用 `core/turn_quality.py`），这里读它。W2a 之前写下的老行没有
        # 这一项，才回落到「长度 + 有没有回执」这条当时的事实列上。
        q = t.get("quality") or {}
        if q.get("findings") is not None:
            return any(f.get("code") == "long_body_without_a_receipt" for f in q["findings"])
        return not t["artifacts"] and _int(t.get("answer_chars")) >= LONG_BODY_CHARS
    # W2a：补跑过 / 补跑补上了 / 报了个不存在的路径 / 回执没给出去。
    # 判据都在 `core/turn_quality.py`，这里只读它写进 `quality` 的结论。
    if key == "retried":
        return _int(t.get("retried")) > 0
    if key == "repaired":
        return bool((t.get("quality") or {}).get("repaired"))
    if key == "invented_path":
        return any(f.get("code") == key for f in (t.get("quality") or {}).get("findings") or [])
    if key == "dropped_receipt":
        return bool((t.get("quality") or {}).get("dropped_receipts"))
    # W4：字数。`budget` 是 None = 用户那一句里没给字数（那就没有「超」这回事）。
    if key == "over":
        return bool(((t.get("quality") or {}).get("length") or {}).get("over"))
    if key == "rewrote":
        return _int(((t.get("quality") or {}).get("length") or {}).get("saves")) >= 2
    if key == "multi":
        return len(t["artifacts"]) > 1
    if key == "slow":
        return float(t["seconds"] or 0) >= SLOW_SECONDS
    if key == "expensive":
        return _int(t["tokens_out"]) >= EXPENSIVE_OUT
    if key == "error":
        return bool(t["error"])
    return True
