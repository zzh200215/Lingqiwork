"""全局唤起的落盘侧：划词剪藏 /api/kb/clip_text。

热键、托盘、模拟 Ctrl+C 是 desktop.py 壳层的事，离线测试够不着；这里钉住
「剪藏」动作的后端语义：选中文本落盘成 clippings md 并进索引，空文本拒绝。
vault 与索引都 monkeypatch 到临时目录，绝不碰真实数据。
"""
import atexit
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

# project-local scratch dir (system temp may be sandboxed)
_SCRATCH = Path(tempfile.mkdtemp(prefix="wb-capture-", dir=Path(__file__).parent))


def _cleanup() -> None:
    shutil.rmtree(_SCRATCH, ignore_errors=True)


atexit.register(_cleanup)

from fastapi import HTTPException  # noqa: E402

import app.routers.kb as kb_mod  # noqa: E402


def _patch_vault(monkeypatch, name: str) -> Path:
    root = _SCRATCH / name
    monkeypatch.setattr(kb_mod, "_CLIP_DIR", root / "clippings")
    monkeypatch.setattr(kb_mod, "VAULT_DIR", root)
    return root


async def test_clip_text_saves_and_indexes(monkeypatch):
    root = _patch_vault(monkeypatch, "one")

    def fake_index(path):
        return 3

    monkeypatch.setattr(kb_mod.indexer, "index_file", fake_index)
    r = await kb_mod.kb_clip_text(kb_mod.TextClipIn(text="await 把控制权交还给调度器", title="测试剪藏"))
    assert r["chunks"] == 3 and r["title"] == "测试剪藏"
    saved = root / r["filename"]
    assert saved.exists()
    text = saved.read_text(encoding="utf-8")
    assert "剪藏自划词" in text and "await" in text
    assert r["filename"].startswith("clippings/")


async def test_clip_text_rejects_empty_and_needs_no_title(monkeypatch):
    _patch_vault(monkeypatch, "two")

    def fake_index(path):
        return 1

    monkeypatch.setattr(kb_mod.indexer, "index_file", fake_index)
    with pytest.raises(HTTPException):
        await kb_mod.kb_clip_text(kb_mod.TextClipIn(text="   "))
    # 无标题时取正文开头
    r = await kb_mod.kb_clip_text(kb_mod.TextClipIn(text="第一行是标题\n第二行"))
    assert "第一行是标题" in r["title"]
