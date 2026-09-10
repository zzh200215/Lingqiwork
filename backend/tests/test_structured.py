"""结构化输出层：畸形输入矩阵。

每一条都对应一个此前「prompt + 贪婪正则」会漏的真实场景，其中代码块包裹
（此前没有任何清洗，100% 失败）和多段 JSON（贪婪正则会吃到最后一个 `}`）
是最常见的两种。这些用例同时也是 core/structured.py 的存在理由，改动该模块
时它们应该最先报警。
"""
import sys

sys.path.insert(0, ".")

from pydantic import BaseModel, Field  # noqa: E402

from app.core.structured import clean_json, extract_json, stats  # noqa: E402


class _Fact(BaseModel):
    concept: str = ""
    aliases: list[str] = Field(default_factory=list)


def _info():
    from app.core.llm import ProviderInfo

    return ProviderInfo(kind="openai", base_url="http://x", api_key="k")


# ---------- clean_json：纯函数，不需要模型 ----------


def test_plain_json():
    assert clean_json('{"concept": "asyncio"}') == '{"concept": "asyncio"}'


def test_fenced_json_is_unwrapped():
    """此前没有任何去围栏逻辑，模型包 ```json 就 100% 解析失败。"""
    assert clean_json('```json\n{"concept": "a"}\n```') == '{"concept": "a"}'


def test_fence_without_lang():
    assert clean_json('```\n{"concept": "a"}\n```') == '{"concept": "a"}'


def test_surrounded_by_prose():
    assert clean_json('好的，结果如下：\n{"concept": "a"}\n希望有帮助') == '{"concept": "a"}'


def test_two_objects_takes_the_first():
    """贪婪正则 `\\{.*\\}` 会一路吃到最后一个 }，这里必须取第一段。"""
    out = clean_json('{"concept": "first"} 另外 {"concept": "second"}')
    assert out == '{"concept": "first"}'


def test_trailing_comma_is_repaired():
    """cards.py 曾为此单独打过补丁，现在统一在这里。"""
    assert clean_json('{"concept": "a",}') == '{"concept": "a"}'


def test_array_form():
    assert clean_json('[{"kind": "fact"}]') == '[{"kind": "fact"}]'


def test_no_json_returns_none():
    assert clean_json("完全没有 JSON") is None


def test_empty_returns_none():
    assert clean_json("") is None


def test_brace_inside_string_is_not_counted():
    assert clean_json('{"concept": "a{b}c"}') == '{"concept": "a{b}c"}'


# ---------- extract_json：需要注入假模型 ----------


async def _run(monkeypatch, native, streams):
    """native: L1 返回（None = provider 不支持）；streams: 每次 stream_chat 的文本。"""
    import app.core.structured as st

    st._native_unsupported.clear()  # 测试间隔离
    calls = {"native": 0, "stream": 0}

    async def _fake_native(info, model, messages, *, json_schema=None, usage=None):
        calls["native"] += 1
        return native

    async def _fake_stream(info, model, messages, usage=None):
        i = calls["stream"]
        calls["stream"] += 1
        for ch in streams[min(i, len(streams) - 1)]:
            yield ch

    monkeypatch.setattr(st, "structured_chat", _fake_native)
    monkeypatch.setattr(st, "stream_chat", _fake_stream)
    obj, meta = await extract_json(_info(), "m", [{"role": "user", "content": "x"}], _Fact)
    return obj, meta, calls


async def test_native_path_wins(monkeypatch):
    obj, meta, calls = await _run(monkeypatch, '{"concept": "原生"}', [])
    assert obj is not None and obj.concept == "原生"
    assert meta.strategy == "native" and meta.schema_ok
    assert calls["stream"] == 0  # 原生成功就不该再调模型


async def test_falls_back_when_native_unsupported(monkeypatch):
    obj, meta, _ = await _run(monkeypatch, None, ['{"concept": "降级"}'])
    assert obj is not None and obj.concept == "降级"
    assert meta.strategy == "cleaned"


async def test_fenced_output_is_recovered(monkeypatch):
    obj, meta, _ = await _run(monkeypatch, None, ['```json\n{"concept": "围栏"}\n```'])
    assert obj is not None and obj.concept == "围栏"
    assert meta.strategy == "cleaned"


async def test_self_correction_retry(monkeypatch):
    """第一次没给 JSON，第二次（带错误反馈）给对了 → retried。"""
    obj, meta, calls = await _run(monkeypatch, None, ["嗯，我想想", '{"concept": "重试后"}'])
    assert obj is not None and obj.concept == "重试后"
    assert meta.strategy == "retried"
    assert calls["stream"] == 2


async def test_all_fail_returns_none_without_raising(monkeypatch):
    obj, meta, _ = await _run(monkeypatch, None, ["完全没有 JSON"])
    assert obj is None
    assert meta.strategy == "failed" and not meta.schema_ok
    assert meta.error


async def test_missing_fields_use_defaults(monkeypatch):
    obj, _, _ = await _run(monkeypatch, None, ['{"concept": "只有概念"}'])
    assert obj is not None
    assert obj.concept == "只有概念" and obj.aliases == []


async def test_upstream_error_never_raises(monkeypatch):
    """契约：上游抛异常时按失败计，绝不向上抛。"""
    import app.core.structured as st

    st._native_unsupported.clear()

    async def _boom(info, model, messages, *, json_schema=None, usage=None):
        return None

    async def _raise(info, model, messages, usage=None):
        raise RuntimeError("上游炸了")
        yield  # pragma: no cover

    monkeypatch.setattr(st, "structured_chat", _boom)
    monkeypatch.setattr(st, "stream_chat", _raise)
    obj, meta = await extract_json(
        _info(), "m", [{"role": "user", "content": "x"}], _Fact
    )
    assert obj is None and meta.strategy == "failed"
    assert "上游炸了" in meta.error


def test_stats_shape():
    s = stats()
    assert {"native", "cleaned", "retried", "failed", "total", "success_rate"} <= set(s)
    assert 0.0 <= s["success_rate"] <= 1.0
