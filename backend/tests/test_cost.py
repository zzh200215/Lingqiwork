"""成本与配额中心测试：estimate_cost 纯函数 + usage_summary 聚合 + budget 护栏。"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import delete

from app.core import cost
from app.db import SessionLocal, engine
from app.models import Base, Conversation, Message, ModelUsage, TaskRun


async def _init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def _clear() -> None:
    async with SessionLocal() as db:
        await db.execute(delete(Message))
        await db.execute(delete(TaskRun))
        await db.execute(delete(ModelUsage))
        await db.execute(delete(Conversation))
        await db.commit()


# ---------- 纯函数：estimate_cost ----------


def test_estimate_cost_basic():
    by_model = {"gpt-4o": {"in": 1_000_000, "out": 2_000_000}}
    prices = {"gpt-4o": {"input": 2.5, "output": 10.0}}
    out = cost.estimate_cost(by_model, prices)
    # in 1M*2.5 + out 2M*10 = 2.5 + 20 = 22.5
    assert out["total"] == 22.5
    assert out["per_model"]["gpt-4o"] == 22.5
    assert out["priced_models"] == 1


def test_estimate_cost_skips_unpriced():
    by_model = {"paid": {"in": 1000, "out": 1000}, "free": {"in": 5000, "out": 0}}
    prices = {"paid": {"input": 1.0, "output": 1.0}}
    out = cost.estimate_cost(by_model, prices)
    assert out["unpriced_models"] == ["free"]
    assert out["priced_models"] == 1


def test_estimate_cost_empty_prices():
    by_model = {"m": {"in": 1000, "out": 1000}}
    out = cost.estimate_cost(by_model, {})
    assert out["total"] == 0
    assert out["priced_models"] == 0
    assert out["unpriced_models"] == ["m"]


def test_estimate_cost_zero_price_not_counted():
    by_model = {"m": {"in": 1_000_000, "out": 0}}
    prices = {"m": {"input": 0, "output": 0}}
    out = cost.estimate_cost(by_model, prices)
    assert out["total"] == 0
    assert "m" not in out["per_model"]


# ---------- 日期口径：窗口边界必须与落盘格式同口径（P2-1 回归） ----------
# 落盘是「空格分隔 naive UTC」（SQLite 无时区类型），`>=` 是文本字典序比较；
# `T` 分隔或 `+08:00` 偏移都会让边界日的行整片被丢——预算护栏曾因此系统性少报。


def test_since_matches_storage_format():
    s = cost._since(1)
    assert "T" not in s and "+" not in s
    parsed = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
    expect = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1)
    assert abs((parsed - expect).total_seconds()) < 5


def test_month_start_matches_storage_format():
    ms = cost._month_start()
    assert "T" not in ms and "+" not in ms
    parsed = datetime.strptime(ms, "%Y-%m-%d %H:%M:%S")
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    assert (parsed.year, parsed.month, parsed.day) == (now_utc.year, now_utc.month, 1)
    assert (parsed.hour, parsed.minute, parsed.second) == (0, 0, 0)


async def test_boundary_day_row_is_counted():
    """边界日回归：与窗口起点同一天、在其后 1 分钟的行必须被计入。

    行时间戳从 `_since(1)` 自身推导，所以「与起点同日」是构造保证——旧实现
    （`T` 分隔 + 偏移）下 `' ' < 'T'` 该行必被丢、此测试必挂。
    """
    await _init_db()
    await _clear()
    row_ts = datetime.fromisoformat(cost._since(1)).replace(tzinfo=None) + timedelta(seconds=60)
    async with SessionLocal() as db:
        conv = Conversation(title="t")
        db.add(conv)
        await db.flush()
        db.add(
            Message(
                conversation_id=conv.id,
                role="assistant",
                content="x",
                model_id="m",
                tokens_in=10,
                tokens_out=0,
                created_at=row_ts,
            )
        )
        await db.commit()
    s = await cost.usage_summary(days=1)
    assert s["chat_calls"] == 1
    assert s["total_tokens"] == 10


async def test_month_start_boundary_row_is_counted(monkeypatch):
    """月初边界回归：自然月第 1 天的行必须进预算（旧代码把月初整片丢掉）。"""
    await _init_db()
    await _clear()
    row_ts = datetime.strptime(cost._month_start(), "%Y-%m-%d %H:%M:%S") + timedelta(seconds=60)
    async with SessionLocal() as db:
        db.add(TaskRun(task_id=1, model_id="m", tokens_in=2_000_000, tokens_out=0, started_at=row_ts))
        await db.commit()
    monkeypatch.setattr(
        "app.core.cost.load_config",
        lambda: {
            "monthly_budget_usd": 1.0,
            "model_prices": {"m": {"input": 1.0, "output": 1.0}},
        },
    )
    out = await cost.monthly_budget_status()
    assert out["spent"] == 2.0  # 2M * $1/M —— 旧代码这里是 0
    assert out["over"] is True


# ---------- DB：usage_summary ----------


async def test_usage_summary_aggregates_chat_and_task():
    await _init_db()
    await _clear()
    async with SessionLocal() as db:
        conv = Conversation(title="t")
        db.add(conv)
        await db.flush()
        db.add(Message(conversation_id=conv.id, role="assistant", content="x", model_id="gpt-4o", tokens_in=100, tokens_out=200))
        db.add(Message(conversation_id=conv.id, role="assistant", content="y", model_id="gpt-4o", tokens_in=50, tokens_out=0))
        db.add(TaskRun(task_id=1, model_id="gpt-4o", tokens_in=30, tokens_out=70))
        await db.commit()

    s = await cost.usage_summary(days=30)
    assert s["total_tokens_in"] == 180  # 100 + 50 + 30
    assert s["total_tokens_out"] == 270  # 200 + 0 + 70
    assert s["total_tokens"] == 450
    assert s["chat_calls"] == 2
    assert s["task_runs"] == 1
    assert s["by_model"]["gpt-4o"]["in"] == 180
    assert s["by_model"]["gpt-4o"]["out"] == 270
    assert s["by_model"]["gpt-4o"]["calls"] == 3
    assert len(s["by_day"]) >= 1  # 至少有一天（本地日期分组）


async def test_usage_summary_ignores_null_tokens():
    await _init_db()
    await _clear()
    async with SessionLocal() as db:
        conv = Conversation(title="t")
        db.add(conv)
        await db.flush()
        db.add(Message(conversation_id=conv.id, role="assistant", content="x", model_id="m", tokens_in=None, tokens_out=None))
        await db.commit()
    s = await cost.usage_summary(days=30)
    assert s["total_tokens"] == 0
    assert s["chat_calls"] == 0  # 全 NULL 的 message 不计入


# ---------- DB：monthly_budget_status ----------


async def test_budget_disabled_when_zero(monkeypatch):
    monkeypatch.setattr("app.core.cost.load_config", lambda: {"monthly_budget_usd": 0, "model_prices": {}})
    out = await cost.monthly_budget_status()
    assert out["enabled"] is False
    assert out["over"] is False


async def test_budget_over_flag(monkeypatch):
    await _init_db()
    await _clear()
    async with SessionLocal() as db:
        db.add(TaskRun(task_id=1, model_id="m", tokens_in=5_000_000, tokens_out=0))
        await db.commit()
    monkeypatch.setattr(
        "app.core.cost.load_config",
        lambda: {
            "monthly_budget_usd": 1.0,
            "model_prices": {"m": {"input": 1.0, "output": 1.0}},
        },
    )
    out = await cost.monthly_budget_status()
    assert out["enabled"] is True
    assert out["spent"] == 5.0  # 5M * $1/M = $5
    assert out["over"] is True
    assert out["tokens"] == 5_000_000


async def test_budget_under_flag(monkeypatch):
    await _init_db()
    await _clear()
    async with SessionLocal() as db:
        db.add(TaskRun(task_id=1, model_id="m", tokens_in=100_000, tokens_out=0))
        await db.commit()
    monkeypatch.setattr(
        "app.core.cost.load_config",
        lambda: {
            "monthly_budget_usd": 1.0,
            "model_prices": {"m": {"input": 1.0, "output": 1.0}},
        },
    )
    out = await cost.monthly_budget_status()
    assert out["enabled"] is True
    assert out["spent"] == 0.1  # 0.1M * $1/M = $0.1
    assert out["over"] is False


async def test_budget_counts_the_ledger_leg(monkeypatch):
    """BUG-007：预算护栏必须把 `model_usage` 账本那条腿也算进去。

    研究/产出/复盘/教学/圆桌/播客/卡片/记忆整理烧的 token 只落在这张表里——护栏以前只
    数 messages + task_runs，把整类后台开销漏在账外，于是明明超了预算也判「没超」。
    """
    await _init_db()
    await _clear()
    async with SessionLocal() as db:
        db.add(ModelUsage(kind="research", model_id="m", tokens_in=3_000_000, tokens_out=0, calls=1))
        await db.commit()
    monkeypatch.setattr(
        "app.core.cost.load_config",
        lambda: {
            "monthly_budget_usd": 1.0,
            "model_prices": {"m": {"input": 1.0, "output": 1.0}},
        },
    )
    out = await cost.monthly_budget_status()
    assert out["enabled"] is True
    assert out["spent"] == 3.0  # 3M * $1/M = $3，全来自账本这条腿
    assert out["over"] is True
    assert out["tokens"] == 3_000_000
