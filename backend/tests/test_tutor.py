"""Offline tests for 对话式教学 (PLAN.md 第 6 节 第一步).

Scratch db via WB_DB_PATH before import, same pattern as test_usage.py. No model
and no embedder are touched: `_embed`, `_stream` and `_extract` are the three
seams, monkeypatched per test.

What is actually pinned here is the part PLAN.md 第 4 节 calls the only unique
value — that a session ends as a 概念/自评/卡点 triple, that a later related topic
gets it back, and that an *unrelated* topic does not.
"""
import asyncio
import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-tutor-", dir=Path(__file__).parent))


def _cleanup() -> None:
    try:
        asyncio.run(engine.dispose())
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")
# 取材（第 7 节）走真 chroma；不指走就等于每次跑测试都摸真实库
os.environ["WB_CHROMA_PATH"] = str(_TMP / "chroma")

from app.core import tutor as core  # noqa: E402
from app.db import engine  # noqa: E402


@pytest.fixture(autouse=True)
def _no_kb_retrieval(monkeypatch):
    """Default every test to an empty KB so say() never reaches the real index.

    Tests that exercise 取材 override `core._retrieve` themselves.
    """

    async def nothing(query: str, top_k: int):
        return []

    monkeypatch.setattr(core, "_retrieve", nothing)

_INIT = False


async def _init_db() -> None:
    global _INIT
    from app.models import Base

    if not _INIT:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        _INIT = True


async def _fake_embed(texts):
    """Three axes: 事件循环 / 闭包 / 协程. Anything else lands between them, below the floor.

    协程 is its own axis on purpose: it is the *synonym rewrite* vocabulary. A row's
    primary text (topic + concept + stuck) says 事件循环, its alias line says 协程, and
    a query months later says 协程 — so the alias line is the only text that can reach
    it, which is the whole reason `aliases` exists.
    """
    out = []
    for t in texts:
        if "事件循环" in t or "await" in t:
            out.append([1.0, 0.0, 0.0])
        elif "闭包" in t:
            out.append([0.0, 1.0, 0.0])
        elif "协程" in t:
            out.append([0.0, 0.0, 1.0])
        else:
            out.append([0.6, 0.8, 0.0])
    return out


def _fake_stream(chunks: list[str], seen: list | None = None):
    async def stream(model_id, messages):
        if seen is not None:
            seen.append((model_id, messages))
        for c in chunks:
            yield c

    return stream


async def _collect(agen) -> list:
    return [e async for e in agen]



async def _seed(
    topic: str,
    concept: str,
    verdict: str,
    stuck: str = "",
    recalled: bool = False,
    aliases: str = "",
) -> int:
    """A finished past session, written directly — `end()` has its own tests."""
    from app.db import SessionLocal
    from app.models import TutorSession, utcnow

    async with SessionLocal() as db:
        row = TutorSession(
            topic=topic,
            concept=concept,
            verdict=verdict,
            stuck=stuck,
            aliases=aliases,
            recalled=recalled,
            ended_at=utcnow(),
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


# ---------- pure functions ----------


def test_cosine_bounds():
    assert core._cosine([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)
    assert core._cosine([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)
    assert core._cosine([1.0, 2.0], [1.0]) == 0.0  # ragged input must not raise
    assert core._cosine([], []) == 0.0
    assert core._cosine([0.0, 0.0], [1.0, 1.0]) == 0.0  # zero vector, no ZeroDivision


def test_clean_aliases_joins_a_list_into_one_line():
    # `|` 是 ALIAS_SEP：别名边界必须活到召回（tutor.py 里量过，空格会把
    # 「event loop 调度」切成碎词，碎词自己就能越过 0.62）
    assert core._clean_aliases(["协程什么时候切换", "event loop 调度"]) == "协程什么时候切换 | event loop 调度"


def test_clean_aliases_accepts_the_shapes_models_actually_return():
    # a comma string instead of a list, and 、 / ； are what a Chinese model reaches for
    assert core._clean_aliases("协程切换、event loop 调度；GIL") == "协程切换 | event loop 调度"  # GIL：3 字裸词，MIN 挡
    assert core._clean_aliases([{"alias": "协程切换"}]) == "协程切换"
    assert core._clean_aliases("「协程切换」") == "协程切换"
    for junk in (None, 3, {"a": "b"}, [], ""):
        assert core._clean_aliases(junk) == ""


def test_clean_aliases_drops_the_concept_echoed_back():
    """The alias line is embedded on its own, so the concept in it does the opposite
    of what aliases are for — it pulls the vector back to the standard term the user
    could not remember (smoke_recall.py 变体 C vs D: 0.621 → 0.643)."""
    assert core._clean_aliases(["asyncio 事件循环", "协程切换"], "asyncio 事件循环") == "协程切换"
    assert core._clean_aliases(["asyncio  事件循环"], "asyncio 事件循环") == ""  # spacing差异不算新别名


def test_clean_aliases_dedupes_caps_and_drops_junk():
    assert core._clean_aliases(["协程切换", "协程切换", "协程切换 "]) == "协程切换"
    assert len(core._clean_aliases([f"别名{i}" for i in range(20)]).split(core.ALIAS_SEP)) == core.ALIAS_MAX
    assert core._clean_aliases(["x", "、", "协程切换"]) == "协程切换"  # 1 字的挡不住任何噪声
    assert core._clean_aliases(["很" * (core.ALIAS_CHARS_EACH + 1)]) == ""  # 整句不是别名


def test_format_recall_empty_is_empty():
    assert core.format_recall([]) == ""


def test_format_recall_carries_the_stuck_point_and_the_no_forcing_rule():
    block = core.format_recall(
        [
            {"concept": "asyncio 事件循环", "verdict": "half", "stuck": "以为 await 交给了操作系统", "date": "08-21"},
            {"concept": "GIL", "verdict": "got", "stuck": "", "date": "08-19"},
        ]
    )
    assert "asyncio 事件循环" in block and "以为 await 交给了操作系统" in block
    assert "08-21" in block
    assert "半懂" in block and "说通了" in block
    # 验收 asks that recall be *right*; without this line the model links anything
    # it is handed, which is how a wrong recall looks from the outside.
    assert "无关" in block and "硬扯" in block


def test_format_recall_tolerates_missing_keys():
    assert "闭包" in core.format_recall([{"concept": "闭包"}])


def test_build_messages_puts_voice_first_recall_second():
    msgs = core.build_messages([{"role": "user", "content": "想搞懂 await"}], "RECALL-BLOCK")
    assert [m["role"] for m in msgs] == ["system", "system", "user"]
    assert msgs[0]["content"] == core.SOCRATIC_PROMPT
    assert msgs[1]["content"] == "RECALL-BLOCK"


def test_build_messages_without_recall_sends_only_the_voice():
    msgs = core.build_messages([{"role": "user", "content": "x"}])
    assert len(msgs) == 2 and msgs[0]["content"] == core.SOCRATIC_PROMPT


def test_build_messages_keeps_the_opening_line_when_truncating():
    history = [{"role": "user", "content": "我想搞懂 X"}] + [
        {"role": "assistant" if i % 2 else "user", "content": f"turn {i}"}
        for i in range(core.HISTORY_LIMIT + 20)
    ]
    msgs = core.build_messages(history)
    body = msgs[1:]
    assert len(body) == core.HISTORY_LIMIT
    # dropping the opening line is what makes the model forget what it is teaching
    assert body[0]["content"] == "我想搞懂 X"
    assert body[-1]["content"] == history[-1]["content"]


# ---------- session lifecycle ----------


async def _reset() -> None:
    from sqlalchemy import delete

    from app.db import SessionLocal
    from app.models import TutorSession, TutorTurn

    core._SESSION_SOURCES.clear()  # 进程内的已引用来源是测试间的隐藏状态
    await _init_db()
    async with SessionLocal() as db:
        await db.execute(delete(TutorTurn))
        await db.execute(delete(TutorSession))
        await db.commit()


async def test_start_pins_the_model_and_reports_its_health(monkeypatch):
    await _reset()
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "p/m")
    monkeypatch.setattr(providers, "is_unhealthy", lambda mid, cache=None: False)
    got = await core.start("  asyncio 事件循环  ")
    assert got["topic"] == "asyncio 事件循环" and got["model_id"] == "p/m"
    assert got["model_ok"] is True

    # 第 9 节: a known-broken model has to be visible before the first reply
    monkeypatch.setattr(providers, "is_unhealthy", lambda mid, cache=None: True)
    assert (await core.start("闭包"))["model_ok"] is False


async def test_start_with_no_provider_is_not_ok(monkeypatch):
    await _reset()
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: None)
    got = await core.start("GIL")
    assert got["model_id"] == "" and got["model_ok"] is False


async def test_start_rejects_an_empty_topic():
    await _reset()
    for bad in ("", "   ", "\n"):
        with pytest.raises(ValueError):
            await core.start(bad)


async def test_turns_roundtrip_in_order():
    await _reset()
    sid = await _seed("x", "", "")
    await core.add_turn(sid, "user", "第一句")
    await core.add_turn(sid, "assistant", "第二句")
    assert await core.turns(sid) == [
        {"role": "user", "content": "第一句"},
        {"role": "assistant", "content": "第二句"},
    ]


# ---------- recall: the only unique value in the product (第 4 节) ----------


async def test_recall_returns_the_related_session_and_drops_the_unrelated(monkeypatch):
    await _reset()
    monkeypatch.setattr(core, "_embed", _fake_embed)
    await _seed("上次聊的", "asyncio 事件循环", "half", "以为 await 交给了操作系统")
    await _seed("更早", "JS 闭包", "got")

    hits = await core.recall_hits("我想搞懂 asyncio 事件循环")
    assert [h["concept"] for h in hits] == ["asyncio 事件循环"]
    assert hits[0]["stuck"] == "以为 await 交给了操作系统"
    assert hits[0]["score"] >= core.RECALL_MIN_SIM


async def test_recall_stays_empty_when_nothing_clears_the_floor(monkeypatch):
    await _reset()
    monkeypatch.setattr(core, "_embed", _fake_embed)
    await _seed("上次", "JS 闭包", "got")
    # top-k alone would inject this anyway; the floor is what keeps recall honest
    assert await core.recall_hits("我想搞懂 asyncio 事件循环") == []


async def test_recall_skips_useless_verdicts_and_unlabelled_sessions(monkeypatch):
    await _reset()
    monkeypatch.setattr(core, "_embed", _fake_embed)
    await _seed("没用那次", "asyncio 事件循环", "useless", "以为 await 交给了操作系统")
    await _seed("没标概念", "", "got", "await 的事")
    assert await core.recall_hits("asyncio 事件循环") == []


async def test_recall_excludes_the_running_session(monkeypatch):
    await _reset()
    monkeypatch.setattr(core, "_embed", _fake_embed)
    sid = await _seed("这次", "asyncio 事件循环", "half", "await")
    assert await core.recall_hits("asyncio 事件循环", exclude_id=sid) == []
    assert len(await core.recall_hits("asyncio 事件循环")) == 1


async def test_recall_caps_at_top_k(monkeypatch):
    await _reset()
    monkeypatch.setattr(core, "_embed", _fake_embed)
    for i in range(core.RECALL_TOP_K + 2):
        await _seed(f"第{i}次", f"asyncio 事件循环 {i}", "got")
    assert len(await core.recall_hits("asyncio 事件循环")) == core.RECALL_TOP_K


async def test_recall_survives_a_broken_embedder(monkeypatch):
    await _reset()

    async def boom(texts):
        raise RuntimeError("模型没加载")

    monkeypatch.setattr(core, "_embed", boom)
    await _seed("上次", "asyncio 事件循环", "half", "await")
    assert await core.recall_hits("asyncio 事件循环") == []  # teaching goes on regardless


async def test_recall_reaches_a_synonym_rewrite_through_the_alias_line(monkeypatch):
    """别名存在的唯一理由（2026-09-06）。

    A row's primary text carries the standard term (事件循环); months later the same
    question comes back as a phenomenon (协程什么时候切换). Real measurement on
    bge-small-zh: that pair scores 0.44–0.49 on the primary text — under the noise
    ceiling, so no threshold reaches it — and 0.707 on the alias line. `via` says
    which text won, because 「别名有没有在挣钱」 is otherwise unanswerable.
    """
    await _reset()
    monkeypatch.setattr(core, "_embed", _fake_embed)
    await _seed(
        "上次", "asyncio 事件循环", "half", "以为 await 交给了操作系统",
        aliases="协程什么时候切换 event loop 调度",
    )

    hits = await core.recall_hits("协程是在什么时机切换的")
    assert [h["concept"] for h in hits] == ["asyncio 事件循环"]
    assert hits[0]["via"] == "alias" and hits[0]["stuck"] == "以为 await 交给了操作系统"
    # and the standard term still comes in on the primary text, not through the alias
    assert (await core.recall_hits("asyncio 事件循环"))[0]["via"] == "concept"


async def test_a_blank_alias_line_never_becomes_a_candidate(monkeypatch):
    """Whitespace-only `aliases` must behave exactly like none.

    An empty alias text still embeds to *something*, and rows written before aliases
    existed have none at all — in both cases the alias candidate would degenerate to
    matching on the concept alone, which smoke_recall.py measured as the worst
    variant (unrelated pairs reach the same 0.601 as real ones). Taking a max against
    that is how noise gets let back in.
    """
    await _reset()
    monkeypatch.setattr(core, "_embed", _fake_embed)
    await _seed("上次", "asyncio 事件循环", "half", "以为 await 交给了操作系统", aliases="   ")

    hits = await core.recall_hits("asyncio 事件循环")
    assert len(hits) == 1 and hits[0]["via"] == "concept"
    assert await core.recall_hits("协程是在什么时机切换的") == []  # 没别名就接不住改写


def test_the_floor_clears_the_measured_noise_ceiling():
    """0.45 → 0.62 on 2026-09-05, from `smoke_recall.py`'s measurement.

    bge-small-zh-v1.5 scores *any* two short Chinese technical phrases at roughly
    0.4-0.6, so the old floor sat below the noise rather than above it: 「Rust 的
    所有权和借用检查」 pulled 「asyncio 事件循环」 at 0.555, and a three-line recall
    block came back with two wrong lines. From the outside that is exactly 第 5 节's
    「触发了但没用」 — the signal that says cut recall, reached for a tuning reason.

    Offline on purpose (no model loaded): this only stops the constant from being
    loosened. Whether the number still separates *real* embeddings is
    smoke_recall.py's job, and it checks this same recorded ceiling against them.
    """
    assert core.RECALL_MIN_SIM > core.RECALL_MIN_SIM_NOISE_CEILING
    assert core.RECALL_MIN_SIM_NOISE_CEILING >= 0.55, "噪声真有这么高，写低了等于没量"


async def test_a_candidate_inside_the_noise_band_is_not_a_hit(monkeypatch):
    """`_fake_embed`'s third bucket scores 0.6 — inside the band where the real
    embedder parks unrelated technical Chinese, and above the floor this used to
    have. Nothing in that band may come back as a hit."""
    await _reset()
    monkeypatch.setattr(core, "_embed", _fake_embed)
    assert core._cosine([1.0, 0.0, 0.0], [0.6, 0.8, 0.0]) == pytest.approx(0.6)

    await _seed("上次", "Docker 镜像分层", "got", "以为每层都要重新下载")
    assert await core.recall_hits("asyncio 事件循环") == []


# ---------- one exchange ----------


async def test_say_streams_writes_both_turns_and_feeds_recall_to_the_model(monkeypatch):
    await _reset()
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "p/m")
    monkeypatch.setattr(core, "_embed", _fake_embed)
    await _seed("上次", "asyncio 事件循环", "half", "以为 await 交给了操作系统")
    sid = (await core.start("asyncio 事件循环"))["id"]

    seen: list = []
    monkeypatch.setattr(core, "_stream", _fake_stream(["你觉得 await ", "控制权去哪了？"], seen))
    events = [e async for e in core.say(sid, "我想搞懂 await")]

    kinds = [k for k, _ in events]
    assert kinds[0] == "recall" and kinds[-1] == "done"
    assert [d["text"] for k, d in events if k == "delta"] == ["你觉得 await ", "控制权去哪了？"]
    assert next(d for k, d in events if k == "recall")["hits"][0]["concept"] == "asyncio 事件循环"
    assert next(d for k, d in events if k == "done") == {"model_id": "p/m", "recalled": True}

    model_id, messages = seen[0]  # the block reached the model, not just the page
    assert model_id == "p/m"
    assert "以为 await 交给了操作系统" in messages[1]["content"]
    assert messages[-1] == {"role": "user", "content": "我想搞懂 await"}

    assert await core.turns(sid) == [
        {"role": "user", "content": "我想搞懂 await"},
        {"role": "assistant", "content": "你觉得 await 控制权去哪了？"},
    ]


async def test_say_announces_recall_once_but_keeps_sending_it(monkeypatch):
    await _reset()
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "p/m")
    monkeypatch.setattr(core, "_embed", _fake_embed)
    await _seed("上次", "asyncio 事件循环", "half", "以为 await 交给了操作系统")
    sid = (await core.start("asyncio 事件循环"))["id"]

    seen: list = []
    monkeypatch.setattr(core, "_stream", _fake_stream(["答"], seen))
    await _collect(core.say(sid, "第一句"))
    second = [k for k, _ in await _collect(core.say(sid, "第二句"))]

    assert "recall" not in second  # one chip per session, not one per message
    # but the block must stay in every request or the model forgets the 卡点
    assert "以为 await 交给了操作系统" in seen[1][1][1]["content"]


async def test_say_without_recall_sends_only_the_teaching_voice(monkeypatch):
    await _reset()
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "p/m")
    monkeypatch.setattr(core, "_embed", _fake_embed)
    sid = (await core.start("JS 闭包"))["id"]

    seen: list = []
    monkeypatch.setattr(core, "_stream", _fake_stream(["答"], seen))
    events = await _collect(core.say(sid, "闭包是什么"))

    assert "recall" not in [k for k, _ in events]
    assert next(d for k, d in events if k == "done")["recalled"] is False
    assert [m["role"] for m in seen[0][1]] == ["system", "user"]


async def test_say_keeps_the_partial_reply_when_the_model_dies_midway(monkeypatch):
    await _reset()
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "p/m")
    monkeypatch.setattr(core, "_embed", _fake_embed)
    sid = (await core.start("GIL"))["id"]

    async def half_dead(model_id, messages):
        yield "讲到一半"
        raise RuntimeError("连接断了")

    monkeypatch.setattr(core, "_stream", half_dead)
    events = await _collect(core.say(sid, "GIL 是什么"))

    assert [k for k, _ in events] == ["delta", "error"]
    assert "连接断了" in events[-1][1]["message"]
    # what you typed AND what you already read must survive a mid-stream failure
    assert await core.turns(sid) == [
        {"role": "user", "content": "GIL 是什么"},
        {"role": "assistant", "content": "讲到一半"},
    ]


async def test_say_rejects_empty_text_and_missing_sessions(monkeypatch):
    await _reset()
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "p/m")
    assert (await _collect(core.say(1, "   ")))[0][0] == "error"
    events = await _collect(core.say(999999, "在吗"))
    assert events[0][0] == "error" and "999999" in events[0][1]["message"]


async def test_say_says_so_when_no_provider_is_configured(monkeypatch):
    await _reset()
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: None)
    sid = (await core.start("GIL"))["id"]
    events = await _collect(core.say(sid, "GIL 是什么"))
    assert events[0][0] == "error" and "provider" in events[0][1]["message"]
    assert await core.turns(sid) == []  # nothing written, nothing lost


# ---------- 取材：讲你自己的材料（第 7 节 第 1 条） ----------


def test_format_material_labels_sources_and_caps_each_chunk():
    long = "x" * (core.MATERIAL_CHUNK_CHARS + 500)
    block = core.format_material(
        [{"source": "clippings/fastapi.md", "text": long, "title": "FastAPI"}]
    )
    assert "[来源 1 — clippings/fastapi.md]" in block
    assert long not in block  # capped, or one chunk drowns the teaching voice
    assert core.format_material([]) == ""


def test_build_messages_orders_material_after_recall_and_before_transcript():
    history = [{"role": "user", "content": "问"}]
    msgs = core.build_messages(history, recall="R", material="M")
    assert [m["role"] for m in msgs] == ["system", "system", "system", "user"]
    assert msgs[1]["content"] == "R" and msgs[2]["content"] == "M"


async def test_say_pulls_material_from_the_kb_and_tells_the_page(monkeypatch):
    await _reset()
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "p/m")

    async def fake_retrieve(query: str, top_k: int):
        assert query == "lifespan 是什么时候触发的"  # 这一轮的提问，不是 topic
        assert top_k == core.MATERIAL_TOP_K
        return [{"source": "notes/asgi.md", "text": "lifespan 在启动时…", "score": 0.7}]

    monkeypatch.setattr(core, "_retrieve", fake_retrieve)
    sid = (await core.start("asgi lifespan"))["id"]
    seen: list = []
    monkeypatch.setattr(core, "_stream", _fake_stream(["讲"], seen))

    events = await _collect(core.say(sid, "lifespan 是什么时候触发的"))

    src = next(d for k, d in events if k == "sources")
    assert src == {"sources": [{"source": "notes/asgi.md", "title": "", "score": 0.7}]}
    _model, messages = seen[0]
    assert "[来源 1 — notes/asgi.md]" in messages[1]["content"]  # reached the model


async def test_say_silently_drops_material_when_retrieval_breaks(monkeypatch):
    """A broken index is a degraded answer, not a failed lesson."""
    await _reset()
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "p/m")

    async def boom(query: str, top_k: int):
        raise RuntimeError("chroma 挂了")

    monkeypatch.setattr(core, "_retrieve", boom)
    sid = (await core.start("GIL"))["id"]
    seen: list = []
    monkeypatch.setattr(core, "_stream", _fake_stream(["答"], seen))

    events = await _collect(core.say(sid, "GIL 是什么"))
    assert [k for k, _ in events] == ["delta", "done"]  # no sources event, no failure
    assert "来源" not in seen[0][1][1]["content"]


async def test_say_sends_no_material_block_when_the_kb_has_nothing(monkeypatch):
    await _reset()
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "p/m")
    sid = (await core.start("GIL"))["id"]  # autouse fixture already returns []
    seen: list = []
    monkeypatch.setattr(core, "_stream", _fake_stream(["答"], seen))

    events = await _collect(core.say(sid, "GIL 是什么"))
    assert "sources" not in [k for k, _ in events]
    assert [m["role"] for m in seen[0][1]] == ["system", "user"]  # voice only, byte-stable


# ---------- ending: 概念 / 自评 / 卡点 ----------


async def fake_extract_triple(session_id, topic, model_id):
    return "asyncio 事件循环", "协程什么时候切换", "以为 await 交给了操作系统"


async def _live(monkeypatch, topic: str) -> int:
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "p/m")
    sid = (await core.start(topic))["id"]
    await core.add_turn(sid, "user", "await 是把控制权给操作系统了吧")
    await core.add_turn(sid, "assistant", "不是。那你说 event loop 在干什么？")
    return sid


async def test_end_stores_the_triple(monkeypatch):
    await _reset()
    sid = await _live(monkeypatch, "asyncio")
    monkeypatch.setattr(core, "_embed", _fake_embed)

    async def fake_extract(session_id, topic, model_id):
        assert model_id == "p/m"
        return "asyncio 事件循环", "协程什么时候切换", "以为 await 交给了操作系统"

    monkeypatch.setattr(core, "_extract", fake_extract)
    assert await core.end(sid, "half") == {
        "id": sid,
        "verdict": "half",
        "concept": "asyncio 事件循环",
        "aliases": "协程什么时候切换",
        "stuck": "以为 await 交给了操作系统",
        "material_nearby": [],  # autouse fixture keeps the KB empty
    }
    row = await core.detail(sid)
    assert row["verdict"] == "half" and row["concept"] == "asyncio 事件循环"
    assert row["ended_at"] and len(row["turns"]) == 2
    # the alias line has exactly one consumer, so this is where it is worth checking
    assert (await core.recall_hits("协程是在什么时机切换的"))[0]["via"] == "alias"


async def test_end_surfaces_nearby_material_from_your_kb(monkeypatch):
    """第 7 节「发现你可能想搞懂的东西」，护栏版：只在 end() 的返回里出现一次，
    按 source 去重、最多 NEARBY_MAX 个 —— 它是你在场时顺手看见的一行字，不是队列。"""
    await _reset()
    sid = await _live(monkeypatch, "asyncio")
    monkeypatch.setattr(core, "_extract", fake_extract_triple)

    async def fake_retrieve(query: str, top_k: int):
        assert top_k == core.NEARBY_TOP_K + 1  # 1 个已引用来源，检索宽度随之放宽
        return [
            {"source": "notes/loop.md", "title": "事件循环", "score": 0.9},  # 本会话刚引用过
            {"source": "clippings/uvloop.md", "title": "uvloop", "score": 0.6},
            {"source": "repos/x.md", "title": "", "score": 0.5},
        ]

    monkeypatch.setattr(core, "_retrieve", fake_retrieve)
    core._SESSION_SOURCES[sid] = {"notes/loop.md"}
    got = await core.end(sid, "got")
    assert [n["source"] for n in got["material_nearby"]] == ["clippings/uvloop.md", "repos/x.md"]
    assert sid not in core._SESSION_SOURCES  # 取走即删，不残留


async def test_end_clears_cited_sources_even_when_useless(monkeypatch):
    await _reset()
    sid = await _live(monkeypatch, "GIL")
    core._SESSION_SOURCES[sid] = {"notes/gil.md"}
    await core.end(sid, "useless")
    assert sid not in core._SESSION_SOURCES


async def test_stuck_points_scans_all_history_not_just_the_rail(monkeypatch):
    """「卡过的点」不能跟着右栏的 50 条显示上限一起截断：第 52 次会话记下的卡点
    也要在。useless 的卡点不算数 —— 教学没成，那句话证明不了任何东西。"""
    await _reset()
    old = await _seed("旧", "旧概念", "got", stuck="旧的卡点")
    for i in range(60):
        await _seed(f"填充{i}", "", "got")
    new = await _seed("新", "新概念", "half", stuck="新的卡点")
    await _seed("没用", "没用概念", "useless", stuck="不算数的卡点")
    await _seed("没卡", "没卡概念", "got")

    stuck = await core.stuck_points()
    assert [r["id"] for r in stuck] == [new, old]  # newest first, useless 剔除
    assert stuck[0]["concept"] == "新概念" and stuck[0]["stuck"] == "新的卡点"
    assert len(await core.stuck_points(limit=1)) == 1

    await _reset()
    sid = await _live(monkeypatch, "asyncio")
    monkeypatch.setattr(core, "_extract", fake_extract_triple)

    async def fake_retrieve(query: str, top_k: int):
        assert query == "asyncio 事件循环"  # 刚谈完的概念，不是 topic
        return [
            {"source": "notes/loop.md", "title": "事件循环", "score": 0.8},
            {"source": "notes/loop.md", "title": "事件循环 2", "score": 0.7},  # 同源，去重
            {"source": "clippings/uvloop.md", "title": "uvloop", "score": 0.6},
            {"source": "repos/x.md", "title": "", "score": 0.5},  # 超出 NEARBY_MAX，丢弃
        ]

    monkeypatch.setattr(core, "_retrieve", fake_retrieve)
    got = await core.end(sid, "got")
    assert got["material_nearby"] == [
        {"source": "notes/loop.md", "title": "事件循环", "score": 0.8},
        {"source": "clippings/uvloop.md", "title": "uvloop", "score": 0.6},
    ]


async def test_end_skips_nearby_for_useless_and_survives_a_dead_index(monkeypatch):
    await _reset()
    sid = await _live(monkeypatch, "asyncio")
    monkeypatch.setattr(core, "_extract", fake_extract_triple)

    called = []

    async def spy(query: str, top_k: int):
        called.append(query)
        raise RuntimeError("chroma 挂了")

    monkeypatch.setattr(core, "_retrieve", spy)
    got = await core.end(sid, "got")
    assert got["material_nearby"] == []  # 挂了的索引只是少一行字，verdict 照样落
    assert called == ["asyncio 事件循环"]

    sid2 = await _live(monkeypatch, "GIL")
    monkeypatch.setattr(core, "_retrieve", spy)
    useless = await core.end(sid2, "useless")
    assert useless["concept"] == "" and useless["material_nearby"] == []
    assert len(called) == 1  # useless 不去检索：verdict 说教学没成，材料无从推荐


async def test_end_keeps_the_verdict_when_extraction_comes_back_empty(monkeypatch):
    await _reset()
    sid = await _live(monkeypatch, "asyncio")
    monkeypatch.setattr(core, "_embed", _fake_embed)

    async def blank(session_id, topic, model_id):
        return "", "", ""

    monkeypatch.setattr(core, "_extract", blank)
    got = await core.end(sid, "got")
    assert got["verdict"] == "got" and got["concept"] == ""
    # 第 4 节's count still works; recall just has nothing to match on
    assert (await core.stats())["got"] == 1
    assert await core.recall_hits("asyncio 事件循环") == []


async def test_end_skips_extraction_for_useless(monkeypatch):
    await _reset()
    sid = await _live(monkeypatch, "asyncio")
    calls: list = []

    async def spy(session_id, topic, model_id):
        calls.append(session_id)
        return "x", "y", "z"

    monkeypatch.setattr(core, "_extract", spy)
    assert (await core.end(sid, "useless"))["concept"] == ""
    assert calls == []  # recall ignores useless rows, so the call would buy nothing


async def test_end_rejects_unknown_verdicts_and_missing_sessions(monkeypatch):
    await _reset()
    sid = await _live(monkeypatch, "asyncio")
    for bad in ("", "GOT", "懂了", "maybe"):
        with pytest.raises(ValueError):
            await core.end(sid, bad)
    with pytest.raises(ValueError):
        await core.end(999999, "got")


async def test_end_is_re_callable(monkeypatch):
    await _reset()
    sid = await _live(monkeypatch, "asyncio")

    async def fake_extract(session_id, topic, model_id):
        return "asyncio 事件循环", "", ""

    monkeypatch.setattr(core, "_extract", fake_extract)
    await core.end(sid, "half")
    assert (await core.end(sid, "got"))["verdict"] == "got"  # 半懂 → 懂了 must overwrite
    assert (await core.detail(sid))["verdict"] == "got"


async def test_extract_with_an_empty_transcript_never_calls_the_model():
    await _reset()
    sid = await _seed("x", "", "")
    assert await core._extract(sid, "x", "p/m") == ("", "", "")


# ---------- history and 第 4 节's two numbers ----------


async def test_sessions_lists_newest_first_with_turn_counts():
    await _reset()
    first = await _seed("先聊的", "GIL", "got")
    second = await _seed("后聊的", "asyncio 事件循环", "half", "await")
    await core.add_turn(second, "user", "一")
    await core.add_turn(second, "assistant", "二")

    rows = await core.sessions()
    assert [r["id"] for r in rows] == [second, first]
    assert rows[0]["turn_count"] == 2 and rows[1]["turn_count"] == 0
    assert rows[0]["created_at"] and rows[0]["ended_at"]


async def test_detail_is_none_for_a_missing_session():
    await _reset()
    assert await core.detail(999999) is None


async def test_stats_counts_got_and_how_often_recall_fired():
    await _reset()
    await _seed("a", "asyncio 事件循环", "got", "await", recalled=True)
    await _seed("b", "GIL", "got")
    await _seed("c", "闭包", "half", recalled=True)
    await _seed("d", "别的", "useless")

    got = await core.stats()
    assert got["sessions"] == 4 and got["got"] == 2
    # 第 5 节 kills recall if this stays 0 — it has to be a lookup, not a memory
    assert got["got_with_recall"] == 1
    assert got["concepts"] == 4


async def test_stats_tolerates_a_junk_window():
    await _reset()
    for bad in (0, -5):
        got = await core.stats(bad)
        assert got["days"] == bad and got["sessions"] == 0 and got["got"] == 0








