"""把库弄到可用状态：建表 + 跑没跑过的迁移。**独立入口的唯一一份**。

**为什么要有它。** 应用启动时会做这两件事（`main.lifespan`），而**独立入口以前各漏一半**：
`migrate.py` 只跑迁移（假设表已经建过），drill 和 CLI 干脆两件都不做。后果是同一个：
一条跟数据库八竿子打不着的命令报出一个语焉不详的 SQLite 错 —— 实测在 W1 的验收里，
`python -m app.eval_turns` 报的是「`messages` 没有 artifacts_json」和
「没有 turn_eval_runs 这张表」，而真正的原因只是「这个库还没被初始化过」。

所以入口收敛成一处：谁要碰库，先 `await ensure_schema()`。它幂等（`create_all` 自带
checkfirst，迁移只跑没跑过的），重复调没有代价。
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)


async def ensure_schema() -> dict:
    """建表 + 跑迁移。返回迁移的结果（`{"applied": [...], "backup": ...}`）。"""
    from app.core import migrations
    from app.db import engine
    from app.models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    out = await migrations.run()
    if out.get("applied"):
        log.info(
            "schema 初始化：应用了 %s 个迁移（%s）",
            len(out["applied"]),
            "、".join(f"v{m['version']}" for m in out["applied"]),
        )
    return out
