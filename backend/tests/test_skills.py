"""Offline tests for V6.1 agent skills (parsing, index, install, remove).

No network: URL fetch is bypassed via _install_text. Skills dir is pointed at
a scratch folder so the developer's real skills/ is untouched.
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

_TMP = Path(tempfile.mkdtemp(prefix="wb-skills-", dir=Path(".").resolve()))


def _cleanup() -> None:
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")

from app.core import skills  # noqa: E402

skills.SKILLS_DIR = _TMP / "skills"
skills.SKILLS_DIR.mkdir(parents=True, exist_ok=True)

VALID = """---
name: code-review
description: 审查代码质量时使用：关注边界条件、命名与测试覆盖
model: deepseek/deepseek-chat
tools: vault_read_file
---

# 代码审查指南

1. 先看边界条件
2. 再看命名
"""

NO_META = "# 只有正文的技能\n\n没有 frontmatter。"


# ---- parsing ----


def test_parse_frontmatter():
    parsed = skills._parse_skill_text(VALID)
    assert parsed["name"] == "code-review"
    assert "边界条件" in parsed["description"]
    assert parsed["model"] == "deepseek/deepseek-chat"
    assert "# 代码审查指南" in parsed["body"]
    assert not parsed["body"].startswith("---")


def test_parse_no_frontmatter():
    parsed = skills._parse_skill_text(NO_META)
    assert parsed["name"] == "" and parsed["description"] == ""
    assert "只有正文的技能" in parsed["body"]


def test_parse_caps_body():
    parsed = skills._parse_skill_text("x" * (skills._MAX_BODY + 999))
    assert len(parsed["body"]) == skills._MAX_BODY


# ---- install / list / load / remove ----


def test_install_requires_description():
    with pytest.raises(ValueError):
        skills._install_text("no-desc", NO_META)


def test_install_list_load_remove_cycle():
    r = skills._install_text("", VALID)
    assert r["name"] == "code-review"
    listed = skills.list_skills()
    assert len(listed) == 1 and listed[0]["name"] == "code-review"
    assert "审查代码" in listed[0]["description"]
    assert "code-review/SKILL.md" in listed[0]["files"]

    content = skills.load_skill("code-review")
    assert "代码审查指南" in content and "技能：code-review" in content

    # duplicate refused without overwrite, replaced with it
    with pytest.raises(ValueError):
        skills._install_text("code-review", VALID)
    skills._install_text("code-review", VALID, overwrite=True)

    skills.remove("code-review")
    assert skills.list_skills() == []
    assert skills.load_skill("code-review").startswith("[未找到]")


def test_install_rejects_bad_name():
    with pytest.raises(ValueError):
        skills._install_text("../escape", VALID)


def test_index_block_and_tool_load():
    try:  # leftover from an earlier failed cycle, if any
        skills.remove("code-review")
    except ValueError:
        pass
    assert skills.index_block() == ""
    skills._install_text("writer", VALID.replace("code-review", "writer"))
    block = skills.index_block()
    assert "skill_load" in block and "writer" in block and "审查代码" in block

    # tool handler path
    out = asyncio.run(skills.load_skill_tool({"name": "writer"}))
    assert "代码审查指南" in out
    assert asyncio.run(skills.load_skill_tool({"name": "nope"})).startswith("[未找到]")


def test_skill_load_resolves_frontmatter_name():
    """Folder __live_v6__ with frontmatter name live-v6 must load via either name."""
    skills._install_text("__live_v6__", VALID.replace("code-review", "live-v6"))
    try:
        assert "代码审查指南" in skills.load_skill("live-v6")  # frontmatter name
        assert "代码审查指南" in skills.load_skill("__live_v6__")  # folder name
        assert skills.load_skill("nope").startswith("[未找到]")
        assert skills.load_skill("../evil").startswith("[未找到]")
    finally:
        try:
            skills.remove("__live_v6__")
        except ValueError:
            pass


def test_skill_load_lists_extra_files():
    skills._install_text("extra", VALID.replace("code-review", "extra"))
    (skills.SKILLS_DIR / "extra" / "checklist.md").write_text("- item", encoding="utf-8")
    content = skills.load_skill("extra")
    assert "checklist.md" in content
    skills.remove("extra")
