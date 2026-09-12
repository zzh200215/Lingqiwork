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
