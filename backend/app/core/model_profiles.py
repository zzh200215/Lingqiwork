"""模型画像与 per-model 策略（W7）：**换模型 = 换画像 + 跑一遍基线，不再靠「看起来还行」。**

**它补的是什么。** 同一个提示词喂所有模型，而实测行为差异巨大（flash-lite 需要把规矩提到
system 层且仍会谎报/循环；deepseek-v4-pro 限流且输出不完整；qwen 另配一套）。以前这些差别
只存在于我的记忆和临时脚本里 —— 换一个模型，没有任何东西会告诉你它在上一条路上表现如何。

**核心纪律（plan 的原话：每个画像必须有一条 W1 跑出来的行为基线，否则不许上线）。** 这里把它
翻译成一条可执行的规则：

> **没有基线的画像不生效。** `effective()` 发现 `baseline_run_id` 为空时，回落成默认策略，
> 并把原因写进返回值 —— 调用方（聊天）会把它记进账本，界面上看得见「这份画像没被采纳」。

为什么是「不生效」而不是「不许用这个模型」：把模型从产品里挡掉，代价立刻落在用户头上
（聊天直接不能用了），而一个没量过的 temperature 只是让行为回到默认。**纪律要拦的是
「凭手感改策略」，不是「用这个模型」。**

**不做**：不做自动调参、不做按 prompt 的画像、不做 provider 探测。这一层只记事实 + 一条闸。

**入口（方向 10，2026-09-28 收线）**：对外 4 个 HTTP 端点已收——前端从未有过画像 UI，
读写走 CLI `app/model_check.py`（overview/save/bless/history 全覆盖）；`effective()`
照旧由 chat 调用，核内逻辑一字未动。想恢复端点就照 git 历史把 `routers/profiles.py`
拿回来再注册。
"""
from __future__ import annotations

import json
import logging
from typing import Any

log = logging.getLogger(__name__)

# 默认策略。画像里为空/没基线的字段一律回落到这里 —— 与「没有画像」时的行为完全一致，
# 所以「画像不生效」不会让产品行为发生任何未预期的改变。
DEFAULTS: dict[str, Any] = {
    "temperature": None,  # None = 用 provider/调用默认
    "max_rounds": None,  # None = llm.MAX_TOOL_ROUNDS
    "tool_choice": "",
    "force_structure": False,
    "length_policy": "",
    "give_output_rule": True,
}

# 写进画像前要校验的字段与范围。**校验放在这里**（一处），路由与 CLI 都走它。
TEMPERATURE_RANGE = (0.0, 2.0)
ROUNDS_RANGE = (1, 50)
TOOL_CHOICES = ("", "auto", "required", "none")
LENGTH_POLICIES = ("", "revise", "truncate")


class ProfileError(ValueError):
    """画像字段不合法。带上字段名，界面直接显示。"""


def validate(fields: dict) -> dict:
    """校验并归一化一份画像字段。返回能落库的那几个键。Pure。"""
    out: dict[str, Any] = {}
    if "temperature" in fields:
        raw = fields["temperature"]
        if raw in (None, ""):
            out["temperature"] = None
        else:
            try:
                t = float(raw)
            except (TypeError, ValueError):
                raise ProfileError("temperature 得是数字") from None
            lo, hi = TEMPERATURE_RANGE
            if not (lo <= t <= hi):
                raise ProfileError(f"temperature 要在 {lo}~{hi} 之间")
            out["temperature"] = t
    if "max_rounds" in fields:
        raw = fields["max_rounds"]
        if raw in (None, ""):
            out["max_rounds"] = None
        else:
            try:
                n = int(raw)
            except (TypeError, ValueError):
                raise ProfileError("max_rounds 得是整数") from None
            lo, hi = ROUNDS_RANGE
            if not (lo <= n <= hi):
                raise ProfileError(f"max_rounds 要在 {lo}~{hi} 之间")
            out["max_rounds"] = n
    for key, allowed in (("tool_choice", TOOL_CHOICES), ("length_policy", LENGTH_POLICIES)):
        if key in fields:
            v = str(fields[key] or "").strip()
            if v not in allowed:
                raise ProfileError(f"{key} 只能是 {'/'.join(x or '（空）' for x in allowed)}")
            out[key] = v
    for key in ("force_structure", "supports_structure", "give_output_rule"):
        if key in fields:
            out[key] = bool(fields[key])
    if "notes" in fields:
        out["notes"] = str(fields["notes"] or "").strip()[:2000]
    return out


def _row_fields(row) -> dict:
    """一行画像 → 一份纯 dict（不含基线那几个字段）。"""
    return {
        "temperature": row.temperature,
        "max_rounds": row.max_rounds,
        "tool_choice": row.tool_choice or "",
        "force_structure": bool(row.force_structure),
        "supports_structure": bool(row.supports_structure),
        "length_policy": row.length_policy or "",
        "give_output_rule": bool(row.give_output_rule),
        "notes": row.notes or "",
    }


def has_baseline(row) -> bool:
    return bool(row is not None and row.baseline_run_id)


def effective_from(row) -> dict:
    """从一行画像算出**真正生效**的策略。Pure（除读行本身）。

    返回 `{"temperature", "max_rounds", "tool_choice", "force_structure", "length_policy",
    "give_output_rule", "source", "why"}`：`source="profile"` 才算这份画像被采纳了。
    """
    if row is None:
        return {**DEFAULTS, "source": "default", "why": "没有画像"}
    if not has_baseline(row):
        return {
            **DEFAULTS,
            "source": "default",
            "why": "这份画像还没有 W1 基线 —— 不生效（W7 的纪律：每个画像必须有一条量过的基线）",
        }
    fields = _row_fields(row)
    return {
        "temperature": fields["temperature"],
        "max_rounds": fields["max_rounds"],
        "tool_choice": fields["tool_choice"],
        # 强制结构化要**两边都成立**：想走 + 量过 provider 支持（W2b 按 provider 灰度）
        "force_structure": bool(fields["force_structure"] and fields["supports_structure"]),
        "length_policy": fields["length_policy"],
        "give_output_rule": fields["give_output_rule"],
        "source": "profile",
        "why": f"基线 #{row.baseline_run_id}",
    }


async def effective(model_id: str) -> dict:
    """当前这个模型真正生效的策略。**每次聊天都会调它**，所以只读一行。"""
    row = await get(model_id)
    return effective_from(row)


async def get(model_id: str):
    """读一行画像（没有返回 None）。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import ModelProfile

    if not model_id:
        return None
    async with SessionLocal() as db:
        return (
            await db.execute(select(ModelProfile).where(ModelProfile.model_id == model_id))
        ).scalar_one_or_none()


async def in_use() -> list[str]:
    """**在用的模型**：按 provider 配置里启用着的那些模型算。

    「在用」不去猜（会话历史里出现过的模型也算，但那是历史）—— 配置里启用的模型才是候选。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import ModelProfile, ProviderConfig

    ids: list[str] = []
    async with SessionLocal() as db:
        rows = (await db.execute(select(ProviderConfig).where(ProviderConfig.enabled.is_(True)))).scalars().all()
        for p in rows:
            for m in (p.models or []):
                m = str(m).strip()
                if not m:
                    continue
                ids.append(m if "/" in m else f"{p.name}/{m}")
        # 已经画过像的也算「在用」：不然一个画像会因为 provider 暂时关掉而显示成孤儿
        ids.extend((await db.execute(select(ModelProfile.model_id))).scalars().all())
    seen: list[str] = []
    for i in ids:
        if i not in seen:
            seen.append(i)
    return seen


async def overview() -> dict:
    """给界面/CLI：每个在用模型的画像、基线、以及画像到底生不生效。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import ModelProfile, iso_utc

    async with SessionLocal() as db:
        rows = {r.model_id: r for r in (await db.execute(select(ModelProfile))).scalars().all()}
    models = await in_use()
    out = []
    for mid in models:
        row = rows.get(mid)
        eff = effective_from(row)
        out.append(
            {
                "model_id": mid,
                "has_profile": row is not None,
                "has_baseline": has_baseline(row),
                "baseline": (
                    {
                        "run_id": row.baseline_run_id,
                        "pass": row.baseline_pass,
                        "total": row.baseline_total,
                        "ci_low": row.baseline_ci_low,
                        "ci_high": row.baseline_ci_high,
                        "judged": row.baseline_judged,
                        "seconds": row.baseline_seconds,
                        "tokens_out_per_turn": row.baseline_tokens_out,
                        # SQLite 把 DateTime round-trip 成 naive——裸 isoformat 会让浏览器
                        # 把 UTC 当本地读（本时区差 8 小时）。与 history() 同走 iso_utc。
                        "at": iso_utc(row.baseline_at) or "",
                    }
                    if row is not None
                    else None
                ),
                "profile": _row_fields(row) if row is not None else dict(DEFAULTS),
                "effective": eff,
            }
        )
    return {"models": out, "defaults": DEFAULTS}


async def save(model_id: str, fields: dict, *, note: str = "") -> dict:
    """写一份画像，并**留一条 append-only 的改动记录**（改了什么、改成什么）。"""
    from app.models import ModelProfile, ModelProfileChange, utcnow

    from app.db import SessionLocal

    clean = validate(fields)
    if not clean:
        raise ProfileError("没有可写的字段")
    model_id = (model_id or "").strip()
    if not model_id:
        raise ProfileError("model_id 不能为空")

    from sqlalchemy import select

    async with SessionLocal() as db:
        row = (
            await db.execute(select(ModelProfile).where(ModelProfile.model_id == model_id))
        ).scalar_one_or_none()
        if row is None:
            row = ModelProfile(model_id=model_id)
            db.add(row)
            await db.flush()
            before: dict = {k: None for k in clean}
        else:
            before = {k: getattr(row, k, None) for k in clean}
        changed = {k: [before.get(k), v] for k, v in clean.items() if before.get(k) != v}
        if not changed:
            return {"model_id": model_id, "changed": {}, "note": "没有变化，什么都没写"}
        for k, v in clean.items():
            setattr(row, k, v)
        row.updated_at = utcnow()
        db.add(
            ModelProfileChange(
                model_id=model_id,
                changed_json=json.dumps(changed, ensure_ascii=False),
                profile_json=json.dumps(_row_fields(row), ensure_ascii=False),
                baseline_run_id=row.baseline_run_id,
                note=note,
            )
        )
        await db.commit()
    return {"model_id": model_id, "changed": changed, "note": note}


async def bless(model_id: str, run_id: int | None = None, *, note: str = "") -> dict:
    """把一条 W1 跑分挂成这个模型的基线 —— **画像生效的唯一入口**。

    `run_id` 不给就用这个模型**最近一条** `TurnEvalRun`（跑完马上挂，别去记 id）。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import ModelProfile, ModelProfileChange, TurnEvalRun, utcnow

    async with SessionLocal() as db:
        run = None
        if run_id is not None:
            run = await db.get(TurnEvalRun, int(run_id))
        else:
            run = (
                await db.execute(
                    select(TurnEvalRun)
                    .where(TurnEvalRun.model_id == model_id)
                    .order_by(TurnEvalRun.id.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
        if run is None:
            raise ProfileError(f"找不到这个模型的跑分：{model_id}（先跑 `python -m app.eval_turns`）")
        if run.model_id != model_id:
            raise ProfileError(f"那条跑分是 {run.model_id} 的，不能挂到 {model_id} 上")

        row = (
            await db.execute(select(ModelProfile).where(ModelProfile.model_id == model_id))
        ).scalar_one_or_none()
        if row is None:
            row = ModelProfile(model_id=model_id)
            db.add(row)
            await db.flush()
        before_run = row.baseline_run_id
        row.baseline_run_id = run.id
        # `TurnEvalRun` 存的是通过率；报告要的是 k/n，所以两个都留
        row.baseline_total = run.total
        row.baseline_pass = int(round(run.deterministic * run.total))
        row.baseline_judged = run.judged
        row.baseline_seconds = run.seconds
        # 区间与「每轮输出 token」从明细里算（`TurnEvalRun` 只存了比例）
        try:
            detail = json.loads(run.detail_json or "[]")
        except ValueError:
            detail = []
        if isinstance(detail, list) and detail:
            row.baseline_tokens_out = round(
                sum(int(d.get("tokens_out") or 0) for d in detail) / len(detail), 1
            )
        from app.core.prompt_eval import wilson

        if row.baseline_total:
            lo, hi = wilson(row.baseline_pass, row.baseline_total)
            row.baseline_ci_low, row.baseline_ci_high = round(lo, 3), round(hi, 3)
        row.baseline_at = utcnow()
        row.updated_at = utcnow()
        db.add(
            ModelProfileChange(
                model_id=model_id,
                changed_json=json.dumps({"baseline_run_id": [before_run, run.id]}, ensure_ascii=False),
                profile_json=json.dumps(_row_fields(row), ensure_ascii=False),
                baseline_run_id=run.id,
                note=note or f"挂上基线：run #{run.id}",
            )
        )
        await db.commit()
    return await baseline_status(model_id)


async def baseline_status(model_id: str) -> dict:
    """这个模型的基线三项（分数 / 成本 / 延迟）—— 没有就如实说没有。"""
    from app.models import iso_utc

    row = await get(model_id)
    if row is None or not row.baseline_run_id:
        return {"model_id": model_id, "has_baseline": False}
    return {
        "model_id": model_id,
        "has_baseline": True,
        "run_id": row.baseline_run_id,
        "pass": row.baseline_pass,
        "total": row.baseline_total,
        "ci": [row.baseline_ci_low, row.baseline_ci_high],
        "judged": row.baseline_judged,
        "seconds": row.baseline_seconds,
        "tokens_out_per_turn": row.baseline_tokens_out,
        # 同 overview()：naive datetime 裸 isoformat 会造成浏览器时区偏移，走 iso_utc。
        "at": iso_utc(row.baseline_at) or "",
    }


async def history(model_id: str, limit: int = 20) -> list[dict]:
    """这个模型的画像改动历史（新的在前）—— 「改画像有前后对照」就是这一条。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import ModelProfileChange, iso_utc

    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(ModelProfileChange)
                .where(ModelProfileChange.model_id == model_id)
                .order_by(ModelProfileChange.id.desc())
                .limit(max(1, min(int(limit or 20), 200)))
            )
        ).scalars().all()
    return [
        {
            "id": r.id,
            "at": iso_utc(r.at),
            "changed": json.loads(r.changed_json or "{}"),
            "profile": json.loads(r.profile_json or "{}"),
            "baseline_run_id": r.baseline_run_id,
            "note": r.note or "",
        }
        for r in rows
    ]
