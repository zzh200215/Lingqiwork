"""Local backup: zip vault/ + SQLite snapshot + config.json into a rolling set.

Restore stays manual on purpose (stop server → unzip over the project root →
restart), so a bug here can never overwrite live data. The vector index is not
archived: it is fully rebuildable from vault via the KB rebuild endpoint.

What is *not* in the archive is listed in the manifest rather than left to be
discovered during a restore — see `NOT_INCLUDED`. `smoke_restore.py` rehearses
the whole path and will tell you if any of this drifts.
"""
import json
import logging
import os
import sqlite3
import subprocess
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
# T8：backup_removable 开着时，归档落第一块 USB 外接盘的这个子目录。
REMOVABLE_DIRNAME = "workbench-backup"


class NoRemovableDrive(RuntimeError):
    """backup_removable 模式下当前没有任何 USB 外接盘——计划任务跳过、手动跑收到人话。"""


def removable_drives() -> list[str]:
    """USB 总线挂载的盘符（U 盘/移动硬盘/SSD），如 ["E:\\"]；非 Windows 恒 []。

    GetDriveTypeW 只认得出 U 盘（DRIVE_REMOVABLE）——移动硬盘/SSD 报 FIXED 会漏，
    所以反查 Win32_LogicalDiskToPartition → Win32_DiskDrive(InterfaceType='USB')。
    PowerShell 冷启动 1-2 秒，对每天一次的备份可承受。探测失败按「没插盘」处理：
    少备一次有日志可查，比挂掉强。
    """
    if os.name != "nt":
        return []
    script = (
        "$usb = @(Get-CimInstance Win32_DiskDrive -Filter \"InterfaceType='USB'\""
        " | Select-Object -ExpandProperty Index);"
        "if ($usb.Count -eq 0) { exit 0 };"
        "Get-CimInstance Win32_LogicalDiskToPartition | ForEach-Object {"
        "$p = [wmi]$_.Antecedent; $l = [wmi]$_.Dependent;"
        "if ($usb -contains $p.DiskIndex) { $l.DeviceID } }"
    )
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        log.warning("USB 外接盘探测失败（按没插盘处理）", exc_info=True)
        return []
    if r.returncode != 0:
        log.warning("USB 外接盘探测返回 %s: %s", r.returncode, (r.stderr or "").strip()[:150])
        return []
    return sorted({line.strip() for line in r.stdout.splitlines() if line.strip()})

# Everything else under data/ and why it is acceptable to lose. Written into the
# manifest so a restore three months from now does not have to guess which dead
# links are expected. 生成物那一行是真正的缺口，不是设计选择。
NOT_INCLUDED = {
    "data/chroma": "向量库，可由 vault 重建（KB 页「重建索引」）",
    "data/repos": "克隆的仓库，可重新克隆",
    "data/feeds_seen.json": "订阅去重状态，丢了最多重复推一次旧条目",
    "data/artifacts + images + podcasts + tts": "生成物，不可重建；DB 里的引用会变死链",
    # 有意排除，不是遗漏：令牌属于本机，跟着备份走到另一台机器
    # 没有意义（那边首启会自己生成一个），而且它本就不该出现在任何可拷走的包里。
    "data/api_token": "启动令牌，本机首启自动生成；有意不入包，恢复后重生成",
}


def _fixed_dir() -> Path:
    raw = (load_config().get("backup_dir") or "").strip()
    d = Path(raw).expanduser() if raw else DEFAULT_BACKUP_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def backup_landing() -> Path:
    """create_backup 真正用的落点。backup_removable 开着 → 第一块 USB 外接盘；
    没插盘抛 NoRemovableDrive（调度跳过 / 手动跑收到人话），绝不退回正本同盘。
    关着 → 旧行为：配置的 backup_dir 或项目下 backups/。"""
    if load_config().get("backup_removable"):
        drives = removable_drives()
        if not drives:
            raise NoRemovableDrive(
                "没找到 USB 外接盘——插上盘再备份，或在设置里改用固定备份目录"
            )
        d = Path(drives[0]) / REMOVABLE_DIRNAME
        d.mkdir(parents=True, exist_ok=True)
        return d
    return _fixed_dir()


def backup_dir() -> Path:
    """展示/列表用的**宽容**落点：外接盘没插时退回固定目录，列表页不能 500。
    「现在到底落哪儿」以 create_backup 用的 backup_landing() 为准。"""
    try:
        return backup_landing()
    except NoRemovableDrive:
        return _fixed_dir()


def _keep() -> int:
    try:
        return max(1, int(load_config().get("backup_keep", DEFAULT_KEEP)))
    except (TypeError, ValueError):
        return DEFAULT_KEEP


def _archives() -> list[Path]:
    """Our own archives in the (tolerant) backup dir, newest first."""
    return _archives_in(backup_dir())


def _archives_in(d: Path) -> list[Path]:
    """Our own archives in the given dir, newest first."""
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
    bdir = backup_landing()
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
                        "secrets": (
                            "密钥（config.json 与 SQLite）以 Windows DPAPI 密文入包："
                            "换机器/账户不可解，恢复后需重填"
                        ),
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
    """外接盘模式没插盘时**不报错**：归档本来就在那块盘上，返回空的清单
    加一句 `removable_missing` 人话，让设置页照实说「为什么是空的」。"""
    try:
        landing = backup_landing()
        missing = ""
    except NoRemovableDrive as e:
        landing, missing = None, str(e)
    items = (
        [
            {
                "name": p.name,
                "size": p.stat().st_size,
                "created_at": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds"),
            }
            for p in _archives_in(landing)
        ]
        if landing
        else []
    )
    from app.core import scheduler as sched

    return {
        "dir": str(landing) if landing else "",
        "removable_missing": missing,
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
    except NoRemovableDrive as e:
        # T8：外接盘没插是**正常状态**不是故障——这一轮安静跳过，留一行日志。
        log.info("scheduled backup skipped: %s", e)
    except Exception:  # noqa: BLE001 - a failed run must not kill the scheduler
        log.exception("scheduled backup failed")
