"""交付引擎（体裁 × 读者）的离线测试。

全部不打网络、不碰真实索引也不碰真实记忆库：`synthesize` 的模型调用走 `stream_fn`
注入，取材的三路（知识库 / 长期记忆 / 日记）都注入假函数——取材本身是 `compose.gather_inward`
（那一路由 `test_compose.py` 覆盖），这里只测交付自己那一层：提示词怎么拼、事件怎么发、
落盘落哪。
"""
import asyncio
from pathlib import Path

import pytest

from app.core import deliver


# ---------- 注入缝 ----------


def _llm(payload: str):
    """假 stream_fn：无论问什么都吐 payload（extract_json 走 L2 清洗路径）。"""

    async def _stream(info, model, messages):
        yield payload

    return _stream


@pytest.fixture
def wired(monkeypatch):
    """`_resolve` 永远成功——沙箱库里没有 provider，不然 synthesize 直接返回空。"""

    async def fake_resolve(model_id=""):
        from app.core.llm import ProviderInfo

        return ProviderInfo(kind="openai", base_url="http://x", api_key="k"), "test-model"

    monkeypatch.setattr(deliver, "_resolve", fake_resolve)


async def _no_kb(query, top_k):
    return []


async def _no_memory(query):
    return ""


def _no_journal(limit):
    return []


async def _collect(gen) -> list[tuple[str, dict]]:
    return [ev async for ev in gen]


# ---------- synth_prompt / catalogue ----------


def test_genres_are_five_and_audiences_three():
    catalogue = deliver.catalogue()
    assert [g["id"] for g in catalogue["genres"]] == [
        "weekly",
        "briefing",
        "email",
        "review",
        "proposal",
    ]
    assert [a["id"] for a in catalogue["audiences"]] == ["self", "colleague", "leader"]
    assert catalogue["default_genre"] == "weekly"
    assert catalogue["default_audience"] == "self"


def test_synth_prompt_carries_genre_structure_and_audience_directive():
    """体裁决定小节名与顺序、读者决定详略——两者都得进提示词，缺一个就退化成泛泛的长文。"""
    p = deliver.synth_prompt("proposal", "leader")
    assert "一页纸提案" in p
    for name in ("问题", "方案", "代价与风险", "下一步"):
        assert name in p
    assert deliver.AUDIENCES["leader"]["prompt"] in p


def test_synth_prompt_differs_by_genre_and_audience():
    assert deliver.synth_prompt("weekly", "self") != deliver.synth_prompt("email", "self")
    assert deliver.synth_prompt("weekly", "self") != deliver.synth_prompt("weekly", "leader")


def test_synth_prompt_rejects_unknown_genre_or_audience():
    with pytest.raises(ValueError):
        deliver.synth_prompt("nope", "self")
    with pytest.raises(ValueError):
        deliver.synth_prompt("weekly", "boss")


def test_merge_pinned_puts_pinned_first_and_dedups():
    """人指的材料优先于引擎自己捞的；同一份被两边拿到时，只留钉的那条。"""
    pinned = [{"kind": "kb", "title": "P", "ref": "notes/a.md", "text": "钉的"}]
    gathered = [
        {"n": 1, "kind": "kb", "title": "同一条", "ref": "notes/a.md", "text": "捞的"},
        {"n": 2, "kind": "kb", "title": "G", "ref": "notes/b.md", "text": "捞的"},
    ]
    out = deliver.merge_pinned(pinned, gathered)
    assert [s["ref"] for s in out] == ["notes/a.md", "notes/b.md"]
    assert [s["n"] for s in out] == [1, 2]
    assert out[0]["text"] == "钉的"


def test_pinned_sources_skip_what_cannot_be_read(monkeypatch):
    """一条材料读不出来，只是少一条材料——不该拖垮整次产出。"""
    from app.core import cards as cards_core

    def boom(source_path="", text="", max_chars=0):
        raise ValueError("读不出来")

    monkeypatch.setattr(cards_core, "collect_material", boom)
    assert deliver.pinned_sources(["notes/gone.md"]) == []
    assert deliver.pinned_sources([]) == []
    assert deliver.pinned_sources(["  "]) == []


# ---------- save ----------


def test_save_writes_vault_deliver_and_indexes(monkeypatch):
    seen: list[Path] = []

    def fake_index(path, **kw):
        seen.append(Path(path))
        return 2

    monkeypatch.setattr("app.core.indexer.index_file", fake_index)

    rep = deliver.Report(
        title="本周进展", sections=[deliver.Section(heading="本周进展", body="B [1]")], used=[1]
    )
    srcs = [{"n": 1, "kind": "kb", "title": "笔记", "ref": "notes/a.md", "text": "x"}]
    out = asyncio.run(deliver.save(rep, srcs))

    assert out["chunks"] == 2
    assert out["filename"].startswith("deliver/") and out["filename"].endswith(".md")
    dest = deliver.DELIVER_DIR / Path(out["filename"]).name
    assert dest.exists()
    assert "本周进展" in dest.read_text(encoding="utf-8")
    assert seen == [dest]  # 落盘之后确实进了索引——「下次先捞你自己的」靠这一步


# ---------- run（完整生成器） ----------


def _run(topic, genre="weekly", audience="self", **kw):
    async def _go():
        return await _collect(deliver.run(genre, topic, audience, **kw))

    return asyncio.run(_go())


def test_run_rejects_empty_topic(wired):
    assert _run("   ") == [("error", {"message": "话题不能为空"})]


def test_run_rejects_unknown_genre(wired):
    events = _run("话题", genre="nope")
    assert [e for e, _ in events] == ["error"]
    assert "unknown genre" in events[0][1]["message"]


def test_run_errors_without_provider(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "")
    events = _run("话题")
    assert [e for e, _ in events] == ["error"]
    assert "provider" in events[0][1]["message"]


def test_run_errors_when_no_material(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    events = _run("话题", kb_fn=_no_kb, memory_fn=_no_memory, journal_fn=_no_journal)
    assert [e for e, _ in events] == ["gathering", "error"]


def test_run_happy_path_carries_genre_audience_and_prompt_sha(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    async def kb(query, top_k):
        return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]

    stream = _llm('{"title":"R","sections":[{"heading":"H","body":"B [1]"}],"used":[1]}')
    events = _run(
        "话题",
        "briefing",
        "leader",
        kb_fn=kb,
        memory_fn=_no_memory,
        journal_fn=_no_journal,
        stream_fn=stream,
    )

    kinds = [e for e, _ in events]
    # 流式：正文边生成边发 draft。滤掉 draft 之后仍是四步，且 draft 必在 report 之前
    assert [k for k in kinds if k != "draft"] == ["gathering", "sources", "writing", "report"]
    assert kinds.index("draft") < kinds.index("report")

    report = dict(events)["report"]
    assert report["title"] == "R"
    assert report["used"] == [1]
    assert report["genre"] == "briefing" and report["audience"] == "leader"
    # 质量闭环的 join key：指纹必须对应**这个体裁×读者**拼出来的提示词，否则反馈没法按版本统计
    from app.core import report as report_mod

    assert report["prompt_sha"] == report_mod.prompt_sha(
        deliver.synth_prompt("briefing", "leader")
    )
