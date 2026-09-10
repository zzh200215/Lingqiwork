"""Vault file-change triggers for tasks (ROADMAP V2.3).

A second watchfiles thread watches the vault and fires any task with
`trigger_kind="watch"` whose `watch_path` matches the changed file. Guards
against runaway loops: a per-task 90 s cooldown plus a running-set, and
tasks.core marks watch tasks around every run so a task writing into its own
watched folder does not immediately re-fire itself.
"""
import asyncio
import logging
import sqlite3
import threading
import time
from pathlib import Path

from watchfiles import Change, watch

from app.config import VAULT_DIR, settings
from app.core import ingest

log = logging.getLogger(__name__)

DEBOUNCE_SECONDS = 2.0
COOLDOWN_SECONDS = 90


class TaskTriggerWatcher:
    def __init__(self, root: Path = VAULT_DIR):
        self.root = root
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_fire: dict[int, float] = {}
        self._running: set[int] = set()
        self._lock = threading.Lock()
        self.status = "stopped"  # stopped | running | dispatching

    # ---------- lifecycle ----------

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        from app.core import tasks as core

        core.WATCH_HOOK = self.mark  # watch tasks suppress their own writes
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="task-triggers", daemon=True)
        self._thread.start()
        self.status = "running"
        log.info("watching %s for task triggers", self.root)

    def stop(self):
        self._stop.set()
        self.status = "stopped"

    # ---------- called from tasks core ----------

    def mark(self, task_id: int) -> None:
        """Suppress triggers for this task (it just ran / is about to write)."""
        with self._lock:
            self._last_fire[task_id] = time.monotonic()

    # ---------- internals ----------

    def _watched_tasks(self) -> list[tuple[int, str]]:
        rows: list[tuple[int, str]] = []
        try:
            conn = sqlite3.connect(settings.db_path)
            try:
                rows = conn.execute(
                    "SELECT id, watch_path FROM tasks "
                    "WHERE enabled = 1 AND trigger_kind = 'watch'"
                ).fetchall()
            finally:
                conn.close()
        except sqlite3.Error:
            log.debug("tasks table unavailable, no watch triggers", exc_info=True)
        return rows

    @staticmethod
    def _match(watch_rel: str, changed_rel: str) -> bool:
        """True when the changed vault-relative path is the watched path or under it."""
        w = watch_rel.strip().strip("/")
        c = changed_rel.replace("\\", "/").strip("/")
        if not w:
            return True
        return c == w or c.startswith(w + "/")

    def _to_rel(self, raw_path: str) -> str | None:
        """Absolute event path -> vault-relative posix path (None if outside)."""
        try:
            return Path(raw_path).resolve().relative_to(self.root).as_posix()
        except ValueError:
            return None

    def _is_relevant(self, raw_path: str) -> bool:
        # deletions are filtered by the caller — only content-bearing events get here
        path = Path(raw_path)
        return (
            ingest.is_supported(path)
            and "__pycache__" not in path.parts
            and not path.name.startswith(".")
        )

    def _run(self):
        for changes in watch(self.root, rust_timeout=500, stop_event=self._stop, recursive=True):
            relevant = {
                p for c, p in changes if c in (Change.added, Change.modified) and self._is_relevant(p)
            }
            if not relevant:
                continue
            self._stop.wait(DEBOUNCE_SECONDS)  # debounce bursts, same as VaultWatcher
            if self._stop.is_set():
                return
            self.status = "dispatching"
            try:
                rel_paths = [rel for p in sorted(relevant) if (rel := self._to_rel(p))]
                if rel_paths:
                    self._dispatch(rel_paths)
            finally:
                self.status = "running"

    def _dispatch(self, changed_paths: list[str]) -> None:
        watched = self._watched_tasks()
        if not watched:
            return
        from app.core import scheduler as sched

        if sched.LOOP is None or sched.LOOP.is_closed():
            return
        now = time.monotonic()
        for task_id, watch_path in watched:
            if not any(self._match(watch_path, p) for p in changed_paths):
                continue
            with self._lock:
                if task_id in self._running:
                    continue
                if now - self._last_fire.get(task_id, 0.0) < COOLDOWN_SECONDS:
                    continue
                self._last_fire[task_id] = now
                self._running.add(task_id)
            asyncio.run_coroutine_threadsafe(self._run_task(task_id), sched.LOOP)

    async def _run_task(self, task_id: int) -> None:
        from app.core import tasks as core

        try:
            result = await core.run_task(task_id, trigger="watch")
            log.info("watch-triggered task %s finished: %s", task_id, result.get("status"))
        except Exception:  # noqa: BLE001 - a failed trigger must not kill the watcher
            log.exception("watch-triggered task %s crashed", task_id)
        finally:
            with self._lock:
                self._running.discard(task_id)


watcher = TaskTriggerWatcher()
