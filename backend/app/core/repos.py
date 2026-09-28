"""Git repository ingestion (ROADMAP V5.1).

Repos are shallow-cloned into `data/repos/<name>/` — deliberately *outside*
`vault/`, so they don't flood the Notes list and don't bloat backup zips. Their
chunks are namespaced with the `repos/<name>/` source prefix, which keeps a
vault rebuild from pruning them.
"""
import logging
import re
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path

from app.config import DATA_DIR
from app.core import indexer, ingest
from app.core.prefs import load_config, save_config

log = logging.getLogger(__name__)

REPOS_DIR = DATA_DIR / "repos"
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,60}$")

MAX_FILE_BYTES = 200_000  # a 200KB source file is already ~250 chunks
MAX_FILES = 1500  # guard against indexing a monorepo by accident
GIT_TIMEOUT = 300

SKIP_DIRS = {
    ".git", ".github", "node_modules", "dist", "build", "out", "target", "vendor",
    "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".next",
    ".nuxt", "coverage", ".idea", ".vscode", "site-packages",
}


def _rmtree(path: Path) -> None:
    """Delete a clone. Git keeps objects read-only, which makes a plain rmtree
    fail on Windows, so clear the read-only bit first."""
    import os
    import stat

    for p in path.rglob("*"):
        try:
            os.chmod(p, stat.S_IWRITE)
        except OSError:
            pass
    shutil.rmtree(path, ignore_errors=True)


def name_from_url(url: str) -> str:
    tail = url.rstrip("/").rsplit("/", 1)[-1]
    return re.sub(r"[^A-Za-z0-9._-]", "-", tail.removesuffix(".git")) or "repo"


def _repo_dir(name: str) -> Path:
    if not NAME_RE.match(name):
        raise ValueError(f"非法仓库名: {name}")
    return REPOS_DIR / name


def _git(*args: str, cwd: Path | None = None) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=GIT_TIMEOUT,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "git failed").strip()[:500])
    return proc.stdout


def list_repos() -> list[dict]:
    repos = load_config().get("repos") or []
    out = []
    for r in repos:
        d = dict(r)
        d["cloned"] = (REPOS_DIR / r["name"]).exists() if NAME_RE.match(r.get("name", "")) else False
        out.append(d)
    return out


def _save_repo(entry: dict) -> None:
    repos = [r for r in (load_config().get("repos") or []) if r.get("name") != entry["name"]]
    repos.append(entry)
    save_config({"repos": sorted(repos, key=lambda r: r["name"])})


def clone(url: str, name: str | None = None) -> dict:
    """Shallow-clone a repo, then index it. Returns the stored entry."""
    url = url.strip()
    if not url:
        raise ValueError("仓库地址为空")
    name = (name or name_from_url(url)).strip()
    target = _repo_dir(name)
    if target.exists():
        raise ValueError(f"仓库 '{name}' 已存在，请改用同步")
    REPOS_DIR.mkdir(parents=True, exist_ok=True)
    log.info("cloning %s -> %s", url, target)
    try:
        _git("clone", "--depth", "1", "--", url, str(target))
    except Exception:
        _rmtree(target)
        raise
    entry = {"name": name, "url": url}
    entry.update(index_repo(name))
    _save_repo(entry)
    return entry


def sync(name: str) -> dict:
    """git pull, then reindex. Returns the updated entry."""
    target = _repo_dir(name)
    if not target.exists():
        raise ValueError(f"仓库 '{name}' 尚未克隆")
    _git("pull", "--ff-only", "--depth", "1", cwd=target)
    known = next((r for r in list_repos() if r["name"] == name), {"name": name, "url": ""})
    entry = {"name": name, "url": known.get("url", "")}
    entry.update(index_repo(name))
    _save_repo(entry)
    return entry


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


def index_repo(name: str) -> dict:
    """Index every eligible file, prune sources that vanished since last sync."""
    t0 = time.time()
    root = _repo_dir(name)
    prefix = f"{indexer.REPO_SOURCE_PREFIX}{name}/"
    files = _walk(root)
    chunks, errors = 0, []
    live: set[str] = set()
    for p in files:
        src = f"{prefix}{p.relative_to(root).as_posix()}"
        live.add(src)
        try:
            chunks += indexer.index_file(p, root, source_prefix=f"{indexer.REPO_SOURCE_PREFIX}{name}")
        except Exception as e:  # noqa: BLE001 - one bad file must not stop the sync
            errors.append(f"{p.name}: {e}")
    pruned = [s for s in indexer.list_sources(prefix) if s not in live]
    for s in pruned:
        indexer.delete_source(s)
    return {
        "files": len(files),
        "chunks": chunks,
        "errors": errors[:10],
        "pruned": len(pruned),
        "truncated": len(files) >= MAX_FILES,
        "last_synced": datetime.now().isoformat(timespec="seconds"),
        "seconds": round(time.time() - t0, 1),
    }


def remove(name: str, delete_files: bool = True) -> dict:
    """Drop the repo's chunks, its config entry and (by default) the clone."""
    prefix = f"{indexer.REPO_SOURCE_PREFIX}{name}/"
    sources = indexer.list_sources(prefix)
    for s in sources:
        indexer.delete_source(s)
    repos = [r for r in (load_config().get("repos") or []) if r.get("name") != name]
    save_config({"repos": repos})
    removed_dir = False
    if delete_files:
        target = _repo_dir(name)
        if target.exists():
            _rmtree(target)
            removed_dir = not target.exists()
    return {"ok": True, "sources_removed": len(sources), "dir_removed": removed_dir}
