"""故障注入假模型（maple-os 参考项 4：Mock Parity Harness 的迷你版）。

mock 不该只会正常回复——最没被测过的路径恰恰是 provider 出故障时的行为。
`FakeLLM` 按调用次序消耗脚本（耗尽后重复最后一个），并记录每次调用的实参：

    fake = FakeLLM("fail", ["降级成功"])
    monkeypatch.setattr("app.core.llm.stream_chat", fake.stream)

脚本形态：
    "fail"            建连即抛 ConnectionError（零输出 → 允许降级）
    "drop"            先 yield 一个再抛 RuntimeError（输出已开始 → 禁止降级）
    "timeout"         抛 asyncio.TimeoutError
    "badjson"         yield 一段不是 JSON 的中文文本
    ["a", "b"] / "a"  正常流：依次 yield
    callable          async generator (info, model, messages) → 完全自定义

fake.calls[i] = {"info", "model", "messages"}。
"""
import asyncio


class FakeLLM:
    def __init__(self, *scripts):
        self.scripts = list(scripts) or [["ok"]]
        self.calls: list[dict] = []

    async def stream(self, info, model, messages, usage=None):
        self.calls.append({"info": info, "model": model, "messages": messages})
        i = min(len(self.calls) - 1, len(self.scripts) - 1)
        script = self.scripts[i]
        if callable(script):
            async for chunk in script(info, model, messages):
                yield chunk
            return
        if script == "fail":
            raise ConnectionError(f"{getattr(info, 'base_url', '')} 连不上")
        if script == "drop":
            yield "半句"
            raise RuntimeError("上游流中断")
        if script == "timeout":
            raise asyncio.TimeoutError()
        if script == "badjson":
            yield "抱歉，这段我没有看懂，能再说一次吗？"
            return
        chunks = script if isinstance(script, (list, tuple)) else [script]
        for c in chunks:
            yield c
