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


# --- 取消（2026-09-26：为什么「停止」不能靠掐请求）------------------------------
#
# 「量一遍」「跑一次对照」都是**一次性长 POST**，不是流式。掐掉请求只在流式接口上是真停
# （客户端断开、Starlette 取消生成器）；对一次性的循环，断开连接**服务端照样跑完、
# 照样花那份钱**。所以取消做成合作式：持有者在循环里轮询，见 `prompt_eval.check` /
# `skill_eval.run` / `judge_eval.check`。下面这几条钉的就是这套语义。


def test_cancel_is_refused_when_nothing_runs():
    """停一个没在跑的 → False。**不能假装停成功**：界面要能说出「没有在跑的」。"""
    from app.core import inflight

    inflight._running.clear()
    inflight._cancels.clear()
    assert inflight.request_cancel("nobody") is False
    assert inflight.cancel_requested("nobody") is False


def test_cancel_flag_expires_with_the_run():
    """放掉 key 之后取消标记必须一起清。

    不清的话下一次跑同一个 key 会**一上来就看到上一趟留下的标记**，于是「刚点开始就停了」
    ——而那个标记早该过期了。这一条防的是最难查的那种「莫名跑不动」。
    """
    from app.core import inflight

    inflight._running.clear()
    inflight._cancels.clear()
    assert inflight.try_acquire("k") is True
    assert inflight.request_cancel("k") is True
    assert inflight.cancel_requested("k") is True

    inflight.release("k")
    assert inflight.cancel_requested("k") is False, "放掉之后还能读到取消标记"

    assert inflight.try_acquire("k") is True
    assert inflight.cancel_requested("k") is False, "新的一趟一上来就带着上一趟的取消"
    inflight.release("k")


def test_cancel_requested_is_false_for_a_key_nobody_holds():
    """没持锁时读取消也必须是 False——残留标记不能影响判断。"""
    from app.core import inflight

    inflight._running.clear()
    inflight._cancels.clear()
    inflight._cancels.add("ghost")  # 手工塞一个（正常路径不会出现，但读取要稳）
    assert inflight.cancel_requested("ghost") is False
    inflight._cancels.clear()


def test_two_tabs_cannot_run_the_same_eval_at_once():
    """同一个 key 第二次 acquire 失败（路由据此回 409）。

    不是理论问题：两个标签页同时点「量一遍」= 两倍的模型调用 + 两次写同一份基线，
    而基线只会留下后写的那份。
    """
    from app.core import inflight

    inflight._running.clear()
    inflight._cancels.clear()
    assert inflight.try_acquire("prompt-eval:FEYNMAN_PROMPT") is True
    assert inflight.try_acquire("prompt-eval:FEYNMAN_PROMPT") is False
    inflight.release("prompt-eval:FEYNMAN_PROMPT")


async def test_the_eval_routes_refuse_a_second_run_and_answer_a_cancel():
    """路由层：第二次调用回 409；取消接口如实回 `stopped`。

    **两处必须说的是同一个 key 字符串**——路由拼一个、核心拼一个的话，哪天改前缀，
    「停止」会静默失效（点了什么都不发生，页面上也不报）。所以这条顺带钉住
    `_eval_key` / `_run_key` 就是两端共用的那一个定义。
    """
    import pytest
    from fastapi import HTTPException

    from app.core import inflight
    from app.routers import prompts as pr
    from app.routers import skills as sk

    inflight._running.clear()
    inflight._cancels.clear()

    # 没在跑 → 取消如实回 False（不假装停成功）
    assert (await pr.cancel_check("FEYNMAN_PROMPT"))["stopped"] is False
    assert (await sk.cancel_skill_eval("评测复现"))["stopped"] is False

    # 占着锁 → 取消回 True，且核心读得到
    ptoken = pr._eval_key("FEYNMAN_PROMPT")
    assert inflight.try_acquire(ptoken) is True
    assert (await pr.cancel_check("FEYNMAN_PROMPT"))["stopped"] is True
    assert inflight.cancel_requested(ptoken) is True
    inflight.release(ptoken)

    stoken = sk._run_key("评测复现")
    assert inflight.try_acquire(stoken) is True
    assert (await sk.cancel_skill_eval("评测复现"))["stopped"] is True
    assert inflight.cancel_requested(stoken) is True
    inflight.release(stoken)

    # 锁被占着时再点「跑一次」→ 409（**在任何模型调用之前就返回**，所以这条不花钱）
    assert inflight.try_acquire(ptoken) is True
    try:
        with pytest.raises(HTTPException) as ei:
            await pr.run_check("FEYNMAN_PROMPT")
        assert ei.value.status_code == 409
        assert "正在跑" in str(ei.value.detail)
    finally:
        inflight.release(ptoken)

    assert inflight.try_acquire(stoken) is True
    try:
        with pytest.raises(HTTPException) as ei2:
            await sk.run_skill_eval("评测复现", sk.RunIn())
        assert ei2.value.status_code == 409
    finally:
        inflight.release(stoken)
