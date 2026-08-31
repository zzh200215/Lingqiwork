"""Full-context mode: replace chunks of short documents with the whole file.

Chunking is necessary for recall, but once a short document has been hit
there is no reason to answer from a fragment of it. When a retrieved
source's full text fits the budget, the chunk(s) are collapsed into one
whole-file block (Open WebUI "full context mode").
"""
import logging

from app.config import VAULT_DIR
from app.core import ingest
from app.core.prefs import load_config

log = logging.getLogger(__name__)

DEFAULT_MAX_CHARS = 4000


def enabled() -> bool:
    return bool(load_config().get("full_context", True))


def _max_chars() -> int:
    try:
        return max(500, int(load_config().get("full_context_max_chars", DEFAULT_MAX_CHARS)))
    except (TypeError, ValueError):
        return DEFAULT_MAX_CHARS


def expand(hits: list[dict]) -> list[dict]:
    """Collapse each short source's chunks into a single whole-file hit.

    Ordering follows each source's best-scoring hit. Anything that cannot be
    read or is too long passes through untouched.
    """
    if not hits:
        return hits
    budget = _max_chars()
    root = VAULT_DIR.resolve()
    whole: dict[str, str | None] = {}  # source -> full text (None = keep chunks)
    out: list[dict] = []
    seen: set[str] = set()

    for h in hits:
        src = h.get("source")
        if not src:
            out.append(h)
            continue
        if src not in whole:
            whole[src] = _read_whole(root, src, budget)
        text = whole[src]
        if text is None:
            out.append(h)
            continue
        if src in seen:  # already emitted the whole file for this source
            continue
        seen.add(src)
        out.append(
            {
                **h,
                "text": text,
                "chunk": None,
                "channels": [*h.get("channels", []), "full"],
            }
        )
    return out


def _read_whole(root, src: str, budget: int) -> str | None:
    p = (root / src).resolve()
    if not p.is_relative_to(root) or not p.is_file():
        return None
    try:
        if p.stat().st_size > budget * 4:  # cheap reject before parsing
            return None
        text = ingest.parse_file(p).strip()
    except Exception:  # noqa: BLE001 - never break retrieval
        log.debug("full-context read failed for %s", src, exc_info=True)
        return None
    if not text or len(text) > budget:
        return None
    return text
