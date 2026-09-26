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
    catalogue = asyncio.run(deliver.catalogue())
    # 前五条是内置的——自定义模板**追加在后面**，不替换
    assert [g["id"] for g in catalogue["genres"]][:5] == [
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


def test_every_genre_declares_long_or_short_and_catalogue_carries_it():
    """§8.1 双模的判据**在后端**：哪个体裁算长稿是体裁的属性，不是界面的属性。

    每条都得显式声明（`v.get("long")` 兜底成 False，所以漏写会静默变成短稿）——
    新加一种体裁时必须自己回答「它值不值得先定结构」，这一条就是逼它回答的。
    """
    for gid, g in deliver.GENRES.items():
        assert "long" in g, f"体裁 {gid} 没声明 long/short"

    by_id = {g["id"]: g for g in asyncio.run(deliver.catalogue())["genres"]}
    assert by_id["weekly"]["long"] is True
    assert by_id["review"]["long"] is True
    assert by_id["proposal"]["long"] is True
    # 短稿：结构本来只有一两段（邮件就一个「正文」小节），先确认提纲只是多一次点击
    assert by_id["email"]["long"] is False
    assert by_id["briefing"]["long"] is False
    # 内置的那五条都不是自定义——界面靠它决定这个 chip 能不能编辑/删除
    assert all(by_id[k]["custom"] is False for k in deliver.GENRES)


# ---------- 提纲（§8.1 双模的长稿那一模） ----------


def test_synth_prompt_without_outline_is_unchanged():
    """不传提纲必须**逐字节**等于以前那个串。

    这是硬要求不是洁癖：`prompt_sha` 是这个串的指纹，存量反馈按它分版本——多一个空格
    就把质量闭环的历史劈成两半（`core/quality.py` 顶部记过这条口径）。
    """
    base = f"{deliver._SHAPE}\n\n{deliver.GENRES['weekly']['prompt']}\n\n{deliver.AUDIENCES['self']['prompt']}"
    assert deliver.synth_prompt("weekly", "self") == base
    assert deliver.synth_prompt("weekly", "self", None) == base
    assert deliver.synth_prompt("weekly", "self", []) == base
    assert deliver.synth_prompt("weekly", "self", ["  ", ""]) == base  # 空白节不算数


def test_outline_overrides_the_genre_section_list():
    """定稿的提纲是**覆盖**不是追加：体裁那段里写着默认小节名，用户删改之后那套就作废了。

    所以提示词里必须明说「上面那套只是默认值」——两段互相矛盾的要求，模型未必听后面那段。
    """
    p = deliver.synth_prompt("weekly", "self", ["本周进展", "下周计划"])
    assert p.startswith(deliver.synth_prompt("weekly", "self"))  # 追加，不改写体裁那段
    assert "本周进展 / 下周计划" in p
    assert "用户已经改过了" in p


def test_outline_does_not_move_the_prompt_sha(wired, monkeypatch):
    """提纲进提示词，但**不进 `prompt_sha`**——同 `skill_match.with_skills` 的口径。

    提纲是每一次运行的输入，不是提示词版本。算进 sha 的话每份定稿都自成一版，
    (kind, sha, model) 的满意率再也聚不起来，等于把质量闭环关掉。
    """
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    seen: list[list[dict]] = []

    async def kb(query, top_k):
        return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]

    async def stream(info, model, messages):
        seen.append(messages)
        yield '{"title":"R","sections":[{"heading":"H","body":"B [1]"}],"used":[1]}'

    events = _run(
        "话题",
        "weekly",
        "self",
        outline=["本周进展", "下周计划"],
        kb_fn=kb,
        memory_fn=_no_memory,
        journal_fn=_no_journal,
        stream_fn=stream,
    )
    report = dict(events)["report"]

    from app.core import report as report_mod

    assert report["prompt_sha"] == report_mod.prompt_sha(deliver.synth_prompt("weekly", "self"))
    # 但模型**确实收到了**那份提纲——sha 不算它，不等于不喂给它
    assert "本周进展 / 下周计划" in seen[0][0]["content"]
    assert report["outline"] == ["本周进展", "下周计划"]


def test_run_without_outline_reports_an_empty_one(wired, monkeypatch):
    """没走提纲那条路时回一个空表——界面靠它区分「按你确认的写的」和「没走提纲」。"""
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    async def kb(query, top_k):
        return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]

    events = _run(
        "话题",
        kb_fn=kb,
        memory_fn=_no_memory,
        journal_fn=_no_journal,
        stream_fn=_llm('{"title":"R","sections":[{"heading":"H","body":"B [1]"}],"used":[1]}'),
    )
    assert dict(events)["report"]["outline"] == []


def test_make_outline_asks_for_structure_only_and_gathers_nothing(wired, monkeypatch):
    """「点头后才**取材**成文」——提纲这一步一次检索都不做。

    这是它便宜的全部原因（取材 + 成文才是贵的那两段）。所以发给模型的 user 消息里
    **只能有话题**，不许出现材料块；一旦有人顺手把取材挪到前面来，这一条会红。
    """
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    seen: list[list[dict]] = []

    async def stream(info, model, messages):
        seen.append(messages)
        yield '{"title":"第 37 周周报","sections":["本周进展","遇到的问题","下周计划"]}'

    out = asyncio.run(deliver.make_outline("这周的 RAG", "weekly", "self", stream_fn=stream))

    assert out == {
        "title": "第 37 周周报",
        "sections": ["本周进展", "遇到的问题", "下周计划"],
        "model_id": "test-model",
    }
    system, user = seen[0]
    assert user == {"role": "user", "content": "话题：这周的 RAG"}  # 没有材料
    assert "材料：" not in user["content"]
    # 体裁要求跟着提纲提示词一起进去——不然提纲会脱离体裁（周报出成议论文的结构）
    assert deliver.GENRES["weekly"]["prompt"] in system["content"]
    assert "只定小节标题" in system["content"]


def test_make_outline_takes_the_heading_shape_too(wired, monkeypatch):
    """模型见过成文的形状，偶尔把 `sections` 给成 `[{"heading": …}]`——照收。

    只要能取出名字就不该为这点漂移丢掉整份提纲（宽容度同 `Report`）。
    """
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    async def stream(info, model, messages):
        yield '{"title":"T","sections":[{"heading":"问题"},{"heading":"方案"},{"heading":"下一步"}]}'

    out = asyncio.run(deliver.make_outline("话题", "proposal", "leader", stream_fn=stream))
    assert out["sections"] == ["问题", "方案", "下一步"]


def test_make_outline_gives_up_honestly(wired, monkeypatch):
    """出不来就是 None——不编一份默认提纲顶上（编的话用户会以为模型真看过他的题目）。"""
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    async def junk(info, model, messages):
        yield "抱歉，我不能只给标题，我直接把正文写了吧……"

    async def empty(info, model, messages):
        yield '{"title":"T","sections":[]}'

    async def blank_names(info, model, messages):
        yield '{"title":"T","sections":["  ", ""]}'

    assert asyncio.run(deliver.make_outline("话题", "weekly", "self", stream_fn=junk)) is None
    assert asyncio.run(deliver.make_outline("话题", "weekly", "self", stream_fn=empty)) is None
    assert asyncio.run(deliver.make_outline("话题", "weekly", "self", stream_fn=blank_names)) is None
    # 输入本身不成立时也不调模型
    assert asyncio.run(deliver.make_outline("   ", "weekly", "self", stream_fn=junk)) is None
    assert asyncio.run(deliver.make_outline("话题", "nope", "self", stream_fn=junk)) is None


def test_make_outline_caps_a_runaway_list(wired, monkeypatch):
    """模型偶尔一口气列十几节——那是目录不是提纲，封顶（`OUTLINE_MAX`）。"""
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    many = ",".join(f'"第 {i} 节"' for i in range(20))

    async def stream(info, model, messages):
        yield '{"title":"T","sections":[' + many + "]}"

    out = asyncio.run(deliver.make_outline("话题", "weekly", "self", stream_fn=stream))
    assert len(out["sections"]) == deliver.OUTLINE_MAX


def test_outline_endpoint_validates_before_calling_the_model(monkeypatch):
    """端点：输入不合法 → 4xx；模型给不出东西 → 502（**不是** 4xx，用户没做错什么）。

    校验抽在 `_check` 里给两个端点共用，所以这里顺带钉住「提纲与成文的校验是同一套」。
    """
    from fastapi import HTTPException

    from app.routers import deliver as api

    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    with pytest.raises(HTTPException) as e1:
        asyncio.run(api.deliver_outline(api.OutlineIn(topic="  ", genre="weekly")))
    assert e1.value.status_code == 400

    with pytest.raises(HTTPException) as e2:
        asyncio.run(api.deliver_outline(api.OutlineIn(topic="话题", genre="nope")))
    assert e2.value.status_code == 400

    async def nothing(*a, **kw):
        return None

    monkeypatch.setattr(api.core, "make_outline", nothing)
    with pytest.raises(HTTPException) as e3:
        asyncio.run(api.deliver_outline(api.OutlineIn(topic="话题", genre="weekly")))
    assert e3.value.status_code == 502

    async def ok(*a, **kw):
        return {"title": "T", "sections": ["A"], "model_id": "m"}

    monkeypatch.setattr(api.core, "make_outline", ok)
    out = asyncio.run(api.deliver_outline(api.OutlineIn(topic="  话题  ", genre="weekly")))
    assert out["sections"] == ["A"]


def test_outline_reaches_the_engine_through_the_run_endpoint(monkeypatch):
    """`DeliverIn.outline` 得真的接到 `core.run` 上——界面按这个名字传。"""
    from app.routers import deliver as api

    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    got: dict = {}

    async def fake_run(genre, topic, audience, **kw):
        got.update({"genre": genre, "topic": topic, "audience": audience, **kw})
        yield "report", {"title": "T"}

    monkeypatch.setattr(api.core, "run", fake_run)
    body = api.DeliverIn(topic=" 话题 ", genre="weekly", audience="leader", outline=["A", "B"])
    resp = asyncio.run(api.deliver_run(body))
    frames = asyncio.run(_drain(resp))

    assert got["topic"] == "话题" and got["outline"] == ["A", "B"] and got["genre"] == "weekly"
    assert "event: report" in frames


async def _drain(resp) -> str:
    """把 `StreamingResponse` 的 body 收成一个串（SSE 帧是文本，直接拼）。"""
    out: list[str] = []
    async for chunk in resp.body_iterator:
        out.append(chunk if isinstance(chunk, str) else chunk.decode())
    return "".join(out)


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


def test_save_keeps_genre_and_audience_on_the_file(monkeypatch):
    """M5：体裁与读者**存进文件头**——「这份是给谁写的」不能存完就丢。

    交付的事后见证（`core/delivery.py`）读的就是它：mtime 是交出去的时刻，frontmatter 是
    给谁写的。写的是**界面名**（周报 / 领导），id 那边早钉在 `prompt_sha` 上了。
    """
    monkeypatch.setattr("app.core.indexer.index_file", lambda path, **kw: 1)
    rep = deliver.Report(title="第 37 周周报", sections=[], used=[])

    out = asyncio.run(deliver.save(rep, [], genre="weekly", audience="leader"))

    text = (deliver.DELIVER_DIR / Path(out["filename"]).name).read_text(encoding="utf-8")
    assert text.startswith("---\ngenre: 周报\naudience: 领导\n---\n\n# 第 37 周周报")


def test_the_save_endpoint_carries_them_through(monkeypatch):
    """端点是三行委派，但它得真的把这两个字段接过去（前端按这两个名字传）。

    **不传**时一个字节都不写（别的引擎与没给体裁的调用照旧）——空字段写进文件等于
    「问过了但没答案」，那比不写坏。
    """
    monkeypatch.setattr("app.core.indexer.index_file", lambda path, **kw: 1)
    from app.routers import deliver as api

    body = api.SaveIn(
        title="第 37 周周报",
        sections=[api.Section(heading="结论", body="先说结论")],
        genre="weekly",
        audience="leader",
    )
    out = asyncio.run(api.save(body))
    text = (deliver.DELIVER_DIR / Path(out["filename"]).name).read_text(encoding="utf-8")
    assert "genre: 周报" in text and "audience: 领导" in text

    bare = api.SaveIn(title="随手一篇", sections=[api.Section(heading="H", body="B")])
    out2 = asyncio.run(api.save(bare))
    text2 = (deliver.DELIVER_DIR / Path(out2["filename"]).name).read_text(encoding="utf-8")
    assert text2.startswith("# 随手一篇")


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


# ---------- 自定义体裁模板（§8.1 行2） ----------
#
# 内置那五条是**代码**（`GENRES` 常量表），这一节测的是**你自己写的**那些
# （`deliver_templates` 表）。沙箱（`conftest.py`）每个**模块**重建库表，而这些用例会建行，
# 所以每条都带 `clean_templates`——不清的话第二个用例就撞上第一个留下的「月报」。


def _mk(label, prompt="体裁：月报。按「本月成果 / 下月目标」两个小节写。", long=True):
    return asyncio.run(deliver.create_template(label, prompt, long))


def _spec(genre_id):
    return asyncio.run(deliver.genre_spec(genre_id))


@pytest.fixture
def clean_templates():
    """用例开始前清空模板表（沙箱是每模块一份，而这些用例会建行）。"""
    from sqlalchemy import delete

    from app.db import SessionLocal
    from app.models import DeliverTemplate

    async def _wipe():
        async with SessionLocal() as db:
            await db.execute(delete(DeliverTemplate))
            await db.commit()

    asyncio.run(_wipe())
    yield


def test_template_id_is_stable_across_renames(clean_templates):
    """**id 与名字分开**：`prompt_sha` 按体裁 id 分版本，改名不该让质量闭环的历史断裂。

    这也是 `slug` 这一列存在的全部理由——直接拿名字当 id 更省事，但那样「给老板的月报」
    改叫「月报（老板）」的那一刻，此前所有评价就换了一个版本 key。
    """
    t = _mk("给老板的月报")
    assert t["id"].startswith(deliver.CUSTOM_PREFIX)

    again = asyncio.run(deliver.update_template(t["id"], label="月报（老板）"))
    assert again["id"] == t["id"]  # 一个字符都没动
    assert again["label"] == "月报（老板）"
    # 用 id 查得到新名字；旧名字不是 id，查不到
    assert _spec(t["id"])["label"] == "月报（老板）"
    assert _spec("给老板的月报") is None


def test_template_cannot_shadow_a_builtin(clean_templates):
    """两道保证，缺一不可。

    `t-` 前缀是**硬**保证：内置体裁的 id 永远不可能被顶掉（不然建一个 slug 恰好叫
    `weekly` 的模板，就把内置周报悄悄换掉了）。重名判据是**软**保证：id 撞不上，
    但界面上会出现两个「周报」——点哪个都不是你想的那个。
    """
    with pytest.raises(ValueError):
        asyncio.run(deliver.create_template("周报", "体裁：随便什么"))

    _mk("月报")
    with pytest.raises(ValueError):
        asyncio.run(deliver.create_template("月报", "体裁：另一份月报"))

    assert all(
        t["id"].startswith(deliver.CUSTOM_PREFIX) for t in asyncio.run(deliver.list_templates())
    )


def test_template_ids_do_not_collide_when_a_label_is_freed(clean_templates):
    """名字腾出来了就能再建一个——两个模板的 id 必须不一样（去重靠 `_slugify`）。"""
    a = _mk("月报")
    asyncio.run(deliver.update_template(a["id"], label="月度小结"))
    b = _mk("月报")
    assert a["id"] != b["id"]
    assert len({t["id"] for t in asyncio.run(deliver.list_templates())}) == 2


def test_template_rejects_an_empty_name_or_an_empty_structure(clean_templates):
    """空名字 → chips 上一个没有字的胶囊；空结构指令 → 模板退化成「没有体裁」。

    后一条尤其要拦：体裁的定义就是那段结构指令，空着等于只剩公共的 JSON 形状，
    和不用模板没有区别——而用户会以为自己存了一种体裁。
    """
    for label, prompt in (("   ", "体裁：有内容"), ("月报", "   "), ("月报", "\n\t ")):
        with pytest.raises(ValueError):
            asyncio.run(deliver.create_template(label, prompt))


def test_a_custom_template_is_a_genre_like_any_other(clean_templates):
    """`synth_prompt` 对内置与自定义**一视同仁**——这是「它是体裁，不是别的东西」的落地。"""
    t = _mk("月报", "体裁：月报。按「本月成果 / 下月目标」两个小节写。")
    spec = _spec(t["id"])
    assert spec["custom"] is True and spec["long"] is True

    p = deliver.synth_prompt(t["id"], "leader", custom=spec)
    assert "本月成果 / 下月目标" in p
    assert deliver.AUDIENCES["leader"]["prompt"] in p
    assert deliver._SHAPE in p  # 公共那份 JSON 形状照旧

    cat = asyncio.run(deliver.catalogue())
    assert next(g for g in cat["genres"] if g["id"] == t["id"]) == {
        "id": t["id"],
        "label": "月报",
        "long": True,
        "custom": True,
    }
    # 列表不带结构指令（那是编辑那条路的事，`/templates` 才给）
    assert all("prompt" not in g for g in cat["genres"])
    # 内置的排在前——自定义的是追加，不是替换
    assert [g["id"] for g in cat["genres"]][:5] == [
        "weekly",
        "briefing",
        "email",
        "review",
        "proposal",
    ]


def test_unknown_genre_id_is_none_not_a_crash():
    """查不到就是 None / False——四个入口都得说「没有」，不许抛。"""
    assert _spec("nope") is None
    assert _spec("") is None
    assert asyncio.run(deliver.update_template("nope", label="x")) is None
    assert asyncio.run(deliver.delete_template("nope")) is False


def test_run_writes_with_the_custom_template(clean_templates, wired, monkeypatch):
    """走完整条：自定义体裁 → 模型收到的是**它**那段结构指令，任何内置体裁的都不在。"""
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    t = _mk("月报", "体裁：月报。按「本月成果 / 下月目标」两个小节写，全文不超过 400 字。")
    seen: list[list[dict]] = []

    async def kb(query, top_k):
        return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]

    async def stream(info, model, messages):
        seen.append(messages)
        yield '{"title":"九月月报","sections":[{"heading":"本月成果","body":"B [1]"}],"used":[1]}'

    events = _run(
        "这个月",
        t["id"],
        "leader",
        kb_fn=kb,
        memory_fn=_no_memory,
        journal_fn=_no_journal,
        stream_fn=stream,
    )
    report = dict(events)["report"]
    system = seen[0][0]["content"]
    assert "本月成果 / 下月目标" in system
    assert deliver.GENRES["weekly"]["prompt"] not in system

    # sha 算的是**这份模板**的提示词：它自己就是提示词的一部分
    from app.core import report as report_mod

    assert report["prompt_sha"] == report_mod.prompt_sha(
        deliver.synth_prompt(t["id"], "leader", custom=_spec(t["id"]))
    )
    assert report["genre"] == t["id"]


def test_editing_a_template_does_move_the_prompt_sha(clean_templates):
    """**提纲不动 sha，模板改动要动**——分界是「提示词本身变了没有」。

    提纲是每一次运行的输入（像注入的技能工序），模板那段结构指令是提示词本身。
    改了它，新旧版本的满意率**本来就该分开统计**——那正是质量闭环要的。
    """
    from app.core import report as report_mod

    t = _mk("月报", "体裁：月报。按「本月成果」一个小节写。")
    before = deliver.synth_prompt(t["id"], "self", custom=_spec(t["id"]))
    asyncio.run(
        deliver.update_template(t["id"], prompt="体裁：月报。按「成果 / 目标 / 风险」三个小节写。")
    )
    after = deliver.synth_prompt(t["id"], "self", custom=_spec(t["id"]))

    assert before != after
    assert report_mod.prompt_sha(before) != report_mod.prompt_sha(after)


def test_deleting_a_template_leaves_written_files_alone(clean_templates, monkeypatch):
    """删模板只是「以后不再拿它当选项」。

    已经交出去的那些 md 一份都不动——文件头写的是**界面名**（`save` 走 `genre_spec`
    查出来再写），所以模板删了之后那些成品照样读得懂「什么体裁、给谁写的」。
    """
    monkeypatch.setattr("app.core.indexer.index_file", lambda path, **kw: 1)
    t = _mk("月报")
    rep = deliver.Report(title="九月月报", sections=[], used=[])

    out = asyncio.run(deliver.save(rep, [], genre=t["id"], audience="leader"))
    dest = deliver.DELIVER_DIR / Path(out["filename"]).name
    assert "genre: 月报" in dest.read_text(encoding="utf-8")

    assert asyncio.run(deliver.delete_template(t["id"])) is True
    assert asyncio.run(deliver.list_templates()) == []
    # 文件一个字没动；而且删完之后再问同一个 id 也不会崩
    assert "genre: 月报" in dest.read_text(encoding="utf-8")
    assert _spec(t["id"]) is None


def test_check_accepts_a_custom_genre_and_rejects_an_unknown_one(clean_templates, monkeypatch):
    """`_check` 是 `/deliver` 与 `/deliver/outline` 共用的那道门——它得认自定义体裁。

    不然会出现最难受的那种分叉：**提纲出得来、成文写不出来**（或反过来）。
    """
    from fastapi import HTTPException

    from app.routers import deliver as api

    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    t = _mk("月报")

    topic, spec = asyncio.run(api._check(" 这个月 ", t["id"], "leader"))
    assert topic == "这个月" and spec["id"] == t["id"]

    with pytest.raises(HTTPException) as e1:
        asyncio.run(api._check("话题", "nope", "self"))
    assert e1.value.status_code == 400

    with pytest.raises(HTTPException) as e2:
        asyncio.run(api._check("话题", t["id"], "boss"))
    assert e2.value.status_code == 400


def test_template_endpoints(clean_templates, monkeypatch):
    """端点：输入不合法 422、找不到 404、删掉之后真的没有了。

    422 与 502 是**分开的**：422 = 你的输入有问题，502 = 模型没给出东西。界面靠状态码
    决定说哪句话，混成一个数就分不清「我填错了」和「再试一次」。
    """
    from fastapi import HTTPException

    from app.routers import deliver as api

    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    made = asyncio.run(api.create_template(api.TemplateIn(label="月报", prompt="体裁：月报。")))
    assert made["label"] == "月报" and made["long"] is True

    with pytest.raises(HTTPException) as e1:
        asyncio.run(api.create_template(api.TemplateIn(label="月报", prompt="体裁：又一份")))
    assert e1.value.status_code == 422

    with pytest.raises(HTTPException) as e2:
        asyncio.run(api.update_template("t-nope", api.TemplatePatch(label="x")))
    assert e2.value.status_code == 404

    # 只改传进来的字段：没传的（label）不动
    patched = asyncio.run(api.update_template(made["id"], api.TemplatePatch(long=False)))
    assert patched["long"] is False and patched["label"] == "月报"

    assert asyncio.run(api.genres())["genres"][-1]["id"] == made["id"]
    assert asyncio.run(api.templates())[0]["prompt"] == "体裁：月报。"

    assert asyncio.run(api.delete_template(made["id"])) == {"deleted": made["id"]}
    with pytest.raises(HTTPException) as e3:
        asyncio.run(api.delete_template(made["id"]))
    assert e3.value.status_code == 404
