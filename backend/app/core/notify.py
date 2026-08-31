"""Windows desktop toast notifications (ROADMAP V6.2).

winotify is an optional dependency — when unavailable (or not on Windows)
notifications degrade to a log line so callers never need to guard.
"""
import logging

log = logging.getLogger(__name__)


def desktop(title: str, body: str = "") -> None:
    try:
        from winotify import Notification

        Notification(app_id="AI Workbench", title=title[:120], msg=body[:300]).show()
    except Exception:  # noqa: BLE001 - notification is best-effort by design
        log.debug("desktop notification skipped: %s | %s", title, body)
