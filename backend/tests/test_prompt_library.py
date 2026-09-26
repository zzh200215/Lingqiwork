"""「提示词」模块的库：往返、搜索、版本回溯、调用历史、带走（导入导出）。

**这一层之前一条测试都没有** —— `/api/prompts` 的老 CRUD 全仓没有测试命中过。
新写的每一条都对着一个**会悄悄错**的地方，而不是「能不能存进去」：

- 版本：改正文才留快照，只改标签不留（不然历史里全是没差别的噪音）；
- 回滚：**当前这一版要先被存下来** —— 回滚不该是单向门；
- 删除：版本与使用记录**跟着走**（没有外键，得自己收 —— 同 `test_threads._clean()` 那个教训）；
- 导入：同名跳过、不覆盖（一次误导入不该冲掉你攒的东西）；
- 标签：全角逗号也认（中文输入法下打出来的就是「，」）。
"""
import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy import delete as sa_delete

from app.db import engine as _engine
from app.db import SessionLocal
from app.models import Base as _Base
from app.models import Prompt, PromptCategory, PromptUsage, PromptVersion
from app.routers.prompts import (
    CategoryIn,
    CategoryPatch,
    ImportIn,
    PromptIn,
    PromptPatch,
    UseIn,
    create_category,
    create_prompt,
    delete_category,
    delete_prompt,
    export_prompts,
    facets,
    import_prompts,
    list_categories,
    list_prompts,
    list_usages,
    list_versions,
    restore_version,
    router,
    update_category,
    update_prompt,
    use_prompt,
    _tags_of,
)


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


@pytest.fixture(autouse=True)
def _clean():
    """新加的表**要同时想清楚谁负责收**，否则跨用例串味（M2 那次就是这么栽的）。

    `PromptVersion` / `PromptUsage` / `PromptCategory` 都是新加的，必须在这里；
    少写一张，下一条用例就会「捡到」上一条留下的版本数、使用次数或分类行。
    """

    async def _go() -> None:
        async with SessionLocal() as db:
            for model in (PromptVersion, PromptUsage, PromptCategory, Prompt):
                await db.execute(sa_delete(model))
            await db.commit()

    asyncio.run(_go())
    yield


async def _mk(db, title: str, content: str = "正文", **kw) -> dict:
    return await create_prompt(PromptIn(title=title, content=content, **kw), db=db)


# ---------- 纯函数 ----------


def test_tags_accept_full_width_comma_and_dedupe():
    """中文输入法打出来的是「，」。不认它，这个标签就等于没打。"""
    assert _tags_of("写作，调研, 写作") == ["写作", "调研"]
    assert _tags_of(["a", " a ", "b"]) == ["a", "b"]
    assert _tags_of("") == []


# ---------- 往返与筛选 ----------


async def test_create_roundtrip_keeps_the_new_fields():
    async with SessionLocal() as db:
        made = await _mk(
            db,
            "周报模板",
            "写给{读者}的周报",
            tags=["写作", "周报"],
            category="汇报",
            favorite=True,
            rating=4,
            source="https://example.com/x",
            note="leader 喜欢短句",
        )
        rows = await list_prompts(db=db)

    assert made["tags"] == ["写作", "周报"]
    assert made["category"] == "汇报" and made["favorite"] is True and made["rating"] == 4
    assert made["source"].startswith("https://")
    assert len(rows) == 1 and rows[0]["title"] == "周报模板"
    assert rows[0]["used_count"] == 0 and rows[0]["version_count"] == 0


async def test_rating_is_clamped_not_rejected():
    """评分是给人顺手点的，越界应该夹住而不是报错（报错只会让人以为坏了）。"""
    async with SessionLocal() as db:
        too_high = await _mk(db, "高", rating=9)
        too_low = await _mk(db, "低", rating=-3)
        patched = await update_prompt(too_high["id"], PromptPatch(rating=99), db=db)
    assert too_high["rating"] == 5 and too_low["rating"] == 0
    assert patched["rating"] == 5


async def test_search_covers_title_content_and_tags():
    async with SessionLocal() as db:
        await _mk(db, "费曼讲法", "让模型当学生", tags=["教学"])
        await _mk(db, "周报模板", "写给 leader 的周报", tags=["汇报"])

        by_title = await list_prompts(q="费曼", db=db)
        by_content = await list_prompts(q="学生", db=db)
        by_tag = await list_prompts(q="汇报", db=db)
        none = await list_prompts(q="不存在的词", db=db)

    assert [p["title"] for p in by_title] == ["费曼讲法"]
    assert [p["title"] for p in by_content] == ["费曼讲法"]
    assert [p["title"] for p in by_tag] == ["周报模板"]
    assert none == []


async def test_filter_by_category_and_favorite():
    async with SessionLocal() as db:
        await _mk(db, "A", category="汇报", favorite=True)
        await _mk(db, "B", category="汇报")
        await _mk(db, "C", category="教学", favorite=True)

        only_report = await list_prompts(category="汇报", db=db)
        only_fav = await list_prompts(favorite=True, db=db)

    assert {p["title"] for p in only_report} == {"A", "B"}
    assert {p["title"] for p in only_fav} == {"A", "C"}


async def test_facets_count_categories_and_tags_from_the_library():
    async with SessionLocal() as db:
        await _mk(db, "A", category="汇报", tags=["写作", "周报"])
        await _mk(db, "B", category="教学", tags=["周报"])
        await _mk(db, "C")  # 未分类
        f = await facets(db=db)

    # 没挑过颜色的分类按名字排（`position` 都是 0）——**确定性**比插入顺序重要：
    # 每次刷新都换个顺序，你会以为东西变了。
    assert [(c["name"], c["count"]) for c in f["categories"]] == [("教学", 1), ("汇报", 1)]
    assert [(t["name"], t["count"]) for t in f["tags"]] == [("周报", 2), ("写作", 1)]
    assert f["total"] == 3 and f["uncategorized"] == 1


async def test_categories_take_the_position_you_gave_them():
    """新建的分类排在末尾（position 递增），改了 position 就以 position 为准。"""
    async with SessionLocal() as db:
        a = await create_category(CategoryIn(name="乙"), db=db)
        b = await create_category(CategoryIn(name="甲"), db=db)
        assert [c["name"] for c in (await facets(db=db))["categories"]] == ["乙", "甲"]

        await update_category(b["id"], CategoryPatch(position=0), db=db)
        await update_category(a["id"], CategoryPatch(position=1), db=db)
        assert [c["name"] for c in (await facets(db=db))["categories"]] == ["甲", "乙"]


# ---------- 版本回溯 ----------


async def test_editing_content_snapshots_the_previous_version():
    async with SessionLocal() as db:
        made = await _mk(db, "模板", "第一版")
        await update_prompt(made["id"], PromptPatch(content="第二版"), db=db)
        versions = await list_versions(made["id"], db=db)
        rows = await list_prompts(db=db)

    assert len(versions) == 1
    assert versions[0]["content"] == "第一版", "留下的该是**改之前**那一版"
    assert rows[0]["content"] == "第二版"
    assert rows[0]["version_count"] == 1


async def test_editing_only_metadata_does_not_snapshot():
    """只点了个收藏、改了个标签，不该在历史里塞一条一模一样的快照。"""
    async with SessionLocal() as db:
        made = await _mk(db, "模板", "正文")
        await update_prompt(made["id"], PromptPatch(tags=["新标签"], favorite=True), db=db)
        await update_prompt(made["id"], PromptPatch(content="正文"), db=db)  # 内容没变
        versions = await list_versions(made["id"], db=db)

    assert versions == []


async def test_the_same_content_saved_again_is_not_a_new_version():
    async with SessionLocal() as db:
        made = await _mk(db, "模板", "正文")
        await update_prompt(made["id"], PromptPatch(content="改过"), db=db)
        await update_prompt(made["id"], PromptPatch(content="改过"), db=db)
        versions = await list_versions(made["id"], db=db)
    assert len(versions) == 1


async def test_restore_keeps_the_current_one_as_history():
    """回滚**不是单向门**：回到旧版时，被你丢下的那一版也要留下。"""
    async with SessionLocal() as db:
        made = await _mk(db, "模板", "第一版")
        await update_prompt(made["id"], PromptPatch(content="第二版"), db=db)
        versions = await list_versions(made["id"], db=db)
        back = await restore_version(made["id"], versions[0]["id"], db=db)
        after = await list_versions(made["id"], db=db)

    assert back["content"] == "第一版"
    # 历史里同时留着两条：`第二版` 是**被你丢下的那一版**（回滚不是单向门），
    # `第一版` 是当初改到第二版时留下的快照——它现在与当前内容相同，是无害的冗余，
    # 但**不能**为了好看去删历史：删历史这件事一旦自动化，就没人敢信它了。
    assert "第二版" in {v["content"] for v in after}, "被丢下的那一版要留在历史里"


async def test_restoring_to_the_current_content_is_a_noop():
    async with SessionLocal() as db:
        made = await _mk(db, "模板", "第一版")
        await update_prompt(made["id"], PromptPatch(content="第二版"), db=db)
        v = await list_versions(made["id"], db=db)
        await restore_version(made["id"], v[0]["id"], db=db)  # → 第一版
        v2 = await list_versions(made["id"], db=db)
        # 再回滚到「第一版」那条：内容已经一样，不该再长版本
        target = [x for x in v2 if x["content"] == "第一版"][0]
        same = await restore_version(made["id"], target["id"], db=db)
        v3 = await list_versions(made["id"], db=db)

    assert same["content"] == "第一版"
    assert len(v3) == len(v2), "内容没变就不该再留一版"


# ---------- 使用记录 ----------


async def test_use_records_history_and_shows_a_count():
    async with SessionLocal() as db:
        made = await _mk(db, "模板", "写给{读者}")
        await use_prompt(made["id"], UseIn(vars={"读者": "leader"}), db=db)
        again = await use_prompt(made["id"], UseIn(), db=db)
        rows = await list_prompts(db=db)

    assert again["used_count"] == 2
    assert rows[0]["used_count"] == 2


async def test_use_records_which_version_was_used():
    """sha 记的是**这一次用的哪一版**：改过之后 sha 会变，事后能按它分段看。"""
    async with SessionLocal() as db:
        made = await _mk(db, "模板", "第一版")
        await use_prompt(made["id"], UseIn(), db=db)
        await update_prompt(made["id"], PromptPatch(content="第二版"), db=db)
        await use_prompt(made["id"], UseIn(), db=db)
        from sqlalchemy import select

        shas = [
            r.content_sha
            for r in (
                (await db.execute(select(PromptUsage).order_by(PromptUsage.id))).scalars().all()
            )
        ]

    assert len(shas) == 2 and shas[0] != shas[1], "两版正文该留下两个不同的指纹"


async def test_use_remembers_the_last_filled_vars():
    """**下次复用不必重填** —— 这是「使用历史」真正的用处，不是记个数好看。"""
    async with SessionLocal() as db:
        made = await _mk(db, "模板", "写给{读者}的{周数}周报")
        await use_prompt(made["id"], UseIn(vars={"读者": "leader", "周数": "37"}), db=db)
        await use_prompt(made["id"], UseIn(vars={"读者": "团队", "周数": "38"}), db=db)
        rows = await list_prompts(db=db)

    assert rows[0]["last_vars"] == {"读者": "团队", "周数": "38"}, "要的是**最近一次**那组"


async def test_last_vars_survives_a_usage_without_vars():
    """没填变量的一次使用，不该把上次填的值抹掉——那会让「重填」这件事突然发生。"""
    async with SessionLocal() as db:
        made = await _mk(db, "模板", "没有变量")
        await use_prompt(made["id"], UseIn(vars={"a": "1"}), db=db)
        await use_prompt(made["id"], UseIn(), db=db)
        rows = await list_prompts(db=db)

    assert rows[0]["last_vars"] == {"a": "1"}


async def test_last_used_at_says_when_not_how_often():
    """「最近使用」按**时间**排，不是按次数——用过 9 次但半年前，不该排在昨天用的前面。"""
    async with SessionLocal() as db:
        never = await _mk(db, "没用过的", "正文")
        made = await _mk(db, "用过的", "正文")
        assert never["last_used_at"] == ""

        await use_prompt(made["id"], UseIn(), db=db)
        rows = {p["title"]: p for p in await list_prompts(db=db)}

    assert rows["用过的"]["last_used_at"], "用过就该有时间戳"
    assert rows["没用过的"]["last_used_at"] == "", "没用过就是空的——不是 1970 年"


# ---------- 使用历史（记了就要能看）----------


async def test_usages_are_newest_first_and_carry_the_filled_vars():
    async with SessionLocal() as db:
        made = await _mk(db, "模板", "写给{读者}")
        await use_prompt(made["id"], UseIn(vars={"读者": "leader"}), db=db)
        await use_prompt(made["id"], UseIn(vars={"读者": "团队"}), db=db)
        rows = await list_usages(made["id"], db=db)

    assert len(rows) == 2
    assert rows[0]["vars"] == {"读者": "团队"}, "最近一次排最前"
    assert rows[0]["at"], "要有时间——「最近一次什么时候」正是这份账的用处"
    assert rows[0]["sha"] == rows[1]["sha"], "正文没改，两次的指纹该一样"


async def test_usage_rows_are_capped_on_read_too():
    """读的一侧也要有上界：账会一直长，界面不该被它拖住。"""
    async with SessionLocal() as db:
        made = await _mk(db, "模板", "正文")
        for _ in range(5):
            await use_prompt(made["id"], UseIn(), db=db)
        rows = await list_usages(made["id"], limit=2, db=db)
    assert len(rows) == 2


# ---------- 分类管理（只动标签，不动条目）----------


async def test_creating_a_category_twice_does_not_grow_a_second_row():
    """连着点两次「创建」不该报错，也不该长出第二行——幂等比报错好用。"""
    async with SessionLocal() as db:
        first = await create_category(CategoryIn(name="汇报", color="#3b82f6"), db=db)
        again = await create_category(CategoryIn(name="汇报", color="#000000"), db=db)
        rows = await list_categories(db=db)

    assert again["id"] == first["id"]
    assert len(rows) == 1
    assert rows[0]["color"] == "#3b82f6", "已有的那行不该被后来的颜色覆盖"


async def test_renaming_a_category_moves_its_prompts_with_it():
    """**改名要连条目一起搬**：`prompts.category` 存的是名字，只改表不改条目，
    那些提示词会当场变成「未分类」——而它们明明还在那个分类里。"""
    async with SessionLocal() as db:
        cat = await create_category(CategoryIn(name="汇报"), db=db)
        await _mk(db, "A", category="汇报")
        await _mk(db, "B", category="教学")

        await update_category(cat["id"], CategoryPatch(name="汇报稿"), db=db)
        rows = {p["title"]: p["category"] for p in await list_prompts(db=db)}

    assert rows == {"A": "汇报稿", "B": "教学"}


async def test_renaming_onto_an_existing_name_is_refused():
    """两个分类撞成一个名字，那些条目就再也分不开了——宁可不许。"""
    async with SessionLocal() as db:
        a = await create_category(CategoryIn(name="汇报"), db=db)
        await create_category(CategoryIn(name="教学"), db=db)
        with pytest.raises(HTTPException) as e:
            await update_category(a["id"], CategoryPatch(name="教学"), db=db)
    assert e.value.status_code == 409


async def test_deleting_a_category_uncategorizes_but_keeps_the_prompts():
    """**删一个分类绝不等于删里面的提示词**——这是这一屏最要紧的一条。"""
    async with SessionLocal() as db:
        cat = await create_category(CategoryIn(name="汇报"), db=db)
        await _mk(db, "A", category="汇报")
        await _mk(db, "B", category="汇报")

        out = await delete_category(cat["id"], db=db)
        rows = await list_prompts(db=db)
        cats = await list_categories(db=db)

    assert out == {"ok": True, "uncategorized": 2}
    assert len(rows) == 2, "条目一条都不能少"
    assert {p["category"] for p in rows} == {""}
    assert cats == []


async def test_an_empty_category_still_shows_up():
    """建了还没用的分类也是分类——不然「建了它」这件事在界面上就消失了。"""
    async with SessionLocal() as db:
        await create_category(CategoryIn(name="还没用上的", color="#22c55e"), db=db)
        f = await facets(db=db)

    assert [c["name"] for c in f["categories"]] == ["还没用上的"]
    assert f["categories"][0]["count"] == 0
    assert f["categories"][0]["color"] == "#22c55e"


async def test_a_category_with_prompts_but_no_style_row_still_appears():
    """没挑过颜色也能归类——不必先建分类才能往里放东西。"""
    async with SessionLocal() as db:
        await _mk(db, "A", category="随手写的")
        f = await facets(db=db)

    assert [c["name"] for c in f["categories"]] == ["随手写的"]
    assert f["categories"][0]["color"] == ""


# ---------- 路由顺序（只在真路由上才暴露的坑）----------


def test_the_literal_routes_are_not_swallowed_by_the_id_param_routes():
    """`/categories/rename` 与 `/{prompt_id}/use` 长得**一模一样**，谁先注册谁说了算。

    这是个直调函数永远看不出来的坑：函数级的测试全绿，真请求却被参数那条吃掉
    （`prompt_id="categories"`，然后 422 或 404，报错信息还看不出根因）。
    这里用 Starlette **真的匹配一遍**，把顺序钉住。
    """
    from starlette.routing import Match

    for method, path, expected in (
        ("GET", "/api/prompts/facets", "facets"),
        ("GET", "/api/prompts/categories", "list_categories"),
        ("POST", "/api/prompts/categories", "create_category"),
        ("PUT", "/api/prompts/categories/3", "update_category"),
        ("DELETE", "/api/prompts/categories/3", "delete_category"),
        ("GET", "/api/prompts/7/usages", "list_usages"),
        ("GET", "/api/prompts/7/versions", "list_versions"),
        ("POST", "/api/prompts/7/use", "use_prompt"),
        ("PUT", "/api/prompts/7", "update_prompt"),
        ("GET", "/api/prompts/export", "export_prompts"),
    ):
        scope = {"type": "http", "method": method, "path": path, "headers": []}
        hit = None
        for r in router.routes:
            matched, _ = r.matches(scope)
            if matched == Match.FULL:
                hit = r.endpoint.__name__
                break
        assert hit == expected, f"{method} {path} 被 {hit} 吃掉了"


# ---------- 删除要自己收干净 ----------


async def test_deleting_a_prompt_takes_its_versions_and_usages():
    """没有外键（同 `TaskRun.task_id` 那条），所以删除必须自己收——不然会留孤儿行。"""
    async with SessionLocal() as db:
        made = await _mk(db, "模板", "第一版")
        await update_prompt(made["id"], PromptPatch(content="第二版"), db=db)
        await use_prompt(made["id"], UseIn(), db=db)

        await delete_prompt(made["id"], db=db)

        from sqlalchemy import func, select

        assert (await db.execute(select(func.count()).select_from(PromptVersion))).scalar() == 0
        assert (await db.execute(select(func.count()).select_from(PromptUsage))).scalar() == 0
        assert (await db.execute(select(func.count()).select_from(Prompt))).scalar() == 0


# ---------- 带走 ----------


async def test_export_json_carries_everything_needed_to_rebuild():
    async with SessionLocal() as db:
        await _mk(db, "A", "正文 A", tags=["x"], category="汇报", favorite=True, rating=3)
        blob = await export_prompts(format="json", db=db)
        # 打回原形：导出 → 清空 → 导入，应逐字段一样
        await db.execute(sa_delete(Prompt))
        await db.commit()
        await import_prompts(
            ImportIn(prompts=[PromptIn(**{k: v for k, v in p.items()}) for p in blob["prompts"]]),
            db=db,
        )
        rows = await list_prompts(db=db)

    assert blob["count"] == 1
    assert rows[0]["title"] == "A" and rows[0]["tags"] == ["x"]
    assert rows[0]["category"] == "汇报" and rows[0]["favorite"] is True and rows[0]["rating"] == 3


async def test_export_csv_starts_with_a_bom_for_excel():
    """拿去别的项目多半是用 Excel / 表格工具打开——不加 BOM，中文就是乱码。"""
    async with SessionLocal() as db:
        await _mk(db, "模板", "正文")
        resp = await export_prompts(format="csv", db=db)

    assert resp.body.startswith("\ufeff".encode("utf-8"))
    text = resp.body.decode("utf-8-sig")
    assert "title,content" in text.splitlines()[0]
    assert "模板" in text


async def test_import_skips_existing_titles_instead_of_overwriting():
    """导入是「把东西拿进来」，不是「用别人那份替换我的」。"""
    async with SessionLocal() as db:
        await _mk(db, "同名", "我本地的")
        out = await import_prompts(
            ImportIn(
                prompts=[
                    PromptIn(title="同名", content="别人那份"),
                    PromptIn(title="新的", content="新的正文"),
                ]
            ),
            db=db,
        )
        rows = await list_prompts(db=db)
        mine = [p for p in rows if p["title"] == "同名"][0]

    assert out["added"] == ["新的"] and out["skipped"] == ["同名"]
    assert mine["content"] == "我本地的", "本地那条不能被覆盖"
    assert len(rows) == 2
