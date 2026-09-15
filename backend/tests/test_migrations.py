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


async def test_a_fresh_db_is_recorded_as_v1():
    await _reset_db()
    out = await mig.run()
    assert [(m["version"], m["name"][:8]) for m in out["applied"]] == [(1, "baseline")]
    done = await mig.applied()
    assert list(done) == [1]
    assert await mig.pending() == []
    # 记了时间，不是一行空壳
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


def test_status_reports_where_the_db_is():
    async def run() -> dict:
        await _reset_db()
        await mig.run()
        return await mig.status()

    st = asyncio.run(run())
    assert st["current"] == st["head"] == 1
    assert st["pending"] == []
    assert st["applied"][0]["version"] == 1 and st["applied"][0]["at"]


def test_the_module_uses_a_real_path():
    """只是把 settings 里那个路径记在案：跑在沙箱里，别误伤真库。"""
    from app.config import settings

    assert "wb-test-sandbox" in str(settings.db_path)
    assert Path(settings.db_path).name == "workbench.db"
