"""Sandbox every writable path before any app.* import runs.

app.config reads env at import time and app.db binds its engine to the result,
so the sandbox has to be wired at conftest import — test modules import app
modules at their own module level, which always happens after conftest.

This exists because the leak already happened once: tests created `dead`/`live`
ProviderConfig rows straight in the live data/workbench.db (found and removed
2026-09-08). With this conftest in place a test would have to work hard to
touch real user data.

**每个模块一份干净状态（W6）。** 单进程 `pytest tests/` 原来会串味：实测 **12 条失败**，
全是上一个模块留下的行漏进了 `test_pet_room` 的断言（它拿 `sqlite3` 写自己的私有库，
而 `pet_room.room()` 读的是应用引擎指的那个库）。原因值得写清楚，因为它是一条死路：

    单进程里**所有测试模块的 import 都发生在任何测试之前**，而各模块是在 import 时写
    `WB_DB_PATH` 的 —— 后写的那个赢，前面全部失效；何况 `app.config` 在 import 时就把
    路径读成了常量、`app.db` 也把引擎绑死了，事后改 env 不会有任何效果。
    **所以「每个模块一个库文件」这种隔离在单进程里结构上不可能成立。**

于是隔离放在**状态**层面：一个沙箱，每个模块开始时清空（库表重建、vault 与 config 删掉）。
单进程与 CI（`run_tests.py` 每文件一进程）结论一致，而不用为测试给产品代码加一层间接
（把 `SessionLocal` 换成代理、把 `settings` 改成动态读 env —— 那是拿产品换测试）。

**留下的一处不体面**：`tests/` 里 20 多个模块在 import 时写的 `WB_DB_PATH = ...` 现在只是
**装饰** —— 它们只在「每文件一进程」时生效，而那种模式下本来就是孤立的。删掉它们是一次
20+ 文件的机械改动，收益是「不再误导读者」；这一轮留着，并在这里说清：
**新写的测试不要再加这种块**，隔离已经由下面这个 fixture 提供了。
"""
import asyncio
import os
import shutil
import tempfile
from pathlib import Path

import pytest

_SANDBOX = Path(tempfile.mkdtemp(prefix="wb-test-sandbox-"))

# A stray WB_* export from the shell must not defeat the sandbox.
for _name in (
    "WB_DATA_DIR",
    "WB_VAULT_DIR",
    "WB_DB_PATH",
    "WB_CONFIG_PATH",
    "WB_CHROMA_PATH",
):
    os.environ.pop(_name, None)

# db_path / config_path / chroma_path all derive from DATA_DIR, so one env var
# moves the database, config.json and the vector store together.
os.environ["WB_DATA_DIR"] = str(_SANDBOX / "data")
os.environ["WB_VAULT_DIR"] = str(_SANDBOX / "vault")
os.environ["WB_DB_PATH"] = str(_SANDBOX / "data" / "workbench.db")
os.environ["WB_CONFIG_PATH"] = str(_SANDBOX / "data" / "config.json")
os.environ["WB_CHROMA_PATH"] = str(_SANDBOX / "data" / "chroma")

# **在这里就把 config 读掉**，让沙箱的位置由 conftest 决定，而不是「谁先 import 谁赢」。
# 不这么做的话，单进程里第一个 import `app.config` 的测试模块会把自己的 `WB_DB_PATH`
# 定成全局 —— 沙箱于是落在那个模块的 `wb-*` scratch 目录里（实测就是 `wb-v23-*/test.db`），
# 能用，但位置随收集顺序变，而且那个模块退出时会把它删掉。
from app.config import settings as _settings  # noqa: E402

assert _settings.db_path == _SANDBOX / "data" / "workbench.db", "沙箱没定住"


@pytest.fixture(autouse=True, scope="module")
def _clean_sandbox():
    """每个测试模块开始前，把沙箱清空：库表重建、vault 清空、config 删掉。

    自动生效（autouse），所以模块不需要记得声明它 —— 隔离是默认值这件事本身就是要点。
    """
    from app.config import VAULT_DIR, settings
    from app.db import engine
    from app.models import Base

    async def _wipe_db() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_wipe_db())
    shutil.rmtree(VAULT_DIR, ignore_errors=True)
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    Path(settings.config_path).unlink(missing_ok=True)
    yield
