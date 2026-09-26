"""Offline tests for V5.3 local-dir ingestion (core/dirs.py).

indexer calls are faked (no embedding, no chroma); the vault-overlap check and
config round-trips run against a scratch config/db. Env set before imports.
"""
import asyncio
import atexit
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-dirs-", dir=Path(".").resolve()))


def _cleanup() -> None:
    try:
        asyncio.run(engine.dispose())
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)


from app.config import VAULT_DIR  # noqa: E402

from app.core import dirs, indexer  # noqa: E402
from app.db import engine  # noqa: E402


# ---- fake indexer: records calls, returns 1 chunk per file ----

INDEXED: list[str] = []
DELETED: list[str] = []
SOURCES: set[str] = set()


def _fake_index_file(path: Path, root: Path = VAULT_DIR, source_prefix: str = "") -> int:
    rel = path.relative_to(root).as_posix()
    if source_prefix:
        rel = f"{source_prefix.rstrip('/')}/{rel}"
    INDEXED.append(rel)
    SOURCES.add(rel)
    return 1


def _fake_delete_source(rel: str) -> None:
    DELETED.append(rel)
    SOURCES.discard(rel)


def _fake_list_sources(prefix: str = "") -> list[str]:
    return sorted(s for s in SOURCES if s.startswith(prefix))


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    INDEXED.clear()
    DELETED.clear()
    SOURCES.clear()
    monkeypatch.setattr(indexer, "index_file", _fake_index_file)
    monkeypatch.setattr(indexer, "delete_source", _fake_delete_source)
    monkeypatch.setattr(indexer, "list_sources", _fake_list_sources)
    # dirs.py binds indexer at import; patch through the module ref
    monkeypatch.setattr(dirs.indexer, "index_file", _fake_index_file, raising=False)
    monkeypatch.setattr(dirs.indexer, "delete_source", _fake_delete_source, raising=False)
    monkeypatch.setattr(dirs.indexer, "list_sources", _fake_list_sources, raising=False)
    yield


def _mkdocs(name: str = "docs", files: dict[str, str] | None = None) -> Path:
    d = _TMP / name
    d.mkdir(parents=True, exist_ok=True)
    for fname, content in (files or {"a.md": "# A", "b.txt": "hello"}).items():
        f = d / fname
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(content, encoding="utf-8")
    return d


# ---- validation ----


def test_validate_rejects_bad_input():
    with pytest.raises(ValueError):  # relative path
        dirs._validate("x", "relative/path")
    with pytest.raises(ValueError):  # missing dir
        dirs._validate("x", str(_TMP / "nope"))
    with pytest.raises(ValueError):  # bad name
        dirs._validate("bad/name", str(_mkdocs()))
    with pytest.raises(ValueError):  # path inside vault
        dirs._validate("x", str(VAULT_DIR / "notes"))
    with pytest.raises(ValueError):  # vault inside path
        dirs._validate("x", str(VAULT_DIR.parent))


def test_validate_accepts_external_dir():
    d = _mkdocs()
    assert dirs._validate("docs", str(d)) == d.resolve()


# ---- add / index / prune ----


async def test_add_indexes_and_saves_stats():
    d = _mkdocs("add-docs")
    entry = await asyncio.to_thread(dirs.add, "adddocs", str(d))
    assert entry["files"] == 2 and entry["chunks"] == 2
    assert {s for s in SOURCES} == {"dirs/adddocs/a.md", "dirs/adddocs/b.txt"}
    stored = dirs.list_dirs()[0]
    assert stored["name"] == "adddocs" and stored["enabled"] is True and stored["exists"]


async def test_sync_prunes_deleted_files():
    d = _mkdocs("sync-docs")
    await asyncio.to_thread(dirs.add, "syncdocs", str(d))
    (d / "b.txt").unlink()
    result = await asyncio.to_thread(dirs.sync, "syncdocs")
    assert result["files"] == 1 and result["pruned"] == 1
    assert SOURCES == {"dirs/syncdocs/a.md"}


async def test_add_rejects_duplicate_name_and_path():
    d = _mkdocs("dup-docs")
    await asyncio.to_thread(dirs.add, "dupdocs", str(d))
    with pytest.raises(ValueError):  # same name
        await asyncio.to_thread(dirs.add, "dupdocs", str(_mkdocs("other")))
    with pytest.raises(ValueError):  # same path, new name
        await asyncio.to_thread(dirs.add, "other", str(d))


# ---- disable / remove ----


async def test_disable_unindexes_enable_reindexes():
    d = _mkdocs("toggle-docs")
    await asyncio.to_thread(dirs.add, "toggledocs", str(d))
    entry = await asyncio.to_thread(dirs.set_enabled, "toggledocs", False)
    assert entry["enabled"] is False and SOURCES == set()
    entry = await asyncio.to_thread(dirs.set_enabled, "toggledocs", True)
    assert entry["files"] == 2 and len(SOURCES) == 2


async def test_remove_keeps_files_on_disk():
    d = _mkdocs("rm-docs")
    await asyncio.to_thread(dirs.add, "rmdocs", str(d))
    result = await asyncio.to_thread(dirs.remove, "rmdocs")
    assert result["sources_removed"] == 2
    assert all(d["name"] != "rmdocs" for d in dirs.list_dirs())
    assert (d / "a.md").exists() and (d / "b.txt").exists()  # user files untouched


# ---- watcher helpers ----


def test_locate_picks_deepest_root():
    outer = _mkdocs("outer")
    inner = outer / "nested"
    inner.mkdir(exist_ok=True)
    roots = [("outer", outer), ("inner", inner)]
    name, root, rel = DirWatcher_locate(str(inner / "x.md"), roots)
    assert (name, rel) == ("inner", "x.md")
    name, root, rel = DirWatcher_locate(str(outer / "y.md"), roots)
    assert (name, rel) == ("outer", "y.md")
    assert DirWatcher_locate(str(_TMP / "elsewhere.md"), roots) is None


def DirWatcher_locate(changed: str, roots):
    return dirs.DirWatcher._locate(changed, roots)


def test_file_relevant():
    rel_ok, rel_del = "notes/a.md", "notes/gone.md"
    assert dirs.DirWatcher._file_relevant(rel_ok, __import__("watchfiles").Change.added)
    assert dirs.DirWatcher._file_relevant(rel_del, __import__("watchfiles").Change.deleted)
    assert not dirs.DirWatcher._file_relevant("x/.hidden.md", __import__("watchfiles").Change.added)
    assert not dirs.DirWatcher._file_relevant("node_modules/a.md", __import__("watchfiles").Change.added)
    assert not dirs.DirWatcher._file_relevant("sub/a.exe", __import__("watchfiles").Change.added)


# ---- indexer external-prefix guard ----


def test_prune_missing_skips_external_prefixes(monkeypatch):
    class FakeCol:
        def count(self):
            return 2

        def get(self, include=None):
            return {"metadatas": [{"source": "dirs/ext/a.md"}, {"source": "vault-gone.md"}]}

        def delete(self, where=None):
            DELETED.append(where["source"])

    monkeypatch.setattr(indexer, "get_collection", lambda: FakeCol())
    stale = indexer._prune_missing(set())
    assert stale == ["vault-gone.md"]  # dirs/ source survives a vault rebuild
