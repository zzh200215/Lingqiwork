"""迁移版本化（W6）：把那张写死的 ALTER 列表变成有序、有记录、能 dry-run 的迁移。

**为什么。** 原来 `main.py` 里是一张写死的 `(表, 列, DDL)` 列表，每次启动全表重放。它其实
能用，而且靠 `PRAGMA table_info` 自检所以幂等 —— 但它**没有任何记录**：没有任何地方知道
这个库现在是哪一版、下一步该跑什么、能不能先看看再跑。这一轮它连着咬了两次：给
`eval_items` / `tutor_sessions` 加 `domain` 时，副本库因为没走应用启动而缺列
（`create_all` 只建新表、**不给老表加列**），脚本当场 SQL 报错。

**不重写历史。** 第一个迁移就是**基线**：把改动之前那张列表原样收进来，记成 v1。
- 老库：跑完 v1 就和改动前一样（缺哪列补哪列），并记下 v1；
- 新库：`create_all` 已经建全了列，v1 是空操作，同样记下 v1。

以后每加一列/改一次结构 = 追一个 v2、v3…，**只跑没跑过的那些**。

**能退回去。** 有待跑的迁移时，先自动备份一次（`core/backup.py` 现成的能力）：
迁移动的是真库，出错没有备份就没得退。没有待跑的就**不备份**——不然每次启动都多一份。
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

log = logging.getLogger(__name__)


# 改动之前那张写死的列表，原样搬过来当基线。**不要在这里加新东西** ——
# 新的结构改动请追一个 MIGRATIONS 条目，这样它才有版本、才有记录、才只跑一次。
LEGACY_COLUMNS: list[tuple[str, str, str]] = [
    ("conversations", "pinned", "ALTER TABLE conversations ADD COLUMN pinned BOOLEAN DEFAULT 0"),
    ("conversations", "folder", "ALTER TABLE conversations ADD COLUMN folder VARCHAR(100) DEFAULT ''"),
    ("messages", "feedback", "ALTER TABLE messages ADD COLUMN feedback VARCHAR(4)"),
    # V2.3 agent orchestration columns (tasks table)
    ("tasks", "mode", "ALTER TABLE tasks ADD COLUMN mode VARCHAR(10) DEFAULT 'simple'"),
    ("tasks", "tool_whitelist", "ALTER TABLE tasks ADD COLUMN tool_whitelist TEXT DEFAULT ''"),
    ("tasks", "max_rounds", "ALTER TABLE tasks ADD COLUMN max_rounds INTEGER DEFAULT 12"),
    ("tasks", "retry", "ALTER TABLE tasks ADD COLUMN retry INTEGER DEFAULT 1"),
    ("tasks", "notify_on_error", "ALTER TABLE tasks ADD COLUMN notify_on_error BOOLEAN DEFAULT 0"),
    ("tasks", "trigger_kind", "ALTER TABLE tasks ADD COLUMN trigger_kind VARCHAR(10) DEFAULT 'cron'"),
    ("tasks", "watch_path", "ALTER TABLE tasks ADD COLUMN watch_path VARCHAR(500) DEFAULT ''"),
    ("tasks", "chain_next_id", "ALTER TABLE tasks ADD COLUMN chain_next_id INTEGER"),
    # 人工卡点（§4-12）：这一步等人点头才触发下游
    ("tasks", "require_approval", "ALTER TABLE tasks ADD COLUMN require_approval BOOLEAN DEFAULT 0"),
    # 会议闭环（§4-13）：转写步骤 + 共享落点目录
    ("tasks", "action", "ALTER TABLE tasks ADD COLUMN action VARCHAR(12) DEFAULT 'prompt'"),
    ("tasks", "landing_dir", "ALTER TABLE tasks ADD COLUMN landing_dir VARCHAR(300) DEFAULT ''"),
    # V1.4 memory upgrade
    ("memories", "source", "ALTER TABLE memories ADD COLUMN source VARCHAR(10) DEFAULT 'manual'"),
    ("memories", "kind", "ALTER TABLE memories ADD COLUMN kind VARCHAR(10) DEFAULT 'fact'"),
    # 记忆证据链（DeepTutor 参考项：可检视记忆）
    ("memories", "evidence_json", "ALTER TABLE memories ADD COLUMN evidence_json TEXT DEFAULT '[]'"),
    # V6.2 observability: per-message / per-run token usage
    ("messages", "tokens_in", "ALTER TABLE messages ADD COLUMN tokens_in INTEGER"),
    ("messages", "tokens_out", "ALTER TABLE messages ADD COLUMN tokens_out INTEGER"),
    # 产出回执落库（P1）：正文可能空着，回执不能丢
    ("messages", "artifacts_json", "ALTER TABLE messages ADD COLUMN artifacts_json TEXT"),
    ("task_runs", "tokens_in", "ALTER TABLE task_runs ADD COLUMN tokens_in INTEGER"),
    ("task_runs", "tokens_out", "ALTER TABLE task_runs ADD COLUMN tokens_out INTEGER"),
    # 工作流运行的尺子（§4-10）：接地分 0-5 + 一句话理由
    ("task_runs", "grounded", "ALTER TABLE task_runs ADD COLUMN grounded INTEGER"),
    ("task_runs", "judge_reason", "ALTER TABLE task_runs ADD COLUMN judge_reason TEXT DEFAULT ''"),
    ("task_runs", "run_dir", "ALTER TABLE task_runs ADD COLUMN run_dir VARCHAR(300) DEFAULT ''"),
    # 用量按事记（§4-16）
    ("model_usage", "thread_id", "ALTER TABLE model_usage ADD COLUMN thread_id INTEGER"),
    # tutor history compression (maple-os 参考项：长会话中段压缩)
    ("tutor_sessions", "summary", "ALTER TABLE tutor_sessions ADD COLUMN summary TEXT DEFAULT ''"),
    ("tutor_sessions", "summary_upto", "ALTER TABLE tutor_sessions ADD COLUMN summary_upto INTEGER DEFAULT 0"),
    ("tutor_sessions", "repo", "ALTER TABLE tutor_sessions ADD COLUMN repo VARCHAR(100) DEFAULT ''"),
    ("tutor_sessions", "mode", "ALTER TABLE tutor_sessions ADD COLUMN mode VARCHAR(10) DEFAULT 'socratic'"),
    # 卡点清单：待解 / 已解（NULL = 待解）
    ("tutor_sessions", "stuck_resolved_at", "ALTER TABLE tutor_sessions ADD COLUMN stuck_resolved_at DATETIME"),
    # 领域（Q3 形态）：三样证据各自的领域标签。空的含义是「还没归类」，不是「无领域」。
    ("tutor_sessions", "domain", "ALTER TABLE tutor_sessions ADD COLUMN domain VARCHAR(30) DEFAULT ''"),
    ("eval_items", "domain", "ALTER TABLE eval_items ADD COLUMN domain VARCHAR(30) DEFAULT ''"),
]


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    apply: Callable[..., Awaitable[None]]


async def _m001_baseline(conn) -> None:
    """v1 基线：改动之前那张写死的列表，原样重放一遍。

    仍然靠 `PRAGMA table_info` 自检，所以在新库上（`create_all` 已建全列）是彻底的空操作，
    在老库上只补缺的那些。**不重写历史**：老库里已有的列一根手指都不碰。
    """
    from sqlalchemy import text

    for table, col, ddl in LEGACY_COLUMNS:
        cols = (await conn.execute(text(f"PRAGMA table_info({table})"))).mappings().all()
        if cols and not any(c["name"] == col for c in cols):
            await conn.execute(text(ddl))
            log.info("迁移 v1：%s 补上 %s", table, col)


async def _add_column(conn, table: str, col: str, ddl: str) -> bool:
    """补一列，已经有就跳过。返回是否真的动了结构。

    **每条给老表加列的迁移都要走这里**：新库是 `create_all` 先建的（列早就有了），
    老库才需要 ALTER —— 不先查一下就会在新库上撞一句 `duplicate column name`。
    """
    from sqlalchemy import text

    cols = (await conn.execute(text(f"PRAGMA table_info({table})"))).mappings().all()
    if not cols:
        return False  # 表都没有：那是 create_all 的事，迁移不负责建表
    if any(c["name"] == col for c in cols):
        return False
    await conn.execute(text(ddl))
    return True


async def _m002_turn_quality(conn) -> None:
    """v2：回合账本加 `quality_json`（W2a 的两条底线校验结论）。

    单独一版而不是塞进 v1：v1 是**历史基线**，它记的是「改动前那张列表」，
    往里加东西就等于把历史改写了一遍，以后没人分得清哪一版到底改了什么。
    """
    if await _add_column(
        conn, "turn_traces", "quality_json", "ALTER TABLE turn_traces ADD COLUMN quality_json TEXT DEFAULT '{}'"
    ):
        log.info("迁移 v2：turn_traces 补上 quality_json")


# 有序。**只增不改**：已经发出去的版本号不许改内容（谁跑过就永远跑过了）。
MIGRATIONS: list[Migration] = [
    Migration(1, "baseline：补齐历史列（改动前那张写死的列表）", _m001_baseline),
    Migration(2, "W2a：回合账本加 quality_json（两条底线校验的结论）", _m002_turn_quality),
]


def _version_of(m: Migration) -> int:
    return int(m.version)


async def _ensure_table(conn) -> None:
    from app.models import SchemaMigration

    await conn.run_sync(lambda sync_conn: SchemaMigration.__table__.create(sync_conn, checkfirst=True))


async def applied() -> dict[int, str]:
    """已应用的版本 → 应用时刻（ISO）。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import SchemaMigration, iso_utc

    try:
        async with SessionLocal() as db:
            rows = (await db.execute(select(SchemaMigration).order_by(SchemaMigration.version))).scalars().all()
    except Exception:  # noqa: BLE001 - 还没有这张表 = 一版都没跑过
        return {}
    return {r.version: iso_utc(r.applied_at) or "" for r in rows}


async def pending() -> list[Migration]:
    """按版本号排好、还没跑过的那些。"""
    done = await applied()
    return sorted((m for m in MIGRATIONS if _version_of(m) not in done), key=_version_of)


async def run(dry_run: bool = False) -> dict:
    """跑没跑过的迁移。

    `dry_run=True` 只回答「会跑什么」，**一个字节都不写**（不建表、不备份、不改结构）。
    有待跑的迁移时先自动备份一次：迁移动的是真库，出错没有备份就没得退。
    """
    from app.db import engine

    todo = await pending()
    out = {
        "applied": [{"version": _version_of(m), "name": m.name} for m in todo],
        "backup": None,
        "dry_run": bool(dry_run),
    }
    if not todo or dry_run:
        return out

    from app.core import backup

    try:
        made = backup.create_backup("before-migrate")
        out["backup"] = made.get("name") if isinstance(made, dict) else None
        log.info("迁移前备份：%s", out["backup"])
    except Exception:  # noqa: BLE001 - 备份失败不该挡住启动，但要留痕
        log.warning("迁移前备份失败（继续迁移）", exc_info=True)

    from sqlalchemy import insert

    from app.models import SchemaMigration, utcnow

    async with engine.begin() as conn:
        await _ensure_table(conn)
        for m in todo:
            await m.apply(conn)
            await conn.execute(
                insert(SchemaMigration).values(
                    version=_version_of(m), name=m.name, applied_at=utcnow()
                )
            )
            log.info("迁移已应用：v%s %s", _version_of(m), m.name)
    return out


async def status() -> dict:
    """已应用 / 待应用，各带版本与名字。给 CLI 看，也给人看。"""
    done = await applied()
    return {
        "applied": [
            {"version": v, "name": next((m.name for m in MIGRATIONS if _version_of(m) == v), ""), "at": at}
            for v, at in sorted(done.items())
        ],
        "pending": [{"version": _version_of(m), "name": m.name} for m in await pending()],
        "current": max(done) if done else 0,
        "head": max((_version_of(m) for m in MIGRATIONS), default=0),
    }
