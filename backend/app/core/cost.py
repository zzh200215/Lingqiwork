"""成本与配额中心 —— token 用量聚合 + 可选成本估算 + 可选预算护栏。

本地优先项目的成本护栏。背景：2026-09-04 曾因 provider 免费配额耗尽，所有
自动化功能静默打到死模型；且 agent 模式多轮循环、无人值守定时任务存在
「悄悄烧钱」的风险。token 本身在 Message / TaskRun 里已经记录了，这里补上
它一直缺的三样东西：**聚合**（用量可见）、**估算**（可选价格）、**护栏**
（可选预算）。

价格与预算都是 opt-in（默认关），零侵入：

- `model_prices`：model_id → {"input": 每百万 token 价, "output": 每百万 token 价}。
  单位由用户自定（USD / CNY 均可），成本输出的币种与所填价格一致。空 = 只
  显示 token、不显示钱。
- `monthly_budget_usd`：月度预算（与价格同币种），0 = 不设限。超了在体检报告
  里标出来，不做硬性拦截（拦停任务比烧一点钱更糟）。
"""
import logging
from datetime import timedelta

from app.core.prefs import load_config
from app.core.timeutil import iso_cutoff, naive_utc_now

log = logging.getLogger(__name__)


def _since(days: int) -> str:
    """窗口起点：days 天前，naive UTC + 空格分隔，与落盘同口径（见 `timeutil`）。

    供 SQLite 的文本 `>=` 比较。以前这里用 `.astimezone().isoformat()` 产出
    `T` 分隔 + 本地偏移的串——`' ' < 'T'` 让边界日的行整片被丢，再叠时区差，
    用量与预算护栏系统性少报（P2-1）。口径唯一出处是 `app.core.timeutil`。
    """
    return iso_cutoff(naive_utc_now() - timedelta(days=days))


def _month_start() -> str:
    """本月 1 号 00:00（naive UTC，与 `_since` 同口径），供预算窗口。"""
    return iso_cutoff(naive_utc_now().replace(day=1, hour=0, minute=0, second=0, microsecond=0))


async def usage_summary(days: int = 30) -> dict:
    """聚合最近 `days` 天的 token 用量：总量、按模型、按天。

    只读，不跑模型。聊天（Message）与任务（TaskRun）两条腿都算进去。
    """
    from sqlalchemy import text as sql

    from app.db import SessionLocal

    days = max(1, min(days, 365))
    since = _since(days)

    by_model: dict[str, dict] = {}
    by_day: dict[str, int] = {}
    chat_calls = task_runs = 0
    total_in = total_out = 0

    async with SessionLocal() as db:
        # 聊天侧
        rows = (
            await db.execute(
                sql(
                    "SELECT COALESCE(model_id,''), "
                    "SUM(COALESCE(tokens_in,0)), SUM(COALESCE(tokens_out,0)), COUNT(*) "
                    "FROM messages WHERE created_at >= :since AND (tokens_in IS NOT NULL OR tokens_out IS NOT NULL) "
                    "GROUP BY model_id"
                ),
                {"since": since},
            )
        ).all()
        for model, tin, tout, cnt in rows:
            tin, tout = int(tin or 0), int(tout or 0)
            m = by_model.setdefault(model, {"in": 0, "out": 0, "total": 0, "calls": 0})
            m["in"] += tin
            m["out"] += tout
            m["total"] += tin + tout
            m["calls"] += int(cnt or 0)
            total_in += tin
            total_out += tout
            chat_calls += int(cnt or 0)

        # 任务侧
        rows = (
            await db.execute(
                sql(
                    "SELECT COALESCE(model_id,''), "
                    "SUM(COALESCE(tokens_in,0)), SUM(COALESCE(tokens_out,0)), COUNT(*) "
                    "FROM task_runs WHERE started_at >= :since AND (tokens_in IS NOT NULL OR tokens_out IS NOT NULL) "
                    "GROUP BY model_id"
                ),
                {"since": since},
            )
        ).all()
        for model, tin, tout, cnt in rows:
            tin, tout = int(tin or 0), int(tout or 0)
            m = by_model.setdefault(model, {"in": 0, "out": 0, "total": 0, "calls": 0})
            m["in"] += tin
            m["out"] += tout
            m["total"] += tin + tout
            m["calls"] += int(cnt or 0)
            total_in += tin
            total_out += tout
            task_runs += int(cnt or 0)

        # 账本侧：聊天与定时任务之外的全部（研究 / 产出 / 复盘 / 方案 / 对质 / 教学 /
        # 圆桌 / 播客 / 卡片 / 记忆整理…）。这两条腿各自有列，所以这里不会重复计。
        rows = (
            await db.execute(
                sql(
                    "SELECT COALESCE(model_id,''), SUM(tokens_in), SUM(tokens_out), SUM(calls) "
                    "FROM model_usage WHERE created_at >= :since GROUP BY model_id"
                ),
                {"since": since},
            )
        ).all()
        ledger_calls = 0
        for model, tin, tout, cnt in rows:
            tin, tout = int(tin or 0), int(tout or 0)
            m = by_model.setdefault(model, {"in": 0, "out": 0, "total": 0, "calls": 0})
            m["in"] += tin
            m["out"] += tout
            m["total"] += tin + tout
            m["calls"] += int(cnt or 0)
            total_in += tin
            total_out += tout
            ledger_calls += int(cnt or 0)

        # 按操作：这才是「钱花在哪」的正答
        rows = (
            await db.execute(
                sql(
                    "SELECT kind, SUM(tokens_in), SUM(tokens_out), SUM(calls) "
                    "FROM model_usage WHERE created_at >= :since GROUP BY kind"
                ),
                {"since": since},
            )
        ).all()
        by_kind = {
            str(kind): {"in": int(tin or 0), "out": int(tout or 0), "calls": int(cnt or 0)}
            for kind, tin, tout, cnt in rows
        }

        # 按天趋势（localtime，与 usage.open_days 同一纪律）
        rows = (
            await db.execute(
                sql(
                    "SELECT date(created_at,'localtime') AS d, "
                    "SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)) "
                    "FROM messages WHERE created_at >= :since GROUP BY d"
                ),
                {"since": since},
            )
        ).all()
        for day, total in rows:
            by_day[day] = int(total or 0)
        rows = (
            await db.execute(
                sql(
                    "SELECT date(started_at,'localtime') AS d, "
                    "SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)) "
                    "FROM task_runs WHERE started_at >= :since GROUP BY d"
                ),
                {"since": since},
            )
        ).all()
        for day, total in rows:
            by_day[day] = by_day.get(day, 0) + int(total or 0)
        rows = (
            await db.execute(
                sql(
                    "SELECT date(created_at,'localtime') AS d, SUM(tokens_in + tokens_out) "
                    "FROM model_usage WHERE created_at >= :since GROUP BY d"
                ),
                {"since": since},
            )
        ).all()
        for day, total in rows:
            by_day[day] = by_day.get(day, 0) + int(total or 0)

    return {
        "days": days,
        "total_tokens_in": total_in,
        "total_tokens_out": total_out,
        "total_tokens": total_in + total_out,
        "chat_calls": chat_calls,
        "task_runs": task_runs,
        "ledger_calls": ledger_calls,
        "by_model": by_model,
        "by_kind": by_kind,
        "by_day": sorted(by_day.items()),
    }


def estimate_cost(by_model: dict[str, dict], prices: dict[str, dict]) -> dict:
    """用可选价格表估算成本。纯函数。

    prices[model] = {"input": 每百万 token 价, "output": 每百万 token 价}。
    没配价格的模型不计入（也提示哪些模型没价格）。
    """
    per_model: dict[str, float] = {}
    unpriced: list[str] = []
    for model, m in by_model.items():
        p = prices.get(model)
        if not p or not isinstance(p, dict):
            unpriced.append(model)
            continue
        usd = (m["in"] / 1_000_000) * float(p.get("input") or 0) + (
            m["out"] / 1_000_000
        ) * float(p.get("output") or 0)
        if usd > 0:
            per_model[model] = round(usd, 4)
    total = round(sum(per_model.values()), 4)
    return {
        "total": total,
        "per_model": per_model,
        "priced_models": len(per_model),
        "unpriced_models": unpriced,
    }


async def monthly_budget_status() -> dict:
    """当月用量 + 估算成本 vs 月度预算。0 预算 = 未启用。只读。"""
    prefs = load_config()
    budget = float(prefs.get("monthly_budget_usd") or 0)
    prices = prefs.get("model_prices") or {}
    if budget <= 0:
        return {"enabled": False, "budget": 0.0, "spent": 0.0, "over": False}

    summary = await _monthly_usage()
    cost = estimate_cost(summary["by_model"], prices)
    spent = cost["total"]
    return {
        "enabled": True,
        "budget": budget,
        "spent": spent,
        "over": spent > budget,
        "tokens": summary["total_tokens"],
        "unpriced_models": cost["unpriced_models"],
    }


async def _monthly_usage() -> dict:
    """自然月（本月 1 号 00:00 UTC 至今，落盘即 UTC）的 token 聚合，供预算判断。"""
    from sqlalchemy import text as sql

    from app.db import SessionLocal

    month_start = _month_start()
    by_model: dict[str, dict] = {}
    total = 0

    async with SessionLocal() as db:
        # 三条腿，与 usage_summary（:95-96）同源、互不重复：messages=聊天、task_runs=定时
        # 任务、model_usage=其余全部（研究/产出/复盘/教学/圆桌/播客/卡片/记忆整理…）。
        # 预算护栏以前只算前两条，把整类后台开销漏在账外 → 系统性少报，明明超了也判没超。
        for table, ts_col in (
            ("messages", "created_at"),
            ("task_runs", "started_at"),
            ("model_usage", "created_at"),
        ):
            rows = (
                await db.execute(
                    sql(
                        f"SELECT COALESCE(model_id,''), "
                        f"SUM(COALESCE(tokens_in,0)), SUM(COALESCE(tokens_out,0)) "
                        f"FROM {table} WHERE {ts_col} >= :since "
                        f"AND (tokens_in IS NOT NULL OR tokens_out IS NOT NULL) GROUP BY model_id"
                    ),
                    {"since": month_start},
                )
            ).all()
            for model, tin, tout in rows:
                tin, tout = int(tin or 0), int(tout or 0)
                m = by_model.setdefault(model, {"in": 0, "out": 0, "total": 0, "calls": 0})
                m["in"] += tin
                m["out"] += tout
                m["total"] += tin + tout
                total += tin + tout
    return {"total_tokens": total, "by_model": by_model}
