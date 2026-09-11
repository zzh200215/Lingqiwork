"""模型用量账本（PLAN §10.2「成本」）。

**它解决什么。** `messages`（聊天）与 `task_runs`（定时任务）各记一条用量，而**其余路径
全不记**——研究 / 产出 / 复盘 / 方案 / 对质 / 教学 / 圆桌 / 播客 / 卡片 / 记忆整理烧的
token，在「这个月钱花在哪」里一个字都看不到。

**怎么记。** 操作入口开一个 `async with span(kind, ref)`；`llm._absorb_usage` 在调用方
**没有自己的账本**时把用量记进当前 span。有账本的那两条（聊天、定时任务）照旧走自己的
列——`note()` 只在 span 里才生效，所以**不存在重复记账**。span 退出时按模型汇总成一行。

**为什么用 contextvar 而不是把 usage 顺着参数传下去**：要记账的有二十来个模块，逐个改签名
是把一个横切关注点铺进每一处调用。span 只在入口开一次，中间层一行都不用动。
"""
import functools
import inspect
import logging
from contextlib import asynccontextmanager
from contextvars import ContextVar

log = logging.getLogger(__name__)

_span: ContextVar[dict | None] = ContextVar("wb_usage_span", default=None)


def traced(kind: str):
    """给一次操作套上用量 span。**同时吃异步生成器与协程**——这些入口形状不一（大多是
    `yield (event, data)` 的生成器，`roundtable.run` 之类直接返回结果），所以由装饰器自己分辨。

    为什么用装饰器而不是在函数体里 `with`：这些函数体动辄上百行，加一层 `with` 就要整体重排
    缩进；装饰器只动一行，而且 span 覆盖整个过程（生成器在 `async with` 里挂起，直到它跑完
    才结算）。`ref` 取第一个位置参数（话题 / 文件名 / 会话 id），没有就留空。
    """

    def _ref(args, kw):
        raw = args[0] if args else kw.get("topic", "")
        return "" if raw is None else str(raw)[:60]

    def deco(fn):
        if inspect.isasyncgenfunction(fn):

            @functools.wraps(fn)
            async def gen_wrapper(*args, **kw):
                async with span(kind, _ref(args, kw)):
                    async for ev in fn(*args, **kw):
                        yield ev

            return gen_wrapper

        @functools.wraps(fn)
        async def coro_wrapper(*args, **kw):
            async with span(kind, _ref(args, kw)):
                return await fn(*args, **kw)

        return coro_wrapper

    return deco


def note(model: str, tokens_in: int, tokens_out: int) -> None:
    """把一次模型调用的用量记进当前 span。**没在 span 里就丢弃**——那条路径有自己的账本
    （聊天写 `messages`，定时任务写 `task_runs`），重复记会让总额翻倍。"""
    state = _span.get()
    if state is None:
        return
    try:
        bucket = state["by_model"].setdefault(model or "", {"in": 0, "out": 0, "calls": 0})
        bucket["in"] += max(0, int(tokens_in or 0))
        bucket["out"] += max(0, int(tokens_out or 0))
        bucket["calls"] += 1
    except (TypeError, ValueError):
        pass


def active() -> bool:
    """当前有没有 span 在收账。`llm.py` 据此决定要不要让 provider 带上 usage——
    OpenAI 兼容的流式响应只有显式要了才会回 usage 字段。"""
    return _span.get() is not None


async def wrap_stream(kind: str, ref: str, agen):
    """包一个**在 return 之后才被消费**的 SSE 生成器。

    路由里那种 `return StreamingResponse(gen())` 的写法不能靠装饰路由函数——函数返回时流还
    没开始跑，span 会提前结算。用法：`StreamingResponse(usage_ledger.wrap_stream("notes", topic, gen()))`。
    """
    async with span(kind, ref):
        async for item in agen:
            yield item


@asynccontextmanager
async def span(kind: str, ref: str = ""):
    """包住一次操作：退出时把 span 内累积的用量按模型落成行。

    嵌套时内层会盖住外层（`ContextVar.set` 的语义），外层退出时拿回自己的状态——单层足够
    用，嵌套只是不会崩。
    """
    token = _span.set({"kind": kind, "ref": (ref or "")[:120], "by_model": {}})
    try:
        yield
    finally:
        state = _span.get()
        _span.reset(token)
        if state and state["by_model"]:
            try:
                await _write(state)
            except Exception:  # noqa: BLE001 - 记账失败绝不能影响正在做的事
                log.warning("usage ledger write failed", exc_info=True)


async def _write(state: dict) -> None:
    from app.db import SessionLocal
    from app.models import ModelUsage

    async with SessionLocal() as db:
        for model, m in state["by_model"].items():
            db.add(
                ModelUsage(
                    kind=state["kind"],
                    ref=state["ref"],
                    model_id=model,
                    tokens_in=m["in"],
                    tokens_out=m["out"],
                    calls=m["calls"],
                )
            )
        await db.commit()
