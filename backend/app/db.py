"""Async SQLAlchemy engine + session factory."""
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

engine = create_async_engine(
    f"sqlite+aiosqlite:///{settings.db_path}",
    echo=False,
    connect_args={"timeout": 15},
)


def _sqlite_pragma(dbapi_conn, _record) -> None:
    """连接级 PRAGMA（CTO review #2）。

    - **WAL**：watcher 索引、调度器任务、聊天流式落库、用量账本多路并发写，
      默认的 DELETE journal 下写会挡住读；WAL 让读写不互斥（写仍串行）。
      它是**库文件的持久属性**，这里每次连上再设一遍只是幂等保险；
    - **synchronous=NORMAL**：WAL 下的推荐档——掉电最多丢最后一个事务，不损库；
    - **foreign_keys=ON**：SQLite 默认关，不开的话外键只是装饰。

    备份走 sqlite3 在线 backup API（`core/backup.py::_snapshot_db`），快照一致性
    不依赖 journal 模式，WAL 不影响它。
    """
    pragmas = (
        "PRAGMA journal_mode=WAL",
        "PRAGMA synchronous=NORMAL",
        "PRAGMA foreign_keys=ON",
    )
    run_async = getattr(dbapi_conn, "run_async", None)
    if run_async is not None:
        # aiosqlite 适配层：raw 连接的 execute 是协程，得经 run_async 落到它的线程
        async def _set(conn) -> None:
            for p in pragmas:
                await conn.execute(p)

        run_async(_set)
        return
    cur = dbapi_conn.cursor()
    for p in pragmas:
        cur.execute(p)
    cur.close()


event.listens_for(engine.sync_engine, "connect")(_sqlite_pragma)

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db() -> AsyncSession:
    """FastAPI dependency yielding a database session."""
    async with SessionLocal() as session:
        yield session
