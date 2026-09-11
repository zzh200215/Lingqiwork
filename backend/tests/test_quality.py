"""生成质量闭环的离线测试：只碰沙箱 SQLite，不打模型、不碰网络。"""
import asyncio
import sys

import pytest

sys.path.insert(0, ".")

from app.core import quality  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import Base  # noqa: E402


async def _init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init_db())


def _rec(**kw):
    base = {"kind": "recap", "verdict": "good"}
    base.update(kw)
    return asyncio.run(quality.record(**base))


def test_empty_summary_is_well_formed():
    """空库也要有完整形状——看板不能因为"还没人评过"就报错。必须先于其它用例跑。"""
    s = asyncio.run(quality.summary())
    assert s == {
        "days": 90,
        "total": 0,
        "good": 0,
        "bad": 0,
        "rate": 0.0,
        "groups": [],
        "recent_bad": [],
    }


def test_groups_split_by_prompt_version():
    """提示词一改，新旧版本的评价必须分开统计——这是整个闭环的 join key。"""
    _rec(kind="recap", verdict="good", prompt_sha="aaaaaaaaaaaa", model_id="m1")
    _rec(kind="recap", verdict="bad", prompt_sha="aaaaaaaaaaaa", model_id="m1", reason="太泛")
    _rec(kind="recap", verdict="good", prompt_sha="bbbbbbbbbbbb", model_id="m1")

    s = asyncio.run(quality.summary())
    assert (s["total"], s["good"], s["bad"]) == (3, 2, 1)
    assert s["rate"] == 0.667

    by_sha = {g["prompt_sha"]: g for g in s["groups"]}
    assert by_sha["aaaaaaaaaaaa"]["total"] == 2
    assert by_sha["aaaaaaaaaaaa"]["rate"] == 0.5
    assert by_sha["bbbbbbbbbbbb"]["rate"] == 1.0


def test_groups_split_by_model_within_one_prompt():
    """同一版提示词、两个 provider——正是"哪个 provider 在本产品上更强"要的切分。"""
    for _ in range(2):
        _rec(kind="research", verdict="good", prompt_sha="c" * 12, model_id="strong")
    _rec(kind="research", verdict="bad", prompt_sha="c" * 12, model_id="weak")

    groups = {(g["prompt_sha"], g["model_id"]): g for g in asyncio.run(quality.summary())["groups"]}
    assert groups[("c" * 12, "strong")]["rate"] == 1.0
    assert groups[("c" * 12, "weak")]["rate"] == 0.0


def test_recent_bad_carries_reasons_newest_first():
    # 一个进程里所有用例共用一个库，所以按 model_id 标记隔离出本用例自己的两行
    _rec(kind="compose", verdict="bad", model_id="t-recent", reason="引用是编的")
    _rec(kind="compose", verdict="bad", model_id="t-recent", reason="太泛")

    s = asyncio.run(quality.summary())
    mine = [b["reason"] for b in s["recent_bad"] if b["model_id"] == "t-recent"]
    assert mine == ["太泛", "引用是编的"]


def test_good_verdicts_stay_out_of_recent_bad():
    _rec(kind="compose", verdict="good", reason="这篇不错")
    assert all(b["reason"] != "这篇不错" for b in asyncio.run(quality.summary())["recent_bad"])


def test_reason_is_capped():
    _rec(kind="compose", verdict="bad", model_id="t-cap", reason="x" * 500)
    mine = next(b for b in asyncio.run(quality.summary())["recent_bad"] if b["model_id"] == "t-cap")
    assert len(mine["reason"]) == quality.REASON_CAP


def test_unknown_kind_is_rejected():
    with pytest.raises(ValueError):
        _rec(kind="nope")


def test_unknown_verdict_is_rejected():
    with pytest.raises(ValueError):
        _rec(verdict="meh")


def test_repeat_feedback_is_kept_not_deduped():
    """改主意（先 👎 后 👍）是正常的——评价是流水，不是状态。"""
    _rec(kind="research", verdict="bad", prompt_sha="d" * 12)
    _rec(kind="research", verdict="good", prompt_sha="d" * 12)

    g = next(x for x in asyncio.run(quality.summary())["groups"] if x["prompt_sha"] == "d" * 12)
    assert g["total"] == 2


def test_days_window_excludes_old_rows():
    from datetime import datetime, timedelta, timezone

    from app.db import SessionLocal
    from app.models import ArtifactFeedback

    async def _old():
        async with SessionLocal() as db:
            db.add(
                ArtifactFeedback(
                    kind="compose",
                    verdict="good",
                    created_at=datetime.now(timezone.utc) - timedelta(days=200),
                )
            )
            await db.commit()

    asyncio.run(_old())
    s90 = asyncio.run(quality.summary(days=90))
    s400 = asyncio.run(quality.summary(days=400))
    assert s400["total"] == s90["total"] + 1
