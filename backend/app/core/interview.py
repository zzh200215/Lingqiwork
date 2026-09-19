"""面试陪练（M3 · PLAN.md §3 G3）：零柒扮面试官，一场 5–8 题，散场给一份复盘报告。

**它不新开账，也不新开表。**

- 「会话」就是一场 `tutor_sessions`（`mode='interview'`），transcript 就是 `tutor_turns`。
  于是 `tutor.say()` 那条流（召回、取材、画像、压缩、两次落库）**一行都不用改**——
  只在 `tutor.say` 里换一个声部（`interviewer_prompt`）。进度（问了几题）也一样：
  从对话里**数出来的**（assistant 轮次），不另存一个计数器。
- 「卡壳一键进卡点清单」走的是**现有路径**：报告里每一条卡壳都能点开成一场教学
  （`tutor.start`，那条路才会写 `stuck`、才进卡点清单）。**不给面试单独造一张卡点表**：
  面试不是教学，把它的结论写成教学记录就是第二份真值。

**红线**：`vault/面试准备.md` **只读**——报告只导出到 `vault/reports/`，绝不回写题库
（改题是你的决定，不是它顺手做的事）。这一条有测试钉着（跑完报告文件一个字节没变）。

**报告不算「成品」**：`reports/` 不在 `pet._OUTPUT_DIRS` 里（那里只有
research / decisions / conflicts / recap / deliver），所以它不计成长值、不上小屋架子、
不进产出清单，也**不会有零柒那句「交出去了」**。这是刻意的（PLAN §3 G3 那段）：
陪练报告是给你自己看的；塞进 `deliver/`（那份目录的语义是"给别人看"）会把
「你交出 N 份」这个数灌水。想让飞轮当场接上就改落 `deliver/`，一行的事。
"""
from __future__ import annotations

import logging

from pydantic import BaseModel, field_validator

log = logging.getLogger(__name__)

# 本场计划：5–8 题（PLAN §3 G3）。**上界是硬要求**（到 8 必须收尾），下界只是"够了"。
MIN_QUESTIONS = 5
MAX_QUESTIONS = 8
BANK_FILE = "面试准备.md"  # vault 根目录下那份（不在就只用概念与到期卡）
BANK_MAX = 40
REPORT_DIR = "reports"

INTERVIEW_PROMPT = """你是面试官，正在给用户做一场技术面试陪练。**你不讲解、不给答案、不点评对错**——你的活是问。
规则：
1. 每次回复**只问一个问题**，别的一律不说（不寒暄、不说「好问题」、不给提示、不总结）。
2. 他的回答里有薄弱点 → 就那一点追问一层；同一个点最多追三层，追完必须换题。
3. 回答站得住 → 直接换下一题，**不要夸**。
4. 题目优先从他自己的题库里挑**还没问过的**；题库里没有合适的，就顺着他刚说的话找下一个可问的点。
5. 本场计划 5–8 题：问够 5 题之后可以自然收尾；**到 8 题必须收尾**（最后一题问完就停，别再开新题）。"""

_REPORT_PROMPT = """你在读一场技术面试陪练的对话（他是被面试的人）。只输出一个 JSON 对象，不要解释：
{"summary": "两三句总的评价", "solid": ["答得稳的点"], "stuck": ["明显卡壳、答错或含糊的点"], "teach_next": ["建议回头搞懂的点，按优先级排"]}
规则：每一句都必须是**对话里真的出现过**的东西（不许编、不许泛泛而谈、不许写「基础需加强」这种空话）；
某一类没有就给空数组。每条一句话，最好带上他当时说的那个说法。"""


class InterviewReport(BaseModel):
    """报告的四个格子。字段全给默认值：模型少给一个键不该让整份报告失败。"""

    summary: str = ""
    solid: list[str] = []
    stuck: list[str] = []
    teach_next: list[str] = []

    @field_validator("summary", mode="before")
    @classmethod
    def _text(cls, v):  # noqa: ANN001
        return "" if v is None else str(v)

    @field_validator("solid", "stuck", "teach_next", mode="before")
    @classmethod
    def _items(cls, v):  # noqa: ANN001
        if isinstance(v, str):
            return [v.strip()] if v.strip() else []
        if isinstance(v, list):
            return [str(x).strip() for x in v if str(x).strip()]
        return []


# ---------- 题库：他自己的东西，只读 ----------


def _file_questions() -> tuple[str, list[str]]:
    """`vault/面试准备.md` 里的题目行。文件不在就是空表（**这不是失败**）。"""
    from app.config import VAULT_DIR

    p = VAULT_DIR / BANK_FILE
    if not p.is_file():
        return "", []
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return "", []
    out: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith(">"):
            continue
        # 去掉列表符号与序号：题库是人手写的，格式别太当真
        line = line.lstrip("-*+· ").strip()
        for i, sep in enumerate((". ", "、", ") ")):
            if i == 0 and len(line) > 3 and line[0].isdigit() and sep in line[:4]:
                line = line.split(sep, 1)[1].strip()
        if len(line) < 4:
            continue
        out.append(line[:200])
        if len(out) >= BANK_MAX:
            break
    return str(p.name), out


async def bank() -> dict:
    """题库（**只读**）：`vault/面试准备.md` + 半懂 / 又卡住的概念 + 到期卡。

    三处的来源都标出来，界面上看得见"这条题是哪儿来的"——面试官问什么，
    你自己得能查。全都 best-effort：坏一处就少一处，绝不抛。
    """
    from app.core import cards as cards_core
    from app.core import tutor

    name, questions = _file_questions()
    concepts: list[dict] = []
    try:
        rows = await tutor.concepts()
        recurring = {c["concept"] for c in await tutor.recurring_mistakes()}
        for c in rows:
            if c.get("verdict") != "half":
                continue
            concepts.append(
                {
                    "concept": c["concept"],
                    "recurring": c["concept"] in recurring,
                    "stuck": c.get("stuck") or "",
                }
            )
            if len(concepts) >= BANK_MAX:
                break
    except Exception:  # noqa: BLE001 - 题库少一处不算失败
        log.debug("interview bank concepts failed", exc_info=True)
    cards_due: list[str] = []
    try:
        q = await cards_core.queue()
        cards_due = [str(c.get("front") or "")[:200] for c in (q.get("due") or []) if c.get("front")]
    except Exception:  # noqa: BLE001
        log.debug("interview bank cards failed", exc_info=True)
    # 「又卡住」的排前面：那是**系统接住过他卡在哪**的那些，最该再问一遍
    concepts.sort(key=lambda c: (not c["recurring"],))
    return {
        "file": name,
        "questions": questions,
        "concepts": concepts,
        "cards": cards_due[:20],
        "count": len(questions) + len(concepts) + len(cards_due[:20]),
    }


def bank_block(b: dict, asked: int) -> str:
    """把题库与进度拼成一段（进 system，**每轮重算**——与召回/取材同一个理由：
    不每轮带上的话，模型问过三题就忘了自己问过什么）。"""
    lines: list[str] = []
    for q in b.get("questions") or []:
        lines.append(f"- （他题库里的）{q}")
    for c in b.get("concepts") or []:
        tag = "又卡住" if c.get("recurring") else "半懂"
        tail = f"（上次卡在：{c['stuck']}）" if c.get("stuck") else ""
        lines.append(f"- （{tag}）{c['concept']}{tail}")
    for f in b.get("cards") or []:
        lines.append(f"- （到期卡）{f}")
    listed = "\n".join(lines) if lines else "（他自己的题库现在是空的——顺着他的话找可问的点）"
    return (
        f"【题库】优先从这里面挑**还没问过的**：\n{listed}\n"
        f"【本场进度】已经问过 {asked} 题（计划 {MIN_QUESTIONS}–{MAX_QUESTIONS} 题）。"
    )


async def interviewer_prompt(history: list[dict]) -> str:
    """面试官这一轮的声部 = 人设 + 题库 + 进度。`tutor.say()` 里一个分支调它。"""
    asked = sum(1 for t in history or [] if str(t.get("role")) == "assistant")
    try:
        b = await bank()
    except Exception:  # noqa: BLE001 - 题库挂了也得能面试
        log.debug("interview bank failed", exc_info=True)
        b = {}
    return f"{INTERVIEW_PROMPT}\n\n{bank_block(b, asked)}"


# ---------- 散场：复盘报告 ----------


def to_markdown(rep: InterviewReport, *, topic: str, asked: int, model_id: str, when) -> str:  # noqa: ANN001
    """报告正文。只说对话里出现过的东西——四个格子，空的不摆标题。"""
    parts = [f"# 面试陪练复盘 · {topic or '未命名'}", ""]
    parts.append(f"> {when:%Y-%m-%d %H:%M} · 一场 {asked} 题 · 模型 {model_id or '未知'}")
    parts.append("> 这份报告只导出到 `vault/reports/`，**题库文件没有被改过**。")
    parts.append("")
    if rep.summary.strip():
        parts += ["## 总的", "", rep.summary.strip(), ""]
    for key, title in (("solid", "答得稳的"), ("stuck", "卡壳的"), ("teach_next", "建议回头搞懂")):
        items = getattr(rep, key)
        if not items:
            continue
        parts += [f"## {title}", ""]
        parts += [f"- {x}" for x in items]
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"


async def report(session_id: int, *, model_id: str = "", stream_fn=None) -> dict:  # noqa: ANN001
    """一场面试 → 一份复盘报告（`vault/reports/`）。**永不抛**：失败返回 `{ok: False, reason}`。

    一次模型调用；`asked` 与 transcript 都从**真值**（`tutor_turns`）读，不另记一份进度。
    """
    from app.core import providers, tutor, usage_ledger
    from app.core.candidates import _resolve
    from app.core.llm import ProviderInfo, stream_chat
    from app.core.structured import extract_json

    detail = await tutor.detail(session_id)
    if detail is None:
        return {"ok": False, "reason": "会话不存在"}
    turns = [t for t in (detail.get("turns") or []) if str(t.get("content") or "").strip()]
    if not turns:
        return {"ok": False, "reason": "这一场还没有内容，先答几题"}
    asked = sum(1 for t in turns if str(t.get("role")) == "assistant")
    topic = str(detail.get("topic") or "")

    try:
        provider, model = await _resolve(model_id, providers)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": f"没有可用的模型（{e}）"}

    script = "\n\n".join(
        f"{'我' if str(t.get('role')) == 'user' else '面试官'}：{t.get('content')}" for t in turns
    )[-12000:]
    info = ProviderInfo(kind=provider.kind, base_url=provider.base_url, api_key=provider.api_key)
    async with usage_ledger.span("interview", topic[:60]):
        obj, meta = await extract_json(
            info,
            model,
            [
                {"role": "system", "content": _REPORT_PROMPT},
                {"role": "user", "content": f"话题：{topic}\n\n{script}"},
            ],
            InterviewReport,
            stream_fn=stream_fn or stream_chat,
        )
    if obj is None:
        return {"ok": False, "reason": f"报告没生成出来（{meta.strategy}）"}
    rep: InterviewReport = obj  # type: ignore[assignment]

    from datetime import datetime

    from app.config import VAULT_DIR
    from app.core.report import slug

    when = datetime.now()
    dest_dir = VAULT_DIR / REPORT_DIR
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{when:%Y-%m-%d}-面试陪练-{slug(topic or '未命名', 'interview')}.md"
    body = to_markdown(rep, topic=topic, asked=asked, model_id=f"{provider.name}/{model}", when=when)
    rel = ""
    try:
        dest.write_text(body, encoding="utf-8")
        rel = dest.relative_to(VAULT_DIR).as_posix()
    except OSError as e:  # 写不进去就如实说，别假装存了
        log.warning("interview report write failed", exc_info=True)
        return {"ok": False, "reason": f"报告写不进 vault（{e}）", "sections": rep.model_dump()}
    try:
        import asyncio

        from app.core import indexer

        await asyncio.to_thread(indexer.index_file, dest, VAULT_DIR)
    except Exception:  # noqa: BLE001 - 索引是增强，不是前置（同 `mcp._save_artifact`）
        log.warning("interview report indexing failed: %s", rel, exc_info=True)
    return {
        "ok": True,
        "path": rel,
        "asked": asked,
        "model_id": f"{provider.name}/{model}",
        "chars": len(body),
        "sections": rep.model_dump(),
    }
