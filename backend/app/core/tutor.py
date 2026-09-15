"""对话式教学：说出想搞懂什么 → 先探理解 → 讲一段 → 出题 → 记下卡点。

The direction settled on 2026-09-05, replacing 制卡 + 间隔复习.
The load-bearing part is not the chat — any model does chat — it is that a
session ends with a 概念 / 自评 / 卡点 triple, and that the next session on a
related topic gets those triples back. If that recall never fires or never
helps, it gets cut, so it is kept in one module.

RAG 取材 was deliberately absent in the first step and added
afterwards (2026-09-06, gate lifted by the user): the
teaching now draws on the user's own vault / clippings when they match, but
stays silent when they don't. No tools, no scheduled jobs. Heavy imports stay
inside functions, matching the other core modules.
"""
import asyncio
import logging
import math
import re
from datetime import datetime

from pydantic import BaseModel, Field, field_validator
from app.core import usage_ledger

log = logging.getLogger(__name__)

HISTORY_LIMIT = 60  # turns sent back to the model; a session is one concept, not a day
# 中段压缩（maple-os 参考项）：攒够这么多轮新掉出窗口才重新压缩一次摘要——
# 一个额外的小模型调用摊在几十轮上，而不是每轮都付。
SUMMARY_BATCH = 4
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
# three recalled lines were wrong, which from the outside is the
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
# 会话结束时「材料里还有」的检索宽度与条数。它不是推荐队列：只在
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

# 费曼模式：同一个会话引擎，方向反过来。用户讲，模型当考官学生。
# 它是 mode 的实现细节，不是第二个产品——召回/画像/取材/压缩/end() 全部共用。
FEYNMAN_PROMPT = """你在「费曼模式」里扮演一个聪明但没搞懂的 学生 + 考官。用户会向你解释一个概念，你的任务是检验他是不是真的懂了。

规则：
1. 他讲完后，像一个真诚困惑的学生那样提问——追问没讲清的步骤、没定义的术语、跳掉的「为什么」。
2. 他甩术语而不解释时，要求他用大白话重说一遍；他类比含糊时，要一个具体例子。
3. 他讲对的部分不要重复夸奖，直接推进到更深一层。
4. 发现讲不通的地方，指出来矛盾在哪，让他自己再试一次——不要替他讲。
5. 只有他明确卡死或求救时，才给一次最小提示，然后继续让他自己往下讲。
6. 每轮只做一件事：提一个最好的问题，或指出一个最关键的漏洞。不要列清单。
7. 结尾如果他已经讲圆了，让他用三句话给完全外行的人再讲一遍——这是最终检验。

不要做的事：
- 不要接管讲解，哪怕你觉得你讲得更好——检验比讲解重要。
- 不要客套，不要说「很好的解释」。
- 不要一次抛三个问题。"""

MODES = ("socratic", "feynman", "future")

FUTURE_PROMPT = """你是用户一年后的自己，正在和今天的 TA 说话。你手里的「一年后的档案」来自 TA 的记忆、日记和学习记录——你就是从那些日子里走过来的。

规则：
1. 用「我」的口吻，温和、具体、不装。你知道 TA 正在学什么、卡在哪，因为你就这么走过来的。
2. 讲一年后的具体图景：哪些东西后来学会了、哪些当时觉得难后来发现不过如此、什么习惯留了下来。档案里没有的就说「我也不确定」——不要编造成功学，不要画饼。
3. 少给建议，多讲经历。要给就说「我当时是这么做的」，不要说「你应该」。
4. TA 说到焦虑、落后感的时候认真接住：用档案里 TA 自己过去的进步当证据，而不是空泛安慰。
5. 每轮 2-4 句，像聊天。不要列清单，不要一次把一年的事讲完——TA 会再问的。
6. 这是私人对话：不吹捧、不恐吓。你唯一的目标是让 TA 感到「一年后的我和现在的我是连续的」。
7. 不要透露你是模型、不要讨论这个设定本身——TA 需要的是一段和自己的对话，不是一次角色扮演评测。"""

# aliases 那一段的三条硬要求都是量出来的（2026-09-06 accept 实测，每个别名单独成一条
# 向量）：「至少 4 个字」挡「async」这种裸词 —— 它对无关查询「asyncio 里的任务调度」
# 拿到 0.632，越过 0.62；「不要纯英文」挡「coroutine suspension」这种 —— 中文查询对它
# 只有 0.256，而同一次提取里的中文说法「协程挂起后去哪」是 0.712。名额只有 4 个，浪费
# 一个就少一条能接住重逢的文本。
_EXTRACT_PROMPT = """你在读一段技术教学对话。只输出一个 JSON 对象，不要任何解释：

{"concept": "这次谈的核心概念，10 字以内的名词短语", "aliases": ["同一个概念的另一种问法", "再一种"], "stuck": "他卡在哪，一句话，20 字以内；如果全程没卡住就给空字符串", "transfer": "一句把概念放进新场景的检验问题，30 字以内；教得不好就给空字符串"}

concept 用领域里的标准叫法（例如「asyncio 事件循环」而不是「那个循环的事」），并且必须带上领域限定词——框架、语言或库的名字。写「asyncio 事件循环」，不要只写「事件循环」；写「SQLite WAL 模式」，不要只写「WAL 模式」。没有这个名字，下次换个说法提起这个话题时就对不上。

aliases 给 2-4 个，是同一个概念的**其他问法**：几个月后他又想起这个东西、但已经想不起标准术语时会怎么打字。所以要换词，不是换语序——用同义词、用大白话、用现象描述（写「协程什么时候切换」，不要写「事件循环的调度机制」）。每个都写成完整的一句问法、至少 4 个字：不要写「async」「GIL」「WAL」这种裸术语，也不要写纯英文短语，标准叫法已经在 concept 里了。不要把 concept 原样重复一遍，也不要写宽泛到能套任何概念的词（「并发」「性能」「原理」）。

stuck 要写他的错误理解本身（例如「以为 await 把控制权交给了操作系统」），不要写「不理解事件循环」这种空话。

transfer 是「换个场景再试一次」的问题：把这次的概念放到一个**不同的情境**里让他应用，而不是换个说法重复刚讲过的内容（刚学了 asyncio 事件循环，就问别的运行时或别的语言里对应的调度会怎样）。学过就在原场景里答得对不算懂，换个场景还能用才算——问题要真的换场景。教得潦草或概念太薄撑不起这种问题，就给空字符串。"""


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


async def start(
    topic: str, repo: str = "", mode: str = "socratic", origin_point_id: int | None = None
) -> dict:
    """Open a session on `topic`. Pins the model so the teaching voice can't
    change mid-session; reports whether that model is known-broken so the page
    can say so instead of failing on the first turn.

    `repo` 非空 = 代码库陪读：这场会话的取材只在 repos/<repo>/ 的 chunk 里找，
    仓库必须已在 prefs 的 repos 里索引过。
    `mode` = socratic（老师问你答，默认）| feynman（你讲它追问）。
    `origin_point_id` 非空 = 这一场是从「材料拆出的某个点」开出来的，把它在
    `digest_points` 里标成已教——它就不再算「未触及」。"""
    topic = (topic or "").strip()[:200]
    if not topic:
        raise ValueError("topic is empty")
    if mode not in MODES:
        raise ValueError(f"mode 必须是 {'/'.join(MODES)}")
    repo = (repo or "").strip()[:100]
    if repo:
        from app.core.prefs import load_config

        names = {r.get("name") for r in load_config().get("repos", []) if isinstance(r, dict)}
        if repo not in names:
            raise ValueError(f"仓库「{repo}」还没有被索引，先在知识库页同步它")

    from app.core import providers
    from app.db import SessionLocal
    from app.models import TutorSession

    model_id = providers.default_model_id() or ""
    async with SessionLocal() as db:
        row = TutorSession(topic=topic, model_id=model_id, repo=repo, mode=mode)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        sid = row.id
    if origin_point_id:
        await _mark_point_taught(origin_point_id, sid)
    return {
        "id": sid,
        "topic": topic,
        "repo": repo,
        "mode": mode,
        "model_id": model_id,
        "model_ok": bool(model_id) and not providers.is_unhealthy(model_id),
    }


async def _mark_point_taught(point_id: int, session_id: int) -> None:
    """一个建议点开成了教学 → 回填 `taught_session_id`，它不再是「未触及」。

    已标过的行不覆盖：一个点先开的场次才是它的出处。失败不影响教学本身。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import DigestPoint

    try:
        async with SessionLocal() as db:
            row = (
                await db.execute(select(DigestPoint).where(DigestPoint.id == point_id))
            ).scalar_one_or_none()
            if row is not None and row.taught_session_id is None:
                row.taught_session_id = session_id
                await db.commit()
    except Exception:  # noqa: BLE001 - 标注失败不该挡住这场教学
        log.warning("mark digest point taught failed", exc_info=True)


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
        # 别名为什么每个各成一条向量（五种拼法的代价如下，
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


# ---------- 学习画像：全量概念的水平一览（参考 ChatApp 用户画像） ----------


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


CONCEPTS_CAP = 200  # 学习轨迹一屏放得下的量；超出按最近时间截断


async def concepts() -> list[dict]:
    """按概念分组的学习轨迹，**纯派生，不落库** —— 「我学到哪了」的真值。

    `profile()` 只回答「哪些说通了 / 半懂」（两个裸清单），够用来校准讲解，但答不了
    「这个概念什么时候碰的、卡在哪、以前卡过的点接回来过几次」。这里补的就是这个切面：
    一个概念一行 = 最近一次自评 + 那次的卡点（**以及解没解**）+ 最后一次时间 + 会话次数
    + 召回触发次数。

    与 `stuck_points` 的分工：那是**逐条卡点记录**（同一概念可能有多条），这是**按概念
    收敛后的当前状态**。与 `profile()` 同一条线：useless 不算数（教学没成，证明不了
    水平），每个概念取最近一次——说通了后来又卡住，以新的为准。
    """
    try:
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import TutorSession, iso_utc

        async with SessionLocal() as db:
            rows = (
                await db.execute(
                    select(TutorSession)
                    .where(TutorSession.concept != "", TutorSession.verdict.in_(("got", "half")))
                    .order_by(TutorSession.id)
                )
            ).scalars().all()
    except Exception:  # noqa: BLE001 - 派生视图，坏了也不挡教学
        log.warning("tutor concepts query failed", exc_info=True)
        return []

    agg: dict[str, dict] = {}
    for r in rows:  # id 升序遍历：后写覆盖，即最近一次为准
        cur = agg.setdefault(
            r.concept,
            {
                "concept": r.concept,
                "verdict": "",
                "stuck": "",
                "stuck_resolved": False,
                "last_at": "",
                "last_session_id": 0,
                "sessions": 0,
                "recalled": 0,
            },
        )
        cur["verdict"] = r.verdict
        cur["stuck"] = r.stuck or ""
        cur["stuck_resolved"] = r.stuck_resolved_at is not None
        cur["last_at"] = iso_utc(r.created_at)
        cur["last_session_id"] = r.id
        cur["sessions"] += 1
        cur["recalled"] += 1 if r.recalled else 0
    ordered = sorted(agg.values(), key=lambda c: c["last_at"], reverse=True)
    return ordered[:CONCEPTS_CAP]


LEARNING_MAP_CAP = 200  # 每档一屏放得下的量
UNTOUCHED_CAP = 50  # 「未触及」只列最近的这些；更早的靠重拆材料再出来

MASTERY_MIN_SESSIONS = 2  # 一场是运气，两场才算学会——学习地图与零柒成长共用这一条


def _mastered(c: dict) -> bool:
    """一个概念「学会了」的唯一判定。学习地图的「已掌握」与零柒的成长事件共用它，
    免得同一条规则在两地各写一半、日后各改一半。"""
    return c["verdict"] == "got" and c["sessions"] >= MASTERY_MIN_SESSIONS


async def learning_map() -> dict:
    """学习地图：把概念分四档。**纯派生**（`untouched` 读的是 digest_points 建议日志）。

    - **已掌握**：最近一次说通了，且**不止一场**（一次是运气，两次才算学会）
    - **在学**：最近一次半懂，或只说通过一次
    - **卡住**：还有**未解**的卡点
    - **未触及**：digest 拆出来、但还没开成教学的点

    与 `concepts()` 同一条规矩：`useless` 不算数，每个概念取最近一次。**不新增学习状态
    表**——真值仍然只有 `tutor_sessions`；`digest_points` 只是建议日志。

    「卡住」优先于前两档：一个还挂着未解卡点的概念，最该出现的位置是卡住那一档，哪怕它
    最近一次是「说通了」。正常情况两者不冲突——说通了一个概念会自动把它的卡点关掉
    （见 `_resolve_concept_stucks`），所以挂在卡住档的，正是还没走完这条路的概念。
    """
    cs = await concepts()
    unresolved = {s["concept"] for s in await stuck_points() if not s.get("resolved_at")}
    mastered: list[dict] = []
    learning: list[dict] = []
    stuck: list[dict] = []
    for c in cs:
        if c["concept"] in unresolved:
            stuck.append(c)
        elif _mastered(c):
            mastered.append(c)
        else:
            learning.append(c)
    return {
        "mastered": mastered[:LEARNING_MAP_CAP],
        "learning": learning[:LEARNING_MAP_CAP],
        "stuck": stuck[:LEARNING_MAP_CAP],
        "untouched": await _untouched_points(),
    }


async def _untouched_points(limit: int = UNTOUCHED_CAP) -> list[dict]:
    """digest 拆出来、还没开成教学的点（`taught_session_id IS NULL`），新→旧。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import DigestPoint, iso_utc

    try:
        async with SessionLocal() as db:
            rows = (
                await db.execute(
                    select(DigestPoint)
                    .where(DigestPoint.taught_session_id.is_(None))
                    .order_by(DigestPoint.id.desc())
                    .limit(max(1, min(int(limit or UNTOUCHED_CAP), 200)))
                )
            ).scalars().all()
    except Exception:  # noqa: BLE001 - 派生视图，坏了不挡教学
        log.warning("tutor untouched points query failed", exc_info=True)
        return []
    return [
        {
            "id": r.id,
            "point": r.point,
            "why": r.why or "",
            "source": r.source,
            "created_at": iso_utc(r.created_at),
        }
        for r in rows
    ]


async def untouched_count() -> int:
    """还没开成教学的 digest 点数（真计数，不是清单长度）。

    `_untouched_points()` 按 `UNTOUCHED_CAP=50` 截断，拿它 len() 会永远停在 50——
    今日概览要的是「有几件还堆着」，得直接 count。best-effort：坏了返回 0，别挡概览。
    """
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import DigestPoint

    try:
        async with SessionLocal() as db:
            n = (
                await db.execute(
                    select(func.count(DigestPoint.id)).where(
                        DigestPoint.taught_session_id.is_(None)
                    )
                )
            ).scalar()
    except Exception:  # noqa: BLE001 - 派生计数，坏了不该挡今日页
        log.warning("tutor untouched count failed", exc_info=True)
        return 0
    return int(n or 0)


NEIGHBOR_LIMIT = 6  # 一屏列得下的邻居数


async def _neighbors_via_thread(sids: list[int]) -> set[str]:
    """同一件「事」上挂着的其它教学概念 —— 最结实的证据（是你自己归到一起的）。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import ThreadItem, TutorSession

    refs = [str(s) for s in sids]
    try:
        async with SessionLocal() as db:
            threads = (
                await db.execute(
                    select(ThreadItem.thread_id).where(
                        ThreadItem.kind == "tutor", ThreadItem.ref.in_(refs)
                    )
                )
            ).scalars().all()
            if not threads:
                return set()
            other_refs = (
                await db.execute(
                    select(ThreadItem.ref).where(
                        ThreadItem.kind == "tutor",
                        ThreadItem.thread_id.in_(list(threads)),
                        ThreadItem.ref.notin_(refs),
                    )
                )
            ).scalars().all()
            ids = [int(r) for r in other_refs if str(r).isdigit()]
            if not ids:
                return set()
            names = (
                await db.execute(
                    select(TutorSession.concept).where(
                        TutorSession.id.in_(ids), TutorSession.concept != ""
                    )
                )
            ).scalars().all()
        return {n for n in names if n}
    except Exception:  # noqa: BLE001 - 派生视图，坏了不挡教学
        log.warning("tutor neighbors/thread failed", exc_info=True)
        return set()


async def _neighbors_via_material(sids: list[int]) -> set[str]:
    """从**同一份材料**拆出来、又都教过的两个点 —— 共现的最直接形态。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import DigestPoint, TutorSession

    try:
        async with SessionLocal() as db:
            sources = (
                await db.execute(
                    select(DigestPoint.source).where(
                        DigestPoint.taught_session_id.in_(sids), DigestPoint.source != ""
                    )
                )
            ).scalars().all()
            if not sources:
                return set()
            other = (
                await db.execute(
                    select(DigestPoint.taught_session_id).where(
                        DigestPoint.source.in_(list(sources)),
                        DigestPoint.taught_session_id.isnot(None),
                        DigestPoint.taught_session_id.notin_(sids),
                    )
                )
            ).scalars().all()
            if not other:
                return set()
            names = (
                await db.execute(
                    select(TutorSession.concept).where(
                        TutorSession.id.in_(list(other)), TutorSession.concept != ""
                    )
                )
            ).scalars().all()
        return {n for n in names if n}
    except Exception:  # noqa: BLE001
        log.warning("tutor neighbors/material failed", exc_info=True)
        return set()


async def concept_neighbors(concept: str, limit: int = NEIGHBOR_LIMIT) -> list[dict]:
    """一个概念的「邻居」—— 三路证据，纯派生、不落库。

    - **同一件事**：两个概念都挂在同一件「事」上（Thread 的 tutor 条目）；
    - **同一份材料**：两个概念是从同一份材料拆出来的点教出来的（`digest_points.source`）；
    - **语义相近**：概念名的嵌入余弦过 `RECALL_MIN_SIM`（就是召回那条实测底线，不另造一个）。

    结构性证据（事 / 材料）排在语义前面：那是**你自己**归到一起的，比向量的猜测可信。
    返回 `[{concept, why, score}]`，why 空 = 只是语义近。
    """
    concept = (concept or "").strip()
    if not concept:
        return []
    others = {c["concept"] for c in await concepts() if c["concept"] and c["concept"] != concept}
    if not others:
        return []

    try:
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import TutorSession

        async with SessionLocal() as db:
            sids = list(
                (
                    await db.execute(
                        select(TutorSession.id).where(TutorSession.concept == concept)
                    )
                ).scalars().all()
            )
    except Exception:  # noqa: BLE001
        sids = []

    evidence: dict[str, set[str]] = {}

    def _mark(names: set[str], why: str) -> None:
        for n in names & others:  # 邻居必须是地图上真的存在的概念
            evidence.setdefault(n, set()).add(why)

    if sids:
        _mark(await _neighbors_via_thread(sids), "同一件事")
        _mark(await _neighbors_via_material(sids), "同一份材料")

    sims: dict[str, float] = {}
    try:
        names = sorted(others)
        vecs = await _embed([concept, *names])
        base = vecs[0]
        for n, v in zip(names, vecs[1:]):
            s = _cosine(base, v)
            if s >= RECALL_MIN_SIM:
                sims[n] = s
    except Exception:  # noqa: BLE001 - 向量挂了就只剩结构性证据
        log.warning("tutor neighbors/embed failed", exc_info=True)

    ranked = sorted(
        set(evidence) | set(sims),
        key=lambda n: (len(evidence.get(n, ())), sims.get(n, 0.0)),
        reverse=True,
    )
    cap = max(1, min(int(limit or NEIGHBOR_LIMIT), 20))
    return [
        {"concept": n, "why": " · ".join(sorted(evidence.get(n, ()))), "score": round(sims.get(n, 0.0), 3)}
        for n in ranked[:cap]
    ]


async def mastery_events() -> dict:
    """成长事件：一个概念「学会了」的那些时刻 —— 零柒成长模型的原料（A3）。

    规则与学习地图「已掌握」**同一条**（`_mastered`）：最近一次自评说通了，且不止
    一场——一场是运气，两场才算学会。事件时间取**最近那次说通**的时刻。

    `from_half` 是这条路上值钱的那一格：这个概念以前半懂过、后来才说通。「从半懂到
    懂」比「一上来就懂」更值得记一笔，也是零柒能说出口的那句人话。

    纯派生，不落库——真值仍然只有 `tutor_sessions`。坏掉也不挡教学，返回空表。
    """
    cs = await concepts()
    mastered = [c for c in cs if _mastered(c)]
    if not mastered:
        return {"events": [], "mastered": 0, "learning": len(cs), "sessions": 0}

    half_seen: set[str] = set()
    try:
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import TutorSession

        async with SessionLocal() as db:
            rows = (
                await db.execute(
                    select(TutorSession.concept).where(
                        TutorSession.concept.in_([c["concept"] for c in mastered]),
                        TutorSession.verdict == "half",
                    )
                )
            ).scalars().all()
        half_seen = set(rows)
    except Exception:  # noqa: BLE001 - 派生视图，坏了不挡教学也不挡成长
        log.warning("tutor mastery half-history query failed", exc_info=True)

    events = sorted(
        (
            {
                "concept": c["concept"],
                "at": c["last_at"],
                "sessions": c["sessions"],
                "recalled": c["recalled"],
                "from_half": c["concept"] in half_seen,
            }
            for c in mastered
        ),
        key=lambda e: e["at"],
        reverse=True,
    )
    return {
        "events": events,
        "mastered": len(events),
        "learning": len(cs) - len(events),
        "sessions": sum(c["sessions"] for c in cs),
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


def format_future_dossier(prof: dict, memories: list, entries: list, blocks: list) -> str:
    """四路数据 → 「一年后的档案」注入块。Pure，离线可测。

    空档案返回 ''——say() 那边 profile_block 为空时 FUTURE_PROMPT 本身仍然
    成立（模型靠「我也不确定」兜底），未来模式不能因为哪块数据缺席就说不出话。
    """
    lines: list[str] = []
    now = datetime.now().astimezone()
    lines.append(
        f"【时间锚点】TA 今天是 {now:%Y-%m-%d}。你是一年后的 TA（约 {now.year + 1} 年），"
        "从下面这些日子里走过来的。"
    )
    known = (prof.get("known") or [])[:PROFILE_LIST_CAP]
    half = (prof.get("half") or [])[:PROFILE_LIST_CAP]
    if known or half:
        lines.append(
            "【TA 在学什么】已说通过：" + ("、".join(known) or "暂无")
            + "；还半懂：" + ("、".join(half) or "暂无")
        )
    journal_lines = [f"{e.get('date', '')[5:]} {e.get('time', '')} 「{(e.get('text') or '')[:60]}」" for e in entries[:5]]
    if journal_lines:
        lines.append("【TA 最近写的日记】\n" + "\n".join(journal_lines))
    fact_lines = [f"- {m.content}" for m in memories[:12]]
    if fact_lines:
        lines.append("【TA 的长期记忆】\n" + "\n".join(fact_lines))
    stuck_lines = [f"- {title}：{text}" for title, text in blocks[:3]]
    if stuck_lines:
        lines.append("【TA 最近卡过的点】\n" + "\n".join(stuck_lines))
    if len(lines) == 1:
        return ""
    return "\n\n".join(lines)


async def _future_dossier() -> str:
    """「一年后的档案」：四路来源各取一点，全部 best-effort——未来模式不能因为
    哪一块挂了就说不出话。纯查询无 LLM，每轮现算（数据在变，档案跟着变）。"""
    from app.core import journal
    from app.core.memory import list_memories

    prof: dict = {}
    memories: list = []
    entries: list = []
    blocks: list = []
    try:
        prof = await profile()
    except Exception:  # noqa: BLE001
        log.warning("future dossier: profile failed", exc_info=True)
    try:
        memories = await list_memories()
    except Exception:  # noqa: BLE001
        log.warning("future dossier: memories failed", exc_info=True)
    try:
        entries = journal.recent(5)
    except Exception:  # noqa: BLE001
        log.warning("future dossier: journal failed", exc_info=True)
    try:
        blocks = await stuck_blocks(days=90, cap=3)
    except Exception:  # noqa: BLE001
        log.warning("future dossier: stuck blocks failed", exc_info=True)
    try:
        return format_future_dossier(prof, memories, entries, blocks)
    except Exception:  # noqa: BLE001
        log.warning("future dossier: format failed", exc_info=True)
        return ""


# ---------- 取材：讲你自己的材料，而不是通用答案 ----------


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


async def _retrieve_scoped(query: str, top_k: int, source_prefix: str) -> list[dict]:
    """限定来源前缀的取材（代码库陪读的边界）。

    search_auto 没有过滤参数，超取 4 倍再客户端过滤；过滤后为空就返回空——
    材料块本就是「有就讲，没有就不硬扯」。Test seam: monkeypatch me."""
    hits = await _retrieve(query, top_k * 4)
    scoped = [h for h in hits if str(h.get("source") or "").startswith(source_prefix)]
    return scoped[:top_k]


# ---------- one teaching reply ----------


def _speaker(role: str) -> str:
    return "用户" if role == "user" else "老师"


def split_history(history: list[dict]) -> tuple[list[dict], list[dict]]:
    """(window, dropped-middle) — the truncation rule in one place, so the
    compression range and the actually-discarded range can never drift apart.
    The window keeps the opening turn (the topic anchor) exactly as
    build_messages has always truncated.
    """
    if len(history) <= HISTORY_LIMIT:
        return history, []
    recent = history[-HISTORY_LIMIT:]
    # 60 turns on one concept is already unusual, but losing the opening line
    # is what makes the model forget what it is teaching, so it survives.
    recent = [history[0], *recent[1:]]
    return recent, history[1 : len(history) - HISTORY_LIMIT + 1]


def format_older(summary: str, uncovered: list[dict]) -> str:
    """Compressed middle + turns not yet covered by it → one system block
    ('' if neither exists). Pure, so it is testable.

    `uncovered` is honest slack: between summary refreshes a few dropped turns
    would otherwise exist nowhere (not in the window, not in the summary), so
    they ride along verbatim until the next batch compresses them.
    """
    if not summary and not uncovered:
        return ""
    parts: list[str] = []
    if summary:
        parts.append(f"较早对话的摘要：\n{summary}")
    if uncovered:
        lines = [f"{_speaker(t['role'])}：{t['content']}" for t in uncovered]
        parts.append("摘要之后、掉出窗口之前的几轮原文：\n" + "\n".join(lines))
    return (
        "以下是本次会话较早的部分（已不在最近的对话窗口里）：\n\n"
        + "\n\n".join(parts)
        + "\n\n把它当作你已经知道的背景接着教，不要重复问已经回答过的内容。"
    )


def build_messages(
    history: list[dict],
    recall: str = "",
    material: str = "",
    profile: str = "",
    older: str = "",
    voice: str = SOCRATIC_PROMPT,
) -> list[dict]:
    """Prompt for one reply: teaching voice, then recall, then profile, then
    material, then the compressed older middle, then the transcript.

    `voice` picks the persona (socratic teacher vs feynman examiner); it is the
    first system message and everything downstream is mode-agnostic.

    Recall is a second system message rather than being glued onto
    SOCRATIC_PROMPT: with nothing to recall the voice is then byte-identical
    every turn, so when the teaching drifts it is clear which block moved.
    Profile sits after recall — it is the stable breadth picture; material sits
    after profile; `older` sits nearest the transcript — it *is* conversation,
    and the model reads what is adjacent when picking up the thread.
    """
    msgs: list[dict] = [{"role": "system", "content": voice}]
    if recall:
        msgs.append({"role": "system", "content": recall})
    if profile:
        msgs.append({"role": "system", "content": profile})
    if material:
        msgs.append({"role": "system", "content": material})
    if older:
        msgs.append({"role": "system", "content": older})
    recent, _dropped = split_history(history)
    msgs.extend({"role": t["role"], "content": t["content"]} for t in recent)
    return msgs


async def _stream(model_id: str, messages: list[dict]):
    """One streaming teaching call. Test seam: monkeypatch me.

    The pinned provider is tried first; if it yields nothing at all (dead URL,
    bad key), the next enabled provider serves the turn — teaching must not
    stop because one endpoint is down. Once text is flowing, errors propagate:
    a mid-stream switch would duplicate or garble the reply.
    """
    from sqlalchemy import select

    from app.core.llm import ProviderInfo, stream_chat_fallback
    from app.models import ProviderConfig
    from app.routers.chat import resolve_model

    resolved = await resolve_model(model_id)
    p = resolved.provider
    candidates = [
        (
            ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key),
            resolved.model,
            f"{p.name}/{resolved.model}",
        )
    ]
    from app.db import SessionLocal

    async with SessionLocal() as db:
        others = (
            await db.execute(
                select(ProviderConfig)
                .where(ProviderConfig.enabled.is_(True), ProviderConfig.id != p.id)
                .order_by(ProviderConfig.id)
            )
        ).scalars().all()
    for o in others:
        if o.models:
            candidates.append(
                (
                    ProviderInfo(kind=o.kind, base_url=o.base_url, api_key=o.api_key),
                    o.models[0],
                    f"{o.name}/{o.models[0]}",
                )
            )
    async for delta in stream_chat_fallback(candidates, messages):
        yield delta


# ---------- 中段压缩：超出窗口的对话不丢弃，压成摘要跟着走 ----------


_SUMMARY_SYSTEM = (
    "你在压缩一段苏格拉底式教学会话的较早部分，摘要将替代原文放进后续对话上下文。"
    "只输出摘要正文，不超过 300 字，必须保留：在讨论什么概念、已经讲通了什么、"
    "用户卡在哪里、得出了什么结论或约定。不要评论，不要开头语和收尾语。"
)


async def _summarize(model_id: str, prior: str, dropped: list[dict]) -> str:
    """One small model call compressing the dropped middle. Test seam: monkeypatch me."""
    from app.core.llm import ProviderInfo, stream_chat
    from app.routers.chat import resolve_model

    resolved = await resolve_model(model_id)
    p = resolved.provider
    convo = "\n".join(f"{_speaker(t['role'])}：{t['content']}" for t in dropped)
    user = (f"已有摘要（在此基础上合并重新压缩）：\n{prior}\n\n" if prior else "") + f"对话原文：\n{convo}"
    parts = [
        c
        async for c in stream_chat(
            ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key),
            resolved.model,
            [{"role": "system", "content": _SUMMARY_SYSTEM}, {"role": "user", "content": user}],
        )
    ]
    return "".join(parts).strip()


async def _older_block(session_id: int, history: list[dict], model_id: str) -> str:
    """The system block for turns that fell out of HISTORY_LIMIT ('' when none).

    The summary is cached on the session row (summary / summary_upto) and
    re-compressed lazily once SUMMARY_BATCH new turns have dropped out of the
    window: a long session pays one extra small call every few dozen turns,
    not one per turn. Turn rows are never touched — this compresses the
    *prompt*; end() still extracts from the full history. A compression failure
    just degrades to injecting the uncovered turns verbatim; teaching never
    stops for it.
    """
    from app.db import SessionLocal
    from app.models import TutorSession

    _recent, dropped = split_history(history)
    if not dropped:
        return ""
    async with SessionLocal() as db:
        row = await db.get(TutorSession, session_id)
        if row is None:
            return ""
        covered = int(row.summary_upto or 0)
        summary = row.summary or ""
        uncovered = dropped[covered:]
        if len(uncovered) >= SUMMARY_BATCH:
            try:
                new = await _summarize(model_id, summary, dropped)
            except Exception:  # noqa: BLE001 - compression is an enhancement, not a dependency
                log.warning("tutor history compression failed", exc_info=True)
            else:
                if new:
                    summary, uncovered = new, []
                    row.summary, row.summary_upto = new, len(dropped)
                    await db.commit()
    return format_older(summary, uncovered)


@usage_ledger.traced("tutor")
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
        repo = row.repo or ""
        mode = row.mode or "socratic"
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
        # Flagged on the row the first time it fires, so "recall never
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
    # 取材是增强，教学不能因为它停下来。仓库陪读会话的取材被限定在
    # repos/<repo>/ 里——普通取材会把整个 vault 的东西都捞进来。
    try:
        if repo:
            sources = await _retrieve_scoped(text, MATERIAL_TOP_K, f"repos/{repo}/")
        else:
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

    profile_block = await _profile_block()
    older = await _older_block(session_id, history, model_id)
    # 费曼会话换声部：提示词反转，其余块（召回/画像/材料/压缩）一概不动。
    # 未来会话更进一步：声部换成「一年后的你」，画像块整个换成一年后的档案——
    # 教学画像对这场对话是反效果（未来的 TA 不需要被提醒 TA 半懂什么，TA 要讲
    # 一年之后的事）。
    voice = {"socratic": SOCRATIC_PROMPT, "feynman": FEYNMAN_PROMPT, "future": FUTURE_PROMPT}.get(
        mode, SOCRATIC_PROMPT
    )
    if mode == "future":
        profile_block = await _future_dossier()
    parts: list[str] = []
    try:
        async for delta in _stream(
            model_id,
            build_messages(history, format_recall(hits), format_material(sources), profile_block, older, voice),
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
    on, which is the one thing this product calls its only value.
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


class TutorExtract(BaseModel):
    """end() 的提取结果。字段宽松：类型不对一律当空，避免一次模型抖动丢掉整条记录。

    裁剪长度与原实现保持一致（concept 120 / stuck 200 / transfer 120）。超长
    不报错、只截断——截断比为了长度再触发一次模型调用划算。
    """

    concept: str = ""
    aliases: list[str] = Field(default_factory=list)
    stuck: str = ""
    transfer: str = ""

    @field_validator("aliases", mode="before")
    @classmethod
    def _as_list(cls, v):
        if v is None:
            return []
        if isinstance(v, str):
            return re.split(r"[、,，;；/|\n]+", v) if v.strip() else []
        if isinstance(v, list):
            return [str(x).strip() for x in v if str(x).strip()]
        return []

    @field_validator("concept", "stuck", "transfer", mode="before")
    @classmethod
    def _as_text(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()


DIGEST_MAX_POINTS = 12  # 一次拆这么多；再多就不是「逐点去搞懂」，而是又一张待办清单
DIGEST_MATERIAL_CHARS = 6000  # 拆点看的是材料在讲什么，用不着整篇；头部够定性


class TutorDigestPoint(BaseModel):
    title: str = ""  # 一句话的点，尽量是他自己会问出口的那种问法
    why: str = ""  # 为什么容易卡 / 它在材料里的位置

    @field_validator("title", "why", mode="before")
    @classmethod
    def _as_text(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()


class TutorDigest(BaseModel):
    points: list[TutorDigestPoint] = Field(default_factory=list)

    @field_validator("points", mode="before")
    @classmethod
    def _as_list(cls, v):
        if v is None:
            return []
        if isinstance(v, dict):  # 有的模型会给单个对象而不是数组
            return [v]
        if not isinstance(v, list):
            return []
        # 数组里混进字符串/数字是常见抖动：丢掉它们，别让一条杂物毁掉整批点
        return [x for x in v if isinstance(x, dict)]


_DIGEST_PROMPT = """你在帮一个人把手上这份材料拆成「要搞懂的点」——每个点之后会单独开一场教学去搞懂它。

只输出一个 JSON 对象，不要任何解释：
{{"points": [{{"title": "…", "why": "…"}}]}}

规则：
- 只挑**值得单独开一场教学**的点：一个概念、一个机制、一处容易搞错的地方。
- 不要挑目录式的概括（「本文介绍了 X 的用法」），也不要太泛（「理解整个系统」）。
- title 写成他会问出口的那句话，别堆名词。
- why 一句话说清「为什么这里容易卡」或「它在材料里的位置」，不超过 40 字。
- 按材料里的先后顺序，最多 {limit} 个。
- 材料里没讲的不要编。
"""


async def _digest_points(material: str, label: str, model_id: str) -> list[dict]:
    """一次结构化调用 → [{title, why}]。拆不出来就抛，交给 `digest()` 兜成人话。
    Test seam: monkeypatch me.
    """
    from app.core.llm import ProviderInfo
    from app.core.structured import extract_json
    from app.routers.chat import resolve_model

    resolved = await resolve_model(model_id)
    p = resolved.provider
    obj, meta = await extract_json(
        ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key),
        resolved.model,
        [
            {"role": "system", "content": _DIGEST_PROMPT.format(limit=DIGEST_MAX_POINTS)},
            {"role": "user", "content": f"材料：{label}\n\n{material}"},
        ],
        TutorDigest,
    )
    if obj is None:
        raise ValueError(meta.error or "模型没有给出可用的结果")
    out: list[dict] = []
    for pt in obj.points:
        title = pt.title[:120]
        if not title:
            continue
        out.append({"title": title, "why": pt.why[:80]})
        if len(out) >= DIGEST_MAX_POINTS:
            break
    return out


async def digest(source_path: str = "", text: str = "") -> dict:
    """一份材料 → 「要搞懂的点」。**两条线的交汇点**：材料进来是收敛的，哪几点要搞懂是发散的。

    这里只做一件事：读材料、挑点。逐点开教学走现成的 `start()`，出卡走现成的卡片链，
    理解状态靠 `end()` 回写——不重复造任何一段。

    拆出的点会写进 `digest_points`：那是**建议日志，不是学习状态**（学习状态的真值仍然
    只有 `tutor_sessions`）。它存在的唯一理由，是让「拆出来但还没开教的点」有个落点，
    供学习地图的「未触及」一档取用。点开成教学后回填 `taught_session_id`。
    """
    from app.core import cards as _cards

    source, label, material = _cards.collect_material(source_path=source_path, text=text)

    from app.core import providers

    model_id = providers.default_model_id() or ""
    if not model_id:
        return {
            "source": source,
            "source_label": label,
            "points": [],
            "error": "还没有可用的模型，先去设置里配一个",
        }
    try:
        points = await _digest_points(material[:DIGEST_MATERIAL_CHARS], label, model_id)
    except Exception as e:  # noqa: BLE001 - 拆点挂了，材料本身不该跟着丢
        log.warning("tutor digest failed", exc_info=True)
        return {"source": source, "source_label": label, "points": [], "error": f"拆点失败：{e}"}
    points = await _remember_points(source, points)
    return {"source": source, "source_label": label, "points": points, "error": ""}


async def _remember_points(source: str, points: list[dict]) -> list[dict]:
    """拆出的点写进 `digest_points`，回带 id（`[{id, title, why}]`）。

    去重按 `(source, point)`：同一份材料重拆一遍不该堆出第二行。**已存在的行只复用 id，
    不动 `taught_session_id`**——那个点教没教过是既成事实，重拆不改变它。

    落库失败**不回退功能**：把点原样还给用户（id=0），只是「未触及」一档少几条记录。
    """
    if not points:
        return []
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import DigestPoint

    try:
        async with SessionLocal() as db:
            existing = {
                r.point: r
                for r in (
                    await db.execute(select(DigestPoint).where(DigestPoint.source == source))
                ).scalars().all()
            }
            out: list[dict] = []
            seen: set[str] = set()
            for p in points:
                title = p.get("title", "")
                if not title or title in seen:
                    continue
                seen.add(title)
                row = existing.get(title)
                if row is None:
                    row = DigestPoint(source=source, point=title, why=p.get("why", ""))
                    db.add(row)
                    await db.flush()  # 拿自增 id
                out.append({"id": row.id, "title": title, "why": p.get("why", "")})
            await db.commit()
        return out
    except Exception:  # noqa: BLE001 - 记不住建议不该拖垮拆点
        log.warning("tutor digest points persist failed", exc_info=True)
        return [{"id": 0, "title": p.get("title", ""), "why": p.get("why", "")} for p in points]


async def _extract(session_id: int, topic: str, model_id: str) -> tuple[str, str, str, str]:
    """One non-streaming call → (concept, aliases, stuck, transfer), all '' on failure.

    transfer（Bjork 可取难度的会话内版）：一句把概念放进新场景的检验问题，
    只在 end() 的总结里出现一次——不是题库，不落库，没有第二次出现。
    Test seam: monkeypatch me.
    """
    try:
        rows = await turns(session_id)
        if not rows:
            return "", "", "", ""

        from app.core.llm import ProviderInfo
        from app.core.structured import extract_json
        from app.routers.chat import resolve_model

        script = "\n\n".join(
            f"{'我' if t['role'] == 'user' else '老师'}：{t['content']}" for t in rows
        )[-END_EXTRACT_CHARS:]  # tail, not head: the 卡点 shows up late in a session

        resolved = await resolve_model(model_id)
        p = resolved.provider
        obj, meta = await extract_json(
            ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key),
            resolved.model,
            [
                {"role": "system", "content": _EXTRACT_PROMPT},
                {"role": "user", "content": f"话题：{topic}\n\n{script}"},
            ],
            TutorExtract,
        )
        if obj is None:
            log.info("tutor extraction unavailable: %s", meta.error)
            return "", "", "", ""
        concept = obj.concept[:120]
        return (
            concept,
            _clean_aliases(obj.aliases, concept),
            obj.stuck[:200],
            obj.transfer[:120],
        )
    except Exception:  # noqa: BLE001 - the verdict is already saved; this is the extra
        log.warning("tutor extraction failed", exc_info=True)
        return "", "", "", ""


async def _nearby_material(concept: str, exclude: set[str] | None = None) -> list[dict]:
    """刚搞懂的概念 → 你的材料里还讲过这附近的东西（<=NEARBY_MAX 个文件）。

    「从你的材料里发现你可能想搞懂的东西」的护栏版：查询是**这个会话
    刚谈完的概念**（你在场的上下文里顺手看见），不是一份推送清单。所以它只在
    `end()` 的返回里出现一次——没有表、没有计数、没有角标，下一次会话开始它
    就不在了。`exclude` 是本会话取材已经引用过的来源：
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


async def _note_first_mastery(concept: str, mode: str = "socratic") -> None:
    """第一次说通一个概念时，让零柒记一句（成长陪伴的原料）。

    规则刻意比「已掌握」（连着两次说通）浅一档：从「半懂 / 没碰过」到**第一次说通**
    才是那个有情绪的时刻；第二次说通是巩固，不必重复庆祝。同一概念只会触发一次，
    因为判据是「这个概念的 got 场次 ≤ 1」。零柒那边是 best-effort，坏了也不挡教学。

    `mode` 只影响**那句话的主语**：费曼模式是「你讲给它听」，说通的是你的讲解，
    不是你的理解——同一个概念、两条路，台词不该一样。
    """
    try:
        from sqlalchemy import func, select

        from app.db import SessionLocal
        from app.models import TutorSession

        async with SessionLocal() as db:
            n = (
                await db.execute(
                    select(func.count(TutorSession.id)).where(
                        TutorSession.concept == concept, TutorSession.verdict == "got"
                    )
                )
            ).scalar() or 0
        if int(n) <= 1:
            from app.core import pet

            pet.emit("mastered", name=concept, detail="taught" if mode == "feynman" else "")
    except Exception:  # noqa: BLE001 - 一句台词而已，绝不能挡住自评落库
        log.debug("tutor first-mastery note failed", exc_info=True)


async def end(session_id: int, verdict: str) -> dict:
    """Close a session: save your verdict, then extract 概念 / 别名 / 卡点 / 迁移问题
    from the transcript, and look up what else in your KB touches the same
    concept (`material_nearby`).

    The verdict is the only manual input in the whole product, so it is written
    first and unconditionally: with the model down, the session count still works
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
        mode = row.mode or "socratic"

    concept, aliases, stuck, transfer = "", "", "", ""
    nearby: list[dict] = []
    # 未来会话不是教学：提取概念/卡点只会把「和未来的自己聊天」的内容污染进
    # 画像和召回——自评照存（记录是你的），提取跳过。
    if verdict != "useless" and model_id and mode != "future":
        concept, aliases, stuck, transfer = await _extract(session_id, topic, model_id)
        if concept:  # a 卡点 with no concept is unrecallable, so both or neither
            async with SessionLocal() as db:
                row = await db.get(TutorSession, session_id)
                if row is not None:
                    row.concept, row.aliases, row.stuck = concept, aliases, stuck
                    await db.commit()
            if verdict == "got":
                # 「结束回写」：说通了这个概念，它到此为止的卡点一并关掉
                await _resolve_concept_stucks(concept, session_id)
                await _note_first_mastery(concept, mode)
            nearby = await _nearby_material(concept, _SESSION_SOURCES.pop(session_id, None))
    _SESSION_SOURCES.pop(session_id, None)  # useless / 没提取出概念也要清掉残留
    return {
        "id": session_id,
        "verdict": verdict,
        "concept": concept,
        "aliases": aliases,
        "stuck": stuck,
        "transfer": transfer,
        "material_nearby": nearby,
    }


# ---------- history and the two numbers ----------


async def sessions(limit: int = 50) -> list[dict]:
    """Newest first, for the page's rail. History, not a queue — no due dates and
    no unfinished count: anything that reads as debt is the old shape."""
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
            "mode": r.mode or "socratic",
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
    nothing.

    `resolved_at` 非空 = 这条已经解了（同一概念后来说通了，或你手动关掉）。卡点本身
    照旧留在 `stuck` 里当记录；状态是另一轴，所以这里**不过滤**——待解/已解怎么摆是
    界面的事，但全量得看得到。
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
            "resolved_at": iso_utc(r.stuck_resolved_at) if r.stuck_resolved_at else "",
        }
        for r in rows
    ]


async def _resolve_concept_stucks(concept: str, upto_id: int) -> int:
    """说通了一个概念 → 它到此为止记下的卡点全部关掉（「结束回写」）。

    `upto_id` 含当前这一场：自评「搞懂了」而这一场又记了卡点，意思是「说通了，
    当时卡在 X」——卡点留着当记录，状态跟着自评走。返回关掉了几条。
    """
    from sqlalchemy import update

    from app.db import SessionLocal
    from app.models import TutorSession, utcnow

    async with SessionLocal() as db:
        res = await db.execute(
            update(TutorSession)
            .where(
                TutorSession.concept == concept,
                TutorSession.stuck != "",
                TutorSession.stuck_resolved_at.is_(None),
                TutorSession.id <= upto_id,
            )
            .values(stuck_resolved_at=utcnow())
        )
        await db.commit()
        return int(res.rowcount or 0)


async def resolve_stuck(session_id: int, resolved: bool = True) -> dict:
    """手动把一条卡点标成已解 / 待解。

    这不是主要出口（自动回写在 `end()` 里），兜的是「我不打算再管这个了」——
    没有它，清单只增不减。
    """
    from app.db import SessionLocal
    from app.models import TutorSession, utcnow

    async with SessionLocal() as db:
        row = await db.get(TutorSession, session_id)
        if row is None:
            raise ValueError(f"会话 {session_id} 不存在")
        if not (row.stuck or "").strip():
            raise ValueError("这一场没有记卡点")
        row.stuck_resolved_at = utcnow() if resolved else None
        await db.commit()
    return {"id": session_id, "resolved": bool(resolved)}


async def stuck_blocks(days: int = 90, cap: int = 8) -> list[tuple[str, str]]:
    """卡点 → 播客源材料（(标题, 文本) 块），「卡点讨论」播客的输入。

    复用 stuck_points 的过滤（got/half 且 stuck 非空，useless 不算数），按
    created_at 倒序取最近的。材料刻意只带卡点摘要、不带原对话——播客要讨论
    的是「这个卡点怎么想通」，逐字重放教学没有那个价值。"""
    from datetime import datetime, timedelta

    rows = await stuck_points(limit=max(cap, 1) * 4)
    cutoff = datetime.now().astimezone() - timedelta(days=max(1, days))
    blocks: list[tuple[str, str]] = []
    for r in rows:
        created = r.get("created_at") or ""
        try:
            if created and datetime.fromisoformat(created) < cutoff:
                continue
        except ValueError:
            pass
        state = "说通了" if r["verdict"] == "got" else "半懂"
        blocks.append(
            (
                f"卡点：{r['concept']}（{state}）",
                f"用户围绕「{r['concept']}」有过一场教学会话，自评{state}，当时卡在：{r['stuck']}。",
            )
        )
        if len(blocks) >= cap:
            break
    return blocks


# ---------- 开场建议：从你自己的记录里派生「也许你现在想搞这个」（DeepTutor 参考项） ----------

STARTER_CAP = 3  # 开场屏一排看得完；是就近入口，不是推荐流
JOURNAL_Q_WORDS = ("搞不懂", "不懂", "不明白", "搞懂", "疑问", "为什么", "怎么才能")


async def starters() -> list[dict]:
    """开场屏的建议话题（[{kind, topic, note}]），**纯派生、不落库、无模型参与**。

    DeepTutor v1.5.13 的「home starter suggestions drawn from memory」的本地版：
    来源只有两路——最近半懂的概念（每个概念取最近一次时间，新→旧最多 2 条）和
    最近一条日记里带疑问词的句子（最多 1 条）。护栏照旧：这是你自己的
    记录放在手边的就近入口，点它才开会话——没有计数、没有到期、没有「还没学」
    的欠账感；query 挂了返回 []，绝不能挡住开场输入框。
    """
    out: list[dict] = []
    try:
        from sqlalchemy import func, select

        from app.db import SessionLocal
        from app.models import TutorSession

        async with SessionLocal() as db:
            rows = (
                await db.execute(
                    select(TutorSession.concept, func.max(TutorSession.created_at).label("latest"))
                    .where(TutorSession.concept != "", TutorSession.verdict == "half")
                    .group_by(TutorSession.concept)
                    .order_by(func.max(TutorSession.created_at).desc())
                    .limit(2)
                )
            ).all()
        for concept, _latest in rows:
            out.append({"kind": "half", "topic": str(concept), "note": "上次半懂"})
    except Exception:  # noqa: BLE001
        log.warning("tutor starters: half concepts failed", exc_info=True)
    try:
        from app.core import journal

        for e in journal.recent(30):
            text = (e.get("text") or "").strip()
            if len(text) >= 6 and any(w in text for w in JOURNAL_Q_WORDS):
                out.append(
                    {"kind": "journal", "topic": text[:60], "note": f"日记 {str(e.get('date') or '')[5:]}"}
                )
                break
    except Exception:  # noqa: BLE001
        log.warning("tutor starters: journal failed", exc_info=True)
    return out[:STARTER_CAP]


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
            "mode": r.mode or "socratic",
            "model_id": r.model_id,
            "created_at": iso_utc(r.created_at),
            "ended_at": iso_utc(r.ended_at),
        }
    out["turns"] = await turns(session_id)
    return out


async def stats(days: int = 14) -> dict:
    """The two numbers over the trailing `days`: how many sessions you marked
    「懂了」, and how many of those had recall fire.

    Not a dashboard — the honest record is three hand-written lines in LOG.md.
    This exists so the kill decision (「上次卡过」从没触发) is a lookup
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










