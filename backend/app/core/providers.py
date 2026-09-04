"""Which model can we actually use right now — resolution plus health.

Two concerns that belong together, and one incident that forced the module into
existence. On 2026-09-04 `qwen3.7-plus`'s free quota was exhausted; it was the
first model of the first enabled provider, so *every* automated feature (daily
review nudge, weekly remediation, digest, greetings, automemory, graph extraction)
was talking to a dead model. Nothing in the UI said so, and a working model was
sitting second in the same list.

Before this module the picking rule was written three times — `pet._default_model_id`
(raw sqlite3), `digest._resolve_model_id` (raw sqlite3, identical) and
`ask._default_model` (async ORM, raises HTTPException). Those three now delegate
here, so "prefer a model that is known to work" only had to be implemented once.

Module level stays light on purpose: `pet` and `digest` reach this at startup, and
anything heavy here would take down all of FastAPI rather than one feature.
"""
import logging
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)

HEALTH_KEY = "provider_health"  # prefs: {"<provider>/<model>": {ok, code, message, at, ms}}
PROBE_TIMEOUT = 30.0  # seconds per model
PROBE_PROMPT = "hi"  # keep it minimal: a probe should cost ~nothing
HEALTH_TTL = timedelta(hours=72)  # older than this is "unknown", never "broken"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def health() -> dict[str, dict]:
    """Cached probe results, keyed `provider/model`. Never raises."""
    try:
        from app.core.prefs import load_config

        data = load_config().get(HEALTH_KEY) or {}
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        log.debug("provider health read failed", exc_info=True)
        return {}


def is_unhealthy(model_id: str, cache: dict | None = None) -> bool:
    """True only when a RECENT probe failed.

    Unknown is deliberately not unhealthy: a model nobody has probed must stay
    usable, and stale results must not quietly disqualify a model that has since
    been topped up.
    """
    row = (cache if cache is not None else health()).get(model_id)
    if not isinstance(row, dict) or row.get("ok", True):
        return False
    try:
        at = datetime.fromisoformat(str(row.get("at") or ""))
    except ValueError:
        return False
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return _now() - at < HEALTH_TTL


def enabled_models() -> list[str]:
    """`provider/model` for every enabled provider, in configured order.

    Raw sqlite3 rather than the ORM because the sync callers (`pet`, `digest`) run
    outside a session — that is why the two originals were written this way too.
    Never raises: a missing or corrupt DB simply means no models.
    """
    import json
    import sqlite3

    from app.config import settings

    try:
        conn = sqlite3.connect(settings.db_path)
        try:
            rows = conn.execute(
                "SELECT name, models FROM provider_configs WHERE enabled = 1 ORDER BY id"
            ).fetchall()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        log.debug("enabled_models query failed", exc_info=True)
        return []
    out: list[str] = []
    for name, models in rows:
        try:
            for m in json.loads(models or "[]"):
                if m:
                    out.append(f"{name}/{m}")
        except (TypeError, ValueError):
            continue
    return out


def default_model_id() -> str | None:
    """First enabled provider's first model that is not known-broken.

    When every candidate has failed a recent probe it returns the first one anyway
    rather than None: None makes callers report "没有已启用的 provider", which is a
    lie that hides the real 403. Better to attempt the call and surface the true
    upstream error.
    """
    candidates = enabled_models()
    if not candidates:
        return None
    cache = health()
    for mid in candidates:
        if not is_unhealthy(mid, cache):
            return mid
    log.warning("every configured model failed a recent probe; falling back to %s", candidates[0])
    return candidates[0]


# ---------- probing ----------


def error_code(e: BaseException) -> str:
    """Short, greppable label for a provider error.

    For the incident that started this module it yields
    "403 AllocationQuota.FreeTierOnly" — which is exactly the string you want to
    see next to a model name in the settings page. Bare "403" would not: it does
    not distinguish an exhausted quota from a bad key.

    The upstream code is read from `e.body` when the SDK populated it, and parsed
    out of the message otherwise — for a *streaming* request the openai SDK raises
    along a path that leaves `.body` unset while still rendering the whole payload
    into `str(e)`, which is what actually happened here.
    """
    import re

    status = getattr(e, "status_code", None) or getattr(
        getattr(e, "response", None), "status_code", None
    )
    code = ""
    body = getattr(e, "body", None)
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            code = str(err.get("code") or err.get("type") or "")
    if not code:
        m = re.search(r"['\"]code['\"]\s*:\s*['\"]([\w.\-]+)['\"]", str(e))
        if m:
            code = m.group(1)
    label = " ".join(str(x) for x in (status, code) if x).strip()
    return label or type(e).__name__


async def probe_model(kind: str, base_url: str, api_key: str, model: str) -> dict:
    """One minimal request. -> {ok, code, message, ms}. Never raises.

    Goes through `llm.stream_chat` rather than a hand-rolled HTTP call so the probe
    exercises the same auth and protocol path the real features use — a probe that
    passes while chat fails would be worse than no probe. One token back is proof
    enough, so the stream is closed immediately and the call costs ~nothing.
    """
    import asyncio
    import time

    from app.core.llm import ProviderInfo, stream_chat

    info = ProviderInfo(kind=kind, base_url=base_url, api_key=api_key)
    t0 = time.time()
    agen = None

    def _clean(msg: str) -> str:
        # the message is stored in config.json and returned to the browser, so scrub
        # the key even though today's SDKs only render the response body: an upstream
        # that echoed the credential back would otherwise leak it into a file
        return (msg.replace(api_key, "***") if api_key else msg)[:400]

    try:
        async with asyncio.timeout(PROBE_TIMEOUT):
            agen = stream_chat(info, model, [{"role": "user", "content": PROBE_PROMPT}])
            async for _ in agen:
                break
        return {"ok": True, "code": "", "message": "", "ms": int((time.time() - t0) * 1000)}
    except TimeoutError:
        return {
            "ok": False,
            "code": "timeout",
            "message": f"{PROBE_TIMEOUT:.0f}s 内没有响应",
            "ms": int((time.time() - t0) * 1000),
        }
    except Exception as e:  # noqa: BLE001 - the point of a probe is to report failures
        return {
            "ok": False,
            "code": error_code(e),
            "message": _clean(str(e)),
            "ms": int((time.time() - t0) * 1000),
        }
    finally:
        if agen is not None:
            try:
                await agen.aclose()
            except Exception:  # noqa: BLE001
                pass


def record_health(results: dict[str, dict]) -> dict[str, dict]:
    """Merge probe results into the cached health map and persist it."""
    from app.core.prefs import load_config, save_config

    at = _now().astimezone().isoformat(timespec="seconds")
    merged = {**(load_config().get(HEALTH_KEY) or {})}
    for mid, r in results.items():
        merged[mid] = {**r, "at": at}
    save_config({HEALTH_KEY: merged})
    return merged
