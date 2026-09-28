"""Spaced-repetition cards: SM-2 scheduling, AI card generation, weak-source rollup.

Three parts, deliberately in this order:

1. `schedule()` — a pure SM-2 variant. No clock, no randomness, no I/O: it takes
   the current state plus a grade and returns the next state as a *seconds
   offset*, so every scheduling rule is unit-testable without mocking time.
2. Card generation — prompt assembly and JSON parsing are pure functions too
   (same discipline as `routers/notes.py:_compose_prompt`); only `generate_iter`
   touches an LLM, and it yields (stage, data) progress like `core/podcast.py`.
3. DB access + the proactive layer (daily reminder, weekly remediation).

Everything heavy (llm / embedder / indexer / ingest / chromadb) is imported
INSIDE functions on purpose: this module is imported at app startup through
`routers/cards.py`, and a module-level failure here would take down all of
FastAPI, not just review. Same pattern as `routers/notes.py:250`, `core/pet.py`.
"""
import json
import logging
import random
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from app.core import usage_ledger

log = logging.getLogger(__name__)

# ---------- SM-2 ----------

LEARNING_AGAIN_SEC = 600  # 答错 → 10 分钟后重来
GRADUATE_INTERVAL = 1.0  # 天：首次答对
SECOND_INTERVAL = 6.0  # 天：第二次答对
MIN_EASE, MAX_EASE = 1.30, 2.80
EASE_DELTA = {1: -0.20, 2: -0.15, 3: 0.0, 4: +0.10}
GRADE_FACTOR = {2: 0.6, 3: 1.0, 4: 1.3}
MAX_INTERVAL = 365.0
FUZZ_MIN_DAYS = 3.0  # 低于此不加抖动
FUZZ_RATIO = 0.05
LEECH_LAPSES = 8  # 到此自动搁置
SESSION_REQUEUE_SEC = 1200  # due_seconds 小于此 → 前端本节内重排
# 「成熟」= 间隔已经拉到三周以上（`stats()` 与 PLAN2 的地图卡片摘要共用这一条）。
# 抽成常量是因为它此前是散在两处的一个字面量 21 —— 同一个词在两处必须是一个意思。
MATURE_DAYS = 21.0

KINDS = ("concept", "cloze", "scenario", "debug")

# 模型可能用中文或近义词回答 kind，一律归一；认不出的落 concept
_KIND_ALIASES = {
    "概念": "concept", "辨析": "concept", "定义": "concept",
    "填空": "cloze", "代码填空": "cloze", "cloze_deletion": "cloze",
    "情景": "scenario", "场景": "scenario", "情境": "scenario",
    "调试": "debug", "排错": "debug", "debugging": "debug", "bug": "debug",
}


@dataclass(frozen=True)
class Sched:
    """Next scheduling state. `due_seconds` is an offset from "now", not a time.

    Keeping it an offset is what makes `schedule()` clock-free and therefore
    testable with plain integer assertions; the caller adds it to utcnow().
    """

    interval_days: float
    ease: float
    reps: int
    lapses: int
    due_seconds: int
    lapsed: bool  # this answer was a lapse (a graduated card forgotten)


def schedule(interval_days: float, ease: float, reps: int, lapses: int, grade: int) -> Sched:
    """SM-2 variant. grade: 1 重来 | 2 困难 | 3 良好 | 4 简单.

    Pure function. Raises ValueError on an out-of-range grade — a bad grade is a
    caller bug (or a stray keypress), and silently clamping it would corrupt the
    schedule invisibly.
    """
    if grade not in (1, 2, 3, 4):
        raise ValueError(f"grade 必须是 1-4，收到 {grade!r}")

    if grade == 1:
        # forgotten: back to the front of the queue, interval reset.
        # Ease drops ONLY on a real lapse (a graduated card forgotten). A
        # brand-new card fumbled mid-learning is not a lapse, and penalizing
        # its ease would permanently handicap a good card for one rough pass.
        ease = _clamp_ease(ease + EASE_DELTA[1]) if reps > 0 else ease
        return Sched(
            interval_days=0.0,
            ease=ease,
            reps=0,
            lapses=lapses + (1 if reps > 0 else 0),
            due_seconds=LEARNING_AGAIN_SEC,
            lapsed=reps > 0,
        )

    ease = _clamp_ease(ease + EASE_DELTA[grade])
    if reps == 0:
        nxt = GRADUATE_INTERVAL
    elif reps == 1:
        nxt = SECOND_INTERVAL
    else:
        nxt = interval_days * ease * GRADE_FACTOR[grade]
        # strictly increasing: round(1 * 1.2) == 1 would pin a card at one day
        nxt = max(nxt, interval_days + 1.0)
    nxt = min(nxt, MAX_INTERVAL)
    return Sched(
        interval_days=nxt,
        ease=ease,
        reps=reps + 1,
        lapses=lapses,
        due_seconds=int(round(nxt * 86400)),
        lapsed=False,
    )


def _clamp_ease(v: float) -> float:
    return max(MIN_EASE, min(MAX_EASE, v))


def fuzz_interval(days: float, rnd: random.Random | None = None) -> float:
    """±5% jitter on intervals >= 3 days so a batch made the same day spreads out.

    Kept out of `schedule()` so that one stays deterministic and pure.
    """
    if days < FUZZ_MIN_DAYS:
        return days
    r = rnd or random
    return round(days * (1.0 + r.uniform(-FUZZ_RATIO, FUZZ_RATIO)), 2)


# ---------- 出卡 ----------

MAX_INPUT_CHARS = 15000  # 与 podcast 输入上限一致：这是喂给模型的预算
# 面板是给人读和划词的，不是 prompt，所以另设一个大得多的上限。实测 core/cards.py
# 有 45k 字——按 15000 截会让一个源码文件三分之二的内容根本选不到。
PANE_MAX_CHARS = 60000
MIN_INPUT_CHARS = 80  # 太短的文本出不了有意义的卡
MAX_CARDS = 20
DEFAULT_CARDS = 8
MAX_FRONT_CHARS = 400
MAX_BACK_CHARS = 1200

_GEN_SYSTEM = (
    "你负责把技术材料改写成间隔复习卡片。目标是「做得出来」而不是「背得出来」："
    "优先考具体判断和动手做法，不要考定义背诵。\n"
    "四种类型，按材料实际内容选，不必凑齐，优先出 scenario 和 debug：\n"
    "- scenario：给现象问原因，或给需求问做法。front 描述具体情境，back 给做法与理由。\n"
    "- debug：给一段有问题的代码/配置/报错，问错在哪、怎么改。"
    "back 必须点明根因，不能只贴改后的代码。\n"
    "- cloze：代码/命令/配置填空。front 用 ____ 标出要填的部分，一张卡只挖一处；"
    "back 给完整正确写法并补一句为什么是它。\n"
    "- concept：概念辨析。问区别、边界、代价。"
    "不要问「X 是什么」这种照抄原文就能答的。\n"
    "硬要求：\n"
    "① 只用材料里出现过的信息，材料没写的一律不编。材料里的实测数字、报错原文、"
    "踩坑结论是最好的素材，优先用它们。\n"
    "② 一张卡只考一件事。答案是一串清单的，拆成多张。\n"
    "③ front 不超过 300 字，back 不超过 500 字；代码用 ``` 围起来。\n"
    "④ front 必须自包含：不能出现「上文提到的」「前面那个方法」这类指代，"
    "因为复习时看不到材料。\n"
    "⑤ topic 给一个简短的中文或英文小写主题词（如 python / sqlite / 检索）。\n"
    "⑥ excerpt 摘 30 字以内的原文片段，说明这张卡的依据。\n"
    '只输出一个 JSON 数组，不要解释、不要用代码块包裹整个数组：\n'
    '[{"kind":"debug","front":"...","back":"...","hint":"","topic":"python","excerpt":"..."}]\n'
    "没有值得出卡的内容就输出 []。"
)


# `:` is illegal in Windows filenames, so these two schemes can never shadow a
# real vault-relative path. Deliberately NOT reusing the indexer's "repos/" /
# "dirs/" prefixes (indexer.py:35-36): with those, a vault subdirectory happening
# to be named repos/ would be silently hijacked. `Card.source` does not need to
# equal the indexer's source id — it is only used for the weak-source rollup,
# `existing_fronts` grouping and the vault deep-link, none of which require it.
EXTERNAL_SCHEMES = ("repo:", "dir:")
MAX_MATERIAL_BYTES = 500_000  # same order as dirs.MAX_FILE_BYTES; bigger isn't human-readable


def _external_root(scheme: str, name: str):
    """-> Path of the git clone or the registered folder. Raises ValueError."""
    from pathlib import Path

    if scheme == "repo:":
        from app.core import repos

        if not repos.NAME_RE.match(name):
            raise ValueError(f"非法仓库名：{name}")
        root = (repos.REPOS_DIR / name).resolve()
        if not root.is_dir():
            raise ValueError(f"没有这个仓库：{name}（先在知识库页克隆）")
        return root

    from app.core import dirs

    entry = next((d for d in dirs.list_dirs() if d.get("name") == name), None)
    if entry is None:
        raise ValueError(f"没有这个目录：{name}（先在知识库页注册）")
    root = Path(entry.get("path") or "").expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"目录不在了：{root}")
    return root


def spec_from_indexer_source(source: str) -> str:
    """indexer source id -> carding spec. "" when it cannot be carded.

    The indexer namespaces external material as "repos/<name>/<rel>" and
    "dirs/<name>/<rel>" (indexer.py:35-36), while the carding entries use
    "repo:" / "dir:" — see EXTERNAL_SCHEMES for why the two namings differ on
    purpose. Vault-relative paths pass through unchanged. Both directions live
    here because the source picker and the retrieval search both need them.
    """
    for prefix, scheme in (("repos/", "repo:"), ("dirs/", "dir:")):
        if source.startswith(prefix):
            rest = source[len(prefix) :]
            return scheme + rest if "/" in rest else ""  # bare "repos/<name>" is not a file
    return source


def indexer_source_from_spec(spec: str) -> str:
    """The reverse of `spec_from_indexer_source`."""
    for scheme, prefix in (("repo:", "repos/"), ("dir:", "dirs/")):
        if spec.startswith(scheme):
            return prefix + spec[len(scheme) :]
    return spec


def _collect_external(spec: str, max_chars: int = MAX_INPUT_CHARS) -> tuple[str, str, str]:
    """"repo:<name>/<rel>" or "dir:<name>/<rel>" -> (source, label, material)."""
    from app.core import ingest

    scheme = next(s for s in EXTERNAL_SCHEMES if spec.startswith(s))
    name, _, rel = spec[len(scheme) :].strip().lstrip("/\\").partition("/")
    if not name or not rel:
        raise ValueError(f"来源格式应为 {scheme}名称/文件路径")
    root = _external_root(scheme, name)
    p = (root / rel).resolve()
    if not p.is_relative_to(root):
        raise ValueError("路径越出该来源的根目录")
    if not p.is_file():
        raise ValueError(f"找不到文件：{rel}")
    try:
        if p.stat().st_size > MAX_MATERIAL_BYTES:
            raise ValueError(f"文件太大（超过 {MAX_MATERIAL_BYTES // 1000}KB）")
    except OSError as e:
        raise ValueError(f"读不了这个文件：{e}") from e
    material = (ingest.parse_file(p) or "").strip()[:max_chars]
    if len(material) < MIN_INPUT_CHARS:
        raise ValueError("这个文件内容太短，出不了卡")
    source = f"{scheme}{name}/{p.relative_to(root).as_posix()}"
    return source, source, material


def collect_material(
    source_path: str = "", text: str = "", max_chars: int = MAX_INPUT_CHARS
) -> tuple[str, str, str]:
    """-> (source_rel, source_label, material). Filesystem only, no DB.

    Exactly one of source_path / text must be given. Three kinds of source_path:
    a vault-relative path, or a `repo:`/`dir:` spec for indexed material outside
    the vault. The `text` entry exists for everything with no file at all —
    A file at the repo root would never pass the containment check.

    `max_chars` defaults to the model's input budget; the read-only pane passes
    PANE_MAX_CHARS instead, because a human selecting a span is not a prompt.
    Raises ValueError.
    """
    has_path, has_text = bool((source_path or "").strip()), bool((text or "").strip())
    if has_path == has_text:
        raise ValueError("source_path 与 text 必须给且只给一个")

    if has_text:
        material = text.strip()[:max_chars]
        if len(material) < MIN_INPUT_CHARS:
            raise ValueError(f"文本太短（至少 {MIN_INPUT_CHARS} 字）")
        return "", "粘贴文本", material

    spec = source_path.strip()
    if spec.startswith(EXTERNAL_SCHEMES):
        return _collect_external(spec, max_chars)

    from app.config import VAULT_DIR
    from app.core import ingest

    root = VAULT_DIR.resolve()
    rel = spec.lstrip("/\\")
    p = (root / rel).resolve()
    if not p.is_relative_to(root):
        raise ValueError("路径越出 vault 目录")
    if not p.is_file():
        raise ValueError(f"找不到文件：{rel}")
    material = (ingest.parse_file(p) or "").strip()[:max_chars]
    if len(material) < MIN_INPUT_CHARS:
        raise ValueError("这篇内容太短，出不了卡")
    return p.relative_to(root).as_posix(), p.relative_to(root).as_posix(), material


# ---------- 划词挖空（手工建卡，零 LLM） ----------

CLOZE_BLANK = "____"
CLOZE_MAX_SELECTION = 200  # 选超过这么多字就不是填空了
CLOZE_MIN_CONTEXT = 15  # 挖完剩下的线索少于这么多字，这张卡答不了
_BLANK_LINE = re.compile(r"\n[ \t\r]*\n")  # 段落分隔，容忍 \r 和行内空白
_FENCE = re.compile(r"^[ \t]*(?:`{3,}|~{3,})", re.M)


def _fence_bounds(text: str, start: int, end: int) -> tuple[int, int] | None:
    """If the span sits inside a ``` fenced block, the whole block's [lo, hi)."""
    marks = list(_FENCE.finditer(text))
    for i in range(0, len(marks) - 1, 2):  # markers pair up open/close in order
        lo = marks[i].start()
        nl = text.find("\n", marks[i + 1].end())
        hi = len(text) if nl < 0 else nl
        if lo <= start and end <= hi:
            return lo, hi
    return None


def _block_bounds(text: str, start: int, end: int) -> tuple[int, int]:
    """The span's containing block: a whole fenced block, else the paragraph."""
    fence = _fence_bounds(text, start, end)
    if fence:
        return fence
    lo = 0
    for m in _BLANK_LINE.finditer(text, 0, start):
        lo = m.end()
    m = _BLANK_LINE.search(text, end)
    return lo, m.start() if m else len(text)


def _line_bounds(text: str, start: int, end: int) -> tuple[int, int]:
    nl = text.find("\n", end)
    return text.rfind("\n", 0, start) + 1, len(text) if nl < 0 else nl


def make_cloze(text: str, start: int, end: int) -> dict | None:
    """Turn text[start:end] into a cloze draft. Pure — no model, no network.

    `front` is the span's containing block (a fenced code block whole, otherwise
    the paragraph) with the selection replaced by ____. Too long a block falls
    back to the containing line, and then to a window sized so the result always
    fits MAX_FRONT_CHARS.

    Returns None rather than raising in the three cases where the card would be
    worthless: nothing selected; more than CLOZE_MAX_SELECTION chars selected
    (that is not a blank); or less than CLOZE_MIN_CONTEXT chars of cue left after
    blanking, which is a card you cannot answer. Better no card than a bad one —
    one unanswerable card is enough to stop trusting the queue.
    """
    if not text or start < 0 or end > len(text) or start >= end:
        return None
    answer = text[start:end].strip()
    if not answer or len(answer) > CLOZE_MAX_SELECTION:
        return None

    block = _block_bounds(text, start, end)
    half = max(0, MAX_FRONT_CHARS - len(CLOZE_BLANK)) // 2  # window budget fits by construction
    front = ""
    for lo, hi in (
        block,
        _line_bounds(text, start, end),
        (max(0, start - half), min(len(text), end + half)),
    ):
        front = (text[lo:start] + CLOZE_BLANK + text[end:hi]).strip()
        if len(front) <= MAX_FRONT_CHARS:
            break
    if len(front.replace(CLOZE_BLANK, "").strip()) < CLOZE_MIN_CONTEXT:
        return None
    return {
        "kind": "cloze",
        "front": front[:MAX_FRONT_CHARS],
        "back": answer[:MAX_BACK_CHARS],
        "hint": "",
        "topic": "",
        "excerpt": text[block[0] : block[1]].strip()[:2000],
        "origin": "manual",
    }


def compose_gen_prompt(
    material: str, label: str, count: int, kinds: list[str] | None = None, focus: str = ""
) -> tuple[str, str]:
    """-> (system, user). Pure — no I/O, no model — so prompt shape is unit-testable.

    `focus` 非空 = **只围绕这一点出卡**（材料消化后「按点出卡」用它）：材料照给，好让模型
    有上下文，但明说只要跟这一点有关的卡。空 = 照旧，整份材料随便出。

    Raises ValueError on an unknown kind or a non-positive count.
    """
    if count <= 0:
        raise ValueError("count 必须为正")
    count = min(count, MAX_CARDS)
    system = _GEN_SYSTEM
    if kinds:
        bad = [k for k in kinds if k not in KINDS]
        if bad:
            raise ValueError(f"未知卡型：{', '.join(bad)}")
        system = f"{system}\n这次只出以下类型：{'、'.join(kinds)}。"
    focus = (focus or "").strip()[:200]
    if focus:
        system = (
            f"{system}\n这次**只围绕这一点**出卡：{focus}。"
            "材料里跟它无关的内容一律不要出——每一张卡都必须落在这一个点上。"
        )
    user = (
        f"材料来源：{label}\n请出 {count} 张卡片。\n\n---\n{material[:MAX_INPUT_CHARS]}"
    )
    return system, user


def parse_cards(raw: str) -> tuple[list[dict], int]:
    """Model output -> (valid card dicts, dropped count).

    Accepts a bare array or {"cards": [...]}, fenced or not. Raises ValueError
    when nothing usable comes back — unlike the background jobs, card generation
    is a foreground action the user is waiting on, so a silent empty result would
    just look broken. Individual malformed cards are skipped, not fatal.
    """
    text = (raw or "").strip()
    if not text:
        raise ValueError("模型返回空内容")
    m = re.search(r"[\[{].*[\]}]", text, re.S)
    if not m:
        raise ValueError("模型没有返回 JSON")
    blob = m.group(0)
    try:
        data = json.loads(blob)
    except json.JSONDecodeError:
        # trailing commas are by far the most common single defect in LLM JSON
        try:
            data = json.loads(re.sub(r",\s*([\]}])", r"\1", blob))
        except json.JSONDecodeError as e:
            raise ValueError(f"JSON 解析失败：{e}") from e

    if isinstance(data, dict):
        for key in ("cards", "items", "data"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if not isinstance(data, list):
        raise ValueError("模型返回的不是数组")

    out: list[dict] = []
    dropped = 0
    for item in data:
        if not isinstance(item, dict):
            continue
        front = str(item.get("front") or "").strip()
        back = str(item.get("back") or "").strip()
        if not front or not back:
            continue
        # too long is DROPPED, not truncated: a truncated answer is a wrong
        # answer, and a wrong answer in a review queue is worse than no card
        if len(front) > MAX_FRONT_CHARS or len(back) > MAX_BACK_CHARS:
            dropped += 1
            continue
        kind = str(item.get("kind") or "").strip().lower()
        kind = _KIND_ALIASES.get(kind, kind if kind in KINDS else "concept")
        out.append(
            {
                "kind": kind,
                "front": front,
                "back": back,
                "hint": str(item.get("hint") or "").strip()[:300],
                "topic": str(item.get("topic") or "").strip().lower()[:100],
                "excerpt": str(item.get("excerpt") or "").strip()[:300],
            }
        )
        if len(out) >= MAX_CARDS:
            break
    if not out:
        raise ValueError("没有解析出可用的卡片")
    return out, dropped


# ---------- 去重 ----------

DEDUP_SIMILARITY = 0.95  # 比 memory 的 0.92 高：卡片 front 更长更模板化，同源余弦天然偏高
DEDUP_SCAN_CAP = 1500  # 有界扫描（照 kg.SCAN_CAP 的先例）

# card id -> (front, vector); avoids re-embedding unchanged cards
_vec_cache: dict[int, tuple[str, list[float]]] = {}


async def _embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch in a thread (CPU-bound). Test seam: monkeypatch me."""
    import asyncio

    from app.core import embedder

    return await asyncio.to_thread(embedder.embed, texts)


def _cosine(a: list[float], b: list[float]) -> float:
    import math

    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


async def find_duplicates(
    candidates: list[dict], existing: list[tuple[int, str]]
) -> tuple[list[dict], bool]:
    """Mark near-duplicate candidates in place-ish; returns (candidates, semantic_ok).

    Only `front` is compared: the question is "don't ask me the same thing twice",
    and that lives in the front. Same front + different back is a conflict you
    WANT to see; same back + different front is a good thing (multiple angles).

    Never raises. If embedding is unavailable we fall back to exact string
    matching and report semantic_ok=False so the UI can say so honestly, because
    silently skipping dedup would look identical to dedup finding nothing.
    """
    for c in candidates:
        c.setdefault("duplicate_of", None)
        c.setdefault("similarity", None)

    seen: dict[str, int] = {}
    for cid, front in existing:
        seen.setdefault(front.strip(), cid)
    batch_seen: set[str] = set()
    for c in candidates:  # exact matches first — free and always available
        key = c["front"].strip()
        hit = seen.get(key)
        if hit is not None:
            c["duplicate_of"], c["similarity"] = hit, 1.0
        elif key in batch_seen:
            c["duplicate_of"], c["similarity"] = -1, 1.0  # -1 = 同批内重复
        batch_seen.add(key)

    pool = existing[-DEDUP_SCAN_CAP:]
    try:
        cand_vecs = await _embed_texts([c["front"] for c in candidates])
        miss = [(i, f) for i, f in pool if i not in _vec_cache or _vec_cache[i][0] != f]
        if miss:
            for (i, f), v in zip(miss, await _embed_texts([f for _, f in miss])):
                _vec_cache[i] = (f, v)
    except Exception:  # noqa: BLE001 - dedup must never block card generation
        log.warning("card dedup embedding failed, exact-match only", exc_info=True)
        return candidates, False

    for n, (c, cv) in enumerate(zip(candidates, cand_vecs)):
        if c["duplicate_of"] is not None:
            continue
        best_id, best = None, 0.0
        for i, _f in pool:
            cached = _vec_cache.get(i)
            if not cached:
                continue
            s = _cosine(cv, cached[1])
            if s > best:
                best_id, best = i, s
        # also compare against earlier cards in this same batch
        for prev in range(n):
            s = _cosine(cv, cand_vecs[prev])
            if s > best:
                best_id, best = -1, s
        if best >= DEDUP_SIMILARITY:
            c["duplicate_of"], c["similarity"] = best_id, round(best, 3)
    return candidates, True


# ---------- 生成（带进度） ----------


@usage_ledger.traced("cards")
async def generate_iter(
    source_path: str = "",
    text: str = "",
    count: int = DEFAULT_CARDS,
    kinds: list[str] | None = None,
    model_id: str = "",
    focus: str = "",
):
    """Yield (stage, data) progress, ending on a terminal ("done", {...}).

    `focus` 非空 = 只围绕这一点出卡（材料消化后「按点出卡」）；见 `compose_gen_prompt`。

    Same shape as `core/podcast.generate_from_blocks` so the SSE endpoint stays a
    thin wrapper. Input validation happens BEFORE the caller opens the stream —
    see `routers/cards.py`; once an SSE response starts there is no way to set a
    status code, a lesson already baked into smoke_podcast_stream.py.
    """
    from app.core.llm import ProviderInfo, stream_chat
    from app.core.pet import _default_model_id
    from app.routers.chat import resolve_model

    yield "reading", {}
    source, label, material = collect_material(source_path=source_path, text=text)
    system, user = compose_gen_prompt(material, label, count, kinds, focus)

    mid = (model_id or "").strip() or (_default_model_id() or "")
    if not mid:
        yield "done", {"ok": False, "error": "没有已启用的 provider，请先在设置页配置模型"}
        return

    yield "drafting", {"model_id": mid}
    resolved = await resolve_model(mid)
    p = resolved.provider
    info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)
    parts: list[str] = []
    async for delta in stream_chat(
        info,
        resolved.model,
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
    ):
        parts.append(delta)

    cards, dropped = parse_cards("".join(parts))

    yield "dedup", {"total": len(cards)}
    existing = await existing_fronts(source)
    cards, semantic_ok = await find_duplicates(cards, existing)

    yield "done", {
        "ok": True,
        "cards": cards,
        "dropped": dropped,
        "dedup": "ok" if semantic_ok else "skipped",
        "source": source,
        "source_label": label,
        "model_id": mid,
    }


# ---------- DB ----------


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def existing_fronts(source: str = "") -> list[tuple[int, str]]:
    """(id, front) of every existing card, same-source ones LAST.

    Ordering matters: `find_duplicates` keeps only the tail of this list, and
    same-source cards are the likely duplicates, so they must not be the ones
    sliced away.
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card

    async with SessionLocal() as db:
        rows = (await db.execute(select(Card.id, Card.source, Card.front))).all()
    others = [(r[0], r[2] or "") for r in rows if not source or r[1] != source]
    mine = [(r[0], r[2] or "") for r in rows if source and r[1] == source]
    return others + mine


async def source_card_counts() -> dict[str, int]:
    """{source: how many cards already came from it}.

    Answers "have I carded this file already?" — after indexing a 200-file repo,
    without this you re-read the same file over and over. Pasted-text cards land
    under the "" key, which is correct: they have no re-openable source.
    """
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import Card

    async with SessionLocal() as db:
        rows = (
            await db.execute(select(Card.source, func.count(Card.id)).group_by(Card.source))
        ).all()
    return {(r[0] or ""): int(r[1]) for r in rows}


async def save_cards(
    cards: list[dict], source: str = "", source_label: str = "", model_id: str = ""
) -> dict:
    """Insert reviewed candidates as new cards. Skips exact duplicates."""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card

    added, skipped, ids, new_rows = 0, 0, [], []
    now = utcnow()
    async with SessionLocal() as db:
        known = {
            (f or "").strip()
            for f in (await db.execute(select(Card.front))).scalars().all()
        }
        for c in cards:
            front = str(c.get("front") or "").strip()
            back = str(c.get("back") or "").strip()
            if not front or not back:
                skipped += 1
                continue
            if len(front) > MAX_FRONT_CHARS or len(back) > MAX_BACK_CHARS:
                skipped += 1
                continue
            if front in known:
                skipped += 1
                continue
            kind = str(c.get("kind") or "concept")
            row = Card(
                kind=kind if kind in KINDS else "concept",
                front=front,
                back=back,
                hint=str(c.get("hint") or "")[:300],
                source=source[:500],
                source_label=(source_label or source or "手工")[:200],
                source_excerpt=str(c.get("excerpt") or "")[:2000],
                topic=str(c.get("topic") or "")[:100],
                origin=str(c.get("origin") or "ai"),
                model_id=model_id[:100],
                due=now,
            )
            db.add(row)
            known.add(front)
            added += 1
            new_rows.append(row)
        await db.commit()
        # id 只从本次插入的行对象取（commit 时回填主键）。不要 SELECT 回取：并发插入
        # 时会取到别人刚插的行，ids 与内容错位。
        ids = [r.id for r in new_rows]
    await _announce_cards_made(added, source, source_label)
    return {"added": added, "skipped": skipped, "ids": list(ids)}


async def _announce_cards_made(added: int, source: str, source_label: str) -> None:
    """出卡完成 → 零柒说一句（M2 · PLAN §3 G2）。

    **写盘的人说话**（与 `pet.note_output` 同一个 pattern），数是 `added`（去重之后
    真加进去的张数）。best-effort：一句台词绝不拖累落库。
    """
    if added <= 0:
        return
    try:
        from app.core import pet

        pet.emit("cards_made", name=(source_label or source or "材料")[:60], count=added)
    except Exception:  # noqa: BLE001
        log.debug("pet cards_made line failed", exc_info=True)


def _caps() -> tuple[int, int]:
    from app.core.prefs import load_config

    cfg = load_config()
    return (
        max(0, int(cfg.get("cards_new_per_day", 20) or 0)),
        max(0, int(cfg.get("cards_review_per_day", 200) or 0)),
    )


async def _today_counts(db) -> tuple[int, int]:
    """(reviews today, new-card reviews today), by LOCAL calendar day.

    `date(col,'localtime')` on the SQL side, not a Python-side local date string
    compared against a UTC column — that combination is an off-by-timezone bug.
    """
    from sqlalchemy import text as sql

    rows = (
        await db.execute(
            sql(
                "SELECT COUNT(*), COALESCE(SUM(CASE WHEN reps_before = 0 THEN 1 ELSE 0 END), 0) "
                "FROM card_reviews "
                "WHERE date(reviewed_at, 'localtime') = date('now', 'localtime')"
            )
        )
    ).first()
    return (int(rows[0] or 0), int(rows[1] or 0)) if rows else (0, 0)


async def queue() -> dict:
    """Today's review queue: due cards + fresh cards, both minus what's done today."""
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import Card

    new_cap, review_cap = _caps()
    now = utcnow()
    async with SessionLocal() as db:
        done, new_done = await _today_counts(db)
        due_total = (
            await db.execute(
                select(func.count(Card.id)).where(
                    Card.suspended.is_(False), Card.reps > 0, Card.due <= now
                )
            )
        ).scalar() or 0
        due = (
            (
                await db.execute(
                    select(Card)
                    .where(Card.suspended.is_(False), Card.reps > 0, Card.due <= now)
                    .order_by(Card.due)
                    .limit(max(0, review_cap - done))
                )
            )
            .scalars()
            .all()
        )
        fresh = (
            (
                await db.execute(
                    select(Card)
                    .where(Card.suspended.is_(False), Card.reps == 0, Card.due <= now)
                    .order_by(Card.id)
                    .limit(max(0, new_cap - new_done))
                )
            )
            .scalars()
            .all()
        )
    return {
        "due": [as_dict(c) for c in due],
        "fresh": [as_dict(c) for c in fresh],
        "due_total": int(due_total),
        "caps": {"new_per_day": new_cap, "review_per_day": review_cap},
        "today": {"reviewed": done, "new_done": new_done},
    }


def as_dict(c) -> dict:
    # one shared UTC serialiser: SQLite drops the tz, and a bare isoformat makes
    # the page read 09:41 UTC as 09:41 local (see models.iso_utc)
    from app.models import iso_utc

    return {
        "id": c.id,
        "kind": c.kind,
        "front": c.front,
        "back": c.back,
        "hint": c.hint,
        "topic": c.topic,
        "source": c.source,
        "source_label": c.source_label,
        "source_excerpt": c.source_excerpt,
        "origin": c.origin,
        "suspended": c.suspended,
        "due": iso_utc(c.due),
        "interval_days": c.interval_days,
        "ease": c.ease,
        "reps": c.reps,
        "lapses": c.lapses,
        "last_grade": c.last_grade,
        "last_review": iso_utc(c.last_review),
        "created_at": iso_utc(c.created_at),
    }


async def submit_review(
    card_id: int, grade: int, seconds: float = 0.0, retell: str = "", judged_sha: str = ""
) -> dict:
    """Grade one card: run SM-2, update the card in place, append to the revlog.

    Raises ValueError (bad grade / suspended) or LookupError (no such card) so the
    router can map them to 422 / 400 / 404.

    `retell`（M1）：这一答是**讲出来**的，这里是那次重讲的原文——**与自评落在同一条行上**
    （双入口单账本）。判分挂了但你自己定了档时也会带上它：那一天你确实重讲了，
    这件事不该因为模型没跑成而丢掉。

    `judged_sha`（PLAN2 T2 + §9.4）：**判它的那一版提示词的指纹**。非空 = 这一档是判分器
    判的、且记下了是哪一版；空 = 你自己定的档（包括「判分挂了、退回自评」那种）。

    参数是**指纹而不是布尔**（v10 起）：这样「判过但不知道哪一版」这个状态在新行上
    **写不出来**——v9–v10 之间那些行确实是不知道，但那是历史，不是可以再犯的东西。
    `judged` 那一列由它推出来（`bool(judged_sha)`），两列一起写、永远一致。

    它**只能由 `retell.adjudicate()` 传值**——不在任何 HTTP 入参里（`ReviewIn` 没有这个
    字段）：客户端说自己「判过了」这件事没有任何一方能核实，那是把账本交给调用方写。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card, CardReview

    async with SessionLocal() as db:
        card = (
            await db.execute(select(Card).where(Card.id == card_id))
        ).scalar_one_or_none()
        if card is None:
            raise LookupError(f"card {card_id} not found")
        if card.suspended:
            raise ValueError("这张卡已搁置")

        s = schedule(card.interval_days, card.ease, card.reps, card.lapses, grade)
        interval = fuzz_interval(s.interval_days)
        due_seconds = s.due_seconds if s.interval_days <= 0 else int(round(interval * 86400))
        now = utcnow()
        sha = str(judged_sha or "").strip()[:12]

        db.add(
            CardReview(
                card_id=card.id,
                reviewed_at=now,
                grade=grade,
                seconds=max(0.0, min(float(seconds), 600.0)),
                interval_before=card.interval_days,
                interval_after=interval,
                ease_before=card.ease,
                ease_after=s.ease,
                reps_before=card.reps,
                due_before=card.due,
                retell=str(retell or "").strip()[:4000],
                judged=bool(sha),
                judged_sha=sha,
            )
        )
        card.interval_days = interval
        card.ease = s.ease
        card.reps = s.reps
        card.lapses = s.lapses
        card.last_grade = grade
        card.last_review = now
        card.due = now + timedelta(seconds=due_seconds)
        # a card missed 8 times is a broken card or a missing prerequisite,
        # not a memory problem — shelve it instead of grinding on it
        if card.lapses >= LEECH_LAPSES:
            card.suspended = True
        await db.commit()
        out = as_dict(card)
    out["ok"] = True
    out["due_seconds"] = due_seconds
    out["requeue"] = due_seconds < SESSION_REQUEUE_SEC
    return out


async def undo_review(card_id: int) -> dict:
    """Roll the card back to its state before the latest review, exactly."""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card, CardReview

    async with SessionLocal() as db:
        rev = (
            await db.execute(
                select(CardReview)
                .where(CardReview.card_id == card_id)
                .order_by(CardReview.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if rev is None:
            return {"ok": False, "card": None}
        card = (
            await db.execute(select(Card).where(Card.id == card_id))
        ).scalar_one_or_none()
        if card is None:
            return {"ok": False, "card": None}
        card.interval_days = rev.interval_before
        card.ease = rev.ease_before
        card.reps = rev.reps_before
        card.lapses = max(0, card.lapses - (1 if rev.grade == 1 and rev.reps_before > 0 else 0))
        card.due = rev.due_before or utcnow()
        card.suspended = False
        card.last_grade = None
        card.last_review = None
        await db.delete(rev)
        await db.commit()
        return {"ok": True, "card": as_dict(card)}


async def stats() -> dict:
    """Dashboard/review-page numbers. Best-effort: any failure returns zeros."""
    from sqlalchemy import func, select, text as sql

    from app.models import iso_utc

    from app.db import SessionLocal
    from app.models import Card

    out = {
        "total": 0,
        "new": 0,
        "learning": 0,
        "mature": 0,
        "suspended": 0,
        "due_now": 0,
        "today_reviewed": 0,
        "today_new": 0,
        "remaining_today": 0,
        "accuracy_7d": None,
        "daily": [],
        "streak": 0,
        "next_due": None,
    }
    try:
        now = utcnow()
        async with SessionLocal() as db:
            out["total"] = (await db.execute(select(func.count(Card.id)))).scalar() or 0
            out["suspended"] = (
                await db.execute(
                    select(func.count(Card.id)).where(Card.suspended.is_(True))
                )
            ).scalar() or 0
            out["new"] = (
                await db.execute(
                    select(func.count(Card.id)).where(
                        Card.suspended.is_(False), Card.reps == 0
                    )
                )
            ).scalar() or 0
            out["mature"] = (
                await db.execute(
                    select(func.count(Card.id)).where(
                        Card.suspended.is_(False), Card.interval_days >= MATURE_DAYS
                    )
                )
            ).scalar() or 0
            out["learning"] = max(
                0, out["total"] - out["new"] - out["mature"] - out["suspended"]
            )
            out["due_now"] = (
                await db.execute(
                    select(func.count(Card.id)).where(
                        Card.suspended.is_(False), Card.due <= now
                    )
                )
            ).scalar() or 0
            nxt = (
                await db.execute(
                    select(Card.due)
                    .where(Card.suspended.is_(False), Card.due > now)
                    .order_by(Card.due)
                    .limit(1)
                )
            ).scalar()
            out["next_due"] = iso_utc(nxt)

            done, new_done = await _today_counts(db)
            out["today_reviewed"], out["today_new"] = done, new_done
            new_cap, review_cap = _caps()
            out["remaining_today"] = max(0, min(out["due_now"], review_cap - done))

            acc = (
                await db.execute(
                    sql(
                        "SELECT COUNT(*), SUM(CASE WHEN grade >= 3 THEN 1 ELSE 0 END) "
                        "FROM card_reviews "
                        "WHERE reviewed_at >= datetime('now', '-7 days')"
                    )
                )
            ).first()
            if acc and acc[0]:
                out["accuracy_7d"] = round(float(acc[1] or 0) / float(acc[0]), 3)

            rows = (
                await db.execute(
                    sql(
                        "SELECT date(reviewed_at,'localtime') d, COUNT(*) n FROM card_reviews "
                        "WHERE reviewed_at >= datetime('now','-30 days') GROUP BY d ORDER BY d"
                    )
                )
            ).all()
            by_day = {r[0]: int(r[1]) for r in rows}
            out["daily"] = [{"date": k, "count": v} for k, v in sorted(by_day.items())][-7:]
            out["streak"] = _streak(set(by_day))
    except Exception:  # noqa: BLE001 - stats must never break a page
        log.debug("card stats failed", exc_info=True)
    return out


def _streak(days: set[str]) -> int:
    """Consecutive local days with at least one review, counting back from today.

    Yesterday still counts as a live streak: it is only broken once a whole day
    has gone by with nothing done, otherwise the number would read 0 every
    morning before the first card.
    """
    from datetime import date as _date

    today = _date.today()
    if today.isoformat() not in days and (today - timedelta(days=1)).isoformat() not in days:
        return 0
    n, cur = 0, today if today.isoformat() in days else today - timedelta(days=1)
    while cur.isoformat() in days:
        n += 1
        cur -= timedelta(days=1)
    return n


# ---------- 薄弱来源（纯聚合，不建表） ----------

WEAK_MIN_REVIEWS = 5  # 样本不足不下判断
WEAK_AVG_GRADE = 2.6  # 平均分低于此 = 整体不牢
WEAK_AGAIN_RATE = 0.30  # 或「重来」占比 ≥ 此 = 有具体盲点


async def weak_sources(days: int = 30, limit: int = 10) -> list[dict]:
    """Sources whose cards you keep getting wrong. Pure rollup over the revlog."""
    from sqlalchemy import text as sql

    from app.db import SessionLocal

    days = max(1, min(int(days), 90))
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                sql(
                    "SELECT c.source, c.source_label, "
                    "       COUNT(DISTINCT c.id) AS cards, "
                    "       COALESCE(SUM(c.lapses), 0) AS lapses, "
                    "       COUNT(r.id) AS reviews, "
                    "       AVG(r.grade) AS avg_grade, "
                    "       SUM(CASE WHEN r.grade = 1 THEN 1 ELSE 0 END) AS again "
                    "FROM cards c "
                    "JOIN card_reviews r ON r.card_id = c.id "
                    f"  AND r.reviewed_at >= datetime('now', '-{days} days') "
                    "WHERE c.source <> '' "
                    "GROUP BY c.source "
                    "ORDER BY avg_grade ASC, lapses DESC "
                    f"LIMIT {max(1, min(int(limit), 50))}"
                )
            )
        ).all()

    out = []
    for r in rows:
        reviews = int(r[4] or 0)
        avg = float(r[5]) if r[5] is not None else None
        again = int(r[6] or 0)
        again_rate = (again / reviews) if reviews else None
        out.append(
            {
                "source": r[0],
                "source_label": r[1] or r[0],
                "cards": int(r[2] or 0),
                "lapses": int(r[3] or 0),
                "reviews": reviews,
                "avg_grade": round(avg, 2) if avg is not None else None,
                "again_rate": round(again_rate, 3) if again_rate is not None else None,
                "weak": bool(
                    reviews >= WEAK_MIN_REVIEWS
                    and (
                        (avg is not None and avg < WEAK_AVG_GRADE)
                        or (again_rate is not None and again_rate >= WEAK_AGAIN_RATE)
                    )
                ),
            }
        )
    return out


# ---------- 校准曲线（PLAN2 T2 · 纯聚合，零新表） ----------

CALIB_DAYS = 30
CALIB_MAX_DAYS = 365
_JUDGE_MODULE = "app.core.retell"
_JUDGE_NAME = "JUDGE_SYSTEM"

# 三条「读这条曲线之前必须知道的事」，和后端的口径一起发给界面（界面不自己编一份说法，
# 与 `metrics.north_star` 的 `rules` 同一个做法）。
#
# 第一条（判分器有没有基线）**是动态的**：它随金标集跑没跑过、跑的是不是这一版判分器
# 而变（PLAN2 P2-1）。这里给的是兜底那一句——读不到基线时照实说没跑过。
CALIB_NO_BASELINE = "这一版判分器还没跑过金标集：读趋势不读绝对值。"
CALIB_NOTES = (
    # 历史行：v9 之前没有这一列，判过的行和自评的行长得一模一样 —— 那是「未知」，
    # 不是「自评」。把未知当自评会让曲线开口就说一句假话，所以整段不进。
    "v9（judged 列）之前的历史行是「未知」，不进这条曲线。",
    # sha：账本里没有存提示词版本。这是 PLAN2 §3「全规划只有一列」的直接代价。
    "账本里没存提示词版本，所以换版之后旧行会跟着新指纹一起算；要真按 sha 分段得再存一列。",
)


async def _baseline_note() -> str:
    """页脚第一行：判分器的基线（PLAN2 P2-1）。

    它必须**分三种情况**说话（跑过 / 跑过但是旧版 / 没跑过）：一条曲线的 y 轴到底是什么
    意思，取决于那台判分器跟人对得上多少。读不到就退回兜底那句，绝不假装有基线。
    """
    try:
        from app.core import judge_eval

        return await judge_eval.baseline_note_for_curve()
    except Exception:  # noqa: BLE001 - 基线读不到不该让整条曲线读不出来
        log.debug("judge baseline note failed", exc_info=True)
        return CALIB_NO_BASELINE


def _grade_keys() -> tuple[int, ...]:
    """四档的取值范围（1 重来 | 2 困难 | 3 良好 | 4 简单）。**从 `retell.GRADE_LABELS` 取**——
    这个映射只许有一份（`models.CardReview.grade` 定的，`retell` 是它的登记处）。"""
    from app.core import retell

    return tuple(sorted(retell.GRADE_LABELS))


def tally(rows) -> tuple[dict[int, int], dict[int, int]]:
    """`(grade, judged)` 序列 →（自评分布, 判分分布），键恒为四档（没打过的档是 0）。Pure.

    **分堆只按 `judged` 分**：`judged=False` 收「你自评的」和「判分挂了、退回自评的」
    两种——判分没跑成 ≠ 差评，那一档仍然是你打的。
    """
    self_d = {g: 0 for g in _grade_keys()}
    judged_d = dict(self_d)
    for grade, judged in rows:
        g = int(grade)
        if g not in self_d:
            continue  # 账面外的档位（不该有）不进任何一侧：宁可少算，不猜它属于哪边
        (judged_d if judged else self_d)[g] += 1
    return self_d, judged_d


def mean_of(dist: dict[int, int]) -> float | None:
    """分布均值。**一个样本都没有就是 None，不是 0**——0 是「均值 0 档」，两回事。Pure."""
    n = sum(dist.values())
    if n <= 0:
        return None
    return sum(g * c for g, c in dist.items()) / n


def offset(self_d: dict[int, int], judged_d: dict[int, int]) -> float | None:
    """校准偏移 = **自评均值 − 判分均值**（PLAN2 §6 的口径，正数 = 给自己打分更高）。

    任一侧没有样本 → `None`。全自评时它必须是 `null` 而不是 `0`：界面据此说
    「还没有对过账」，而不是画一条贴零的线说「你和它判得一样准」。
    """
    a, b = mean_of(self_d), mean_of(judged_d)
    if a is None or b is None:
        return None
    return round(a - b, 3)


def fold_segments(rows) -> list[dict]:
    """`(grade, judged, judged_sha)` 序列 → **按判分器版本分段**的分布。Pure。

    这是 §9.4 要的那条：判分器换过版之后，曲线上就不是一把尺子了。分段给的是「每一版
    各判了什么」——`sha` 为空的那一格是 **v9–v10 之间的历史行**（判过，但不知道哪一版），
    它必须单独一排，不能被并进当前这一版里假装知道。

    排序：**版本未知的排最后**（它最不可比），其余按条数多的在前。
    """
    segs: dict[str, dict] = {}
    for grade, judged, sha in rows:
        if not judged:
            continue
        key = str(sha or "")
        seg = segs.setdefault(key, {"sha": key, "dist": {g: 0 for g in _grade_keys()}})
        g = int(grade)
        if g in seg["dist"]:
            seg["dist"][g] += 1
    out: list[dict] = []
    for seg in segs.values():
        n = sum(seg["dist"].values())
        out.append({**seg, "n": n, "mean": round(mean_of(seg["dist"]) or 0.0, 3) if n else None})
    out.sort(key=lambda s: (s["sha"] == "", -s["n"]))
    return out


def judge_sha() -> str:
    """当前判分提示词的指纹（12 位）。**从登记表取**（`prompts.fingerprint`），
    不在这里重算一遍 sha——两份算法迟早会漂。"""
    from app.core import prompts

    return prompts.fingerprint(_JUDGE_MODULE, _JUDGE_NAME)


async def calibration(days: int = CALIB_DAYS) -> dict:
    """校准曲线：滚动 `days` 天里，自评的档位分布 vs 判分器判的档位分布。

    **只进仪表盘**——不设目标、不排名、不变成零柒嘴里的任何一句话（红线与
    `metrics.north_star` 同一条）。所以这个模块一行 `pet.*` 都不碰。

    窗口是**滚动 N 天**（锚在「现在」，与 `stats()` / `weak_sources()` 同一个口径），
    而不是北极星那种「本地日格子」：这里要的是一个分布，不是逐日的曲线。

    读不出来时 `readable=false` 且两个分布都空——**不拿一堆零充数**（零是「一条都没有」）。
    """
    from sqlalchemy import text as sql

    from app.db import SessionLocal

    span = max(1, min(int(CALIB_DAYS if days is None else days), CALIB_MAX_DAYS))
    out = {
        "readable": False,
        "error": "",
        "days": span,
        "self_dist": {},
        "judged_dist": {},
        "delta": None,
        "n_self": 0,
        "n_judged": 0,
        "judge_sha": "",
        "segments": [],  # 按判分器版本分段（§9.4）：换过版就不是一把尺子了
        "mixed": False,  # 窗口里是不是混了不止一版
        "notes": [CALIB_NO_BASELINE, *CALIB_NOTES],
    }
    try:
        async with SessionLocal() as db:
            rows = (
                await db.execute(
                    sql(
                        "SELECT grade, judged, COALESCE(judged_sha, ''), COUNT(*) FROM card_reviews "
                        f"WHERE reviewed_at >= datetime('now', '-{span} days') "
                        "GROUP BY grade, judged, COALESCE(judged_sha, '')"
                    )
                )
            ).all()
    except Exception as e:  # noqa: BLE001 - 派生视图，坏了就说读不到
        log.debug("card calibration failed", exc_info=True)
        out["error"] = f"{type(e).__name__}: {e}"
        return out

    pairs: list[tuple[int, bool]] = []
    seg_rows: list[tuple[int, bool, str]] = []
    for grade, judged, sha, n in rows:  # (档位, 是不是判的, 哪一版, 行数)
        for _ in range(int(n or 0)):
            pairs.append((int(grade), bool(judged)))
            seg_rows.append((int(grade), bool(judged), str(sha or "")))
    self_d, judged_d = tally(pairs)
    segments = fold_segments(seg_rows)
    current = judge_sha()
    for s in segments:
        s["current"] = bool(current) and s["sha"] == current
    mixed = len(segments) > 1
    notes = [await _baseline_note(), *CALIB_NOTES]
    if mixed:
        # **混版必须说出来**：这条曲线的 y 轴本来是「这台判分器判得比你严还是松」，
        # 换过版之后窗口里就有两把尺子，pooled 的那个 delta 读之前得先知道这件事。
        # 分段表在 `segments` 里，界面照它摆。
        parts = "、".join(
            f"{'本版' if s['current'] else ('版本未知' if not s['sha'] else s['sha'][:6])} {s['n']} 条"
            for s in segments
        )
        notes.insert(0, f"这条曲线上的判分行来自不止一版判分器（{parts}）——别把两把尺子当成一把量。")
    out.update(
        readable=True,
        error="",
        self_dist=self_d,
        judged_dist=judged_d,
        delta=offset(self_d, judged_d),
        n_self=sum(self_d.values()),
        n_judged=sum(judged_d.values()),
        judge_sha=current,
        segments=segments,
        mixed=mixed,
        notes=notes,
    )
    return out


# ---------- 主动层：每日提醒 + 每周补讲 ----------

_REMEDY_SYSTEM = (
    "你是用户的技术学习助手。用户在某篇材料的复习卡上反复答错，"
    "说明这块知识没真正吃透。请针对他答错的那几个点写一篇补充讲解。\n"
    "要求：\n"
    "① 只讲他错的那几个点，不要复述整篇材料。\n"
    "② 每个点讲清三件事：到底发生了什么、为什么会这样、下次怎么判断出来。\n"
    "③ 能给最小可运行示例就给，代码用 ``` 围起来。\n"
    "④ 用 Markdown，二级标题分点，不要写开场白和总结套话。\n"
    "⑤ 只用材料里的信息，不要编造材料里没有的事实。"
)

REMEDY_MAX_SOURCES = 2
REMEDY_MATERIAL_CHARS = 6000
REMEDY_CARDS = 3


def reschedule() -> None:
    """封存：不再注册每日提醒与每周补讲。

    这两个作业就是上一版「到期了要还债」的主动层 —— 20:00 弹一句「今天有 N 张卡到期」，
    周日 21:00 写一篇补讲。判断标准只有一条：任何机制一旦产生「欠着没做」的感觉，就是
    滑回上一版。所以把导航入口撤掉还不够，会自己开口的部分必须停；「不做任何定时任务与
    提醒」也已经写死。

    代码一行不删（封存不删、不写迁移）。`_remind` / `_remediate_run` 仍可手动
    调用，config 里的 `cards_remind_*` / `cards_remedy_enabled` 也留着，只是不再有人读。
    prune 而不是「什么都不做」：同一个进程里可能还挂着改动之前注册上去的作业，
    `reschedule_all()` 每次改设置都会调到这里，顺手把它们摘掉。
    """
    from app.core import scheduler as sched

    sched.prune_jobs("cards_remind", keep=set())
    sched.prune_jobs("cards_remediate", keep=set())


async def _remind() -> None:
    """零柒 mentions today's queue and unticked habits — in ONE line, or none.

    Both live on the same page and are the same daily ask, so a second job would
    just be a second popup for the same thing. `pet.py:9` says frugal: nothing to
    say, say nothing.
    """
    try:
        q = await queue()
        n = len(q["due"]) + len(q["fresh"])
        try:  # a habits failure must not swallow the card reminder
            from app.core import habits

            pending, names = await habits.pending_today()
        except Exception:  # noqa: BLE001
            log.debug("habit pending lookup failed", exc_info=True)
            pending, names = 0, []
        if n == 0 and pending == 0:
            return  # frugal by contract
        from app.core import pet

        if n == 0:
            pet.emit("habits_due", name="、".join(names), count=pending)
            return
        st = await stats()
        streak = str(st.get("streak") or 0)
        line = pet.compose("cards_due", detail=streak, count=n)
        if pending:  # one sentence covering both, not compose() plus a dangling tail
            since = f"，已经连着 {streak} 天了" if streak not in ("0", "") else ""
            line = f"今天有 {n} 张卡到期、{pending} 个习惯没打勾{since}。"
        pet.emit("cards_due", count=n, detail=streak, text=line)
    except Exception:  # noqa: BLE001 - the pet must never break the scheduler
        log.exception("cards remind failed")


async def _remediate_run() -> None:
    try:
        log.info("cards remediation: %s", await remediate())
    except Exception:  # noqa: BLE001
        log.exception("cards remediation failed")


async def remediate(days: int = 14) -> dict:
    """Write a follow-up explainer into the vault for each weak source.

    Deliberately a standalone job rather than a row in the `tasks` table:
    `ScheduledTask.prompt` is static text, so a scheduled task could never know
    which source is weak *this* week, and teaching the agent mode to look it up
    would mean shipping a new model-visible tool for one fixed weekly action.
    Shape follows `core/digest.generate_digest()`: rollup read, one LLM call,
    one file write. The file lands in the vault, so the watcher indexes it and
    it becomes carding material itself — wrong → explained → asked again.
    """
    from sqlalchemy import select

    from app.config import VAULT_DIR
    from app.core import ingest
    from app.core.llm import ProviderInfo, stream_chat
    from app.core.pet import _default_model_id
    from app.db import SessionLocal
    from app.models import Card
    from app.routers.chat import resolve_model

    weak = [w for w in await weak_sources(days=days) if w["weak"]][:REMEDY_MAX_SOURCES]
    if not weak:
        return {"ok": True, "written": 0, "message": "没有薄弱来源，跳过"}

    model_id = _default_model_id()
    if not model_id:
        return {"ok": False, "error": "没有已启用的 provider"}
    resolved = await resolve_model(model_id)
    p = resolved.provider
    info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)

    root = VAULT_DIR.resolve()
    out_dir = root / "notes"
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[str] = []

    for w in weak:
        try:
            src = (root / w["source"]).resolve()
            material = ""
            if src.is_relative_to(root) and src.is_file():
                material = (ingest.parse_file(src) or "")[:REMEDY_MATERIAL_CHARS]
            async with SessionLocal() as db:
                rows = (
                    (
                        await db.execute(
                            select(Card)
                            .where(Card.source == w["source"])
                            .order_by(Card.lapses.desc(), Card.ease)
                            .limit(REMEDY_CARDS)
                        )
                    )
                    .scalars()
                    .all()
                )
            missed = "\n\n".join(
                f"【错题 {i + 1}】\nQ: {c.front}\nA: {c.back}" for i, c in enumerate(rows)
            )
            if not missed:
                continue
            user = (
                f"材料来源：{w['source']}（平均分 {w['avg_grade']}，"
                f"重来 {w['again_rate']}）\n\n{missed}\n\n"
                f"---\n【原材料节选】\n{material or '（读不到原文，仅按错题作答）'}"
            )
            parts: list[str] = []
            async for delta in stream_chat(
                info,
                resolved.model,
                [
                    {"role": "system", "content": _REMEDY_SYSTEM},
                    {"role": "user", "content": user},
                ],
            ):
                parts.append(delta)
            body = "".join(parts).strip()
            if not body:
                continue
            today = datetime.now().strftime("%Y-%m-%d")
            stem = re.sub(r"[\\/:*?\"<>|]", "-", src.stem or w["source"])[:60]
            f = out_dir / f"补讲-{stem}-{today}.md"
            f.write_text(
                f"# 补讲 · {stem}\n\n"
                f"> 自动生成 {today} · 依据近 {days} 天的复习记录"
                f"（平均分 {w['avg_grade']}，{len(rows)} 张错题）\n\n{body}\n",
                encoding="utf-8",
            )
            written.append(f.name)
        except Exception:  # noqa: BLE001 - one bad source must not kill the rest
            log.exception("remediation failed for %s", w.get("source"))

    if written:
        try:
            from app.core import pet

            pet.emit("cards_remedy", name=written[0], count=len(written))
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "written": len(written), "files": written}












