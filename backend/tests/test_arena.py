"""模型竞技场 + 体检报告的离线测试。

竞技场：所有已启用 provider 并行各答一次，一家的失败不算全场失败；
体检报告：把 self_check + 备份 + 索引 + 任务失败 + 整理员拼成一页，
任何一块坏掉都不能 500。
"""
import asyncio
import atexit
import shutil
import sys
import tempfile
import time
from pathlib import Path


sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-arena-", dir=Path(__file__).parent))


def _cleanup() -> None:
    try:
        asyncio.run(engine.dispose())
    except Exception:  # noqa: BLE001
        pass
    try:
        from app.core import indexer

        if indexer._client is not None:
            indexer._client.close()
            indexer._client = None
    except Exception:  # noqa: BLE001
        pass
    # chroma 的 SQLite 句柄在 Windows 上会让 rmtree 静默失败，留下 _TMP/chroma。
    for _ in range(3):
        shutil.rmtree(_TMP, ignore_errors=True)
        if not _TMP.exists():
            break
        time.sleep(0.3)


atexit.register(_cleanup)

from sqlalchemy import delete  # noqa: E402
import pytest  # noqa: E402

from app.core import arena as core  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, Memory  # noqa: E402
from app.routers import health as health_router  # noqa: E402


async def _init() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init())


def _cands():
    from app.core.llm import ProviderInfo

    return [
        (ProviderInfo(kind="openai", base_url="https://a", api_key="a"), "ma", "a/ma"),
        (ProviderInfo(kind="openai", base_url="https://b", api_key="b"), "mb", "b/mb"),
    ]


async def test_arena_runs_every_provider_in_parallel(monkeypatch):
    tried: list[str] = []

    async def fake_stream(info, model, messages, usage=None):
        tried.append(info.api_key)
        await asyncio.sleep(0.05)  # 两家都慢一点；并行时总耗时 ≈ 最慢一家
        yield f"来自 {info.api_key} 的回答"

    async def fake_cands(_mid):
        return _cands()

    monkeypatch.setattr(core, "stream_chat", fake_stream)  # arena 顶层绑定的名字
    monkeypatch.setattr("app.core.tasks._candidates", fake_cands)

    r = await core.run("用一句话介绍闭包")
    assert [x["label"] for x in r] == ["a/ma", "b/mb"]
    assert all(x["ok"] and x["text"] == f"来自 {x['label'][0]} 的回答" for x in r)
    assert tried == ["a", "b"]  # 两家都被打到
    assert r[0]["seconds"] < core.PER_CALL_TIMEOUT  # 并行：不是各家耗时之和


async def test_arena_one_failure_does_not_sink_the_rest(monkeypatch):
    async def fake_stream(info, model, messages, usage=None):
        if info.api_key == "a":
            raise ConnectionError("a 挂了")
        yield "b 正常"

    async def fake_cands(_mid):
        return _cands()

    monkeypatch.setattr(core, "stream_chat", fake_stream)
    monkeypatch.setattr("app.core.tasks._candidates", fake_cands)

    r = await core.run("hi")
    assert r[0]["ok"] is False and "a 挂了" in r[0]["error"]
    assert r[1]["ok"] is True and r[1]["text"] == "b 正常"


async def test_arena_empty_prompt_and_no_candidates(monkeypatch):
    assert await core.run("   ") == []  # 空 prompt 零成本返回

    async def no_cands(_mid):
        raise RuntimeError("没有已启用的 provider")

    monkeypatch.setattr("app.core.tasks._candidates", no_cands)
    r = await core.run("hi")
    assert len(r) == 1 and r[0]["ok"] is False and "provider" in r[0]["error"]


# ---------- 只打点名的几个模型（提示词页「对打」用它：选 2–4 个比一比）----------


async def test_arena_models_filter_only_hits_the_named_ones(monkeypatch):
    """**不传 `models` 时行为一字不变**（所有已启用 provider）；传了就只打那几家。"""
    tried: list[str] = []

    async def fake_stream(info, model, messages, usage=None):
        tried.append(model)
        yield f"来自 {model}"

    async def fake_cands(_mid):
        return _cands()

    monkeypatch.setattr(core, "stream_chat", fake_stream)
    monkeypatch.setattr("app.core.tasks._candidates", fake_cands)

    # 不传：两家都打（原行为）
    r = await core.run("hi")
    assert [x["label"] for x in r] == ["a/ma", "b/mb"]
    assert tried == ["ma", "mb"]

    # 点名一家：只有那一家被打
    tried.clear()
    r2 = await core.run("hi", ["mb"])
    assert [x["label"] for x in r2] == ["b/mb"]
    assert tried == ["mb"]


async def test_arena_says_so_when_none_of_the_named_models_are_configured(monkeypatch):
    """点名的模型一个都没配上：**如实说**，而不是悄悄跑别的几家。

    悄悄跑的话，用户以为自己在比 A 和 B，其实比的是别的——比「报错」糟得多。
    """
    tried: list[str] = []

    async def fake_stream(info, model, messages, usage=None):
        tried.append(model)
        yield "x"

    async def fake_cands(_mid):
        return _cands()

    monkeypatch.setattr(core, "stream_chat", fake_stream)
    monkeypatch.setattr("app.core.tasks._candidates", fake_cands)

    r = await core.run("hi", ["gpt-4o", "claude-3"])
    assert len(r) == 1
    assert r[0]["ok"] is False
    assert "gpt-4o" in r[0]["error"] and "claude-3" in r[0]["error"]
    assert tried == []  # 一家都没打——没有偷偷替换成别的模型


async def test_arena_partial_match_still_runs_what_it_can(monkeypatch):
    """点两家、只配上一家：**能跑的那家照跑**（不是整局失败）。"""
    tried: list[str] = []

    async def fake_stream(info, model, messages, usage=None):
        tried.append(model)
        yield f"来自 {model}"

    async def fake_cands(_mid):
        return _cands()

    monkeypatch.setattr(core, "stream_chat", fake_stream)
    monkeypatch.setattr("app.core.tasks._candidates", fake_cands)

    r = await core.run("hi", ["ma", "gpt-4o"])
    assert [x["label"] for x in r] == ["a/ma"]
    assert tried == ["ma"]


# ---------- 两段输入：提示词（system）+ 这一问（user），§8.2 区2 ----------


def _capture(monkeypatch):
    """假 stream：把每次收到的 messages 记下来。"""
    seen: list[list[dict]] = []

    async def fake_stream(info, model, messages, usage=None):
        seen.append(messages)
        yield "答"

    async def fake_cands(_mid):
        return _cands()

    monkeypatch.setattr(core, "stream_chat", fake_stream)
    monkeypatch.setattr("app.core.tasks._candidates", fake_cands)
    return seen


async def test_system_and_prompt_go_out_as_two_messages(monkeypatch):
    """「同一输入并排比」的全部意义就在这里：提示词是 system、这一问是 user。

    合成一段就量不出「换了模型」这一件事——那时你比的是「换了模型 + 换了问法」。
    """
    seen = _capture(monkeypatch)
    await core.run("这周的 RAG 调研", ["ma"], "你是资深工程师，结论先行。")

    msgs = seen[0]
    assert [m["role"] for m in msgs] == ["system", "user"]
    assert msgs[0]["content"] == "你是资深工程师，结论先行。"
    assert msgs[1]["content"] == "这周的 RAG 调研"


async def test_no_system_means_the_old_single_user_message(monkeypatch):
    """`system` 空 = 老行为（整段当 user）——存量调用一个字节都不变。"""
    seen = _capture(monkeypatch)
    await core.run("用一句话介绍闭包", ["ma"])
    assert [m["role"] for m in seen[0]] == ["user"]
    assert seen[0][0]["content"] == "用一句话介绍闭包"


async def test_system_only_is_a_legitimate_run(monkeypatch):
    """只有提示词、没有额外输入是**正当用法**（提示词自己说全了）。

    这时**不摆一条空的 user 消息**——空 content 有的 provider 会直接报错。
    """
    seen = _capture(monkeypatch)
    r = await core.run("", ["ma"], "给我三个点子。")
    assert [m["role"] for m in seen[0]] == ["system"]
    assert r[0]["ok"] is True

    # 两段都空才是没事可做
    assert await core.run("  ", ["ma"], "  ") == []


# ---------- 对打记录（§8.2 区2 行3） ----------


async def test_save_record_writes_a_readable_md_and_indexes_it(monkeypatch):
    """一次对打落一篇 md，**并进索引**（下一次取材捞得到它）。"""
    indexed: list[Path] = []
    monkeypatch.setattr("app.core.indexer.index_file", lambda p, **kw: indexed.append(Path(p)) or 3)

    out = await core.save_record(
        title="这周的 RAG 调研",
        system="你是资深工程师，结论先行。",
        prompt="这周的 RAG 调研",
        model_id="a/ma",
        results=[
            {"label": "a/ma", "ok": True, "text": "结论：够用 [1]", "seconds": 1.2, "tokens_in": 10, "tokens_out": 20},
            {"label": "b/mb", "ok": False, "error": "503 挂了", "seconds": 0.1},
        ],
    )
    text = (core.DUEL_DIR / Path(out["filename"]).name).read_text(encoding="utf-8")

    assert out["filename"].startswith("prompts/duels/") and out["chunks"] == 3
    assert indexed and indexed[0].name.endswith(".md")
    # 两段输入分开写着——回看时才知道「比的到底是什么」
    assert "## 提示词" in text and "你是资深工程师，结论先行。" in text
    assert "## 输入" in text and "这周的 RAG 调研" in text
    # 成的那家给正文与耗时/token，挂的那家**照常占一行**（删掉它「两家比」就变成「一家比」）
    assert "### a/ma · 1.2s · 10+20 tok" in text and "结论：够用 [1]" in text
    assert "### b/mb · 失败" in text and "503 挂了" in text
    # 指纹留着：「这次比的是哪一版提示词」以后还答得出来
    from app.core.report import prompt_sha

    assert prompt_sha("你是资深工程师，结论先行。") in text


async def test_save_record_refuses_an_empty_duel(monkeypatch):
    monkeypatch.setattr("app.core.indexer.index_file", lambda p, **kw: 1)
    with pytest.raises(ValueError):
        await core.save_record(results=[])


async def test_save_record_is_not_an_output_dir(monkeypatch):
    """**不落产出目录**：它不是「交出去的东西」，落 `deliver/` 会让「你交出 N 份」灌水。"""
    monkeypatch.setattr("app.core.indexer.index_file", lambda p, **kw: 1)
    from app.core import pet

    out = await core.save_record(results=[{"label": "a", "ok": True, "text": "x", "seconds": 1}])
    assert pet.is_output_path(out["filename"]) is False


async def test_health_report_aggregates_and_survives_breakage(monkeypatch):
    async with SessionLocal() as db:
        await db.execute(delete(Memory))
        await db.commit()

    r = await health_router.report()
    # 断言「包含关键字段」而非「等于完整集合」——以后加字段不会破这个测试
    assert {"self", "backups", "kb", "tasks_failing", "tidy", "structured", "prompts", "cost"} <= set(r)
    assert r["self"]["jobs_total"] >= 0 and isinstance(r["tasks_failing"], list)

    # 备份列表挂掉：体检不 500，该块退化为空
    from app.core import backup as backup_core

    def boom():
        raise RuntimeError("backup down")

    monkeypatch.setattr(backup_core, "list_backups", boom)
    r2 = await health_router.report()
    assert r2["backups"] == {} and r2["self"]["jobs_total"] >= 0
