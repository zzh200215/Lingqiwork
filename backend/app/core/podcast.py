"""Notes → two-person podcast audio.

Turn a note (or a few) into a short host/guest dialogue: the LLM writes the
script as JSON turns, each turn is synthesized with a distinct edge-tts voice
(V10 stack, per-turn cache reused), then all segments are decoded via PyAV
(bundled with faster-whisper) and stitched — with breathing gaps — into one
24 kHz mono WAV under data/podcasts/. Metadata lives in index.json next to
the audio, so podcasts stay out of the vault and the RAG index.
"""
import asyncio
import json
import logging
import re
import wave
from datetime import datetime
from pathlib import Path

from app.config import DATA_DIR, VAULT_DIR
from app.core import ingest
from app.core.llm import ProviderInfo, stream_chat
from app.core import usage_ledger

log = logging.getLogger(__name__)

PODCAST_DIR = DATA_DIR / "podcasts"
RATE = 24000  # common denominator: edge-tts mp3 is 24 kHz, SAPI wav gets resampled
GAP_SEC = 0.4  # silence between turns
MAX_TURNS = 40
MAX_TURN_CHARS = 400
MAX_INPUT_CHARS = 15000
MAX_FILES = 5
SKIP_PREFIXES = ("clippings/", "digests/", "feeds/")

FILE_RE = re.compile(r"^pod-\d{8}-\d{6}-[0-9a-f]{6}\.wav$")
_ID_ALPHABET = "0123456789abcdef"

_SCRIPT_SYSTEM = (
    "你是一档中文知识播客的编剧。根据给定的笔记材料，写一段双人对话脚本：\n"
    "- host 是主持人：负责开场、串场、追问和结尾总结，口语自然；\n"
    "- guest 是嘉宾：基于笔记内容输出干货，可以引用材料里的具体事实，"
    "材料里没有的信息不要编造；\n"
    "- 每轮 1~4 句、短句为主，总轮数 12~18 轮，先开场引入再深入，最后 host 总结；\n"
    '只输出一个 JSON 对象，不要解释、不要代码块：\n'
    '{"turns": [{"speaker": "host", "text": "..."}, {"speaker": "guest", "text": "..."}]}'
)

_HOST_ALIASES = {"host", "主持人", "主播", "a", "甲"}
_GUEST_ALIASES = {"guest", "嘉宾", "b", "乙"}


def _index_path() -> Path:
    return PODCAST_DIR / "index.json"


def _load_index() -> list[dict]:
    p = _index_path()
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8")).get("podcasts", [])
    except (json.JSONDecodeError, OSError):
        return []


def _save_index(items: list[dict]) -> None:
    PODCAST_DIR.mkdir(parents=True, exist_ok=True)
    _index_path().write_text(
        json.dumps({"podcasts": items}, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def list_podcasts() -> list[dict]:
    return _load_index()


def _norm_speaker(raw: str) -> str:
    s = (raw or "").strip().lower()
    if s in _HOST_ALIASES:
        return "host"
    if s in _GUEST_ALIASES:
        return "guest"
    # anything unrecognised lands on the guest seat so the dialogue keeps two voices
    return "guest"


def _parse_script(raw: str) -> list[dict]:
    """Extract turns from the model output. Pure; raises ValueError on garbage.

    Accepts a bare array or {"turns": [...]}, with or without markdown fences.
    Normalises speaker aliases (主持人/A/甲 → host), drops empty turns, caps
    per-turn length and total turn count so one bad generation can't explode
    into an hour of audio.
    """
    if not raw or not raw.strip():
        raise ValueError("模型返回空脚本")
    from app.core.structured import clean_json

    blob = clean_json(raw.strip())
    if not blob:
        raise ValueError("模型输出里没有找到 JSON 脚本")
    try:
        data = json.loads(blob)
    except json.JSONDecodeError as e:
        raise ValueError(f"脚本 JSON 解析失败: {e}") from e

    turns_raw = data if isinstance(data, list) else (data or {}).get("turns")
    if not isinstance(turns_raw, list) or not turns_raw:
        raise ValueError("脚本里没有对话轮次")

    turns: list[dict] = []
    for t in turns_raw[:MAX_TURNS]:
        if not isinstance(t, dict):
            continue
        text = str(t.get("text") or "").strip()
        if not text:
            continue
        turns.append({"speaker": _norm_speaker(str(t.get("speaker") or "")), "text": text[:MAX_TURN_CHARS]})
    if not turns:
        raise ValueError("脚本对话轮次为空")
    return turns


def _script_prompt(blocks: list[tuple[str, str]]) -> str:
    body = "\n\n".join(f"### {rel}\n{text}" for rel, text in blocks)
    return f"请把下面的笔记材料改编成双人播客对话脚本。\n\n{body}"


async def _resolve_writer() -> tuple[ProviderInfo, str] | None:
    """(ProviderInfo, model) for the script writer; None when no provider is on.

    Test seam: monkeypatch me to run generation without a real provider.
    """
    from app.core.digest import _resolve_model_id

    model_id = _resolve_model_id()
    if not model_id:
        return None
    from app.routers.chat import resolve_model

    resolved = await resolve_model(model_id)
    p = resolved.provider
    return ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key), resolved.model


async def _llm_script(prompt: str, info: ProviderInfo, model: str) -> str:
    """Collect the full script text from the writer model. Test seam."""
    msgs = [
        {"role": "system", "content": _SCRIPT_SYSTEM},
        {"role": "user", "content": prompt},
    ]
    parts = [chunk async for chunk in stream_chat(info, model, msgs)]
    return "".join(parts).strip()


def _collect_notes(paths: list[str]) -> list[tuple[str, str]]:
    """Resolve vault-relative note paths → (rel, text) blocks. Raises ValueError."""
    if not paths:
        raise ValueError("没有指定笔记")
    blocks: list[tuple[str, str]] = []
    total = 0
    for rel in paths[:MAX_FILES]:
        rel = (rel or "").strip().lstrip("/\\")
        if not rel:
            continue
        p = (VAULT_DIR / rel).resolve()
        if not p.is_relative_to(VAULT_DIR) or not p.is_file():
            raise ValueError(f"笔记不存在: {rel}")
        if p.suffix != ".md" or p.relative_to(VAULT_DIR).as_posix().startswith(SKIP_PREFIXES):
            raise ValueError(f"不是可用的笔记文件: {rel}")
        text = ingest.parse_file(p)
        if not text.strip():
            continue
        text = text[:MAX_INPUT_CHARS - total] if total < MAX_INPUT_CHARS else ""
        if not text:
            break  # input budget exhausted
        total += len(text)
        blocks.append((rel, text))
    if not blocks:
        raise ValueError("笔记内容为空，无法生成播客")
    return blocks


async def _synth_turn(text: str, voice: str) -> Path:
    """One turn → cached audio file path (V10 stack, falls back to SAPI)."""
    from app.core import tts

    r = await tts.synthesize(text, voice, "edge")
    name = r["url"].rsplit("/", 1)[-1]
    return tts.TTS_DIR / name


def _decode_24k(path: Path) -> bytes:
    """Any audio file (mp3/wav) → raw s16 mono PCM at RATE, via PyAV."""
    import av

    with av.open(str(path)) as container:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
        out: list[bytes] = []
        for frame in container.decode(audio=0):
            for rf in resampler.resample(frame):
                out.append(rf.to_ndarray().reshape(-1).astype("<i2", copy=False).tobytes())
    return b"".join(out)


def _assemble_wav(segments: list[bytes], out: Path) -> float:
    """Concat PCM segments with silence gaps into a single WAV. Returns seconds."""
    gap = b"\x00\x00" * int(GAP_SEC * RATE)
    pcm = gap.join(segments) if segments else b""
    out.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)
    return len(pcm) / 2 / RATE


def _new_id() -> str:
    import random

    now = datetime.now().strftime("%Y%m%d-%H%M%S")
    tail = "".join(random.choice(_ID_ALPHABET) for _ in range(6))
    return f"pod-{now}-{tail}"


@usage_ledger.traced("podcast")
async def generate(
    paths: list[str], host_voice: str = "", guest_voice: str = "", title: str = ""
) -> dict:
    """Notes → dialogue script → per-turn TTS → single WAV + index entry."""
    blocks = _collect_notes(paths)
    return await generate_from_blocks(blocks, host_voice, guest_voice, title)


async def generate_from_blocks(
    blocks: list[tuple[str, str]],
    host_voice: str = "",
    guest_voice: str = "",
    title: str = "",
) -> dict:
    """Same pipeline over pre-collected (rel, text) blocks — lets callers
    podcast non-note sources (e.g. the daily digest) that _collect_notes
    would reject. Consumes the progress stream, returns the final entry."""
    final: dict = {}
    async for ev, data in generate_from_blocks_iter(blocks, host_voice, guest_voice, title):
        if ev == "done":
            final = data
    return final or {"ok": False, "error": "播客生成中途终止"}


@usage_ledger.traced("podcast")
async def generate_from_blocks_iter(
    blocks: list[tuple[str, str]],
    host_voice: str = "",
    guest_voice: str = "",
    title: str = "",
):
    """Progress-yielding variant of generate_from_blocks.

    Yields (event, data) pairs:
      ("stage", {"stage": "script"})
      ("stage", {"stage": "tts", "index": i, "total": n})   per turn
      ("stage", {"stage": "assemble"})
      ("done", entry)   entry["ok"] False carries "error"; terminal event
    """
    writer = await _resolve_writer()
    if not writer:
        yield "done", {"ok": False, "error": "没有已启用的 provider，无法生成播客脚本"}
        return
    info, model = writer

    yield "stage", {"stage": "script"}
    raw = await _llm_script(_script_prompt(blocks), info, model)
    try:
        turns = _parse_script(raw)
    except ValueError as e:
        yield "done", {"ok": False, "error": str(e)}
        return

    host = host_voice or "zh-CN-YunxiNeural"
    guest = guest_voice or "zh-CN-XiaoxiaoNeural"
    segments: list[bytes] = []
    for i, t in enumerate(turns, 1):
        yield "stage", {"stage": "tts", "index": i, "total": len(turns)}
        path = await _synth_turn(t["text"], host if t["speaker"] == "host" else guest)
        pcm = await asyncio.to_thread(_decode_24k, path)
        if pcm:
            segments.append(pcm)
    if not segments:
        yield "done", {"ok": False, "error": "语音合成失败，没有生成任何音频"}
        return

    yield "stage", {"stage": "assemble"}
    pid = _new_id()
    out = PODCAST_DIR / f"{pid}.wav"
    duration = await asyncio.to_thread(_assemble_wav, segments, out)

    entry = {
        "ok": True,
        "id": pid,
        "title": (title or "").strip() or Path(blocks[0][0]).stem,
        "sources": [rel for rel, _ in blocks],
        "turns": len(turns),
        "duration_sec": round(duration, 1),
        "file": out.name,
        "script": turns,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    items = [entry, *_load_index()]
    _save_index(items)
    log.info("podcast generated: %s (%d turns, %.1fs)", pid, len(turns), duration)
    yield "done", entry


async def from_digest(path: Path, title: str = "") -> dict:
    """Daily digest file → podcast episode. Best-effort helper for the
    digest scheduler hook; never raises for missing/empty input."""
    if not path.exists():
        return {"ok": False, "error": f"摘要文件不存在: {path.name}"}
    text = path.read_text(encoding="utf-8", errors="ignore").strip()
    if not text:
        return {"ok": False, "error": "摘要是空的，跳过播客生成"}
    try:
        rel = path.resolve().relative_to(VAULT_DIR.resolve()).as_posix()
    except ValueError:
        rel = f"digests/{path.name}"
    return await generate_from_blocks(
        [(rel, text)], title=(title or "").strip() or f"笔记简报 {path.stem}"
    )


def delete(pid: str) -> None:
    items = _load_index()
    keep = [e for e in items if e.get("id") != pid]
    if len(keep) == len(items):
        raise FileNotFoundError(pid)
    for e in items:
        if e.get("id") == pid:
            (PODCAST_DIR / e.get("file", "")).unlink(missing_ok=True)
    _save_index(keep)
