"""Offline tests for 备份与恢复 (PLAN.md 第 8 节).

第 8 节把「备份能恢复」列为唯一一件晚做就来不及的事：理解状态是这个产品唯一不可
重建的资产。`smoke_restore.py` 拿真实归档做整套演练；这里钉的是对任何一个归档都
必须成立的部分 —— 打包进去了什么、解开之后能不能逐字节拿回来、保留几份、以及
`resolve` 不能被诱导去读备份目录以外的文件。

不碰模型也不碰 embedder：向量库本来就不入包（可由 vault 重建），SQLite 用 raw
sqlite3 造，所以这个文件连 app.db 都不 import。
"""
import atexit
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-backup-", dir=Path(__file__).parent))
atexit.register(lambda: shutil.rmtree(_TMP, ignore_errors=True))

from app.config import settings  # noqa: E402
from app.core import backup  # noqa: E402

_NON_ASCII = "notes/项目笔记.md"  # vault names are Chinese in practice — zip flags matter
_N = 0  # one vault + one backup dir per test, so retention counts stay isolated


def _cfg(**kw) -> None:
    """Write the scratch config.json. `load_config` re-reads it every call."""
    Path(settings.config_path).write_text(json.dumps(kw, ensure_ascii=False), encoding="utf-8")


def _vault(n: int = 0) -> Path:
    """A throwaway vault with a nested dir and a non-ASCII filename."""
    v = _TMP / f"vault{n}"
    (v / "notes").mkdir(parents=True, exist_ok=True)
    (v / "top.md").write_text("# top\n", encoding="utf-8")
    (v / _NON_ASCII).write_text("卡在 await 交给谁\n", encoding="utf-8")
    (v / "notes" / "deep.md").write_text("x" * 5000, encoding="utf-8")
    return v


def _db(rows: int = 3) -> None:
    """A live-ish SQLite file for the online-backup snapshot to copy."""
    con = sqlite3.connect(settings.db_path)
    try:
        con.execute("CREATE TABLE IF NOT EXISTS tutor_sessions (id INTEGER PRIMARY KEY, concept TEXT)")
        con.execute("DELETE FROM tutor_sessions")
        con.executemany(
            "INSERT INTO tutor_sessions (concept) VALUES (?)",
            [(f"概念{i}",) for i in range(rows)],
        )
        con.commit()
    finally:
        con.close()


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _unzip(name: str, dest: Path) -> Path:
    """Restore exactly the way the hint tells you to: unzip over a project root."""
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(backup.resolve(name)) as z:
        z.extractall(dest)
    return dest


@pytest.fixture()
def live(monkeypatch):
    """A scratch (db, config, vault, backup dir) set wired into what the code reads.

    Own tempdir under tests/, not pytest's `tmp_path`: the system temp root is
    not writable here, same reason the other test files do it this way.

    `WB_DB_PATH` in the environment is not enough. `settings` is constructed once,
    by whichever test module imports `app.config` first, so under the full suite
    this file's env vars arrive too late and `_db()` would be writing into another
    module's database — which already has a real `tutor_sessions`, so the raw
    CREATE TABLE IF NOT EXISTS silently no-ops and the INSERT fails. Both
    `backup._snapshot_db` and `prefs._path` re-read these attributes on every
    call, so patching the object is what actually isolates us."""
    global _N
    _N += 1
    return _wire(monkeypatch, _N)


def _wire(monkeypatch, n: int) -> Path:
    monkeypatch.setattr(settings, "db_path", _TMP / f"db{n}.db")
    monkeypatch.setattr(settings, "config_path", _TMP / f"config{n}.json")
    monkeypatch.setattr(backup, "VAULT_DIR", _vault(n))
    bdir = _TMP / f"backups{n}"
    _cfg(backup_dir=str(bdir), backup_keep=5)
    _db()
    return bdir


def test_archive_holds_vault_db_config_and_a_manifest(live):
    info = backup.create_backup("test")
    assert info["ok"] and info["vault_files"] == 3 and info["db"] is True

    with zipfile.ZipFile(backup.resolve(info["name"])) as z:
        names = set(z.namelist())
        manifest = json.loads(z.read("backup-manifest.json"))
    assert "vault/top.md" in names
    assert f"vault/{_NON_ASCII}" in names
    assert "vault/notes/deep.md" in names
    assert f"data/{Path(settings.db_path).name}" in names
    assert f"data/{Path(settings.config_path).name}" in names
    # index_included=False is a promise the restore hint depends on: the vector
    # store is absent *and* the manifest says how to get it back.
    assert manifest["index_included"] is False
    assert manifest["vault_files"] == 3
    assert manifest["db"] is True and manifest["config"] is True
    assert "重建索引" in manifest["restore"]


def test_manifest_spells_out_what_is_not_in_the_archive(live):
    """A restore months from now must not have to guess which dead links are
    expected. The gap that actually hurts — generated files still referenced by
    surviving DB rows — has to be named, not just implied by chroma/repos."""
    info = backup.create_backup("test")
    with zipfile.ZipFile(backup.resolve(info["name"])) as z:
        manifest = json.loads(z.read("backup-manifest.json"))

    assert manifest["not_included"] == backup.NOT_INCLUDED
    assert all(v.strip() for v in manifest["not_included"].values()), "每一条都要说清丢了会怎样"
    assert any("死链" in v for v in manifest["not_included"].values())
    assert any("chroma" in k for k in manifest["not_included"])


def test_restore_round_trip_is_byte_identical(live):
    info = backup.create_backup("test")
    root = _unzip(info["name"], _TMP / "restored")

    vault = backup.VAULT_DIR
    before = {p.relative_to(vault).as_posix(): _sha(p) for p in vault.rglob("*") if p.is_file()}
    rv = root / "vault"
    after = {p.relative_to(rv).as_posix(): _sha(p) for p in rv.rglob("*") if p.is_file()}
    assert after == before, "restored vault differs from the live one"
    # the Chinese filename is the one that silently mangles if the zip loses UTF-8
    assert (rv / _NON_ASCII).read_text(encoding="utf-8").startswith("卡在")


def test_restored_db_is_intact_and_still_holds_the_rows(live):
    info = backup.create_backup("test")
    root = _unzip(info["name"], _TMP / "restored_db")

    con = sqlite3.connect(root / "data" / Path(settings.db_path).name)
    try:
        assert con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        concepts = [r[0] for r in con.execute("SELECT concept FROM tutor_sessions ORDER BY id")]
    finally:
        con.close()
    assert concepts == ["概念0", "概念1", "概念2"]


def test_snapshot_survives_a_write_between_backups(live):
    """The online-backup API, not a file copy: a later write must not leak back
    into an archive that was already written."""
    first = backup.create_backup("test")
    _db(rows=7)
    second = backup.create_backup("test")

    def rows(name: str) -> int:
        root = _unzip(name, _TMP / f"r-{name}")
        con = sqlite3.connect(root / "data" / Path(settings.db_path).name)
        try:
            return con.execute("SELECT COUNT(*) FROM tutor_sessions").fetchone()[0]
        finally:
            con.close()

    assert rows(first["name"]) == 3
    assert rows(second["name"]) == 7


def test_prune_keeps_only_the_configured_count(live):
    _cfg(backup_dir=str(live), backup_keep=2)
    a = backup.create_backup("test")
    b = backup.create_backup("test")
    c = backup.create_backup("test")
    left = {p.name for p in backup._archives()}
    assert len(left) == 2, left
    assert c["name"] in left and b["name"] in left
    assert a["name"] not in left
    assert a["name"] in c["pruned"] or a["name"] in b["pruned"]


def test_list_backups_is_newest_first_and_carries_the_restore_hint(live):
    backup.create_backup("test")
    newest = backup.create_backup("test")
    out = backup.list_backups()
    assert out["backups"][0]["name"] == newest["name"]
    assert out["dir"] == str(live) and out["keep"] == 5
    assert "重建索引" in out["restore_hint"]


@pytest.mark.parametrize(
    "name",
    ["", "   ", "other.zip", "workbench-backup-x.tar", "notes.md",
     "../workbench-backup-x.zip", "sub/workbench-backup-x.zip",
     "workbench-backup-../../x.zip", "workbench-backup-\\x.zip"],
)
def test_resolve_rejects_anything_we_did_not_write(live, name):
    with pytest.raises(ValueError):
        backup.resolve(name)


def test_resolve_reports_a_wellformed_but_absent_archive(live):
    with pytest.raises(FileNotFoundError):
        backup.resolve("workbench-backup-20200101-000000.zip")


def test_a_backup_dir_inside_the_vault_does_not_archive_the_archives(monkeypatch):
    """The mis-set case: backup_dir under vault/ would otherwise make every run
    swallow the previous one and grow the archive without bound."""
    _wire(monkeypatch, 99)  # its own vault: this one has the backup dir *inside* it
    v = backup.VAULT_DIR
    _cfg(backup_dir=str(v / "backups"), backup_keep=5)

    backup.create_backup("test")
    second = backup.create_backup("test")
    with zipfile.ZipFile(backup.resolve(second["name"])) as z:
        names = z.namelist()
    assert not [n for n in names if n.endswith(".zip")], names
    assert second["vault_files"] == 3
