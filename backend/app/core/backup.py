"""Local backup: zip vault/ + SQLite snapshot + config.json into a rolling set.

Restore stays manual on purpose (stop server → unzip over the project root →
restart), so a bug here can never overwrite live data. The vector index is not
archived: it is fully rebuildable from vault via the KB rebuild endpoint.

What is *not* in the archive is listed in the manifest rather than left to be
discovered during a restore — see `NOT_INCLUDED`. `smoke_restore.py` rehearses
the whole path (PLAN.md 第 8 节) and will tell you if any of this drifts.
"""
import json
import logging
import sqlite3
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

from app.config import BASE_DIR, VAULT_DIR, settings
from app.core.prefs import load_config

log = logging.getLogger(__name__)

DEFAULT_BACKUP_DIR = BASE_DIR / "backups"
DEFAULT_KEEP = 7
_PREFIX = "workbench-backup-"
_SUFFIX = ".zip"

# Everything else under data/ and why it is acceptable to lose. Written into the
# manifest so a restore three months from now does not have to guess which dead
# links are expected. 生成物那一行是真正的缺口，不是设计选择。
NOT_INCLUDED = {
    "data/chroma": "向量库，可由 vault 重建（KB 页「重建索引」）",
    "data/repos": "克隆的仓库，可重新克隆",
    "data/feeds_seen.json": "订阅去重状态，丢了最多重复推一次旧条目",
    "data/artifacts + images + podcasts + tts": "生成物，不可重建；DB 里的引用会变死链",
}


def backup_dir() -> Path:
    raw = (load_config().get("backup_dir") or "").strip()
    d = Path(raw).expanduser() if raw else DEFAULT_BACKUP_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def _keep() -> int:
    try:
        return max(1, int(load_config().get("backup_keep", DEFAULT_KEEP)))
    except (TypeError, ValueError):
        return DEFAULT_KEEP


def _archives() -> list[Path]:
    """Our own archives in the backup dir, newest first."""
    d = backup_dir()
    items = [p for p in d.glob(f"{_PREFIX}*{_SUFFIX}") if p.is_file()]
    items.sort(key=lambda p: (p.stat().st_mtime, p.name), reverse=True)
    return items


def resolve(name: str) -> Path:
    """Map an archive name to a path, rejecting anything we did not create."""
    safe = (name or "").strip()
    if "/" in safe or "\\" in safe or ".." in safe:
        raise ValueError("非法备份名")
    if not (safe.startswith(_PREFIX) and safe.endswith(_SUFFIX)):
        raise ValueError("非法备份名")
    p = backup_dir() / safe
    if not p.is_file():
        raise FileNotFoundError(safe)
    return p


def _snapshot_db(tmp: Path) -> Path | None:
    """Consistent copy of the live SQLite db through the online backup API."""
    src = Path(settings.db_path)
    if not src.exists():
        return None
    dst = tmp / src.name
    con = sqlite3.connect(f"file:{src.as_posix()}?mode=ro", uri=True)
    try:
        out = sqlite3.connect(dst)
        try:
            con.backup(out)
        finally:
            out.close()
    finally:
        con.close()
    return dst


def create_backup(reason: str = "manual") -> dict:
    """Write one archive, then prune to the configured retention count."""
    bdir = backup_dir()
    base = f"{_PREFIX}{datetime.now():%Y%m%d-%H%M%S}"
    out = bdir / f"{base}{_SUFFIX}"
    n = 2
    while out.exists():  # two runs inside the same second must not overwrite
        out = bdir / f"{base}-{n}{_SUFFIX}"
        n += 1
    bdir = bdir.resolve()
    notes = 0
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        db_copy = _snapshot_db(tmp)
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for p in sorted(VAULT_DIR.rglob("*")):
                if not p.is_file() or p.resolve().is_relative_to(bdir):
                    continue  # never archive the archives (mis-set backup_dir)
                z.write(p, f"vault/{p.relative_to(VAULT_DIR).as_posix()}")
                notes += 1
            if db_copy:
                z.write(db_copy, f"data/{db_copy.name}")
            cfg = Path(settings.config_path)
            if cfg.exists():
                z.write(cfg, f"data/{cfg.name}")
            z.writestr(
                "backup-manifest.json",
                json.dumps(
                    {
                        "created_at": datetime.now().isoformat(timespec="seconds"),
                        "reason": reason,
                        "vault_files": notes,
                        "db": bool(db_copy),
                        "config": cfg.exists(),
                        "index_included": False,
                        "not_included": NOT_INCLUDED,
                        "restore": "停止服务 → 解压覆盖项目根目录的 vault/ 与 data/ → 重启 → KB 页重建索引",
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            )
    pruned = prune()
    info = {
        "ok": True,
        "name": out.name,
        "size": out.stat().st_size,
        "vault_files": notes,
        "db": bool(db_copy),
        "reason": reason,
        "pruned": pruned,
    }
    try:
        from app.core import pet

        pet.emit("backup", detail=f"{out.stat().st_size / 1024:.0f} KB，{notes} 个文件")
    except Exception:  # noqa: BLE001 - pet must never break the backup
        pass
    log.info("backup written: %s (%d vault files, pruned %s)", out.name, notes, pruned)
    return info


def prune() -> list[str]:
    """Delete archives beyond the retention count. Returns removed names."""
    removed: list[str] = []
    for p in _archives()[_keep() :]:
        try:
            p.unlink()
            removed.append(p.name)
        except OSError:
            log.warning("could not remove old backup %s", p.name)
    return removed


def list_backups() -> dict:
    items = [
        {
            "name": p.name,
            "size": p.stat().st_size,
            "created_at": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds"),
        }
        for p in _archives()
    ]
    from app.core import scheduler as sched

    return {
        "dir": str(backup_dir()),
        "keep": _keep(),
        "next_run": sched.next_run("auto_backup"),
        "backups": items,
        "restore_hint": (
            "恢复：先停止后端 → 解压 zip，用包内 vault/ 与 data/ 覆盖项目根目录同名目录 → "
            "重启后端 → 如向量检索异常，在 KB 页点「重建索引」（索引未入包，可由 vault 重建）。"
        ),
    }


def delete_backup(name: str) -> None:
    resolve(name).unlink()


def reschedule() -> None:
    from app.core import scheduler as sched

    cfg = load_config()
    sched.set_daily(
        "auto_backup",
        _run,
        bool(cfg.get("backup_enabled")),
        cfg.get("backup_time") or "03:00",
        default_hour=3,
    )


async def _run() -> None:
    import asyncio

    try:
        result = await asyncio.to_thread(create_backup, "scheduled")
        log.info("scheduled backup result: %s", result)
    except Exception:  # noqa: BLE001 - a failed run must not kill the scheduler
        log.exception("scheduled backup failed")
