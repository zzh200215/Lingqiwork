"""重讲判分（M1 · PLAN.md §3 G1）：把「你能把它讲出来吗」变成一次可回写的复习。

**它不改任何既有真值。** 判分算出来的就是一个 1–4 的档位，交回 `cards.submit_review()`
走原来那条路——同一个 `schedule()`、同一张 `card_reviews`、同一个 undo。所以「看卡自评」
与「讲给它听」是**双入口单账本**：两种答法落下来的行长得一模一样，只是后者多一列重讲原文
（那既是判分的输入，也是「这一天你真的重讲了」的唯一凭据），以及 PLAN2 T2/T9.4 那两列
`judged=True` + `judged_sha=<那一版判分器的指纹>`（**唯一**的写入方；判分挂了退回自评时
它是假/空，那正是校准曲线要分的那两堆）。

四条纪律（与 `skill_eval` 同一套）：
1. **判不出来就退自评**（`fallback=True`），**不编分**——"判分没跑成 ≠ 差评"；
2. 宁可低判不高判；判「困难」要给出缺口（提示词里要求，不是硬闸——**读不出档位才是失败**）；
3. 单张卡一次调用，成本写在按钮的 tooltip 上；
4. 坏了不致命：自评那条路一直都在。

prompt 是**模块常量并登记**在 `core/prompts.py` 的 `_SPECS` 里（带 sha、登记页可见），
不塞进 `data/config.json`——那是绕过登记中心（`routers/pet.py` 那条注释写的就是这件事）。
"""
from __future__ import annotations

import logging

from pydantic import BaseModel, field_validator

log = logging.getLogger(__name__)

# 卡片那一侧：四档。**标签 → 数字的映射只有这一份**——`card_reviews.grade`
# （1 重来 | 2 困难 | 3 良好 | 4 简单）是 `models.CardReview` 定下的，这里照它对齐。
GRADES: dict[str, int] = {"重来": 1, "困难": 2, "良好": 3, "简单": 4}
GRADE_LABELS = {v: k for k, v in GRADES.items()}

# 会话那一侧：三个自评，与 `tutor.VERDICTS` 同一套词。容错表只收「意思明确」的别名——
# 认不出来就退自评，绝不猜（猜错会把一个概念写进「已掌握」）。
SESSION_VERDICTS: dict[str, str] = {
    "got": "got",
    "half": "half",
    "useless": "useless",
    "说通了": "got",
    "搞懂了": "got",
    "懂了": "got",
    "半懂": "half",
    "没用": "useless",
    "没讲通": "half",
}

# 判分输入的长度上限：卡片本身有上限（`cards.MAX_BACK_CHARS`），重讲是用户输入的，
# 得自己拦一道——不然一次粘贴能顶掉整条上下文。
MAX_RETELL_CHARS = 4000
MAX_EXCERPT_CHARS = 1200

JUDGE_SYSTEM = """你在给一只叫零柒的宠物判"主人重讲"的质量。
【题面】{front}
【这题的答案（对照基准）】{back}
【出处材料片段】{excerpt}
【主人的重讲】{retell}
输出 JSON：{{"grade": "简单|良好|困难|重来", "missed_points": ["..."], "hint": "一句话提示，仅重来时给", "fallback": false}}
标准：讲对了核心且完整→简单/良好；缺关键点→困难（missed_points 必填）；核心错误或跑题→重来。宁可低判不高判。
判不了（卡上没有答案 / 重讲与题无关）→ fallback=true，不要编分。"""

SESSION_JUDGE_SYSTEM = """你在给一只叫零柒的宠物判"主人刚才讲得怎么样"——他当老师，把概念讲给零柒听。
【话题】{topic}
【对话全文】
{transcript}
按他讲出来的东西判一档，输出 JSON：{{"verdict": "got|half|useless", "missed_points": ["..."], "fallback": false}}
got = 核心讲对了、自己能说圆；half = 讲了个大概、有明确没串起来的地方；
useless = 基本没讲出来、或跑题。
判不了（没有实质内容 / 模型看不出）→ fallback=true，不要编一个档位。"""


class CardVerdict(BaseModel):
    """卡片那一侧的判分结果。字段全给了默认值：模型少给一个键不该让整次判分失败。"""

    grade: str = ""
    missed_points: list[str] = []
    hint: str = ""
    fallback: bool = False

    @field_validator("grade", mode="before")
    @classmethod
    def _text(cls, v):  # noqa: ANN001
        return "" if v is None else str(v)

    @field_validator("missed_points", mode="before")
    @classmethod
    def _points(cls, v):  # noqa: ANN001
        if isinstance(v, str):
            return [v.strip()] if v.strip() else []
        if isinstance(v, list):
            return [str(x).strip() for x in v if str(x).strip()]
        return []


class SessionVerdict(BaseModel):
    verdict: str = ""
    missed_points: list[str] = []
    fallback: bool = False

    @field_validator("verdict", mode="before")
    @classmethod
    def _text(cls, v):  # noqa: ANN001
        return "" if v is None else str(v)

    @field_validator("missed_points", mode="before")
    @classmethod
    def _points(cls, v):  # noqa: ANN001
        if isinstance(v, str):
            return [v.strip()] if v.strip() else []
        if isinstance(v, list):
            return [str(x).strip() for x in v if str(x).strip()]
        return []


# ---------- 纯函数：读得出档位才算数 ----------


def parse_grade(raw) -> int | None:  # noqa: ANN001
    """模型给的档位 → 1–4。认不出来返回 None（= 退自评，**不猜**）。

    容错只做「明显等价」的那几种：中文标签、数字、数字字符串、英文标签。
    """
    if raw is None:
        return None
    if isinstance(raw, bool):  # bool 是 int 的子类，先挡掉：True 不该被读成 1
        return None
    if isinstance(raw, int):
        return raw if raw in GRADE_LABELS else None
    text = str(raw).strip()
    if text in GRADES:
        return GRADES[text]
    if text.isdigit():
        n = int(text)
        return n if n in GRADE_LABELS else None
    low = text.lower()
    for word, n in (("again", 1), ("hard", 2), ("good", 3), ("easy", 4)):
        if low.startswith(word):
            return n
    return None


def grade_label(grade: int) -> str:
    return GRADE_LABELS.get(int(grade), "")


# 会话那一侧判分提示词在登记表里的位置（`core/prompts.py::_SPECS`）。
SESSION_MODULE = "app.core.retell"
SESSION_JUDGE_NAME = "SESSION_JUDGE_SYSTEM"


def session_judge_sha() -> str:
    """会话判分提示词当前的指纹（12 位）。**从登记表取**（`prompts.fingerprint`），
    不在这里重算一遍 sha——两份算法迟早会漂。"""
    from app.core import prompts

    return prompts.fingerprint(SESSION_MODULE, SESSION_JUDGE_NAME)


def parse_verdict(raw) -> str | None:  # noqa: ANN001
    """会话那一侧的档位。同样：认不出来就 None。"""
    if raw is None:
        return None
    text = str(raw).strip()
    if text in SESSION_VERDICTS:
        return SESSION_VERDICTS[text]
    return SESSION_VERDICTS.get(text.lower())


def read_card(obj: CardVerdict | None) -> dict:
    """`CardVerdict` → 结论。**唯一判据是「档位读不读得出来」**：

    - 模型说 `fallback`（材料不够 / 与题无关）→ 不成，退自评；
    - 档位认不出来 → 不成，退自评（宁可没结论，也不给一个编的分）；
    - 缺口是提示词的要求，不是判据：判「困难」而没给缺口，照样算数，只是没有那句提示。
    """
    if obj is None:
        return {"ok": False, "reason": "判分没跑成", "grade": 0, "label": ""}
    if obj.fallback:
        return {"ok": False, "reason": "它说判不了（材料不够 / 与题无关）", "grade": 0, "label": ""}
    grade = parse_grade(obj.grade)
    if grade is None:
        return {
            "ok": False,
            "reason": f"档位读不出来（{obj.grade!r}）",
            "grade": 0,
            "label": "",
        }
    return {
        "ok": True,
        "reason": "",
        "grade": grade,
        "label": grade_label(grade),
        "missed_points": [p[:200] for p in obj.missed_points][:5],
        "hint": obj.hint.strip()[:300],
    }


def read_session(obj: SessionVerdict | None) -> dict:
    if obj is None:
        return {"ok": False, "reason": "判分没跑成", "verdict": ""}
    if obj.fallback:
        return {"ok": False, "reason": "它说判不了（没有实质内容）", "verdict": ""}
    verdict = parse_verdict(obj.verdict)
    if verdict is None:
        return {"ok": False, "reason": f"档位读不出来（{obj.verdict!r}）", "verdict": ""}
    return {
        "ok": True,
        "reason": "",
        "verdict": verdict,
        "missed_points": [p[:200] for p in obj.missed_points][:5],
    }


def card_prompt(
    front: str, back: str, excerpt: str, retell: str, template: str = JUDGE_SYSTEM
) -> str:
    """判分真正的输入。**基准是卡片自己的答案**（`back`），不是检索来的材料——

    出处片段（`source_excerpt`）只是补充；它为空时也不再去检索：那张卡的答案就在手边，
    多一次 chroma 往返只会多一个"检索串味"的失败模式（PLAN §3 G1 的取舍）。

    `template` 只有**对照台**会换（P2-1）：跑一条候选提示词时要走的是**同一条拼装路**，
    只是把模板换掉——另写一份拼装逻辑，测的就是另一个产品了（`prompt_eval` 开篇那条）。
    默认值就是登记在册的那一份，产品路径一个字节都没变。
    """
    return template.format(
        front=(front or "").strip()[:1200],
        back=(back or "").strip()[:1200] or "（这张卡没写答案）",
        excerpt=(excerpt or "").strip()[:MAX_EXCERPT_CHARS] or "（没有）",
        retell=(retell or "").strip()[:MAX_RETELL_CHARS],
    )


def session_prompt(topic: str, transcript: list[dict]) -> str:
    """会话判分的输入：话题 + 全文。太长就从**中间**砍（开头的问题是题目、
    结尾的自述是结论，两头都比中间值钱）。"""
    lines: list[str] = []
    for t in transcript or []:
        who = "主人" if str(t.get("role")) == "user" else "零柒"
        text = str(t.get("content") or "").strip()
        if text:
            lines.append(f"{who}：{text}")
    body = "\n".join(lines)
    if len(body) > 8000:
        head, tail = body[:4000], body[-4000:]
        body = f"{head}\n……（中间略）……\n{tail}"
    return SESSION_JUDGE_SYSTEM.format(topic=(topic or "").strip()[:200], transcript=body or "（空的）")


# ---------- 调模型 ----------


async def _ask(info, model: str, messages: list[dict], schema, stream_fn) -> dict:  # noqa: ANN001
    """一次结构化调用 → 结论 dict。**永不抛**：失败一律是"判分没跑成"。"""
    from app.core import structured

    try:
        obj, meta = await structured.extract_json(
            info, model, messages, schema, stream_fn=stream_fn
        )
    except Exception as e:  # noqa: BLE001 - 判分失败不是错误，是一次"没有结论"
        log.warning("retell judge call failed", exc_info=True)
        return {"ok": False, "reason": f"{type(e).__name__}: {e}"}
    out = read_card(obj) if schema is CardVerdict else read_session(obj)
    if not out["ok"] and meta.strategy == "failed":
        out["reason"] = "判分没跑成（输出读不出来）"
    return out


async def judge_card(
    front: str,
    back: str,
    excerpt: str,
    retell: str,
    *,
    model_id: str = "",
    stream_fn=None,  # noqa: ANN001 - 测试的注入点（同 `structured.extract_json` 的约定）
    template: str = JUDGE_SYSTEM,
) -> dict:
    """判一次「重讲」。返回 `{ok, grade, label, missed_points, hint, reason, model_id}`。

    `template` 同 `card_prompt`：只有对照台会换（跑候选提示词），产品路径用默认的那一份。
    """
    from app.core import providers, usage_ledger
    from app.core.candidates import _resolve
    from app.core.llm import ProviderInfo, stream_chat

    text = (retell or "").strip()
    if not text:
        return {"ok": False, "reason": "还没讲呢", "grade": 0, "label": ""}
    try:
        provider, model = await _resolve(model_id, providers)
    except Exception as e:  # noqa: BLE001 - 没有可用 provider 是最常见的一种"没成"
        return {"ok": False, "reason": f"没有可用的模型（{e}）", "grade": 0, "label": ""}

    info = ProviderInfo(kind=provider.kind, base_url=provider.base_url, api_key=provider.api_key)
    messages = [
        {"role": "system", "content": card_prompt(front, back, excerpt, text, template=template)},
        {"role": "user", "content": "判吧。"},
    ]
    async with usage_ledger.span("retell", (front or "")[:60]):
        out = await _ask(info, model, messages, CardVerdict, stream_fn or stream_chat)
    out["model_id"] = f"{provider.name}/{model}"
    return out


async def judge_session(
    session_id: int, *, model_id: str = "", stream_fn=None  # noqa: ANN001
) -> dict:
    """判一场「我来讲」。返回 `{ok, verdict, missed_points, reason}`——**不落库**：

    落库走 `tutor.end(session_id, verdict, judged_sha=…)`（调用方那一步），与手动自评同一条路。
    所以「又卡住」那条链路一行都不用改就会照常触发。

    **调用方要把 `session_judge_sha()` 一起传下去**（P2-3）：会话侧校准要分得清
    「这个 verdict 是判分器定的还是你定的」，而且要知道是哪一版判的。这件事不能在这里做
    ——这一层的纪律是「判分不落库」，落库只有 `end()` 一个出口。
    """
    from app.core import providers, tutor, usage_ledger
    from app.core.candidates import _resolve
    from app.core.llm import ProviderInfo, stream_chat

    detail = await tutor.detail(session_id)
    if detail is None:
        return {"ok": False, "reason": "会话不存在", "verdict": ""}
    turns = detail.get("turns") or []
    if not any(str(t.get("content") or "").strip() for t in turns):
        return {"ok": False, "reason": "这一场还没有内容可判", "verdict": ""}

    try:
        provider, model = await _resolve(model_id, providers)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": f"没有可用的模型（{e}）", "verdict": ""}

    info = ProviderInfo(kind=provider.kind, base_url=provider.base_url, api_key=provider.api_key)
    messages = [
        {"role": "system", "content": session_prompt(detail.get("topic") or "", turns)},
        {"role": "user", "content": "判吧。"},
    ]
    async with usage_ledger.span("retell", f"session:{session_id}"):
        out = await _ask(info, model, messages, SessionVerdict, stream_fn or stream_chat)
    out["model_id"] = f"{provider.name}/{model}"
    return out


async def adjudicate(
    card_id: int, retell: str, *, seconds: float = 0.0, model_id: str = ""
) -> dict:
    """场景 A 的整条路：读卡 → 判 → **落同一条复习记录** → 零柒接一句。

    `ok=False` 时**一个字节都不写**（不落分、不落文本）——"判分失败 ≠ 差评"。
    调用方（界面）此时退回自评，自评那条路照旧可以把重讲原文带上（`submit_review(retell=…)`），
    于是「这一天你确实重讲了」这件事不会因为判分挂了就丢掉。
    """
    from sqlalchemy import select

    from app.core import cards as cards_core
    from app.core import pet
    from app.db import SessionLocal
    from app.models import Card

    text = (retell or "").strip()
    if not text:
        return {"ok": False, "reason": "还没讲呢", "grade": 0, "label": ""}

    async with SessionLocal() as db:
        card = (await db.execute(select(Card).where(Card.id == card_id))).scalar_one_or_none()
        if card is None:
            return {"ok": False, "reason": "卡片不存在", "grade": 0, "label": ""}
        if card.suspended:
            return {"ok": False, "reason": "这张卡已搁置", "grade": 0, "label": ""}
        snapshot = {
            "front": card.front or "",
            "back": card.back or "",
            "excerpt": card.source_excerpt or "",
            "topic": card.topic or "",
        }

    out = await judge_card(
        snapshot["front"], snapshot["back"], snapshot["excerpt"], text, model_id=model_id
    )
    if not out.get("ok"):
        return {**out, "card": None}

    # 落账：与自评**同一条路**（同一个 `submit_review`），只是多带一列重讲原文。
    # `judged_sha` 是**全仓唯一一处**把它填上的地方（PLAN2 T2 + §9.4）：这一档确实来自
    # 判分器，而且记下是**哪一版**判的（曲线按它分段）。指纹只有一个出处——
    # `cards.judge_sha()` 从登记表取，不在这里重算一遍。判分挂了就在上面那行返回了，
    # 回到自评时它是空串。
    card_out = await cards_core.submit_review(
        card_id,
        int(out["grade"]),
        seconds,
        retell=text,
        judged_sha=cards_core.judge_sha(),
    )
    # 零柒接一句：写账的人说话（与 `pet.note_output` 同一个 pattern）。
    # `count` 在这里是**档位**不是次数——`pet.compose("retell")` 那一支的注释写着这件事。
    try:
        pet.emit(
            "retell",
            name=(snapshot["topic"] or snapshot["front"]).strip()[:60],
            detail=(out.get("missed_points") or [""])[0],
            count=int(out["grade"]),
        )
    except Exception:  # noqa: BLE001 - 一句台词绝不拖累落账
        log.debug("pet retell line failed", exc_info=True)
    return {**out, "card": card_out, "retell": text}
