"""按 key 的在跑守卫：同一引擎第二次并发进来要回 409，而不是再跑一遍。

前端那句 `if (busy) return` 只挡得住一个标签页——第二个标签页、MCP、脚本都到
同一个 endpoint。这里钉的是后端那一层。
"""
import importlib
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

sys.path.insert(0, ".")


@pytest.fixture(autouse=True)
def _clean_guards():
    """守卫是进程级的 set，漏放会串到下一个用例。两头都清干净。"""
    from app.core import inflight

    inflight._running.clear()
    yield
    inflight._running.clear()


# ---------- 守卫本身 ----------


def test_acquire_is_exclusive_and_release_frees():
    from app.core import inflight

    assert inflight.try_acquire("x") is True
    assert inflight.try_acquire("x") is False  # 还占着
    inflight.release("x")
    assert inflight.try_acquire("x") is True


def test_release_is_idempotent():
    from app.core import inflight

    inflight.release("never-held")  # 放一个没占过的不该炸
    inflight.try_acquire("x")
    inflight.release("x")
    inflight.release("x")
    assert inflight.running() == []


def test_keys_do_not_cross_guard():
    """一个引擎在跑不该挡住另一个——它们是分开的 key。"""
    from app.core import inflight

    assert inflight.try_acquire("a") is True
    assert inflight.try_acquire("b") is True
    assert inflight.running() == ["a", "b"]
    inflight.release("a")
    inflight.release("b")


# ---------- 路由接线：key 挂错等于没挂 ----------

_TOPIC = SimpleNamespace(topic="话题")
_RUNNERS = [
    ("recap", "recap_run", None),
    ("research", "research", _TOPIC),
    ("compose", "compose_run", _TOPIC),
    ("decide", "decide_run", _TOPIC),
    ("conflict", "conflict_run", _TOPIC),
]
_IDS = [r[0] for r in _RUNNERS]


def _route(mod: str, fn: str):
    return getattr(importlib.import_module(f"app.routers.{mod}"), fn)


@pytest.mark.parametrize("mod,fn,body", _RUNNERS, ids=_IDS)
async def test_a_second_run_is_rejected_with_409(mod, fn, body, monkeypatch):
    from app.core import inflight, providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "some-model")
    assert inflight.try_acquire(mod), "测试自己得先占住这个 key"

    with pytest.raises(HTTPException) as caught:
        await _route(mod, fn)(body)

    assert caught.value.status_code == 409
    assert "跑" in caught.value.detail  # 是「有人在跑」，不是别的 409


@pytest.mark.parametrize("mod,fn,body", _RUNNERS, ids=_IDS)
async def test_the_guard_is_released_when_the_stream_finishes(mod, fn, body, monkeypatch):
    """流跑完必须放掉——否则一个引擎一辈子只能跑一次。"""
    from app.core import inflight, providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "some-model")

    async def fake_run(*_a, **_kw):
        yield "gathering", {"stage": "fake"}

    monkeypatch.setattr(importlib.import_module(f"app.core.{mod}"), "run", fake_run)

    resp = await _route(mod, fn)(body)
    chunks = [c async for c in resp.body_iterator]

    assert chunks, "假引擎至少该产出一帧"
    assert inflight.running() == [], "流结束了守卫还占着"


@pytest.mark.parametrize("mod,fn,body", _RUNNERS, ids=_IDS)
async def test_the_guard_is_released_when_the_run_raises(mod, fn, body, monkeypatch):
    """引擎中途抛异常也要放掉——否则一次失败会把那个功能永久锁死。"""
    from app.core import inflight, providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "some-model")

    async def boom(*_a, **_kw):
        raise RuntimeError("模型挂了")
        yield  # pragma: no cover - 让它是个 async generator

    monkeypatch.setattr(importlib.import_module(f"app.core.{mod}"), "run", boom)

    resp = await _route(mod, fn)(body)
    chunks = [c async for c in resp.body_iterator]

    assert any("error" in c for c in chunks)  # 错误被转成了 SSE 事件
    assert inflight.running() == [], "异常路径漏放了守卫"
