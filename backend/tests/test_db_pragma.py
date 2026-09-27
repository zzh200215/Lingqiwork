"""连接级 PRAGMA（CTO review #2 / MODE 2 Task 1）：WAL + 外键真的开着。

`db.py` 在每个连接上设 `journal_mode=WAL` / `synchronous=NORMAL` / `foreign_keys=ON`。
之前全后端没有任何连接级 PRAGMA——外键只是装饰，多路并发写在 DELETE journal 下
互相锁。这里钉住「设过且生效」，免得哪次重构把监听器弄丢而没人知道。

两条用例都走 `app.db.engine` 本体（conftest 沙箱库）——测的是**真实接线**，
不是把监听函数再挂一遍的木头测试。
"""
import sqlite3

import pytest
from sqlalchemy import text


async def test_engine_connection_uses_wal():
    """应用引擎的连接：journal_mode 必须是 wal。WAL 是库文件的持久属性，
    任何一条新连接（包括这条测试用的）读回的都该是它。"""
    from app.db import engine

    async with engine.connect() as conn:
        mode = (await conn.exec_driver_sql("PRAGMA journal_mode")).scalar()
    assert str(mode).lower() == "wal", f"journal_mode={mode!r}——WAL 没生效（监听器丢了？）"


async def test_engine_synchronous_is_normal():
    """synchronous=NORMAL：WAL 下的推荐档（掉电最多丢最后一个事务，不损库）。"""
    from app.db import engine

    async with engine.connect() as conn:
        mode = (await conn.exec_driver_sql("PRAGMA synchronous")).scalar()
    assert int(mode) == 1, f"synchronous={mode!r}（0=off 1=normal 2=full）"


async def test_engine_enforces_foreign_keys():
    """foreign_keys=ON：插一条指向不存在 conversation 的消息必须被拒。

    SQLite 默认关外键——不开的话 models.py 里那三处 ForeignKey 只是装饰。
    """
    from app.db import SessionLocal

    async with SessionLocal() as s:
        with pytest.raises(Exception) as ei:
            await s.execute(
                text(
                    "INSERT INTO messages (conversation_id, role, content, created_at) "
                    "VALUES (99999999, 'user', '外键测试', '2026-01-01T00:00:00')"
                )
            )
        assert "FOREIGN KEY" in str(ei.value).upper()
        await s.rollback()


def test_backup_api_still_reads_wal_database(tmp_path):
    """备份路径与 WAL 兼容：在线 backup API 从 WAL 库拷出的快照必须完整可开。

    `core/backup.py::_snapshot_db` 用的就是这一招——WAL 下未 checkpoint 的事务
    也在快照里，这是当初选 backup API 而不是拷文件的原因。
    """
    src = tmp_path / "src.db"
    con = sqlite3.connect(src)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE t (x INTEGER)")
    con.execute("INSERT INTO t VALUES (42)")  # 只在 -wal 里、未 checkpoint 的写入
    con.commit()

    dst = tmp_path / "snap.db"
    out = sqlite3.connect(dst)
    con.backup(out)
    out.close()
    con.close()

    check = sqlite3.connect(dst)
    assert check.execute("SELECT x FROM t").fetchone()[0] == 42
    check.close()
