"""对话式教学：说出想搞懂什么 → 先探理解 → 讲一段 → 出题 → 记下卡点。

The direction settled on 2026-09-05 (PLAN.md 第 1 节), replacing 制卡 + 间隔复习.
The load-bearing part is not the chat — any model does chat — it is that a
session ends with a 概念 / 自评 / 卡点 triple, and that the next session on a
related topic gets those triples back. If that recall never fires or never
helps, PLAN.md 第 5 节 says to cut it, so it is kept in one module.

RAG 取材 was deliberately absent in the first step (PLAN.md 第 6 节) and added
afterwards as 第 7 节's first item (2026-09-06, gate lifted by the user): the
teaching now draws on the user's own vault / clippings when they match, but
stays silent when they don't. No tools, no scheduled jobs. Heavy imports stay
inside functions, matching the other core modules.
"""
import asyncio
import json
import logging
import math
import re

log = logging.getLogger(__name__)

HISTORY_LIMIT = 60  # turns sent back to the model; a session is one concept, not a day
RECALL_TOP_K = 3  # past sessions injected at most
RECALL_MIN_SIM = 0.62  # cosine floor. 验收 asks that recall be *right*, not just
# present, so a floor beats top-k alone: with 3 unrelated past sessions, top-k
# would inject all 3.
#
# Measured, not guessed — `smoke_recall.py` prints the distribution it comes from.
# bge-small-zh-v1.5 packs all short technical Chinese into a narrow cone, so the
# usable window is thin. On the 2026-09-06 calibration (19 topics × 6 past rows,
# candidate text as `recall_hits` builds it): related bottom out at 0.643,
# unrelated top out at 0.601, and 0.62 sits between them with ~0.02 either way.
# It must NOT go higher — a real reworded re-encounter lands at 0.64–0.67
# (measured in smoke_tutor_accept.py), so 0.68 would silence recall on exactly
# the encounters it exists for. Lower is the other failure: at the original
# guess of 0.45 「Rust 的所有权」 pulled 「asyncio 事件循环」 at 0.555 and two of
# three recalled lines were wrong, which from the outside is PLAN.md 第 5 节's
# 「触发了但没用」 — recall killed for a tuning reason.
#
# What is left as a real boundary: a past session with no `aliases` (extraction
# failed, or the row predates them). Those match on topic+concept+stuck alone,
# where a synonym rewrite scores 0.44–0.49 — under the noise ceiling, so no
# threshold reaches it. Aliases are what moved that pair to 0.627.
RECALL_MIN_SIM_NOISE_CEILING = 0.601  # highest unrelated pair seen; the floor must clear it
END_EXTRACT_CHARS = 6000  # transcript slice sent to the extraction call
ALIAS_MAX = 4  # aliases kept per session; each one costs a vector at recall time
ALIAS_CHARS_EACH = 30  # 一句话不是别名，30 字够写「协程什么时候被切走」这种问法
# 下面两个是「每个别名各成一条向量」（见 `recall_hits`）的后果：
#   MIN=4：2-3 字的说法基本就是标准术语本身，而 concept 那条文本已经覆盖了。单独成
#   向量反而是噪声源 —— 2026-09-06 实测「async」这种裸词对无关查询「asyncio 里的任务
#   调度」拿到 0.632，越过了 0.62。
#   SEP：别名边界必须活到召回，所以不能拿空格分隔 ——「event loop 调度」自己就带空格，
#   会被切成三段碎词，而碎词就是上面那个 0.632。
ALIAS_CHARS_MIN = 4
ALIAS_SEP = " | "
MATERIAL_TOP_K = 3  # chunks pulled from the user's own KB per turn
MATERIAL_CHUNK_CHARS = 800  # per chunk; the teaching voice is 3-5 sentences, not a report
# 会话结束时「材料里还有」的检索宽度与条数。它不是推荐队列（第 2 节红线）：只在
# 你点完自评的那条总结里出现一次、最多 2 个文件、不落库、页面上没有它的常驻入口。
NEARBY_TOP_K = 6  # 检索宽一点：按 source 去重后常常只剩两三个
NEARBY_MAX = 2
# 本会话取材已经引用过的来源。存在进程里、end() 时取走即删：单用户桌面应用，
# 从不结课的会话才可能留下残留，量级由使用决定。放进 nearby 的 exclude，
# 「材料里还有」不再推荐你刚看过的文件。
_SESSION_SOURCES: dict[int, set[str]] = {}
VERDICTS = ("got", "half", "useless")

SOCRATIC_PROMPT = """你是一个苏格拉底式的技术老师。用户会说出他想搞懂的东西。你的任务不是把答案讲完，而是让他自己想通。

规则：
1. 第一轮先探他现在的理解，用一个具体的问题——问一个能暴露他真实理解程度的点，不要问"你了解多少"这种。
2. 每次回复只讲一小段（3-5 句），讲完必须以一个他必须回答的问题结尾。
3. 他答错或答得含糊时，不要直接纠正。反问一个能让他自己发现矛盾的问题。
4. 他答对时，确认一句就往下一层问，不要重复他已经懂的部分。
5. 判断他卡在哪，针对那个卡点讲。
6. 不要客套。不要说"好问题"、"很好的想法"、"你说得对"这类开场。直接进入内容。
7. 涉及代码时给最小可运行片段，不给完整项目结构。
8. 如果他明确说"别问了直接讲"，就直接讲清楚，但讲完仍然给一个能检验他是否真懂的问题。

不要做的事：
- 不要一次列出五个要点的清单式讲解——那是文章，不是对话。
- 不要在他还没暴露理解程度之前就开始讲。
- 不要问"你想从哪里开始"这种把决定推回给他的问题。"""

# aliases 那一段的三条硬要求都是量出来的（2026-09-06 accept 实测，每个别名单独成一条
# 向量）：「至少 4 个字」挡「async」这种裸词 —— 它对无关查询「asyncio 里的任务调度」
# 拿到 0.632，越过 0.62；「不要纯英文」挡「coroutine suspension」这种 —— 中文查询对它
# 只有 0.256，而同一次提取里的中文说法「协程挂起后去哪」是 0.712。名额只有 4 个，浪费
# 一个就少一条能接住重逢的文本。
_EXTRACT_PROMPT = """你在读一段技术教学对话。只输出一个 JSON 对象，不要任何解释：

{"concept": "这次谈的核心概念，10 字以内的名词短语", "aliases": ["同一个概念的另一种问法", "再一种"], "stuck": "他卡在哪，一句话，20 字以内；如果全程没卡住就给空字符串"}

concept 用领域里的标准叫法（例如「asyncio 事件循环」而不是「那个循环的事」），并且必须带上领域限定词——框架、语言或库的名字。写「asyncio 事件循环」，不要只写「事件循环」；写「SQLite WAL 模式」，不要只写「WAL 模式」。没有这个名字，下次换个说法提起这个话题时就对不上。

aliases 给 2-4 个，是同一个概念的**其他问法**：几个月后他又想起这个东西、但已经想不起标准术语时会怎么打字。所以要换词，不是换语序——用同义词、用大白话、用现象描述（写「协程什么时候切换」，不要写「事件循环的调度机制」）。每个都写成完整的一句问法、至少 4 个字：不要写「async」「GIL」「WAL」这种裸术语，也不要写纯英文短语，标准叫法已经在 concept 里了。不要把 concept 原样重复一遍，也不要写宽泛到能套任何概念的词（「并发」「性能」「原理」）。

stuck 要写他的错误理解本身（例如「以为 await 把控制权交给了操作系统」），不要写「不理解事件循环」这种空话。"""


# ---------- embedding: the same embedder core/memory.py ranks recall with ----------


async def _embed(texts: list[str]) -> list[list[float]]:
    """Embed a batch in a thread (CPU-bound). Test seam: monkeypatch me."""
    from app.core import embedder

    return await asyncio.to_thread(embedder.embed, texts)


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


# ---------- session lifecycle ----------


async def start(topic: str) -> dict:
    """Open a session on `topic`. Pins the model so the teaching voice can't
    change mid-session; reports whether that model is known-broken so the page
    can say so instead of failing on the first turn (PLAN.md 第 9 节)."""
    topic = (topic or "").strip()[:200]
    if not topic:
        raise ValueError("topic is empty")

    from app.core import providers
    from app.db import SessionLocal
    from app.models import TutorSession

    model_id = providers.default_model_id() or ""
    async with SessionLocal() as db:
        row = TutorSession(topic=topic, model_id=model_id)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        sid = row.id
    return {
        "id": sid,
        "topic": topic,
        "model_id": model_id,
        "model_ok": bool(model_id) and not providers.is_unhealthy(model_id),
    }


async def add_turn(session_id: int, role: str, content: str) -> None:
    from app.db import SessionLocal
    from app.models import TutorTurn

    async with SessionLocal() as db:
        db.add(TutorTurn(session_id=session_id, role=role, content=content))
        await db.commit()


async def turns(session_id: int) -> list[dict]:
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import TutorTurn

    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(TutorTurn)
                .where(TutorTurn.session_id == session_id)
                .order_by(TutorTurn.id)
            )
        ).scalars().all()
    return [{"role": r.role, "content": r.content} for r in rows]


# ---------- recall: the part that makes this more than a chat wrapper ----------


def _local_md(dt) -> str:
    """'08-21' in local time. Same naive-readback trap as `models.iso_utc`:
    SQLite hands a `DateTime(timezone=True)` column back without a tzinfo, so
    calling .astimezone() on it bare would read 09:41 UTC as 09:41 local."""
    from datetime import timezone

    if dt is None:
        return ""
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone().strftime("%m-%d")


async def recall_hits(topic: str, exclude_id: int | None = None) -> list[dict]:
    """Past sessions on concepts close to `topic`, best first ([] if none).

    Ranked by embedding similarity with a floor, not just top-k: injecting the
    three least-unrelated sessions when nothing is actually related is how the
    model ends up forcing a connection, and 验收 asks that the recall be right.
    `useless` sessions are skipped — that verdict says the teaching itself
    missed, so its concept/stuck line is not evidence of anything.

    Returns data rather than the prompt block so the page can show exactly what
    fired and how close it was; judging 「触发得对」 needs the score, not prose.
    """
    try:
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import TutorSession

        async with SessionLocal() as db:
            q = select(TutorSession).where(
                TutorSession.verdict.in_(("got", "half")), TutorSession.concept != ""
            )
            if exclude_id is not None:
                q = q.where(TutorSession.id != exclude_id)
            rows = (await db.execute(q.order_by(TutorSession.id.desc()).limit(200))).scalars().all()
        if not rows:
            return []

        # 每行的待召回文本 = primary 一条 + 每个别名各一条，取分最高的那条（max，
        # 不是拼成一条长的）。
        #
        # primary = topic + concept + stuck。topic 是用户自己打的问法，下次重逢时
        # 他打进来的大概率还是这种问法而不是提取出来的名词短语。实测（2026-09-06）
        # 「怎么优化 SQLite 并发写入」对 concept+stuck 只有 0.577，会从 0.62 底下
        # 滑过去漏掉；带上 topic 后 0.722。只留 concept 反而最差。
        #
        # 别名为什么每个各成一条向量（smoke_recall.py 第 1 节列了五种拼法的代价，
        # 这里只记结论。左右两列 = 该中的最低分 / 不该中的最高分）：
        #   并进 primary 一条         0.573 / 0.601  ← 被平均掉，仍有 1 条漏
        #   别名整行一条              0.573 / 0.601  ← 同一个平均化问题，见下
        #   别名行 = concept + 别名   0.622 / 0.601  ← 只剩 0.002 余量，等于没有
        #   每个别名各一条            0.660 / 0.601  ← 线上这一种
        # 加 concept 会把向量拉回标准术语那一侧，而同义改写要接的正好是「想不起标准
        # 术语」的问法。整行一条是同一个问题小一号：真实提取出来的四个别名是四个不同
        # 角度（2026-09-06 accept 实测「await控制权给谁 | 协程挂起后去哪 | 事件循环等IO
        # | epoll何时阻塞」），查询「协程是在什么时机被切走的」对整行只有 0.573（漏），
        # 对「协程挂起后去哪」单条 0.712。手写的同质别名量不出这个差别 —— 那正是这一版
        # 之前误判成「整行够用」的原因，别再合回去。
        #
        # 代价：每行的向量从 1 条变成 1+k 条，而这里每次召回都是现算（没缓存）。200 行
        # × 5 条 = 1000 条短文本，本地 bge-small 上一两秒，一个会话只算一次。真嫌慢就
        # 去缓存向量，不要改回整行。
        #
        # 没有别名的旧行只有 primary：空别名不参与 max（concept 单独是实测最差的拼法，
        # 拿它取 max 等于把噪声接回来）。
        primary = [f"{r.topic} {r.concept} {r.stuck}".strip() for r in rows]
        alias_texts: list[str] = []
        alias_owner: list[int] = []
        for i, r in enumerate(rows):
            # 分隔符之前存的行没有 ALIAS_SEP，split 后就是整行一条 —— 退回旧行为，不报错
            for alias in r.aliases.split(ALIAS_SEP):
                if alias.strip():
                    alias_texts.append(alias.strip())
                    alias_owner.append(i)
        vecs = await _embed([topic.strip()[:500], *primary, *alias_texts])
        qvec, prim, alia = vecs[0], vecs[1 : 1 + len(rows)], vecs[1 + len(rows) :]

        # (score, via)：via 说的是哪条文本命中的，判断「别名有没有在挣钱」需要它
        best: list[tuple[float, str]] = [(_cosine(qvec, v), "concept") for v in prim]
        for v, i in zip(alia, alias_owner):
            s = _cosine(qvec, v)
            if s > best[i][0]:
                best[i] = (s, "alias")
        scored = sorted(zip(rows, best), key=lambda rb: rb[1][0], reverse=True)
        return [
            {
                "concept": r.concept,
                "verdict": r.verdict,
                "stuck": r.stuck,
                "date": _local_md(r.created_at),
                "score": round(s, 3),
                "via": via,
            }
            for r, (s, via) in scored[:RECALL_TOP_K]
            if s >= RECALL_MIN_SIM
        ]
    except Exception:  # noqa: BLE001 - recall is an enhancement; teaching goes on without it
        log.warning("tutor recall failed", exc_info=True)
        return []


def format_recall(hits: list[dict]) -> str:
    """Ranked hits → one system block ('' if none). Pure, so it is testable."""
    if not hits:
        return ""
    lines = []
    for h in hits:
        state = "半懂" if h.get("verdict") == "half" else "说通了"
        stuck = f"，当时卡在：{h['stuck']}" if h.get("stuck") else ""
        lines.append(f"- {h['concept']}（{state}，{h.get('date', '')}）{stuck}")
    return (
        "以下是这个用户过去在相关概念上的记录（来自你们之前的教学会话）：\n"
        + "\n".join(lines)
        + "\n\n如果当前话题正好碰到他卡过的点，主动提起来——用「你上次在……卡过」的口吻，"
        "然后从那个卡点切进去。已经说通的概念不要重讲。\n"
        "如果这些记录和当前话题其实无关，就完全忽略，不要为了用上它们而硬扯关系。"
    )


# ---------- 学习画像：全量概念的水平一览（PLAN.md 第 7 节，参考 ChatApp 用户画像） ----------


async def profile() -> dict:
    """教学记录 → 按概念聚合的水平画像，**纯派生，不落库**。

    recall 是按语义打分的「相关记录」（0.62 底线上下），画像补的是 breadth：
    概念无关或分数不够时，老师也能知道这个人在哪些概念上说过通、哪些半懂，
    用来校准讲解深度。每个概念取**最近一次** verdict——说通了后来又卡住，
    以新的为准，退回半懂是诚实的行为。useless 不算数（教学没成，证明不了水平）。
    """
    try:
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import TutorSession

        async with SessionLocal() as db:
            rows = (
                await db.execute(
                    select(TutorSession)
                    .where(TutorSession.concept != "", TutorSession.verdict.in_(("got", "half")))
                    .order_by(TutorSession.id)
                )
            ).scalars().all()
    except Exception:  # noqa: BLE001 - profile is an enhancement; teaching goes on
        log.warning("tutor profile query failed", exc_info=True)
        return {"known": [], "half": []}
    latest: dict[str, str] = {}
    for r in rows:
        latest[r.concept] = r.verdict  # id 升序遍历：后写覆盖，即最近一次
    return {
        "known": sorted(c for c, v in latest.items() if v == "got"),
        "half": sorted(c for c, v in latest.items() if v == "half"),
    }


PROFILE_LIST_CAP = 12  # 注入块里每个清单最多列这么多概念，全量在设置页看


def format_profile(prof: dict, memories: list | None = None) -> str:
    """画像 + 偏好记忆 → one system block ('' when nothing at all). Pure."""
    known, half = prof.get("known") or [], prof.get("half") or []
    pref_lines = [
        f"- 【{('偏好' if m.kind == 'preference' else '习惯')}】{m.content}"
        for m in (memories or [])
        if getattr(m, "kind", None) in ("preference", "habit")
    ]
    if not known and not half and not pref_lines:
        return ""
    parts = ["以下是这个用户的学习画像（自动汇总自教学记录与长期记忆，不用向他确认）："]
    if known:
        head = "、".join(known[-PROFILE_LIST_CAP:])
        more = f"（共 {len(known)} 个，仅列最近 {PROFILE_LIST_CAP} 个）" if len(known) > PROFILE_LIST_CAP else ""
        parts.append(f"已说通{more}：{head}")
    if half:
        head = "、".join(half[-PROFILE_LIST_CAP:])
        more = f"（共 {len(half)} 个）" if len(half) > PROFILE_LIST_CAP else ""
        parts.append(f"半懂{more}：{head}")
    if pref_lines:
        parts.append("他的偏好与习惯（来自长期记忆）：\n" + "\n".join(pref_lines))
    parts.append(
        "用它校准你的讲解：已说通的不要重讲；半懂的默认他还记得一点、从上次的状态往下走；"
        "偏好决定详略。与当前话题无关的部分忽略。"
    )
    return "\n".join(parts)


async def _profile_block() -> str:
    """派生画像 + 取偏好记忆，拼成注入块。失败静默（增强，不挡教学）。"""
    try:
        prof = await profile()
        from app.core import memory as _memory

        mems = await _memory.list_memories()
    except Exception:  # noqa: BLE001
        log.warning("tutor profile block failed", exc_info=True)
        return ""
    return format_profile(prof, mems)


# ---------- 取材：讲你自己的材料，而不是通用答案（PLAN.md 第 7 节 第 1 条） ----------


def format_material(sources: list[dict]) -> str:
    """Retrieved KB chunks → one system block ('' if none). Pure, so it is testable."""
    if not sources:
        return ""
    blocks = [
        f"[来源 {i} — {s.get('source', '')}]\n{str(s.get('text', ''))[:MATERIAL_CHUNK_CHARS]}"
        for i, s in enumerate(sources, 1)
    ]
    return (
        "以下是从用户自己的知识库（vault、剪藏、仓库笔记）检索到的片段，可能和当前话题有关：\n\n"
        + "\n\n".join(blocks)
        + "\n\n讲到相关内容时优先用他自己的材料——他的剪藏和笔记反映他真正在接触的东西，"
        "用通用答案讲就浪费了。引用了哪段就自然带一下来源文件名，不要写成论文脚注。"
        "如果片段和当前话题对不上，就完全忽略，按你自己的理解教。"
    )


async def _retrieve(query: str, top_k: int) -> list[dict]:
    """One KB search in a thread. Test seam: monkeypatch me."""
    from app.core import indexer

    return await asyncio.to_thread(indexer.search_auto, query, top_k)


# ---------- one teaching reply ----------


def build_messages(history: list[dict], recall: str = "", material: str = "", profile: str = "") -> list[dict]:
    """Prompt for one reply: teaching voice, then recall, then profile, then material,
    then the transcript.

    Recall is a second system message rather than being glued onto
    SOCRATIC_PROMPT: with nothing to recall the voice is then byte-identical
    every turn, so when the teaching drifts it is clear which block moved.
    Profile sits after recall — it is the stable breadth picture; material sits
    last of the three blocks — nearest the transcript, which is where the model
    looks when deciding what to talk about.
    """
    msgs: list[dict] = [{"role": "system", "content": SOCRATIC_PROMPT}]
    if recall:
        msgs.append({"role": "system", "content": recall})
    if profile:
        msgs.append({"role": "system", "content": profile})
    if material:
        msgs.append({"role": "system", "content": material})
    recent = history[-HISTORY_LIMIT:]
    if len(history) > HISTORY_LIMIT:
        # 60 turns on one concept is already unusual, but losing the opening line
        # is what makes the model forget what it is teaching, so it survives.
        recent = [history[0], *recent[1:]]
    msgs.extend({"role": t["role"], "content": t["content"]} for t in recent)
    return msgs


async def _stream(model_id: str, messages: list[dict]):
    """One streaming teaching call. Test seam: monkeypatch me."""
    from app.core.llm import ProviderInfo, stream_chat
    from app.routers.chat import resolve_model

    resolved = await resolve_model(model_id)
    p = resolved.provider
    async for delta in stream_chat(
        ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key),
        resolved.model,
        messages,
    ):
        yield delta


async def say(session_id: int, text: str):
    """Yield ("recall" | "sources" | "delta" | "done" | "error", data) for one exchange.

    Same generator shape as `core/cards.generate_stream`, so the SSE route stays
    a wrapper. Owns both writes: your turn is stored before the model is called
    (a failed reply must not lose what you typed), the reply once it completes.
    """
    text = (text or "").strip()
    if not text:
        yield "error", {"message": "说点什么"}
        return

    from app.core import providers
    from app.db import SessionLocal
    from app.models import TutorSession

    async with SessionLocal() as db:
        row = await db.get(TutorSession, session_id)
        if row is None:
            yield "error", {"message": f"会话 {session_id} 不存在"}
            return
        topic = row.topic
        model_id = row.model_id or (providers.default_model_id() or "")
        if model_id and not row.model_id:
            row.model_id = model_id  # pinned late: opened before any provider existed
            await db.commit()
    if not model_id:
        yield "error", {"message": "没有已启用的 provider，请先在设置页配置模型"}
        return

    await add_turn(session_id, "user", text)
    history = await turns(session_id)

    # Recomputed every turn rather than cached: the block has to be in *every*
    # request or the model forgets the recalled 卡点 mid-session, and a local
    # embedding pass over <=200 short rows is noise next to the model call.
    hits = await recall_hits(topic, exclude_id=session_id)
    first_recall = False
    if hits:
        # Flagged on the row the first time it fires, so 第 5 节's "recall never
        # triggers → cut it" is a query, not a hand count in LOG.md.
        async with SessionLocal() as db:
            row = await db.get(TutorSession, session_id)
            if row is not None and not row.recalled:
                row.recalled = True
                await db.commit()
                first_recall = True
    if first_recall:
        yield "recall", {"hits": hits}  # once per session; the page shows one chip

    # 取材以这一轮的提问为准（第一轮就是 topic 本身）。空索引、检索挂了都静默跳过：
    # 取材是增强，教学不能因为它停下来。
    try:
        sources = await _retrieve(text, MATERIAL_TOP_K)
    except Exception:  # noqa: BLE001
        log.warning("tutor material retrieval failed", exc_info=True)
        sources = []
    if sources:
        # 记下本会话引用过的来源，end() 的「材料里还有」拿它当排除集
        _SESSION_SOURCES[session_id] = {
            str(s.get("source") or "") for s in sources if s.get("source")
        }
        yield "sources", {
            "sources": [
                {"source": s.get("source", ""), "title": s.get("title", ""), "score": s.get("score", 0)}
                for s in sources
            ]
        }

    parts: list[str] = []
    try:
        async for delta in _stream(
            model_id,
            build_messages(history, format_recall(hits), format_material(sources), await _profile_block()),
        ):
            parts.append(delta)
            yield "delta", {"text": delta}
    except Exception as e:  # noqa: BLE001 - an SSE stream cannot become a 500 midway
        log.warning("tutor reply failed", exc_info=True)
        answer = "".join(parts).strip()
        if answer:
            await add_turn(session_id, "assistant", answer)  # keep the partial
        yield "error", {"message": f"{providers.error_code(e)}: {e}"[:300]}
        return

    answer = "".join(parts).strip()
    if answer:
        await add_turn(session_id, "assistant", answer)
    yield "done", {"model_id": model_id, "recalled": bool(hits)}


# ---------- ending a session: the 概念 / 自评 / 卡点 triple ----------


def _clean_aliases(raw, concept: str = "") -> str:
    """Model output → one `ALIAS_SEP`-joined alias line ('' if nothing usable).

    Pure and separate from `_extract` because aliases exist only to be embedded:
    junk here (the concept echoed back, a comma string instead of a list, twenty
    of them) does not raise anywhere — it silently changes what recall matches
    on, which is the one thing PLAN.md 第 4 节 calls this product's only value.
    """
    if isinstance(raw, str):
        items: list = re.split(r"[、,，;；/|\n]+", raw)
    elif isinstance(raw, (list, tuple)):
        items = list(raw)
    else:
        return ""

    out: list[str] = []
    seen = {re.sub(r"\s+", "", concept)}  # echoing concept buys nothing: it is already in the line
    for it in items:
        if isinstance(it, dict):  # some models answer [{"alias": ...}]
            it = next((v for v in it.values() if isinstance(v, str)), "")
        # `|` 也当空白吞掉：它是 ALIAS_SEP，留在别名里会把一条切成两条碎词
        alias = re.sub(r"[\s|]+", " ", str(it)).strip(" 　「」『』\"'()（）[]【】")
        key = re.sub(r"\s+", "", alias)
        if len(key) < ALIAS_CHARS_MIN or len(alias) > ALIAS_CHARS_EACH or key in seen:
            continue
        seen.add(key)
        out.append(alias)
        if len(out) >= ALIAS_MAX:
            break
    return ALIAS_SEP.join(out)


async def _extract(session_id: int, topic: str, model_id: str) -> tuple[str, str, str]:
    """One non-streaming call → (concept, aliases, stuck), ('', '', '') on failure.

    Test seam: monkeypatch me.
    """
    try:
        rows = await turns(session_id)
        if not rows:
            return "", "", ""

        from app.core.llm import ProviderInfo, stream_chat
        from app.routers.chat import resolve_model

        script = "\n\n".join(
            f"{'我' if t['role'] == 'user' else '老师'}：{t['content']}" for t in rows
        )[-END_EXTRACT_CHARS:]  # tail, not head: the 卡点 shows up late in a session

        resolved = await resolve_model(model_id)
        p = resolved.provider
        raw = "".join(
            [
                c
                async for c in stream_chat(
                    ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key),
                    resolved.model,
                    [
                        {"role": "system", "content": _EXTRACT_PROMPT},
                        {"role": "user", "content": f"话题：{topic}\n\n{script}"},
                    ],
                )
            ]
        )
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            return "", "", ""
        data = json.loads(m.group(0))
        if not isinstance(data, dict):
            return "", "", ""
        concept = str(data.get("concept") or "").strip()[:120]
        return (
            concept,
            _clean_aliases(data.get("aliases"), concept),
            str(data.get("stuck") or "").strip()[:200],
        )
    except Exception:  # noqa: BLE001 - the verdict is already saved; this is the extra
        log.warning("tutor extraction failed", exc_info=True)
        return "", "", ""


async def _nearby_material(concept: str, exclude: set[str] | None = None) -> list[dict]:
    """刚搞懂的概念 → 你的材料里还讲过这附近的东西（<=NEARBY_MAX 个文件）。

    第 7 节「从你的材料里发现你可能想搞懂的东西」的护栏版：查询是**这个会话
    刚谈完的概念**（你在场的上下文里顺手看见），不是一份推送清单。所以它只在
    `end()` 的返回里出现一次——没有表、没有计数、没有角标，下一次会话开始它
    就不在了。做之前回看过第 2 节。`exclude` 是本会话取材已经引用过的来源：
    「还有」的字面意思就是别推荐你刚看过的。
    """
    try:
        chunks = await _retrieve(concept, NEARBY_TOP_K + len(exclude or ()))
    except Exception:  # noqa: BLE001 - a dead index must not break the verdict
        log.warning("tutor nearby-material failed", exc_info=True)
        return []
    out: list[dict] = []
    seen: set[str] = set(exclude or ())
    for c in chunks:
        src = str(c.get("source") or "")
        if not src or src in seen:
            continue
        seen.add(src)
        out.append({"source": src, "title": str(c.get("title") or ""), "score": c.get("score", 0)})
        if len(out) >= NEARBY_MAX:
            break
    return out


async def end(session_id: int, verdict: str) -> dict:
    """Close a session: save your verdict, then extract 概念 / 别名 / 卡点 from the transcript,
    and look up what else in your KB touches the same concept (`material_nearby`).

    The verdict is the only manual input in the whole product, so it is written
    first and unconditionally: with the model down, 第 4 节's count still works
    and recall simply skips this row (`concept` stays ""). `useless` skips
    extraction — recall ignores those rows, so the call would buy nothing.

    Re-callable: changing 半懂 to 懂了 overwrites and re-extracts.
    """
    verdict = (verdict or "").strip()
    if verdict not in VERDICTS:
        raise ValueError(f"verdict must be one of {VERDICTS}")

    from app.db import SessionLocal
    from app.models import TutorSession, utcnow

    async with SessionLocal() as db:
        row = await db.get(TutorSession, session_id)
        if row is None:
            raise ValueError(f"no tutor session {session_id}")
        row.verdict = verdict
        row.ended_at = utcnow()
        await db.commit()
        topic, model_id = row.topic, row.model_id

    concept, aliases, stuck = "", "", ""
    nearby: list[dict] = []
    if verdict != "useless" and model_id:
        concept, aliases, stuck = await _extract(session_id, topic, model_id)
        if concept:  # a 卡点 with no concept is unrecallable, so both or neither
            async with SessionLocal() as db:
                row = await db.get(TutorSession, session_id)
                if row is not None:
                    row.concept, row.aliases, row.stuck = concept, aliases, stuck
                    await db.commit()
            nearby = await _nearby_material(concept, _SESSION_SOURCES.pop(session_id, None))
    _SESSION_SOURCES.pop(session_id, None)  # useless / 没提取出概念也要清掉残留
    return {
        "id": session_id,
        "verdict": verdict,
        "concept": concept,
        "aliases": aliases,
        "stuck": stuck,
        "material_nearby": nearby,
    }


# ---------- history and the two numbers 第 4 节 asks for ----------


async def sessions(limit: int = 50) -> list[dict]:
    """Newest first, for the page's rail. History, not a queue — no due dates and
    no unfinished count, per 第 2 节: anything that reads as debt is the old shape."""
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import TutorSession, TutorTurn, iso_utc

    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(TutorSession)
                .order_by(TutorSession.id.desc())
                .limit(max(1, min(int(limit or 50), 200)))
            )
        ).scalars().all()
        counts = dict(
            (
                await db.execute(
                    select(TutorTurn.session_id, func.count(TutorTurn.id))
                    .where(TutorTurn.session_id.in_([r.id for r in rows] or [0]))
                    .group_by(TutorTurn.session_id)
                )
            ).all()
        )
    return [
        {
            "id": r.id,
            "topic": r.topic,
            "concept": r.concept,
            "verdict": r.verdict,
            "stuck": r.stuck,
            "recalled": bool(r.recalled),
            "turn_count": int(counts.get(r.id, 0)),
            "created_at": iso_utc(r.created_at),
            "ended_at": iso_utc(r.ended_at),
        }
        for r in rows
    ]


async def stuck_points(limit: int = 200) -> list[dict]:
    """Every recorded 卡点, newest first — 「卡过的点」的全量来源。

    The rail's session list caps at 50 rows for display, and filtering stuck rows
    out of it would silently drop everything past that: a stuck point recorded in
    session #52 would be invisible forever. This scans all history instead. Like
    recall, `useless` verdicts are skipped — the teaching missed, the line proves
    nothing. A record, not a queue (第 2 节): no counts, no nudges.
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import TutorSession, iso_utc

    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(TutorSession)
                .where(TutorSession.stuck != "", TutorSession.verdict.in_(("got", "half")))
                .order_by(TutorSession.id.desc())
                .limit(max(1, min(int(limit or 200), 500)))
            )
        ).scalars().all()
    return [
        {
            "id": r.id,
            "concept": r.concept or r.topic,
            "stuck": r.stuck,
            "verdict": r.verdict,
            "created_at": iso_utc(r.created_at),
        }
        for r in rows
    ]


async def detail(session_id: int) -> dict | None:
    """One session plus its transcript (None if gone), so a reload can reopen it.

    `turns` is the message list here and `turn_count` is the number in
    `sessions()` — one key, one type, because a key that is a list in one payload
    and an int in another is the kind of thing the frontend gets wrong once.
    """
    from app.db import SessionLocal
    from app.models import TutorSession, iso_utc

    async with SessionLocal() as db:
        r = await db.get(TutorSession, session_id)
        if r is None:
            return None
        out = {
            "id": r.id,
            "topic": r.topic,
            "concept": r.concept,
            "verdict": r.verdict,
            "stuck": r.stuck,
            "recalled": bool(r.recalled),
            "model_id": r.model_id,
            "created_at": iso_utc(r.created_at),
            "ended_at": iso_utc(r.ended_at),
        }
    out["turns"] = await turns(session_id)
    return out


async def stats(days: int = 14) -> dict:
    """第 4 节's two numbers over the trailing `days`: how many sessions you marked
    「懂了」, and how many of those had recall fire.

    Not a dashboard — 第 4 节 says the honest record is three hand-written lines in
    LOG.md. This exists so 第 5 节's kill decision (「上次卡过」从没触发) is a lookup
    rather than a memory. `date(col,'localtime')` on the SQL side: the column is
    UTC in SQLite, so a Python-side local date would post a 22:00 session to
    tomorrow and quietly bend the metric that decides this feature's fate.
    """
    out = {"days": days, "sessions": 0, "got": 0, "got_with_recall": 0, "concepts": 0}
    try:
        from sqlalchemy import text as sql

        from app.db import SessionLocal

        async with SessionLocal() as db:
            row = (
                await db.execute(
                    sql(
                        "SELECT COUNT(*), "
                        "COALESCE(SUM(CASE WHEN verdict='got' THEN 1 ELSE 0 END),0), "
                        "COALESCE(SUM(CASE WHEN verdict='got' AND recalled THEN 1 ELSE 0 END),0), "
                        "COUNT(DISTINCT CASE WHEN concept<>'' THEN concept END) "
                        "FROM tutor_sessions "
                        "WHERE date(created_at,'localtime') >= date('now','localtime',:off)"
                    ),
                    {"off": f"-{max(1, int(days or 14)) - 1} days"},
                )
            ).first()
        if row:
            out.update(
                sessions=int(row[0] or 0),
                got=int(row[1] or 0),
                got_with_recall=int(row[2] or 0),
                concepts=int(row[3] or 0),
            )
    except Exception:  # noqa: BLE001 - stats must never break a page
        log.debug("tutor stats failed", exc_info=True)
    return out










