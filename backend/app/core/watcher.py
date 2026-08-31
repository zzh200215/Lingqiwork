"""Background vault watcher: debounce file events, reindex changed files."""
import logging
import threading
from pathlib import Path

from watchfiles import Change, watch

from app.config import VAULT_DIR
from app.core import ingest, indexer

log = logging.getLogger(__name__)

DEBOUNCE_SECONDS = 2.0


class VaultWatcher:
    def __init__(self, root: Path = VAULT_DIR):
        self.root = root
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.status = "stopped"  # stopped | running | indexing

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="vault-watcher", daemon=True)
        self._thread.start()
        self.status = "running"
        log.info("watching %s", self.root)

    def stop(self):
        self._stop.set()
        self.status = "stopped"

    def _run(self):
        for changes in watch(
            self.root,
            rust_timeout=500,
            stop_event=self._stop,
            recursive=True,
        ):
            relevant = {
                p
                for c, p in changes
                if c in (Change.added, Change.modified, Change.deleted) and self._is_relevant(p, c)
            }
            if not relevant:
                continue
            # debounce burst of events
            self._stop.wait(DEBOUNCE_SECONDS)
            if self._stop.is_set():
                return
            self.status = "indexing"
            try:
                for p in sorted(relevant):
                    path = Path(p)
                    try:
                        if not path.exists() or not path.is_file():
                            indexer.delete_file(path, self.root)
                        elif ingest.is_supported(path):
                            indexer.index_file(path, self.root)
                    except Exception:  # noqa: BLE001 - one bad file must not kill the loop
                        log.exception("failed to index %s", path)
            finally:
                self.status = "running"

    def _is_relevant(self, raw_path: str, change: Change) -> bool:
        path = Path(raw_path)
        if change == Change.deleted:
            return True  # removals handled regardless of extension (may be a pdf renamed to .tmp)
        return ingest.is_supported(path) and "__pycache__" not in path.parts and not path.name.startswith(".")


watcher = VaultWatcher()
