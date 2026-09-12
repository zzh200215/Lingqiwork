"""复盘引擎的离线测试。

四路取材全部注入假函数，模型调用走 `stream_fn`，索引换成假的——不打网络、不碰真
记录。真实链路由 `smoke_recap.py` 验。
"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, ".")

from app.core import recap  # noqa: E402

# ---------- 注入缝 ----------


def _llm(payload: str):
    async def _stream(info, model, messages):
        yield payload

    return _stream


@pytest.fixture
def wired(monkeypatch):
    async def fake_resolve(model_id=""):
        from app.core.llm import ProviderInfo

        return ProviderInfo(kind="openai", base_url="http://x", api_key="k"), "test-model"

    monkeypatch.setattr(recap, "_resolve", fake_resolve)


@pytest.fixture
def indexed(monkeypatch) -> list[Path]:
    seen: list[Path] = []

    def fake_index(path, **kw):
        seen.append(Path(path))
        return 5

    monkeypatch.setattr("app.core.indexer.index_file", fake_index)
    return seen


# ---------- 四路渲染（纯函数） ----------


def test_render_threads_spans_and_items():
    out = recap._render_threads(
        [
            {
                "label": "我倾向于先拆任务",
                "first_at": "2026-08-01T10:00:00+00:00",
                "last_at": "2026-09-01T10:00:00+00:00",
                "items": [{"content": "先拆再动手"}, {"content": "拆完再排优先级"}],
            }
        ]
    )
    assert "我倾向于先拆任务" in out
    assert "2026-08-01 → 2026-09-01" in out
    assert "先拆再动手；拆完再排优先级" in out


def test_render_threads_empty_is_blank():
    assert recap._render_threads([]) == ""
    assert recap._render_threads(None) == ""
    assert recap._render_threads([{"label": "", "items": []}]) == ""


def test_render_profile_known_and_half():
    out = recap._render_profile({"known": ["asyncio 事件循环"], "half": ["BM25"]})
    assert "说通过的：asyncio 事件循环" in out
    assert "还是半懂的：BM25" in out


def test_render_profile_empty_is_blank():
    assert recap._render_profile({"known": [], "half": []}) == ""
    assert recap._render_profile(None) == ""


def test_render_stuck_skips_malformed_items():
    out = recap._render_stuck([("asyncio", "搞不清切换时机"), "不是二元组", ("", "")])
    assert out == "- asyncio：搞不清切换时机"


def test_render_journal_skips_blank_text():
    out = recap._render_journal(
        [
            {"date": "2026-09-09", "time": "08:10", "text": "在想 RAG 评测"},
            {"date": "2026-09-08", "time": "21:00", "text": "   "},
            "不是 dict",
        ]
    )
    assert out == "- 2026-09-09 08:10 在想 RAG 评测"


def test_render_changes_relative_dated_and_skips_outside_vault():
    p = recap.VAULT_DIR / "notes" / "x.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("x", encoding="utf-8")

    out = recap._render_changes([p, Path("C:/outside.md")])
    assert out.startswith("- notes/x.md（")
    assert "outside" not in out


# ---------- 提示词护栏 ----------


def test_prompt_pins_three_sections_in_order():
    p = recap._SYNTH_PROMPT
    assert p.index("最近在关注什么") < p.index("学到哪") < p.index("卡在哪")


def test_prompt_forbids_advice():
    """复盘是镜子不是任务清单——提示词里必须有这条禁令。"""
    p = recap._SYNTH_PROMPT
    assert "不要写建议" in p
    assert "不要催促" in p


# ---------- gather ----------


def test_gather_collects_all_five_legs():
    async def profile():
        return {"known": ["A"], "half": ["B"]}

    async def stuck(days):
        return [("卡点X", "说不清")]

    async def beliefs():
        return [
            {
                "label": "L",
                "first_at": "2026-08-01",
                "last_at": "2026-09-01",
                "items": [{"content": "c1"}],
            }
        ]

    def journal(limit):
        return [{"date": "2026-09-09", "time": "08:10", "text": "日记正文"}]

    def changes(days):
        return []

    srcs = asyncio.run(
        recap.gather_recent(
            profile_fn=profile,
            stuck_fn=stuck,
            beliefs_fn=beliefs,
            journal_fn=journal,
            changes_fn=changes,
        )
    )

    assert [s["kind"] for s in srcs] == ["belief", "journal", "teach", "stuck"]
    assert [s["n"] for s in srcs] == [1, 2, 3, 4]


def test_gather_survives_a_dead_leg():
    async def boom(*_a, **_k):
        raise RuntimeError("挂了")

    async def beliefs():
        return [
            {"label": "L", "first_at": "2026-08-01", "last_at": "2026-09-01", "items": [{"content": "c"}]}
        ]

    srcs = asyncio.run(
        recap.gather_recent(
            profile_fn=boom,
            stuck_fn=boom,
            beliefs_fn=beliefs,
            journal_fn=boom,
            changes_fn=boom,
        )
    )
    assert [s["kind"] for s in srcs] == ["belief"]


def test_gather_all_dead_is_empty():
    async def boom(*_a, **_k):
        raise RuntimeError("挂了")

    srcs = asyncio.run(
        recap.gather_recent(
            profile_fn=boom, stuck_fn=boom, beliefs_fn=boom, journal_fn=boom, changes_fn=boom
        )
    )
    assert srcs == []


# ---------- save ----------


def test_save_writes_dated_file_in_recap_dir(indexed):
    rep = recap.Report(
        title="最近", sections=[recap.Section(heading="学到哪", body="B [1]")], used=[1]
    )
    srcs = [{"n": 1, "kind": "teach", "title": "画像", "ref": "", "text": "x"}]
    out = asyncio.run(recap.save(rep, srcs))

    assert out["filename"].startswith("recap/") and out["filename"].endswith(".md")
    dest = recap.VAULT_DIR / out["filename"]
    assert dest.exists()
    text = dest.read_text(encoding="utf-8")
    assert "# 最近" in text and "## 学到哪" in text
    assert "（学习画像）" in text  # kind 标签走的是共用映射
    assert indexed == [dest]


def test_save_same_day_overwrites(indexed):
    """一天一份：重跑刷新，不会堆成两份（同 digest 的做法）。"""
    rep = recap.Report(title="最近", sections=[recap.Section(heading="H", body="B [1]")], used=[1])
    srcs = [{"n": 1, "kind": "teach", "title": "t", "ref": "", "text": "x"}]

    first = asyncio.run(recap.save(rep, srcs))
    second = asyncio.run(recap.save(rep, srcs))

    assert first["filename"] == second["filename"]
    assert len(list(recap.RECAP_DIR.glob("*.md"))) == 1


# ---------- run ----------


def _run(**kw):
    async def _go():
        return [ev async for ev in recap.run(**kw)]

    return asyncio.run(_go())


async def _beliefs():
    return [{"label": "L", "first_at": "2026-08-01", "last_at": "2026-09-01", "items": [{"content": "c"}]}]


async def _no_profile():
    return {}


async def _no_stuck(days):
    return []


def _no_journal(limit):
    return []


def _no_changes(days):
    return []


def test_run_errors_without_provider(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "")
    events = _run()
    assert [e for e, _ in events] == ["error"]
    assert "provider" in events[0][1]["message"]


def test_run_errors_when_nothing_to_recap(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    events = _run(
        profile_fn=_no_profile,
        stuck_fn=_no_stuck,
        beliefs_fn=_no_stuck,  # 返回 [] 就行
        journal_fn=_no_journal,
        changes_fn=_no_changes,
    )
    assert [e for e, _ in events] == ["gathering", "error"]
    assert "记录" in events[1][1]["message"]


def test_run_happy_path_saves_and_reports(wired, indexed, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    stream = _llm(
        '{"title":"最近","sections":[{"heading":"最近在关注什么","body":"B [1]"}],"used":[1]}'
    )

    events = _run(
        profile_fn=_no_profile,
        stuck_fn=_no_stuck,
        beliefs_fn=_beliefs,
        journal_fn=_no_journal,
        changes_fn=_no_changes,
        stream_fn=stream,
    )

    kinds = [e for e, _ in events]
    # 流式：正文边生成边发 draft；滤掉它之后仍是原来的五步，且 draft 必在 report 之前
    assert [k for k in kinds if k != "draft"] == ["gathering", "sources", "writing", "report", "saved"]
    assert kinds.index("draft") < kinds.index("report")
    by_event = dict(events)
    report = by_event["report"]
    assert report["title"] == "最近" and report["used"] == [1]
    # 质量闭环的 join key：事件必须带上「这版提示词」的指纹，否则反馈没法按版本统计
    from app.core import report as report_mod

    assert report["prompt_sha"] == report_mod.prompt_sha(recap._SYNTH_PROMPT)
    saved = by_event["saved"]
    assert saved["filename"].startswith("recap/")
    assert saved["chunks"] == 5
    assert indexed  # 落盘之后确实进了索引
