"""Offline tests for knowledge-graph RAG (V11): extraction parsing, graph
build flow (skip-unchanged, caps, failure retry), retrieval ranking and the
context block. No Neo4j needed — all graph I/O sits behind seams.

Env must be set before app imports.
"""
import asyncio
import atexit
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

# project-local scratch dir (system temp may be sandboxed)
_TMP = Path(tempfile.mkdtemp(prefix="wb-kg-", dir=Path(".").resolve()))


def _cleanup() -> None:
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)


from fastapi import HTTPException  # noqa: E402

from app.core import kg  # noqa: E402
from app.core.prefs import load_config, save_config  # noqa: E402
from app.routers import kg as kg_router  # noqa: E402


@pytest.fixture(autouse=True)
def _env():
    save_config({"kg_enabled": False, "kg_password": "", "kg_uri": "bolt://localhost:7687", "kg_user": "neo4j"})
    yield
    save_config({"kg_enabled": False})


# ---------- parsing ----------


def test_parse_extraction_good():
    raw = (
        '前言 {"entities": [{"name": "张三", "type": "人物", "description": "作者"},'
        ' {"name": "工作台", "type": "项目", "description": "个人项目"}],'
        ' "relations": [{"source": "张三", "target": "工作台", "type": "开发", "description": "主力开发"}]} 后记'
    )
    data = kg._parse_extraction(raw)
    assert [e["name"] for e in data["entities"]] == ["张三", "工作台"]
    assert data["relations"][0]["type"] == "开发"


def test_parse_extraction_filters_and_bounds():
    raw = (
        '{"entities": [{"name": "a"}, {"name": "b", "type": "不合法类型!", "description": "x"},'
        ' {"name": "a", "type": "重复跳过"}, {"name": ""}],'
        ' "relations": [{"source": "a", "target": "未知实体", "type": "t"},'
        ' {"source": "a", "target": "b", "type": "合法", "description": "ok"},'
        ' {"source": "a", "target": "a", "type": "自环"}]}'
    )
    data = kg._parse_extraction(raw)
    assert len(data["entities"]) == 2  # dedupe + empty name dropped
    assert data["entities"][1]["type"] == "概念"  # invalid type → default
    assert len(data["relations"]) == 1  # unknown-target + self-loop dropped
    assert data["relations"][0]["source"] == "a"


def test_parse_extraction_garbage():
    assert kg._parse_extraction("模型叨叨了一堆没有JSON") == {"entities": [], "relations": []}
    assert kg._parse_extraction('{"entities": "不是一个列表"}')["entities"] == []


def test_sanitize_type():
    assert kg._sanitize_type("属于") == "属于"
    assert kg._sanitize_type("has a; DROP") == "关联"
    assert kg._sanitize_type("") == "关联"


# ---------- enabled/config ----------


def test_enabled_flag():
    save_config({"kg_enabled": True})
    assert kg.enabled() is True
    save_config({"kg_enabled": False})
    assert kg.enabled() is False


def test_context_for_query_disabled_is_noop():
    save_config({"kg_enabled": False})
    assert kg.context_for_query("任何问题") == ""


# ---------- build flow ----------


def test_build_skips_unchanged_and_marks_empty(monkeypatch):
    import hashlib

    monkeypatch.setattr(kg, "verify", lambda: {"ok": True})  # no real Neo4j in tests
    files = [("notes/a.md", Path("a.md")), ("notes/b.md", Path("b.md")), ("notes/c.md", Path("c.md"))]
    texts = {"a.md": "文本A", "b.md": "文本B", "c.md": "文本C"}
    monkeypatch.setattr(kg, "_scan_vault", lambda: files)
    monkeypatch.setattr(kg, "_file_text", lambda p: texts[p.name])
    # a.md already stored with the hash of its current text → skipped
    monkeypatch.setattr(
        kg, "_existing_hashes", lambda: {"notes/a.md": hashlib.md5("文本A".encode()).hexdigest()}
    )

    upserts: list = []
    monkeypatch.setattr(kg, "_upsert_file", lambda path, digest, data: upserts.append((path, digest, data)))

    async def fake_embed(names):
        return len(names)

    monkeypatch.setattr(kg, "_embed_entities", fake_embed)

    async def fake_llm(text: str, path: str) -> str:
        if "文本B" in text:
            return '{"entities": [{"name": "实体B", "type": "概念", "description": "B"}], "relations": []}'
        return "模型输出无法解析"  # empty extraction still marks the file

    monkeypatch.setattr(kg, "_llm_json", fake_llm)
    report = asyncio.run(kg.build(max_files=5))
    assert report["extracted"] == 2  # a unchanged (skipped), b+c extracted
    assert report["unchanged"] == 1
    assert {u[0] for u in upserts} == {"notes/b.md", "notes/c.md"}
    # the garbage-LLM file still got marked with a hash (no endless retry)
    assert any(u[0] == "notes/c.md" and u[2]["entities"] == [] for u in upserts)


def test_build_failure_is_reported_and_not_marked(monkeypatch):
    monkeypatch.setattr(kg, "verify", lambda: {"ok": True})
    monkeypatch.setattr(kg, "_scan_vault", lambda: [("notes/x.md", Path("x.md"))])
    monkeypatch.setattr(kg, "_existing_hashes", lambda: {})
    monkeypatch.setattr(kg, "_file_text", lambda p: "内容")

    async def boom(text: str, path: str) -> str:
        raise RuntimeError("provider down")

    monkeypatch.setattr(kg, "_llm_json", boom)
    report = asyncio.run(kg.build(max_files=3))
    assert report["extracted"] == 0 and len(report["failed"]) == 1
    assert "provider down" in report["failed"][0]["error"]


# ---------- retrieval + context ----------


def test_retrieve_ranks_and_expands(monkeypatch):
    monkeypatch.setattr(kg, "_embed_query", lambda q: [1.0, 0.0])
    rows = [
        ("工作台", "个人项目", [0.99, 0.1]),
        ("咖啡", "饮品", [0.0, 1.0]),  # orthogonal → filtered by threshold
        ("Python", "编程语言", [0.95, 0.3]),
    ]
    monkeypatch.setattr(kg, "_load_entity_vectors", lambda: rows)
    monkeypatch.setattr(kg, "_expand", lambda names: [{"src": names[0], "type": "使用", "dst": "Python", "description": ""}])
    result = kg.retrieve("工作台用什么写", top_k=3)
    assert [e["name"] for e in result["entities"]] == ["工作台", "Python"]
    assert "咖啡" not in [e["name"] for e in result["entities"]]
    assert result["relations"][0]["dst"] == "Python"


def test_format_context_shape():
    block = kg.format_context(
        {
            "entities": [{"name": "工作台", "description": "个人项目", "score": 0.9, "type": "项目"}],
            "relations": [{"src": "张三", "type": "开发", "dst": "工作台", "description": ""}],
        }
    )
    assert "【相关实体】" in block and "工作台（项目）" in block
    assert "【关联关系】" in block and "张三 —开发→ 工作台" in block
    assert kg.format_context({"entities": []}) == ""


def test_context_for_query_enabled(monkeypatch):
    save_config({"kg_enabled": True})
    monkeypatch.setattr(kg, "retrieve", lambda q, top_k=6: {"entities": [], "relations": []})
    assert kg.context_for_query("q") == ""


# ---------- router ----------


def test_router_build_requires_enabled():
    save_config({"kg_enabled": False})
    with pytest.raises(HTTPException) as ei:
        asyncio.run(kg_router.build(kg_router.KgBuildIn(max_files=8)))
    assert ei.value.status_code == 400


def test_router_config_saves_and_tests(monkeypatch):
    monkeypatch.setattr(kg, "verify", lambda: {"ok": True, "files": 0, "entities": 2, "relations": 1})
    r = asyncio.run(
        kg_router.save_config_and_test(
            kg_router.KgConfigIn(uri="bolt://localhost:7687", user="neo4j", password="test-pw", enabled=True)
        )
    )
    assert r["ok"] is True and r["entities"] == 2
    cfg = load_config()
    assert cfg["kg_password"] == "test-pw" and cfg["kg_enabled"] is True
    save_config({"kg_password": "", "kg_enabled": False})


def test_router_config_bad_password_surfaces_error(monkeypatch):
    monkeypatch.setattr(kg, "verify", lambda: {"ok": False, "error": "AuthError: unauthorized"})
    with pytest.raises(HTTPException) as ei:
        asyncio.run(
            kg_router.save_config_and_test(kg_router.KgConfigIn(password="wrong", enabled=False))
        )
    assert ei.value.status_code == 502 and "AuthError" in ei.value.detail
    save_config({"kg_password": ""})
