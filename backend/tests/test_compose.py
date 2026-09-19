"""产出引擎（学习闭环的出口跳）的离线测试。

全部不打网络、不碰真实索引也不碰真实记忆库：`synthesize` 的模型调用走 `stream_fn`
注入，`gather_inward` 的三路（知识库 / 长期记忆 / 日记）都注入假函数。真实链路由
`smoke_compose.py` 验（真模型 + 真索引）。
"""
import asyncio
import atexit
import shutil
import tempfile
from pathlib import Path

import pytest

from app.core import compose

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

    monkeypatch.setattr(compose, "_resolve", fake_resolve)


async def _no_kb(query, top_k):
    return []


async def _no_memory(query):
    return ""


def _no_journal(limit):
    return []


async def _collect(gen) -> list[tuple[str, dict]]:
    return [ev async for ev in gen]


# ---------- gather_inward ----------


def test_gather_orders_kb_then_memory_then_journal():
    async def kb(query, top_k):
        return [
            {"source": "notes/a.md", "title": "A", "text": "内容A"},
            {"source": "notes/b.md", "title": "B", "text": "   "},  # 空文本 → 跳过
        ]

    async def memory(query):
        return "偏好：喜欢先拆任务"

    def journal(limit):
        return [
            {"date": "2026-09-09", "time": "08:10", "text": "在想 RAG 的评测"},
            {"date": "2026-09-08", "time": "21:00", "text": "读了 Agentic RAG"},
        ]

    srcs = asyncio.run(
        compose.gather_inward("RAG", kb_fn=kb, memory_fn=memory, journal_fn=journal)
    )

    assert [s["n"] for s in srcs] == [1, 2, 3]
    assert [s["kind"] for s in srcs] == ["kb", "memory", "journal"]
    assert srcs[0]["ref"] == "notes/a.md"  # 自己的成品排第一
    assert "偏好：喜欢先拆任务" in srcs[1]["text"]
    assert "2026-09-09 08:10 在想 RAG 的评测" in srcs[2]["text"]


def test_gather_accepts_async_journal():
    async def journal(limit):
        return [{"date": "2026-09-09", "time": "09:00", "text": "异步日记"}]

    srcs = asyncio.run(
        compose.gather_inward(
            "t", kb_fn=_no_kb, memory_fn=_no_memory, journal_fn=journal
        )
    )
    assert [s["kind"] for s in srcs] == ["journal"]


def test_gather_survives_any_single_leg_failing():
    async def boom(*_a, **_k):
        raise RuntimeError("挂了")

    # 只有知识库活着——记忆与日记全挂，照常出一条材料
    async def kb(query, top_k):
        return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]

    srcs = asyncio.run(
        compose.gather_inward("t", kb_fn=kb, memory_fn=boom, journal_fn=boom)
    )
    assert [s["kind"] for s in srcs] == ["kb"]


def test_gather_returns_empty_when_every_leg_fails():
    async def boom(*_a, **_k):
        raise RuntimeError("挂了")

    srcs = asyncio.run(compose.gather_inward("t", kb_fn=boom, memory_fn=boom, journal_fn=boom))
    assert srcs == []


def test_gather_skips_blank_memory():
    # `journal.recent()` 自身已过滤空条目（`_parse`），所以这里只测记忆这条真会空的路：
    # `memory.format_memories()` 在没有记忆时返回 ""。
    async def blank_memory(query):
        return "   "

    srcs = asyncio.run(
        compose.gather_inward(
            "t", kb_fn=_no_kb, memory_fn=blank_memory, journal_fn=_no_journal
        )
    )
    assert srcs == []


# ---------- save ----------


def test_save_writes_vault_notes_and_indexes(monkeypatch):
    seen: list[Path] = []

    def fake_index(path, **kw):
        seen.append(Path(path))
        return 3

    monkeypatch.setattr("app.core.indexer.index_file", fake_index)

    rep = compose.Report(
        title="RAG 笔记", sections=[compose.Section(heading="H", body="B [1]")], used=[1]
    )
    srcs = [{"n": 1, "kind": "kb", "title": "笔记", "ref": "notes/a.md", "text": "x"}]
    out = asyncio.run(compose.save(rep, srcs))

    assert out["chunks"] == 3
    assert out["filename"].startswith("notes/") and out["filename"].endswith(".md")
    dest = compose.COMPOSE_DIR / Path(out["filename"]).name
    assert dest.exists()
    assert "RAG 笔记" in dest.read_text(encoding="utf-8")
    assert seen == [dest]  # 落盘之后确实进了索引——「下次先捞你自己的」靠这一步


# ---------- run（完整生成器） ----------


def _run(topic, **kw):
    async def _go():
        return await _collect(compose.run(topic, **kw))

    return asyncio.run(_go())


def test_run_rejects_empty_topic(wired):
    assert _run("   ") == [("error", {"message": "话题不能为空"})]


def test_run_errors_without_provider(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "")
    events = _run("话题")
    assert [e for e, _ in events] == ["error"]
    assert "provider" in events[0][1]["message"]


def test_run_errors_when_no_material(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    events = _run(
        "话题", kb_fn=_no_kb, memory_fn=_no_memory, journal_fn=_no_journal
    )
    assert [e for e, _ in events] == ["gathering", "error"]


def test_run_happy_path(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    async def kb(query, top_k):
        return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]

    async def memory(query):
        return "偏好：喜欢先拆任务"

    stream = _llm('{"title":"R","sections":[{"heading":"H","body":"B [1]"}],"used":[1]}')
    events = _run("话题", kb_fn=kb, memory_fn=memory, journal_fn=_no_journal, stream_fn=stream)

    kinds = [e for e, _ in events]
    # 流式：正文边生成边发 draft。滤掉 draft 之后仍是原来的四步，且 draft 必在 report 之前
    assert [k for k in kinds if k != "draft"] == ["gathering", "sources", "writing", "report"]
    assert kinds.index("draft") < kinds.index("report")
    draft = dict(events)["draft"]
    assert draft["title"] == "R" and draft["sections"][0]["heading"] == "H"
    by_event = dict(events)
    sources = by_event["sources"]
    assert len(sources["sources"]) == 2 and sources["kb"] == 1
    assert set(sources["sources"][0]) == {"n", "kind", "title", "ref"}  # 不带正文
    report = by_event["report"]
    assert report["title"] == "R"
    assert report["used"] == [1]
    assert report["model_id"] == "test-model"
    # 质量闭环的 join key：事件必须带上「这版提示词」的指纹，否则反馈没法按版本统计
    from app.core import report as report_mod

    assert report["prompt_sha"] == report_mod.prompt_sha(compose._SYNTH_PROMPT)


# ---------- S1：引擎吃 skill（PLAN3 S1） ----------

_TMP_SKILLS = Path(tempfile.mkdtemp(prefix="wb-compose-skills-", dir=Path(".").resolve()))
atexit.register(lambda: shutil.rmtree(_TMP_SKILLS, ignore_errors=True))

_SKILL_NAME = "给领导写汇报要结论先行"
_REPORT_JSON = '{"title":"R","sections":[{"heading":"H","body":"B [1]"}],"used":[1]}'


@pytest.fixture
def engine_skills(monkeypatch):
    """技能目录指到一个临时目录（每个用例都是空的）——真 `skills/` 一个字节都不动。"""
    from app.core import skills as skills_core

    d = _TMP_SKILLS / "skills"
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(skills_core, "SKILLS_DIR", d)
    return d


def _put_skill(root: Path) -> None:
    d = root / _SKILL_NAME
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        "---\n"
        f"name: {_SKILL_NAME}\n"
        "description: 要把工作结果汇报给领导、需要一页纸讲清结论时用\n"
        "---\n\n"
        "第一步：第一个小节就叫「结论」，一句话说清判断。\n",
        encoding="utf-8",
    )


def _capture(payload: str):
    """假 stream_fn + 把 messages 记下来——「system 里到底有什么」是这一节的验收。"""
    seen: list[list[dict]] = []

    async def _stream(info, model, messages):
        seen.append(messages)
        yield payload

    return _stream, seen


async def _kb_one(query, top_k):
    return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]


def test_run_injects_the_matched_skill_into_the_system(engine_skills, wired, monkeypatch):
    """S1 验收第 2 条：命中 → 工序进 system，且与 `skill_eval` 的「有它」侧**逐字一致**。"""
    from app.core import skills as skills_core

    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    _put_skill(engine_skills)

    stream, seen = _capture(_REPORT_JSON)
    events = _run(
        "给领导汇报这次项目的结论",
        kb_fn=_kb_one,
        memory_fn=_no_memory,
        journal_fn=_no_journal,
        stream_fn=stream,
    )

    kinds = [e for e, _ in events]
    # 手动那条路没有运行记录，所以「看得见」全靠这条事件——而且它在写之前
    assert dict(events)["skills"]["skills"] == [_SKILL_NAME]
    assert kinds.index("skills") < kinds.index("writing")

    system = seen[0][0]
    assert system["role"] == "system"
    body = skills_core.load_skill(_SKILL_NAME)
    assert system["content"].startswith(compose._SYNTH_PROMPT)
    assert system["content"].endswith(f"按这套工序做：\n\n{body}")


def test_run_without_a_match_leaves_the_prompt_alone(engine_skills, wired, monkeypatch):
    """S1 验收第 2 条的反面：不命中 → **一个字都不多**（system 逐字节 = 引擎自己那份）。"""
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    stream, seen = _capture(_REPORT_JSON)
    events = _run(
        "给领导汇报这次项目的结论",
        kb_fn=_kb_one,
        memory_fn=_no_memory,
        journal_fn=_no_journal,
        stream_fn=stream,
    )
    assert "skills" not in [e for e, _ in events]
    assert seen[0][0] == {"role": "system", "content": compose._SYNTH_PROMPT}
