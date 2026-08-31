"""Local folder ingestion (ROADMAP V5.3).

Directories outside `vault/` (e.g. D:\\docs) can be registered in
data/config.json under `watch_dirs`; their files are indexed with the
`dirs/<name>/` source prefix — the same namespace trick cloned repos use, so
vault rebuilds never prune them and they stay out of the Notes list.

A watchfiles thread (one generator over all dirs) keeps them in sync live:
file added/modified -> reindex, deleted -> drop chunks. The generator is
recreated when the dirs config changes (add/remove/toggle), detected via a
cheap config fingerprint polled on every watch timeout.
"""
import logging
import re
import threading
import time
from datetime import datetime
from pathlib import Path

from watchfiles import Change, watch

from app.config import VAULT_DIR
from app.core import indexer, ingest
from app.core.prefs import load_config, save_config

log = logging.getLogger(__name__)

_NAME_RE = re.compile(r"^[^\\/:*?\"<>|]{1,60}$")

MAX_FILES = 3000  # guard against indexing a whole drive by accident
MAX_FILE_BYTES = 500_000  # 500KB — beyond this a PDF is likely a scan dump
DEBOUNCE_SECONDS = 2.0

SKIP_DIRS = {
    "$RECYCLE.BIN", "System Volume Information",
    ".git", "node_modules", "dist", "build", "out", "target", "vendor",
    "__pycache__", ".venv", "venv", ".idea", ".vscode", "AppData",
}


def _source_prefix(name: str) -> str:
    return f"{indexer.DIR_SOURCE_PREFIX}{name}/"


def list_dirs() -> list[dict]:
    out = []
    for d in load_config().get("watch_dirs") or []:
        entry = dict(d)
        entry["exists"] = Path(entry.get("path", "")).expanduser().is_dir()
        out.append(entry)
    return out


def _save_dir(entry: dict) -> None:
    dirs = [d for d in (load_config().get("watch_dirs") or []) if d.get("name") != entry["name"]]
    dirs.append(entry)
    save_config({"watch_dirs": sorted(dirs, key=lambda d: d["name"])})


def _get_entry(name: str) -> dict | None:
    return next((d for d in list_dirs() if d.get("name") == name), None)


def _validate(name: str, path: str) -> Path:
    if not _NAME_RE.match(name or ""):
        raise ValueError(f"非法名称（1-60 字，不含 \\/:*?\"<>|）: {name}")
    p = Path(path).expanduser()
    if not p.is_absolute():
        raise ValueError("请填写绝对路径，如 D:\\docs")
    if not p.is_dir():
        raise ValueError(f"目录不存在: {p}")
    rp = p.resolve()
    vault = VAULT_DIR.resolve()
    if rp == vault or vault.is_relative_to(rp) or rp.is_relative_to(vault):
        raise ValueError("不能与 vault 目录重叠（vault 本身已会被索引）")
    return rp


def _walk(root: Path) -> list[Path]:
    files: list[Path] = []
    for p in root.rglob("*"):
        if len(files) >= MAX_FILES:
            break
        if not p.is_file() or p.name.startswith("."):
            continue
        if SKIP_DIRS & set(p.relative_to(root).parts[:-1]):
            continue
        if not ingest.is_repo_indexable(p):
            continue
        try:
            if p.stat().st_size > MAX_FILE_BYTES:
                continue
        except OSError:
            continue
        files.append(p)
    return files


def index_dir(name: str) -> dict:
    """(Re)index every eligible file; prune chunks whose file has vanished."""
    t0 = time.time()
    entry = _get_entry(name)
    if not entry:
        raise ValueError(f"目录 '{name}' 未注册")
    root = Path(entry["path"]).expanduser().resolve()
    prefix = _source_prefix(name)
    files = _walk(root)
    chunks, errors = 0, []
    live: set[str] = set()
    for p in files:
        src = f"{prefix}{p.relative_to(root).as_posix()}"
        live.add(src)
        try:
            chunks += indexer.index_file(p, root, source_prefix=f"{indexer.DIR_SOURCE_PREFIX}{name}")
        except Exception as e:  # noqa: BLE001 - one bad file must not stop the scan
            errors.append(f"{p.name}: {e}")
    pruned = [s for s in indexer.list_sources(prefix) if s not in live]
    for s in pruned:
        indexer.delete_source(s)
    result = {
        "files": len(files),
        "chunks": chunks,
        "errors": errors[:10],
        "pruned": len(pruned),
        "truncated": len(files) >= MAX_FILES,
        "last_synced": datetime.now().isoformat(timespec="seconds"),
        "seconds": round(time.time() - t0, 1),
    }
    _save_dir({**entry, **result})
    return result


def add(name: str, path: str) -> dict:
    rp = _validate(name, path)
    if _get_entry(name):
        raise ValueError(f"目录 '{name}' 已存在")
    if any(Path(d["path"]).expanduser().resolve() == rp for d in list_dirs()):
        raise ValueError(f"该目录已在监听列表中: {rp}")
    entry = {"name": name, "path": str(rp), "enabled": True}
    _save_dir(entry)  # save first so the watcher picks it up immediately
    entry.update(index_dir(name))
    return entry


def remove(name: str) -> dict:
    """Unindex the dir and drop its config entry — user files are never touched."""
    prefix = _source_prefix(name)
    sources = indexer.list_sources(prefix)
    for s in sources:
        indexer.delete_source(s)
    dirs = [d for d in (load_config().get("watch_dirs") or []) if d.get("name") != name]
    save_config({"watch_dirs": dirs})
    return {"ok": True, "sources_removed": len(sources)}


def set_enabled(name: str, enabled: bool) -> dict:
    entry = _get_entry(name)
    if not entry:
        raise ValueError(f"目录 '{name}' 未注册")
    entry["enabled"] = enabled
    removed = 0
    if not enabled:  # disabling = unindex (files stay on disk)
        prefix = _source_prefix(name)
        sources = indexer.list_sources(prefix)
        for s in sources:
            indexer.delete_source(s)
        removed = len(sources)
        entry.update({"files": 0, "chunks": 0})
    else:
        entry.update(index_dir(name))
    _save_dir(entry)
    return {**entry, "sources_removed": removed}


def sync(name: str) -> dict:
    if not _get_entry(name):
        raise ValueError(f"目录 '{name}' 未注册")
    return index_dir(name)


def version() -> int:
    """Cheap fingerprint of the watch_dirs config; polled by the watcher."""
    return hash(repr(load_config().get("watch_dirs") or []))


# ---------- live watcher ----------


class DirWatcher:
    """One watchfiles generator over all enabled dirs.

    watch() blocks, so the dirs config can't be re-read mid-generator: on each
    (1s) timeout tick we compare the config fingerprint and break out to
    recreate the watch set when it changed.
    """

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.status = "stopped"  # stopped | idle | running

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="dir-watcher", daemon=True)
        self._thread.start()
        log.info("dir watcher started")

    def stop(self) -> None:
        self._stop.set()
        self.status = "stopped"

    def _enabled_roots(self) -> list[tuple[str, Path]]:
        out = []
        for d in list_dirs():
            if not d.get("enabled", True):
                continue
            p = Path(d["path"]).expanduser()
            if p.is_dir():
                out.append((d["name"], p.resolve()))
        return out

    @staticmethod
    def _locate(changed: str, roots: list[tuple[str, Path]]) -> tuple[str, Path, str] | None:
        """Absolute changed path -> (dir_name, root, rel path); deepest root wins."""
        p = Path(changed).resolve()
        best: tuple[str, Path] | None = None
        for name, root in roots:
            if p.is_relative_to(root) and (best is None or len(root.parts) > len(best[1].parts)):
                best = (name, root)
        if best is None:
            return None
        name, root = best
        return name, root, p.relative_to(root).as_posix()

    @staticmethod
    def _file_relevant(rel: str, change: Change) -> bool:
        rel_path = Path(rel)
        if rel_path.name.startswith(".") or SKIP_DIRS & set(rel_path.parts[:-1]):
            return False
        if change == Change.deleted:
            return ingest.is_repo_indexable(rel_path)  # only unindex what we indexed
        return ingest.is_repo_indexable(rel_path)

    def _run(self) -> None:
        while not self._stop.is_set():
            roots = self._enabled_roots()
            if not roots:
                self.status = "idle"
                if self._stop.wait(1.0):
                    return
                continue
            self.status = "running"
            v = version()
            try:
                for changes in watch(
                    *[p for _, p in roots], rust_timeout=1000, stop_event=self._stop, recursive=True
                ):
                    if self._stop.is_set() or version() != v:
                        break  # dirs config changed -> recreate the watch set
                    jobs = []
                    for changed, change in sorted(changes):
                        located = self._locate(changed, roots)
                        if not located:
                            continue
                        name, root, rel = located
                        if not self._file_relevant(rel, change):
                            continue
                        jobs.append((name, root, rel, change))
                    if not jobs:
                        continue
                    self._stop.wait(DEBOUNCE_SECONDS)  # debounce bursts
                    if self._stop.is_set():
                        return
                    for name, root, rel, change in jobs:
                        self._apply(name, root, rel, change)
            except Exception:  # noqa: BLE001 - keep the watcher alive
                log.exception("dir watcher loop failed")
                self._stop.wait(1.0)

    def _apply(self, name: str, root: Path, rel: str, change: Change) -> None:
        prefix = _source_prefix(name)
        try:
            if change == Change.deleted:
                indexer.delete_source(f"{prefix}{rel}")
                return
            path = root / rel
            if not path.is_file():
                indexer.delete_source(f"{prefix}{rel}")
            elif path.stat().st_size <= MAX_FILE_BYTES:
                indexer.index_file(path, root, source_prefix=f"{indexer.DIR_SOURCE_PREFIX}{name}")
        except Exception:  # noqa: BLE001 - one bad file must not kill the loop
            log.exception("dir %s: failed to index %s", name, rel)


watcher = DirWatcher()
