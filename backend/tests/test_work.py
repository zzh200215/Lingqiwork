"""工作模块的产出清单：只读文件系统，不落库。

判据全靠文件系统，所以测试要真文件。跟 test_cards.py 一样用工程内的 scratch 目录
——这台机器上 pytest 的 `tmp_path` 落在不可写的 %TEMP%。
"""
import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-work-", dir=Path(__file__).parent))
atexit.register(lambda: shutil.rmtree(_TMP, ignore_errors=True))


def _scratch(name: str) -> Path:
    d = _TMP / name
    d.mkdir(parents=True, exist_ok=True)
    return d


from app.routers import work  # noqa: E402


def _write(vault: Path, rel: str, text: str) -> Path:
    p = vault / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


async def test_outputs_lists_generated_dirs_and_skips_user_notes(monkeypatch):
    """五个引擎的落点都是产出；`notes/` 里用户自己的笔记不是（同目录，靠命名分辨）。"""
    vault = _scratch("vault")
    _write(vault, "research/2026-09-12-asyncio.md", "# asyncio 事件循环\n\n正文")
    _write(vault, "decisions/2026-09-10-选型.md", "# 要不要换 ORM\n")
    _write(vault, "recap/2026-09-11.md", "# 9 月 11 日\n")
    _write(vault, "notes/2026-09-09-成文标题.md", "# 成文标题\n")
    _write(vault, "notes/我的笔记.md", "# 我的笔记\n")  # 用户自己的，不该出现
    monkeypatch.setattr(work, "VAULT_DIR", vault)

    rows = (await work.list_outputs())["outputs"]
    assert {r["path"] for r in rows} == {
        "research/2026-09-12-asyncio.md",
        "decisions/2026-09-10-选型.md",
        "recap/2026-09-11.md",
        "notes/2026-09-09-成文标题.md",
    }


async def test_outputs_carries_kind_label_title_and_date(monkeypatch):
    vault = _scratch("vault-meta")
    _write(vault, "research/2026-09-12-asyncio.md", "# asyncio 事件循环\n正文")
    monkeypatch.setattr(work, "VAULT_DIR", vault)

    (row,) = (await work.list_outputs())["outputs"]
    assert row["kind"] == "research" and row["label"] == "研究"
    assert row["title"] == "asyncio 事件循环"
    assert row["date"] == "2026-09-12"


async def test_outputs_empty_when_no_engine_has_run(monkeypatch):
    """五个引擎都是拉取式——一个都没跑过时目录根本不存在，不能炸。"""
    vault = _scratch("vault-empty")
    monkeypatch.setattr(work, "VAULT_DIR", vault)
    assert (await work.list_outputs())["outputs"] == []


async def test_outputs_newest_first(monkeypatch):
    vault = _scratch("vault-order")
    old = _write(vault, "research/2026-09-01-旧.md", "# 旧\n")
    _write(vault, "recap/2026-09-11.md", "# 新\n")
    os.utime(old, (1, 1))  # 按改动时间排序，把旧的那份按下去
    monkeypatch.setattr(work, "VAULT_DIR", vault)

    rows = (await work.list_outputs())["outputs"]
    assert [r["kind"] for r in rows] == ["recap", "research"]


async def test_title_falls_back_to_the_filename_without_a_heading(monkeypatch):
    vault = _scratch("vault-notitle")
    _write(vault, "conflicts/2026-09-03-两处对不上.md", "没有标题的一堆正文\n")
    monkeypatch.setattr(work, "VAULT_DIR", vault)

    (row,) = (await work.list_outputs())["outputs"]
    assert row["kind"] == "conflict" and row["label"] == "对质"
    assert row["title"] == "两处对不上"  # 日期前缀被剥掉


async def test_deliverables_are_listed(monkeypatch):
    """交付（周报/汇报/短稿…）也是落 vault 的产出，和四个引擎一样进清单。"""
    vault = _scratch("vault-deliver")
    _write(vault, "deliver/2026-09-12-本周进展.md", "# 本周进展\n\n正文")
    monkeypatch.setattr(work, "VAULT_DIR", vault)

    (row,) = (await work.list_outputs())["outputs"]
    assert row["kind"] == "deliver" and row["label"] == "交付"
    assert row["title"] == "本周进展"
    assert row["date"] == "2026-09-12"


async def test_meetings_are_one_row_per_folder(monkeypatch):
    """一场会议是一行——录音/转写/纪要/待办/短稿是同一件事的五个面，
    平铺成五行反而看不出它们是一起的（§4-13）。"""
    vault = _scratch("vault-meet")
    _write(vault, "meetings/2026-09-12-周会/会议·纪要-2026-09-12-1030.md", "# 周会纪要\n\n正文")
    _write(vault, "meetings/2026-09-12-周会/会议·待办-2026-09-12-1030.md", "# 待办\n")
    _write(vault, "meetings/2026-09-12-周会/会议·转写-2026-09-12-1030.md", "# 转写\n")
    (vault / "meetings/2026-09-12-周会/audio.m4a").write_bytes(b"x")
    _write(vault, "meetings/inbox/待处理.m4a", "")  # inbox 不是一场会议
    _write(vault, "meetings/2026-09-11-空壳/note.txt", "没有 md 产物")  # 半成品，不算
    monkeypatch.setattr(work, "VAULT_DIR", vault)

    rows = (await work.list_meetings())["meetings"]
    assert len(rows) == 1
    (m,) = rows
    assert m["name"] == "2026-09-12-周会" and m["date"] == "2026-09-12"
    assert m["title"] == "周会纪要"  # 拿纪要做这一场的标题，它才是"脸"
    assert m["audio"] == "meetings/2026-09-12-周会/audio.m4a"
    assert len(m["files"]) == 3


async def test_meetings_empty_without_the_dir(monkeypatch):
    vault = _scratch("vault-nomeet")
    monkeypatch.setattr(work, "VAULT_DIR", vault)
    assert (await work.list_meetings())["meetings"] == []


async def test_audio_endpoint_serves_only_vault_audio(monkeypatch):
    """这个端点不该变成「读任意文件」的入口——只认 vault 内、后缀是音频的。"""
    vault = _scratch("vault-audio")
    src = vault / "meetings/2026-09-12-周会/audio.m4a"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(b"x")
    monkeypatch.setattr(work, "VAULT_DIR", vault)

    resp = await work.get_audio("meetings/2026-09-12-周会/audio.m4a")
    assert Path(resp.path) == src

    for bad in ("", "../secret.m4a", "notes/a.md", "meetings/2026-09-12-周会/nope.m4a"):
        with pytest.raises(HTTPException):
            await work.get_audio(bad)


async def test_workflow_outputs_count_but_handoff_does_not(monkeypatch):
    """`vault/tasks/` 是定时任务的产物（算产出）；`tasks/handoff/` 是两级之间传的中间件，
    不是给人看的东西，不能混进清单。"""
    vault = _scratch("vault-tasks")
    _write(vault, "tasks/RAG一句话-2026-08-27-1029.md", "# RAG一句话\n\n正文\n")
    _write(vault, "tasks/handoff/上游-to-下游.md", "# 交接\n")
    monkeypatch.setattr(work, "VAULT_DIR", vault)

    rows = (await work.list_outputs())["outputs"]
    assert [r["path"] for r in rows] == ["tasks/RAG一句话-2026-08-27-1029.md"]
    assert rows[0]["kind"] == "task" and rows[0]["label"] == "工作流"
    assert rows[0]["title"] == "RAG一句话"  # 标题取自正文，不是退化到文件名


# ---------- GB/T 9704 docx 导出 ----------


def _document_xml(resp) -> str:
    """docx 是 zip：document.xml 解包出来断言内容，字节层面搜不到中文。"""
    import io as _io
    import zipfile

    zf = zipfile.ZipFile(_io.BytesIO(resp.body))
    return zf.read("word/document.xml").decode("utf-8")


async def test_docx_from_sections_renders_title_org_and_body():
    resp = await work.make_docx(
        work.DocxIn(
            title="第 37 周周报",
            sections=[{"heading": "一、结论", "body": "先说结论 [1]。\n\n1. 第一条事项"}],
            org="某项目组",
        )
    )
    assert resp.status_code == 200
    assert resp.media_type.endswith("wordprocessingml.document")
    xml = _document_xml(resp)
    assert "第 37 周周报" in xml
    assert "某项目组" in xml
    assert "一、结论" in xml
    assert "先说结论 [1]。" in xml
    assert "1. 第一条事项" in xml  # 数字编号是公文条款，原样保留


async def test_docx_from_vault_path_parses_front_matter(monkeypatch):
    vault = _scratch("vault-docx")
    _write(
        vault,
        "deliver/2026-09-12-weekly.md",
        "---\ngenre: weekly\naudience: leader\n---\n\n# 第 37 周周报\n\n## 一、结论\n\n先说结论。",
    )
    monkeypatch.setattr(work, "VAULT_DIR", vault)
    resp = await work.make_docx(work.DocxIn(path="deliver/2026-09-12-weekly.md"))
    xml = _document_xml(resp)
    assert "第 37 周周报" in xml
    assert "先说结论。" in xml
    assert "genre:" not in xml  # front-matter 是元数据，不进正文


async def test_docx_without_org_has_no_red_header_text(monkeypatch):
    """红头单位没给就不加——个人工作台不编造机关名。"""
    resp = await work.make_docx(work.DocxIn(title="周报", sections=[{"heading": "", "body": "正文"}]))
    assert "FF0000" not in _document_xml(resp)


async def test_docx_rejects_path_escaping_the_vault(monkeypatch):
    monkeypatch.setattr(work, "VAULT_DIR", _scratch("vault-docx-esc"))
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ei:
        await work.make_docx(work.DocxIn(path="../../outside.md"))
    assert ei.value.status_code == 400


async def test_docx_rejects_empty_body():
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ei:
        await work.make_docx(work.DocxIn())
    assert ei.value.status_code == 400
