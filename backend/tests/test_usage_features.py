"""功能真实用量聚合（CTO review #6 / MODE 2 Task 5）：`GET /api/usage/features` 的算术。

分组、求和、排序、时间归一——四件事各一条钉子。账本本身「不重复记账」的纪律
在 test_usage_ledger.py；这里只管读出来长什么样。
"""
from app.core import usage_ledger as ul
from app.db import SessionLocal
from app.db import engine as _engine
from app.models import Base, ModelUsage


async def _init_db():
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def _seed(rows: list[ModelUsage]) -> None:
    await _init_db()
    async with SessionLocal() as db:
        db.add_all(rows)
        await db.commit()


async def test_feature_usage_groups_and_sums_by_kind():
    await _seed(
        [
            ModelUsage(kind="briefing", ref="", model_id="m1", tokens_in=10, tokens_out=5, calls=1),
            ModelUsage(kind="briefing", ref="", model_id="m2", tokens_in=1, tokens_out=2, calls=1),
            ModelUsage(kind="deliver", ref="", model_id="m1", tokens_in=7, tokens_out=0, calls=2),
        ]
    )
    rows = await ul.feature_usage()
    by = {r["kind"]: r for r in rows}
    assert by["briefing"]["spans"] == 2
    assert by["briefing"]["calls"] == 2
    assert by["briefing"]["tokens"] == 18  # in+out 合并成一口数，界面不自己再算
    assert by["deliver"]["spans"] == 1
    assert by["deliver"]["calls"] == 2
    # 排序：按发生次数降序，用量最大的功能排最前
    kinds = [r["kind"] for r in rows]
    assert kinds.index("briefing") < kinds.index("deliver")
    # 时间归一成 ISO 字符串（给前端直接摆）
    assert isinstance(by["briefing"]["last"], str) and by["briefing"]["last"] != ""


async def test_feature_usage_empty_is_empty_list():
    """空账本 → 空列表。不是 None、不是报错——「没有就是没有」，界面照实说。"""
    from sqlalchemy import delete

    await _init_db()
    async with SessionLocal() as db:  # 清干净本模块可能残留的行
        await db.execute(delete(ModelUsage))
        await db.commit()
    assert await ul.feature_usage() == []
