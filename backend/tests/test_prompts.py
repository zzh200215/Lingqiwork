"""Prompt 注册中心的完整性测试。

核心价值：钉住「哪些提示词存在、内容是否被意外改动」。sha 是内容指纹——
如果某条 sha 变了，说明提示词被改过（无论是有意还是无意），这里会立刻红，
提示你去确认是否通过了对应的验收 drill。
"""
from app.core.prompts import dump_markdown, inline_notes, inventory, summary

# (module, name, sha12) —— 全量指纹，任何一条改动都能被精确定位。
_FINGERPRINTS = [
    ("app.core.tutor", "SOCRATIC_PROMPT", "2628ed0ab564"),
    ("app.core.tutor", "FEYNMAN_PROMPT", "e9fd94ec9044"),
    ("app.core.tutor", "FUTURE_PROMPT", "bdca8ef795e4"),
    ("app.core.tutor", "_EXTRACT_PROMPT", "27da8ab1904c"),
    ("app.core.tutor", "_SUMMARY_SYSTEM", "5618bcc46585"),
    ("app.core.research", "_PLAN_PROMPT", "b945ceb397e6"),
    ("app.core.research", "_SYNTH_PROMPT", "209cd89a1c70"),
    ("app.core.compose", "_SYNTH_PROMPT", "a56f9bfba701"),
    ("app.core.recap", "_SYNTH_PROMPT", "8adf1e6767e8"),
    ("app.core.decide", "_FRAME_PROMPT", "d7722eebb9a9"),
    ("app.core.decide", "_SYNTH_PROMPT", "afb0c6ccb4f3"),
    ("app.core.memory", "_AUTO_SYSTEM", "8f2821bef994"),
    ("app.core.memory_tidy", "_TIDY_SYSTEM", "2ddf30f42f85"),
    ("app.core.memory_tidy", "_REFLECT_SYSTEM", "56d6bed9fbdc"),
    ("app.core.kg", "_EXTRACTION_SYSTEM", "ae78ef1bcc76"),
    ("app.core.evals", "_JUDGE_SYSTEM", "465fedcd39e5"),
    ("app.core.tasks", "_PARSE_SYSTEM", "c6a244b989cb"),
    ("app.core.providers", "PROBE_PROMPT", "8f434346648f"),
    ("app.core.cards", "_GEN_SYSTEM", "1f8c8f382db6"),
    ("app.core.cards", "_REMEDY_SYSTEM", "2e8c45178395"),
    ("app.core.collab", "_DEFAULT_SYSTEM", "17a9182fc78b"),
    ("app.core.collab", "_REVIEW_SYSTEM", "9688cab53b97"),
    ("app.core.collab", "_REVISION_INSTRUCTION", "54f0055ac7e4"),
    ("app.core.podcast", "_SCRIPT_SYSTEM", "ad4adc32e4e8"),
    ("app.core.pet", "CHAT_SYSTEM", "ad628c50a9e4"),
    ("app.routers.pet", "_PET_TOOL_RULE", "8602fcdecb73"),
    ("app.routers.dashboard", "_BRIEFING_SYSTEM", "b450db794e95"),
    ("app.routers.notes", "_WRITER_PERSONA", "db55b995544d"),
    ("app.routers.notes", "_DEFAULT_REWRITE_INSTRUCTION", "ccb0a4ac2faf"),
    ("app.routers.notes", "_BRIEFING_SYSTEM", "d310e05b8727"),
    ("app.core.llm", "_JSON_HINT", "18f4e689b461"),
    ("app.routers.chat", "_OUTPUT_RULE", "d583da7e7f2f"),
]


def test_inventory_count():
    items = inventory()
    assert len(items) == 32
    assert len(items) == len(_FINGERPRINTS)


def test_no_missing_registration():
    items = inventory()
    missing = [p.name for p in items if p.content is None]
    assert missing == [], f"登记漂移：{missing}"


def test_module_name_pairs_unique():
    items = inventory()
    pairs = [(p.module, p.name) for p in items]
    assert len(pairs) == len(set(pairs)), "存在重复的 (module, name) 登记"


def test_all_content_nonempty():
    items = inventory()
    empty = [f"{p.module}.{p.name}" for p in items if not p.content]
    assert empty == []


def test_fingerprints_stable():
    """防漂移：任何提示词内容改动都会改变 sha，此处会红。

    若某条提示词是**有意**修改（且通过了对应验收 drill），请同步更新上方的
    _FINGERPRINTS 里对应的 sha——用 `app/core/prompts.py` 的 summary() 或
    `smoke_prompts.py` 重新算出即可。
    """
    items = inventory()
    got = {(p.module, p.name): p.sha for p in items}
    for module, name, sha in _FINGERPRINTS:
        assert got.get((module, name)) == sha, f"{module}.{name} 指纹漂移"


def test_dump_markdown_contains_all():
    md = dump_markdown()
    assert "WorkBuddy 提示词全清单" in md
    for module, name, _ in _FINGERPRINTS:
        assert f"### `{name}`" in md
    # 内联清单也进了文档
    assert "## 内联提示词" in md


def test_inline_notes_registered():
    notes = inline_notes()
    assert len(notes) == 8
    assert all(isinstance(m, str) and isinstance(ln, int) and isinstance(p, str) for m, ln, p in notes)


def test_summary_shape():
    s = summary()
    assert s["count"] == 32
    assert s["inline"] == 8
    assert s["missing"] == []
    assert s["by_module"]["app.routers.chat"] == 1
    assert s["by_module"]["app.routers.pet"] == 1
    assert s["by_module"]["app.core.tutor"] == 5
    assert s["by_module"]["app.core.research"] == 2
    assert s["by_module"]["app.core.compose"] == 1
    assert s["by_module"]["app.core.recap"] == 1
    assert s["by_module"]["app.core.decide"] == 2
