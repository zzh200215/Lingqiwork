"""模型竞技场：同一个 prompt 并行打到所有已启用的 provider，并排对比。

平时每家 provider 只在降级链里隐身干活，你看不到它们单独长什么样——这里
看得见：同一句话、各家的回答、耗时、错误。也是降级链（tasks._candidates）
的天然测试台：竞技场列出来的就是降级时会用到的全部候选。

并行而不是逐家串行：一次点击的等待时长 = 最慢的那家，不是各家之和。
"""
import asyncio
import logging
import time

from app.core.llm import stream_chat

log = logging.getLogger(__name__)

MAX_PROMPT_CHARS = 4000
PER_CALL_TIMEOUT = 90  # 秒；本地大模型可能慢，但不该无限等


async def run(prompt: str) -> list[dict]:
    """所有已启用 provider 各答一次。永不抛异常——失败的算作该家 ok=False。"""
    from app.core import providers
    from app.core.tasks import _candidates

    prompt = (prompt or "").strip()[:MAX_PROMPT_CHARS]
    if not prompt:
        return []
    try:
        candidates = await _candidates("")
    except Exception as e:  # noqa: BLE001 - 没有任何可用 provider 也要给一句人话
        return [{"label": "", "ok": False, "error": str(e), "seconds": 0.0}]

    async def _one(info, model: str, label: str) -> dict:
        t0 = time.monotonic()
        try:
            chunks: list[str] = []
            async for delta in stream_chat(info, model, [{"role": "user", "content": prompt}]):
                chunks.append(delta)
            text = "".join(chunks).strip()
            if not text:
                return {"label": label, "ok": False, "error": "模型返回空内容", "seconds": round(time.monotonic() - t0, 1)}
            return {"label": label, "ok": True, "text": text, "seconds": round(time.monotonic() - t0, 1)}
        except Exception as e:  # noqa: BLE001 - 一家挂了不影响其他家的成绩
            log.warning("arena: %s failed", label, exc_info=True)
            code = providers.error_code(e) if hasattr(providers, "error_code") else type(e).__name__
            return {
                "label": label,
                "ok": False,
                "error": f"{code}: {e}"[:300],
                "seconds": round(time.monotonic() - t0, 1),
            }

    results = await asyncio.gather(*[_one(info, model, label) for info, model, label in candidates])
    return list(results)
