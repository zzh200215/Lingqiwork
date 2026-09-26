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

**那处不体面已经清掉了（2026-09-23）**：`tests/` 里 22 个模块原来在 import 时写
`os.environ["WB_DB_PATH"] = ...`（还有 `WB_CONFIG_PATH` / `WB_VAULT_DIR` / `WB_CHROMA_PATH`），
而它们**一个字都改不动**——这个 fixture 早就把沙箱定住了，那些行只在「每文件一进程」那种本来
就孤立的模式下"看起来有用"。清的时候**没一刀切**：19 个模块的临时目录另有用途（后面还拿它写过
文件），只删环境变量那几行；3 个模块的临时目录只为那几个变量存在（`test_pet_tools` /
`test_pet_state` / `test_podcast`），连 `mkdtemp` + `atexit` 一起删，删完再用 AST 查一遍
「`os` / `atexit` / `shutil` / `tempfile` / `Path` 还有没有人用」，没人用就把 import 也删掉。
**新写的测试不要再加那种块**：隔离已经由下面这个 fixture 提供了。

**沙箱要自己收掉（补记）**：每个测试**进程**建一个 `wb-test-sandbox-`，而它从来没有被删过
—— 实测 `%TEMP%` 里积了 **1592 个、215 MB**（09-14 到 09-15）。所以现在两件事都做：
进程正常退出时删掉自己那一个（`atexit`），进程被打断留下的旧目录由下面这次**保守清扫**
顺手扫掉（认前缀、且只清一小时以前的；正在跑的进程不会用一小时前的目录）。
这与 `turn_eval._sweep_stale_chroma` 是同一条经验：**「跑完把临时目录收掉」这件事，
不写下来就一定会再犯。**
"""
import asyncio
import atexit
import os
import shutil
import tempfile
import time
from pathlib import Path

import pytest

_SANDBOX = Path(tempfile.mkdtemp(prefix="wb-test-sandbox-"))


def _sweep_stale_sandboxes(older_than: float = 3600.0) -> int:
    """清掉以前留下的旧沙箱（进程被打断、Ctrl-C 时留下的那些）。返回清了几个。

    **认前缀、认时间**：认不出来就绝不下手 —— 删错一个正在用的目录，症状是几条毫不相干的
    测试开始随机失败，那是这个仓库最不想再见到的那类 bug。
    """
    root = Path(tempfile.gettempdir())
    now = time.time()
    n = 0
    for d in root.glob("wb-test-sandbox-*"):
        try:
            if not d.is_dir() or now - d.stat().st_mtime < older_than:
                continue
            shutil.rmtree(d, ignore_errors=True)
            n += 1
        except OSError:
            continue
    return n


def _drop_handles() -> None:
    """把沙箱里还握着的文件句柄放掉，**不然删不掉**。

    Windows 上这一步不能省：实测 `atexit` 里光 `rmtree(ignore_errors=True)` 是**静默失败**的
    —— sqlite 的连接还开着，目录里那一堆文件删得掉、`workbench.db` 删不掉，于是每次测试跑
    都在 `%TEMP%` 里留一个「看起来删过了」的目录（这正是它积到 1592 个的原因）。
    """
    try:
        from app.db import engine

        asyncio.run(engine.dispose())
    except Exception:  # noqa: BLE001 - 收尾失败不该让测试进程报错
        pass
    try:  # chromadb 的共享 client 也握着临时向量库的句柄（同 `turn_eval._drop_index_client`）
        from app.core import indexer

        from chromadb.api.shared_system_client import SharedSystemClient

        SharedSystemClient.clear_system_cache()
        indexer._client = None  # noqa: SLF001
    except Exception:  # noqa: BLE001
        pass


def _remove_sandbox() -> None:
    _drop_handles()
    shutil.rmtree(_SANDBOX, ignore_errors=True)


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    """会话结束就收掉自己那一个（正常路径）。"""
    _remove_sandbox()


# 进程被打断（Ctrl-C、崩了）时 `pytest_sessionfinish` 不一定跑得到，所以再兜一层。
atexit.register(_remove_sandbox)
# 别人（以前）留下的：顺手扫一遍。
_sweep_stale_sandboxes()

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
