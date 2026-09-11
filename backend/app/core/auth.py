"""Startup-generated API token for the local HTTP surface.

Every `/api/*` route and the `/mcp` server require this token. It reaches the
frontend as a `SameSite=Strict` cookie set by the middleware in `main.py`, so a
same-origin page (the browser on 127.0.0.1:8000, or the pywebview shell) needs
no JS change and subresource loads that cannot carry a header — `<img src>`,
`<audio src>`, `/api/backup/download/...` — still work. The vite dev server
hands the same token to the cross-origin page through its own middleware (see
`frontend/vite.config.ts`).

Threat model, stated honestly: this stops a web page in your browser from
reaching the local API (CSRF / DNS-rebinding) and stops other programs from
calling it by accident. It does **not** isolate you from another process
running as the same Windows user — that process can read `data/api_token` off
disk. Real same-user isolation needs OS-level credentials, which is out of
scope for a local-first tool.
"""
import logging
import os
import secrets as _secrets

from app.config import DATA_DIR

log = logging.getLogger(__name__)

TOKEN_FILE = DATA_DIR / "api_token"
COOKIE = "wb_token"
HEADER = "X-WB-Token"

# Paths that answer without a token. `/api/health` is the liveness probe the
# desktop shell uses before it decides a server is already running
# (`desktop.py:_health_ok`), so it must stay reachable pre-auth.
_PUBLIC = {"/api/health"}

_cached: str | None = None


def token() -> str:
    """The current token: `WB_API_TOKEN` if set, else a persisted random one.

    `WB_API_TOKEN` exists for the test suite and the smoke scripts, which start
    a real server and talk to it over HTTP — they must know the token up front
    instead of scraping it out of `data/api_token`.
    """
    global _cached
    if _cached is not None:
        return _cached

    env = (os.environ.get("WB_API_TOKEN") or "").strip()
    if env:
        _cached = env
        return _cached

    existing = ""
    try:
        existing = TOKEN_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        pass
    if not existing:
        existing = _secrets.token_urlsafe(32)
        try:
            tmp = TOKEN_FILE.with_name(TOKEN_FILE.name + ".tmp")
            tmp.write_text(existing, encoding="utf-8")
            tmp.replace(TOKEN_FILE)
        except OSError as e:  # noqa: BLE001 - a read-only data dir must not kill startup
            log.warning("could not persist api token to %s: %s", TOKEN_FILE, e)
    _cached = existing
    return _cached


def _eq(a: str, b: str) -> bool:
    try:
        return _secrets.compare_digest(a, b)
    except TypeError:  # a non-ASCII candidate makes compare_digest refuse
        return False


def request_ok(header: str | None, cookie: str | None) -> bool:
    """True when either channel carries the token. Header is what fetch uses;
    the cookie is the fallback for loads that cannot set one."""
    tok = token()
    return (bool(header) and _eq(header, tok)) or (bool(cookie) and _eq(cookie, tok))


def is_protected(path: str) -> bool:
    if path in _PUBLIC:
        return False
    if path == "/mcp" or path.startswith("/mcp/"):
        return True
    return path.startswith("/api/")
