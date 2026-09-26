"""迁移版本化（W6）的测试：只跑没跑过的、跑之前先备份、dry-run 一个字节都不写。

这一层要钉住的不是「ALTER 能不能跑」（那本来就能），是**记录**：这个库跑到哪一版、
第二次启动会不会重放、`--dry-run` 是不是真的什么都没动。缺口六说的是
「一张写死的列表，没有版本记录、不能回滚、没有 dry-run」——每一条都对应下面一条测试。
"""
import asyncio
import sys
from pathlib import Path

import pytest
from sqlalchemy import text

sys.path.insert(0, ".")

from app.core import backup  # noqa: E402
from app.core import migrations as mig  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import Base  # noqa: E402

_REAL_CREATE_BACKUP = backup.create_backup
_CALLS: list[str] = []


@pytest.fixture(autouse=True)
def _no_real_backups(monkeypatch):
    """**绝不在测试里造真备份**：`DEFAULT_BACKUP_DIR` 是仓库根的 `backups/`。

    默认把它换成记录器；要断言「备份确实被调了」的测试直接读 `_CALLS`。
    """
    _CALLS.clear()

    def fake(reason: str = "manual") -> dict:
        _CALLS.append(reason)
        return {"name": f"fake-{len(_CALLS)}"}

    monkeypatch.setattr(backup, "create_backup", fake)
    yield
    monkeypatch.setattr(backup, "create_backup", _REAL_CREATE_BACKUP)


async def _reset_db() -> None:
    """干净的全量 schema —— 每个模块开始时 conftest 已经清过一次，这里再显式来一遍。"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)


def _with_extra(monkeypatch, version: int, name: str, fn) -> list[int]:
    """往 MIGRATIONS 里临时追一条（不改真表，只改这份列表）。返回被调用的版本号。"""
    calls: list[int] = []

    async def wrapped(conn) -> None:
        calls.append(version)
        await fn(conn)

    monkeypatch.setattr(mig, "MIGRATIONS", [*mig.MIGRATIONS, mig.Migration(version, name, wrapped)])
    return calls


# ---------- 基线：新库记 v1，老库补列 ----------


async def test_a_fresh_db_records_every_shipped_version():
    """新库跑完 = 每一版都记上了（不是只有基线那一版）。

    刻意不写死「1」：加了 v2 之后，写死版本号的断言会把一次**正常**的迁移变动报成失败，
    于是下次真出问题时那条断言已经被人改麻了。这里对着 `MIGRATIONS` 自身断言。
    """
    await _reset_db()
    out = await mig.run()
    versions = [m.version for m in mig.MIGRATIONS]
    assert [m["version"] for m in out["applied"]] == versions
    done = await mig.applied()
    assert list(done) == versions
    assert await mig.pending() == []
    # 记了时间，不是一行空壳
    assert all(done.values())
    assert done[1]


async def test_the_second_run_does_nothing(monkeypatch):
    """第二次启动不该重放，也不该再备份一份。"""
    await _reset_db()
    await mig.run()
    _CALLS.clear()
    out = await mig.run()
    assert out["applied"] == [] and out["backup"] is None
    assert _CALLS == []


async def test_the_baseline_adds_a_column_an_old_db_is_missing():
    """老库缺列时 v1 要补上 —— 这是那张写死的列表原来唯一的活儿，不能丢。"""
    await _reset_db()
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE messages"))
        await conn.execute(text("CREATE TABLE messages (id INTEGER PRIMARY KEY)"))
    await mig.run()
    async with engine.begin() as conn:
        cols = {r["name"] for r in (await conn.execute(text("PRAGMA table_info(messages)"))).mappings()}
    assert "tokens_in" in cols and "artifacts_json" in cols and "feedback" in cols


# ---------- dry-run ----------


async def test_dry_run_writes_nothing(monkeypatch):
    """`--dry-run` 一个字节都不写：不建表、不备份、不改结构。"""
    await _reset_db()
    await mig.run()  # 先把 v1 记上，让下面那条是唯一的待跑项

    async def add_probe(conn) -> None:
        await conn.execute(text("ALTER TABLE eval_items ADD COLUMN zz_probe INTEGER"))

    _with_extra(monkeypatch, 900, "探针", add_probe)
    _CALLS.clear()

    out = await mig.run(dry_run=True)
    assert [m["version"] for m in out["applied"]] == [900]
    assert out["backup"] is None and _CALLS == []

    done = await mig.applied()
    assert 900 not in done  # 没记录
    async with engine.begin() as conn:
        cols = {r["name"] for r in (await conn.execute(text("PRAGMA table_info(eval_items)"))).mappings()}
    assert "zz_probe" not in cols  # 结构也没动


# ---------- 待跑的迁移：跑一次、记一版、先备份 ----------


async def test_a_pending_migration_runs_exactly_once(monkeypatch):
    await _reset_db()
    await mig.run()

    async def add_probe(conn) -> None:
        await conn.execute(text("ALTER TABLE eval_items ADD COLUMN zz_probe INTEGER"))

    calls = _with_extra(monkeypatch, 900, "探针", add_probe)

    out = await mig.run()
    assert [(m["version"], m["name"]) for m in out["applied"]] == [(900, "探针")]
    assert calls == [900]
    assert 900 in await mig.applied()
    async with engine.begin() as conn:
        cols = {r["name"] for r in (await conn.execute(text("PRAGMA table_info(eval_items)"))).mappings()}
    assert "zz_probe" in cols

    # 再跑一次：不重放（重放会 `duplicate column name` 当场炸）
    again = await mig.run()
    assert again["applied"] == [] and calls == [900]


async def test_backup_happens_once_before_a_pending_migration(monkeypatch):
    """迁移动的是真库，没有备份就没得退 —— 而且**没有待跑的不备份**。"""
    await _reset_db()
    await mig.run()
    _CALLS.clear()

    async def noop(conn) -> None:  # noqa: ARG001
        return

    _with_extra(monkeypatch, 901, "什么都不改", noop)
    out = await mig.run()
    assert _CALLS == ["before-migrate"]
    assert out["backup"] == "fake-1"

    _CALLS.clear()
    await mig.run()
    assert _CALLS == []


async def test_a_failed_migration_is_not_recorded(monkeypatch):
    """迁移自己炸了就不能记成已应用 —— 记了就永远不补了。"""
    await _reset_db()
    await mig.run()

    async def boom(conn) -> None:  # noqa: ARG001
        raise RuntimeError("迁移写错了")

    _with_extra(monkeypatch, 902, "会炸的", boom)
    with pytest.raises(RuntimeError):
        await mig.run()
    assert 902 not in await mig.applied()


# ---------- 版本表本身 ----------


def test_versions_are_unique_and_increasing():
    """版本号是契约：已经发出去的不许改内容，也不许重号。"""
    versions = [m.version for m in mig.MIGRATIONS]
    assert versions == sorted(versions)
    assert len(versions) == len(set(versions))
    assert versions[0] == 1  # 第一个必须是基线
    assert all(m.name.strip() for m in mig.MIGRATIONS)


def test_the_legacy_list_still_has_the_columns_it_shipped_with():
    """基线列表是历史，不是可编辑的配置 —— 少一条就等于某个老库补不上列。"""
    assert len(mig.LEGACY_COLUMNS) >= 30
    for table, col, ddl in mig.LEGACY_COLUMNS:
        assert f"ADD COLUMN {col}" in ddl and table in ddl
    assert ("eval_items", "domain", "ALTER TABLE eval_items ADD COLUMN domain VARCHAR(30) DEFAULT ''") in mig.LEGACY_COLUMNS
    # v1 是**改动之前**那张列表：新加的东西不许塞回去，不然以后没人分得清哪一版改了什么
    assert not any(col == "quality_json" for _t, col, _d in mig.LEGACY_COLUMNS)


async def test_a_new_column_lands_on_an_old_db_and_not_twice():
    """v2 那种「给老表加列」的迁移：老库要补上，新库（create_all 已建列）不能炸。

    这一条是照着 `_add_column` 的存在理由写的 —— 少了 PRAGMA 自检，新库上会撞
    `duplicate column name`，而那是每次全新安装都会走的路径。
    """
    await _reset_db()
    # 造一个「老库」：turn_traces 建回来但没有 quality_json
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE turn_traces"))
        await conn.execute(text("CREATE TABLE turn_traces (id INTEGER PRIMARY KEY)"))
    out = await mig.run()
    assert [m["version"] for m in out["applied"]] == [m.version for m in mig.MIGRATIONS]
    async with engine.begin() as conn:
        cols = {r["name"] for r in (await conn.execute(text("PRAGMA table_info(turn_traces)"))).mappings()}
    assert "quality_json" in cols

    # 新库那条路：create_all 已经建好了列，v2 必须是空操作而不是报错
    await _reset_db()
    await mig.run()
    again = await mig.run()
    assert again["applied"] == []


async def test_v10_adds_the_judge_version_to_an_old_revlog():
    """v10（PLAN2 §9.4）：判分器换版之后曲线要按 sha 分段，所以复习记录得记着是哪一版判的。

    老库（有 `judged` 没有 `judged_sha`）补上这一列，**但不回填**——那时候的行哪一版判的
    本来就不知道，回填一个当前的 sha 等于给它们编一个版本（空串 = 「判过，但不知道哪一版」）。
    """
    await _reset_db()
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE card_reviews"))
        await conn.execute(
            text("CREATE TABLE card_reviews (id INTEGER PRIMARY KEY, card_id INTEGER, grade INTEGER)")
        )
    out = await mig.run()
    versions = [m.version for m in mig.MIGRATIONS]
    assert [m["version"] for m in out["applied"]] == versions
    async with engine.begin() as conn:
        await conn.execute(text("INSERT INTO card_reviews (card_id, grade, judged) VALUES (1, 3, 1)"))
        cols = {r["name"]: r for r in (await conn.execute(text("PRAGMA table_info(card_reviews)"))).mappings()}
        row = (await conn.execute(text("SELECT judged, judged_sha FROM card_reviews"))).first()
    assert {"judged", "judged_sha"} <= set(cols)
    # 老行：判过，但版本是空的（「不知道」），而不是被填成当前那一版
    assert row[0] == 1 and (row[1] or "") == ""
    assert cols["judged_sha"]["dflt_value"] in ("''", '""')


async def test_v12_adds_the_two_marks_the_adoption_metric_needs():
    """v12（PLAN2 §6 回指采纳）：`cards.prereq_seen_at` + `tutor_sessions.prereq_card_id`。

    两列都是 nullable、**不回填**——旧行一律 NULL 在它们上是**真的**（这个功能上线之前
    一次都没有过），不是「未知」。
    """
    await _reset_db()
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE cards"))
        await conn.execute(text("CREATE TABLE cards (id INTEGER PRIMARY KEY, front TEXT)"))
        await conn.execute(text("DROP TABLE tutor_sessions"))
        await conn.execute(
            text("CREATE TABLE tutor_sessions (id INTEGER PRIMARY KEY, topic TEXT)")
        )
    out = await mig.run()
    assert [m["version"] for m in out["applied"]] == [m.version for m in mig.MIGRATIONS]
    async with engine.begin() as conn:
        card_cols = {r["name"] for r in (await conn.execute(text("PRAGMA table_info(cards)"))).mappings()}
        sess_cols = {
            r["name"] for r in (await conn.execute(text("PRAGMA table_info(tutor_sessions)"))).mappings()
        }
    assert "prereq_seen_at" in card_cols
    assert "prereq_card_id" in sess_cols


async def test_v13_adds_the_injection_mark_to_the_feedback_log():
    """v13（PLAN3 §9.2 决策4）：质量闭环要能按「有注入 / 没注入 / 不知道」多摆一行，而反馈行
    与运行没有任何关联（只有 kind/sha/model/ref）——所以这一列只能由点 👍 的那一刻带上来。

    **三态、不回填**：老行留 `""`（不知道），而不是被填成 `"[]"`（没注入）。这个功能上线
    之前，那些行确实**没有**「有没有注入」这个属性；编一个「没注入」比空着坏。
    """
    await _reset_db()
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE artifact_feedback"))
        await conn.execute(
            text("CREATE TABLE artifact_feedback (id INTEGER PRIMARY KEY, kind TEXT, verdict TEXT)")
        )
    out = await mig.run()
    assert [m["version"] for m in out["applied"]] == [m.version for m in mig.MIGRATIONS]
    async with engine.begin() as conn:
        await conn.execute(
            text("INSERT INTO artifact_feedback (kind, verdict) VALUES ('compose', 'good')")
        )
        cols = {
            r["name"]: r
            for r in (await conn.execute(text("PRAGMA table_info(artifact_feedback)"))).mappings()
        }
        row = (await conn.execute(text("SELECT injected FROM artifact_feedback"))).first()
    assert "injected" in cols
    assert (row[0] or "") == ""  # 老行：不知道，而不是「没注入」
    assert cols["injected"]["dflt_value"] in ("''", '""')


async def test_v14_renames_the_old_thread_kind_in_rows_already_written():
    """v14（R3 · PLAN5 §3）：挂接的 kind 从 `tutor` 改名 `session`，**历史行要跟着改**。

    代码侧的改名是原子的（`threads.KINDS`），但**已经写进库的行不会自己变**——
    不改的话，历史挂接在改完的当天集体变成「引用不存在」（`_resolve()` 只认新 kind，
    `exists=False`，界面上那一条就灰了）。所以这条盯的不是列，是**值**。
    """
    await _reset_db()
    await mig.run()  # 先把库推到最新
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO thread_items (thread_id, kind, ref, created_at) "
                "VALUES (1, 'tutor', '7', '2026-09-01 00:00:00')"
            )
        )
        await conn.execute(
            text(
                "INSERT INTO thread_items (thread_id, kind, ref, created_at) "
                "VALUES (1, 'card', '9', '2026-09-01 00:00:00')"
            )
        )
        # 把 v14 从账本里撤掉，让下一次 run() 真的会再跑它一遍
        await conn.execute(text("DELETE FROM schema_migrations WHERE version = 14"))
    out = await mig.run()
    assert 14 in [m["version"] for m in out["applied"]]
    async with engine.begin() as conn:
        rows = (
            await conn.execute(text("SELECT kind, ref FROM thread_items ORDER BY ref"))
        ).all()
    assert [(k, r) for k, r in rows] == [("session", "7"), ("card", "9")]  # 只改那一个值


async def test_v15_opens_the_two_citation_columns_on_an_old_ledger():
    """v15（P3）：回合账本加 `sources_injected` / `sources_cited`。

    这两个数原本挤在 `quality_json` 里（P2 的零迁移做法，那时就写明「P3 开正式列时再搬」）
    —— 而它们是**要聚合的两个计数**，挂在 JSON 里只能一行行读出来自己数。这里盯的是：
    老库补上这两列、**老行的默认值是 0 而不是 NULL**（`turn_trace._view` 会把它读成 int）。
    """
    await _reset_db()
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE turn_traces"))
        await conn.execute(
            text(
                "CREATE TABLE turn_traces ("
                "id INTEGER PRIMARY KEY, model_id TEXT, answer_chars INTEGER, error TEXT)"
            )
        )
    out = await mig.run()
    assert [m["version"] for m in out["applied"]] == [m.version for m in mig.MIGRATIONS]
    async with engine.begin() as conn:
        await conn.execute(text("INSERT INTO turn_traces (model_id, answer_chars) VALUES ('m', 12)"))
        cols = {
            r["name"]: r
            for r in (await conn.execute(text("PRAGMA table_info(turn_traces)"))).mappings()
        }
        row = (await conn.execute(text("SELECT sources_injected, sources_cited FROM turn_traces"))).first()
    assert "sources_injected" in cols and "sources_cited" in cols
    assert (row[0], row[1]) == (0, 0), "老行要落到 0（那时候确实没注入过），不是 NULL"
    for col in ("sources_injected", "sources_cited"):
        assert cols[col]["dflt_value"] == "0"


async def test_v16_opens_the_sub_trace_column_on_an_old_ledger():
    """v16（A1）：回合账本加 `sub_traces_json`（这一轮委托出去的子代理）。

    **为什么它必须是列**：`turn_trace._write` 是逐字段映射列的，往草稿里塞新键会被**静默
    丢掉**（P2 那轮记过这个坑）。A1 的验收要「sub_trace 抽查」，丢掉就等于没记。
    老行补 `[]`：这个功能上线之前没有委托这件事，空数组是事实。
    """
    await _reset_db()
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE turn_traces"))
        await conn.execute(
            text("CREATE TABLE turn_traces (id INTEGER PRIMARY KEY, model_id TEXT, error TEXT)")
        )
    out = await mig.run()
    assert [m["version"] for m in out["applied"]] == [m.version for m in mig.MIGRATIONS]
    async with engine.begin() as conn:
        await conn.execute(text("INSERT INTO turn_traces (model_id) VALUES ('m')"))
        cols = {
            r["name"]: r
            for r in (await conn.execute(text("PRAGMA table_info(turn_traces)"))).mappings()
        }
        row = (await conn.execute(text("SELECT sub_traces_json FROM turn_traces"))).first()
    assert "sub_traces_json" in cols
    assert (row[0] or "") in ("[]", ""), "老行要落到空数组（那时候确实没有委托）"


async def test_v17_turns_the_agent_tool_switch_into_a_whitelist():
    """v17（A2）：`agents.tools_enabled`（布尔）→ `agents.tool_whitelist`（文本白名单）。

    **重建表是这一步唯一的路**（SQLite 没有 `ALTER COLUMN`），所以最该钉住的是
    **旧值的映射**：`true`（用工具）→ `''`（不限制）、`false`（不用工具）→ `'none'`
    （一个都不给）。映射反了，用户已经配好的「这个 agent 不许用工具」会**静默变成全开**。
    另外钉住：表重建之后**数据一行都不许丢**（id / 名字 / 人设 / 模型 / 开关都在）。
    """
    await _reset_db()
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE agents"))
        # 老表的样子**照实写**：agents 从来没有进过 v1 那张 `LEGACY_COLUMNS`（它是
        # `create_all` 建的），所以 `created_at` 一直是 NOT NULL。测试夹具要是把它写成
        # 可空，就会造出一个真库里不存在的场景，再拿它去要求迁移将就——那是自己骗自己。
        await conn.execute(
            text(
                "CREATE TABLE agents ("
                " id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(50) NOT NULL UNIQUE,"
                " avatar VARCHAR(8) NOT NULL, system_prompt TEXT NOT NULL,"
                " model_id VARCHAR(100) NOT NULL, use_rag BOOLEAN NOT NULL,"
                " tools_enabled BOOLEAN NOT NULL, enabled BOOLEAN NOT NULL,"
                " created_at DATETIME NOT NULL)"
            )
        )
        await conn.execute(
            text(
                "INSERT INTO agents (id, name, avatar, system_prompt, model_id, use_rag,"
                " tools_enabled, enabled, created_at) VALUES"
                " (1, '全开', '🤖', '你随便用', 'p/m', 1, 1, 1, '2026-09-01 10:00:00'),"
                " (2, '纯写手', '✍️', '你只写字', '', 0, 0, 1, '2026-09-02 11:00:00')"
            )
        )
    out = await mig.run()
    assert [m["version"] for m in out["applied"]] == [m.version for m in mig.MIGRATIONS]
    async with engine.begin() as conn:
        cols = {
            r["name"] for r in (await conn.execute(text("PRAGMA table_info(agents)"))).mappings()
        }
        rows = (
            await conn.execute(
                text("SELECT id, name, avatar, system_prompt, model_id, use_rag, tool_whitelist, enabled"
                     " FROM agents ORDER BY id")
            )
        ).all()
    assert "tool_whitelist" in cols and "tools_enabled" not in cols
    assert [tuple(r) for r in rows] == [
        (1, "全开", "🤖", "你随便用", "p/m", 1, "", 1),
        (2, "纯写手", "✍️", "你只写字", "", 0, "none", 1),
    ], "旧布尔值要一一对应地搬过去：true → ''（不限制）、false → 'none'（一个都不给）"


async def test_v17_is_a_no_op_on_a_fresh_db():
    """新库走 `create_all` 时列已经是文本 —— 迁移必须**什么都不做**（幂等）。

    这条是「重建表」最危险的地方：真库里若已经有 `tool_whitelist`，再重建一次就会把
    列类型/默认值换掉，或者撞 `table agents_new already exists`。
    """
    await _reset_db()  # create_all 建的是新结构：已经有 tool_whitelist
    out = await mig.run()
    assert [m["version"] for m in out["applied"]] == [m.version for m in mig.MIGRATIONS]
    # 走 ORM 插一行（真实路径就是这样）：默认值由模型给，裸 SQL 得自己把每列都写上
    from app.db import SessionLocal
    from app.models import Agent

    async with SessionLocal() as db:
        db.add(Agent(name="新库的"))
        await db.commit()
        row = (await db.execute(text("SELECT tool_whitelist FROM agents WHERE name = '新库的'"))).first()
    assert (row[0] or "") == ""  # 默认不限制


def test_v18_adds_the_step_ledger_column_to_messages():
    """v18（A2）：`messages.steps_json` —— 协作的逐步账进会话。

    只加列（SQLite 的 `ADD COLUMN`），所以最该钉的是两件事：**老行原样还在**、
    新列是 **NULL**。NULL 不是「空账」而是「那时候没有」——界面据此**不渲染那一栏**，
    而不是画一个 0 步的空壳（同 `sources` / `artifacts` 的口径）。
    """
    async def run() -> tuple[set[str], object]:
        await _reset_db()
        async with engine.begin() as conn:
            # 老表的样子**照实写**：那时没有 steps_json
            await conn.execute(text("DROP TABLE messages"))
            await conn.execute(
                text(
                    "CREATE TABLE messages ("
                    " id INTEGER NOT NULL PRIMARY KEY, conversation_id INTEGER NOT NULL,"
                    " role VARCHAR(20) NOT NULL, content TEXT NOT NULL,"
                    " sources_json TEXT, artifacts_json TEXT, model_id VARCHAR(100),"
                    " feedback VARCHAR(4), tokens_in INTEGER, tokens_out INTEGER,"
                    " created_at DATETIME NOT NULL)"
                )
            )
            await conn.execute(
                text(
                    "INSERT INTO messages (id, conversation_id, role, content, created_at)"
                    " VALUES (1, 1, 'assistant', '老的一条', '2026-09-01 10:00:00')"
                )
            )
        out = await mig.run()
        assert [m["version"] for m in out["applied"]] == [m.version for m in mig.MIGRATIONS]
        async with engine.begin() as conn:
            cols = {
                r["name"]
                for r in (await conn.execute(text("PRAGMA table_info(messages)"))).mappings()
            }
            row = (
                await conn.execute(text("SELECT content, steps_json FROM messages WHERE id = 1"))
            ).first()
        return cols, row

    cols, row = asyncio.run(run())
    assert "steps_json" in cols, "迁移没把列加上"
    assert row[0] == "老的一条", "老行没保住"
    assert row[1] is None, "老行的新列该是 NULL（不是空账）"


def test_v19_turns_the_prompt_table_into_a_library():
    """v19（提示词模块）：`prompts` 扩成库，另加版本与使用两张表。

    这个库最要紧的性质是**老行一条都不丢**——扩列是 SQLite 的 `ADD COLUMN`，
    而对话页那个 `/` 唤起读的就是这些老行。同时钉住新列**不是 NULL**：
    文本列用「空字符串 = 没填」，不让 NULL 同时表达「没填」和「迁移补的」——
    两种含义混在一列里，界面就分不出「他没打标签」和「这列是后加的」。
    """
    async def run() -> tuple[set[str], object, set[str]]:
        await _reset_db()
        async with engine.begin() as conn:
            # 老表的样子**照实写**：那时只有四列，两张新表也当作不存在
            await conn.execute(text("DROP TABLE prompts"))
            await conn.execute(text("DROP TABLE prompt_versions"))
            await conn.execute(text("DROP TABLE prompt_usages"))
            await conn.execute(
                text(
                    "CREATE TABLE prompts ("
                    " id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(100) NOT NULL,"
                    " content TEXT NOT NULL, created_at DATETIME NOT NULL)"
                )
            )
            await conn.execute(
                text(
                    "INSERT INTO prompts (id, title, content, created_at)"
                    " VALUES (1, '老的一条', '你好 {名字}', '2026-09-01 10:00:00')"
                )
            )
        out = await mig.run()
        assert [m["version"] for m in out["applied"]] == [m.version for m in mig.MIGRATIONS]
        async with engine.begin() as conn:
            cols = {
                r["name"]
                for r in (await conn.execute(text("PRAGMA table_info(prompts)"))).mappings()
            }
            row = (
                await conn.execute(
                    text("SELECT title, content, tags, favorite, rating FROM prompts WHERE id = 1")
                )
            ).first()
            tables = {
                r[0]
                for r in await conn.execute(
                    text("SELECT name FROM sqlite_master WHERE type='table'")
                )
            }
        return cols, row, tables

    cols, row, tables = asyncio.run(run())
    for col in ("updated_at", "tags", "category", "favorite", "rating", "source", "note"):
        assert col in cols, f"迁移没把 {col} 加上"
    assert row[0] == "老的一条" and row[1] == "你好 {名字}", "老行没保住（`/` 唤起读的就是它）"
    assert row[2] == "", "新列 tags 该是空串，不是 NULL"
    assert row[3] == 0 and row[4] == 0, "favorite / rating 该是 0，不是 NULL"
    assert {"prompt_versions", "prompt_usages"} <= tables, "两张新表没建出来"


def test_status_reports_where_the_db_is():
    async def run() -> dict:
        await _reset_db()
        await mig.run()
        return await mig.status()

    st = asyncio.run(run())
    head = max(m.version for m in mig.MIGRATIONS)
    assert st["current"] == st["head"] == head
    assert st["pending"] == []
    assert st["applied"][0]["version"] == 1 and st["applied"][0]["at"]
    assert st["applied"][-1]["version"] == head


def test_the_module_uses_a_real_path():
    """只是把 settings 里那个路径记在案：跑在沙箱里，别误伤真库。"""
    from app.config import settings

    assert "wb-test-sandbox" in str(settings.db_path)
    assert Path(settings.db_path).name == "workbench.db"
