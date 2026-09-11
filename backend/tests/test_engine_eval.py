"""成文引擎质量标尺的离线测试。

重点在**结构判分**（纯函数，不碰网络、不碰模型）——它接住大多数回归，也是唯一能
离线跑的那一半。接地判分（LLM）只测「走通了、分数与理由都落进 detail」这一层，
用假 stream_fn 注入。真实分数由 `smoke_engine_eval.py` 在真模型上跑。
"""
import asyncio

import pytest

from app.core import engine_eval as ee
from app.core.report import Report, Section

# ---------- 沙箱库：run() 要写 engine_eval_runs ----------

from app.db import engine as _engine  # noqa: E402
from app.models import Base as _Base  # noqa: E402


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


# ---------- 注入缝 ----------

REPORT_JSON = (
    '{"title":"T","sections":[{"heading":"最近在关注什么","body":"A [1]"},'
    '{"heading":"学到哪","body":"B [2]"},{"heading":"卡在哪","body":"C [1]"}],"used":[1,2]}'
)
DECIDE_REPORT_JSON = (
    '{"title":"方案","sections":['
    '{"heading":"到底在决定什么","body":"A [1]"},'
    '{"heading":"几个选项","body":"B [1]"},'
    '{"heading":"我的判断","body":"C [2]"},'
    '{"heading":"什么会推翻它","body":"D [1]"}],"used":[1,2]}'
)
JUDGE_JSON = '{"score":4,"reason":"主要论断有据"}'


def _fake_llm(*, report=REPORT_JSON, frame=None, judge=JUDGE_JSON):
    """按**系统提示词**路由的假模型，而不是按调用次序。

    用例现在是并发跑的（`asyncio.gather`），按次序发脚本会错位。三类调用的系统提示词
    互不相同，所以按内容路由既稳定又更贴近真实：谁问什么就答什么。
    """
    async def _stream(info, model, messages):
        sys = str(messages[0]["content"]) if messages else ""
        if "读成一次决策" in sys and frame is not None:
            yield frame
        elif "你是严格的评审" in sys:
            yield judge
        else:
            yield report

    return _stream


@pytest.fixture
def wired(monkeypatch):
    async def fake_resolve(model_id=""):
        from app.core.llm import ProviderInfo

        return ProviderInfo(kind="openai", base_url="http://x", api_key="k"), "test-model"

    monkeypatch.setattr(ee, "_resolve", fake_resolve)
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    # decide 的读题用的是它自己模块里的 `_resolve`（早绑定的引用），得单独打
    monkeypatch.setattr("app.core.decide._resolve", fake_resolve)


def _rep(sections, used, title="T"):
    return Report(
        title=title,
        sections=[Section(heading=h, body=b) for h, b in sections],
        used=list(used),
    )


SRC = [
    {"n": 1, "kind": "kb", "title": "A", "ref": "notes/a.md", "text": "内容A"},
    {"n": 2, "kind": "memory", "title": "记忆", "ref": "", "text": "内容B"},
]


def _codes(findings):
    return [f["code"] for f in findings]


# ---------- check_report ----------


def test_clean_report_has_no_findings():
    rep = _rep([("H1", "见 [1]"), ("H2", "见 [2]")], [1, 2])
    assert ee.check_report(rep, SRC, {"sections": ["H1", "H2"], "min_used": 2}) == []


def test_unknown_used_and_citation_are_flagged():
    rep = _rep([("H1", "见 [2] 和 [9]")], [1, 7])
    codes = _codes(ee.check_report(rep, SRC, {}))
    assert "unknown_used" in codes and "unknown_citation" in codes


def test_markdown_link_numbers_are_not_citations():
    """`[1](url)` 是链接不是引用——正则必须放过它，否则每篇带链接的产出都会假报错。"""
    rep = _rep([("H1", "参见 [1](https://example.com) 这篇 [2]")], [2])
    assert "unknown_citation" not in _codes(ee.check_report(rep, SRC, {"min_used": 1}))


def test_too_few_citations_flagged():
    rep = _rep([("H1", "只有一条 [1]")], [1])
    assert "too_few_citations" in _codes(ee.check_report(rep, SRC, {"min_used": 2}))


def test_missing_sections_flagged():
    rep = _rep([("最近在关注什么", "x [1]")], [1])
    f = ee.check_report(rep, SRC, {"sections": ["最近在关注什么", "学到哪", "卡在哪"]})
    assert _codes(f) == ["sections_missing"]
    assert "学到哪" in f[0]["detail"]


def test_too_few_sections_flagged():
    """研究和产出的提示词写的是「2-4 个小节」，名字各自定——所以只能查数量下限。

    这条是真撞出来的：drill 里 research 把该分的东西压成了一个小节，而当时标尺查不出。
    """
    rep = _rep([("H1", "x [1]")], [1])
    f = ee.check_report(rep, SRC, {"min_sections": 2})
    assert _codes(f) == ["too_few_sections"]
    assert "至少 2 个" in f[0]["detail"]


def test_min_sections_not_checked_when_not_declared():
    """复盘/方案要求的是固定小节名，那条已经由 sections_missing 兜住，别再叠一层。"""
    rep = _rep([("H1", "x [1]")], [1])
    assert "too_few_sections" not in _codes(ee.check_report(rep, SRC, {}))


def test_out_of_order_sections_flagged():
    rep = _rep([("H2", "x [1]"), ("H1", "y [1]")], [1])
    assert "sections_out_of_order" in _codes(ee.check_report(rep, SRC, {"sections": ["H1", "H2"]}))


def test_empty_section_flagged():
    rep = _rep([("H1", "x [1]"), ("H2", "   ")], [1])
    assert "empty_section" in _codes(ee.check_report(rep, SRC, {}))


def test_forbidden_phrase_flagged():
    """复盘禁「建议」——它是镜子不是任务清单，这条是提示词里写死的硬要求。"""
    rep = _rep([("卡在哪", "建议你下周先把阈值调一下 [1]")], [1])
    f = ee.check_report(rep, SRC, {"forbid": ["建议", "下一步"]})
    assert _codes(f) == ["forbidden_phrase"]
    assert "建议" in f[0]["detail"]


def test_required_kind_flagged():
    """方案：判断必须落在「你自己的材料」上——只引网络材料就是没做到。"""
    rep = _rep([("几个选项", "x [2]")], [2])
    assert "missing_required_kind" in _codes(ee.check_report(rep, SRC, {"require_kinds": ["kb"]}))
    ok = _rep([("几个选项", "x [1]")], [1])
    assert "missing_required_kind" not in _codes(ee.check_report(ok, SRC, {"require_kinds": ["kb"]}))


def test_missing_title_flagged():
    rep = _rep([("H1", "x [1]")], [1], title="")
    assert "title_missing" in _codes(ee.check_report(rep, SRC, {}))


# ---------- check_frame ----------


class _Frame:
    def __init__(self, decision="要决定 X", options=("A", "B"), criteria=("成本", "可逆")):
        self.decision = decision
        self.options = list(options)
        self.criteria = list(criteria)


def test_frame_passes_when_enough_options():
    assert ee.check_frame(_Frame(), {"frame": {"min_options": 2, "min_criteria": 2}}) == []


def test_frame_flags_single_option():
    """只摆一个选项 = 没帮你选——这是这条链路最核心的一条结构约束。"""
    f = ee.check_frame(_Frame(options=("A",)), {"frame": {"min_options": 2}})
    assert _codes(f) == ["frame_too_few_options"]


def test_frame_flags_few_criteria_and_no_decision():
    f = ee.check_frame(_Frame(decision="", criteria=()), {"frame": {"min_criteria": 3, "min_options": 2}})
    assert set(_codes(f)) == {"frame_no_decision", "frame_too_few_criteria"}


def test_frame_check_is_noop_without_expect():
    assert ee.check_frame(None, {}) == []


# ---------- golden set ----------


def test_fixtures_load_for_every_engine():
    counts = ee.all_case_counts()
    assert set(counts) == set(ee.ENGINES)
    assert all(n >= 2 for n in counts.values()), counts


def test_fixture_cases_are_wellformed():
    for engine in ee.ENGINES:
        for c in ee.load_cases(engine):
            assert c["id"] and c["topic"]
            assert c["sources"], f"{engine}/{c['id']} 没有材料"
            nums = [s["n"] for s in c["sources"]]
            assert nums == list(range(1, len(nums) + 1)), f"{engine}/{c['id']} 的 n 不连续"
            for s in c["sources"]:
                assert s.get("kind") and (s.get("text") or "").strip()


# ---------- run ----------


def _run(engine, **kw):
    async def _go():
        return await ee.run(engine, **kw)

    return asyncio.run(_go())


def test_run_rejects_unknown_engine():
    with pytest.raises(ValueError):
        _run("nope")


def test_run_structural_only_without_provider(monkeypatch, wired):
    """没有可用模型时判分那半跳过，结构判分照跑——它不花钱，也不该被 provider 拖住。"""
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "")

    async def no_resolve(model_id=""):
        return None

    monkeypatch.setattr(ee, "_resolve", no_resolve)
    out = _run("research", stream_fn=_fake_llm())
    assert out["judged"] is False and out["judge_model"] == ""
    run = out["runs"][0]
    assert run["total"] == 2
    assert run["grounded"] is None
    assert run["model_id"] == ""


def test_run_happy_path_records_both_scores(wired):
    out = _run("research", stream_fn=_fake_llm())
    assert out["judged"] is True
    assert len(out["runs"]) == 1

    run = out["runs"][0]
    assert run["engine"] == "research"
    assert run["total"] == 2
    assert run["structural"] == 1.0
    assert run["grounded"] == 4.0
    # join key 必须和 prompts/artifact_feedback 是同一个算法，否则自动分和人工分对不上
    from app.core import report as report_mod
    from app.core import research as research_mod

    assert run["prompt_sha"] == report_mod.prompt_sha(research_mod._SYNTH_PROMPT)
    assert run["id"] is not None

    detail = run["detail"]
    assert len(detail) == 2
    assert all(d["score"] == 4 for d in detail)
    assert all(d["reason"] for d in detail)
    assert all(d["error"] == "" for d in detail)


def test_run_decide_scores_the_frame_too(wired):
    """方案的用例要先读题——`frame` 的 findings 和正文的 findings 一起决定这条过不过。"""
    frame_json = (
        '{"decision":"选哪个向量库","options":["Chroma","Qdrant","LanceDB"],'
        '"criteria":["迁移代价","运维","检索质量"]}'
    )
    # 每个用例三次调用：读题 → 成文 → 判分（按系统提示词路由，乱序也不会错位）
    out = _run("decide", stream_fn=_fake_llm(frame=frame_json, report=DECIDE_REPORT_JSON))
    run = out["runs"][0]
    assert run["total"] == 2
    assert run["structural"] == 1.0  # 读题与正文都全过

    from app.core import decide as decide_mod
    from app.core import report as report_mod

    assert run["prompt_sha"] == report_mod.prompt_sha(decide_mod._SYNTH_PROMPT)
    assert run["detail"][0]["frame_findings"] == []


def test_run_decide_flags_a_single_option_frame(wired):
    frame_json = '{"decision":"选哪个","options":["只有一个"],"criteria":["a","b","c"]}'
    stream = _fake_llm(frame=frame_json, report=DECIDE_REPORT_JSON)
    run = _run("decide", stream_fn=stream)["runs"][0]
    assert _codes(run["detail"][0]["frame_findings"]) == ["frame_too_few_options"]
    assert run["structural"] < 1.0


# ---------- history / latest ----------


def test_compare_marks_prompt_change():
    newer = {"prompt_sha": "bbb", "structural": 1.0, "grounded": 4.0}
    older = {"prompt_sha": "aaa", "structural": 0.5, "grounded": 3.0}
    cmp = ee._compare(newer, older)
    assert cmp["prompt_changed"] is True
    assert cmp["improvements"] == ["grounded", "structural"]
    assert cmp["regressions"] == []


def test_compare_without_prompt_change():
    newer = {"prompt_sha": "aaa", "structural": 0.5, "grounded": 4.0}
    older = {"prompt_sha": "aaa", "structural": 1.0, "grounded": 4.0}
    cmp = ee._compare(newer, older)
    assert cmp["prompt_changed"] is False
    assert cmp["regressions"] == ["structural"]


def test_history_and_latest_shapes():
    hist = asyncio.run(ee.history())
    assert set(hist) == {"runs", "by_engine", "coverage"}
    latest = asyncio.run(ee.latest_by_engine())
    assert set(latest) == set(ee.ENGINES)


# ---------- health：标尺自己的体检 ----------


def test_health_warns_when_scores_pinned_to_the_top():
    """全在 4.5 以上 = 这套用例区分不出好坏，提示词改坏了也看不出来。"""
    latest = {"research": {"grounded": 4.8}, "compose": {"grounded": 4.6}}
    h = asyncio.run(ee.health(latest))
    # 用「压在顶部」而不是「区分度」判别：后者在「用例偏少」那条里也出现，会撞。
    assert any("压在顶部" in w for w in h["warnings"])
    assert h["engines"] == ["compose", "research"]


def test_health_quiet_when_scores_are_spread():
    latest = {"research": {"grounded": 4.0}, "compose": {"grounded": 3.0}}
    h = asyncio.run(ee.health(latest))
    assert not any("压在顶部" in w for w in h["warnings"])


def test_health_warns_when_never_run():
    h = asyncio.run(ee.health({"research": None, "compose": None}))
    assert h["engines"] == []
    assert any("还没跑过" in w for w in h["warnings"])
