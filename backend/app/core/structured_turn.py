"""W2b：交付型回合的强制结构化 —— **正文由结构承载，回执由服务端生成**。

**它补的是什么。** W2a 是事后补救：模型先把成品写在对话里、可能还说自己存了，然后被拦、被补跑。
只要「说了什么」和「做了什么」是两件事，就有说谎的空间。这一条把交付型回合的输出**改成一份结构**：

    {"reply": "...", "artifacts": [{"kind": "deliver", "title": "周报", "body": "..."}]}

于是两件事一起变了：

1. **没有 artifacts 字段就没有回执** —— 回执是服务端 `_save_artifact` 落盘之后**自己拼**出来的，
   模型碰不到它。这是「谎报率 = 0」那个验收在结构上的意思：**回执不可能说谎，因为它不是模型写的**。
   （模型仍可能在 `reply` 里多写一句「已存入产出」—— 那句话由 W2a 的判据标出来、界面提示，
   这里的取舍与 W2a 一致：**不替它改字**，删掉等于替它圆谎。）
2. **正文不在对话里** —— 它走 `body` 字段进 vault，`reply` 只是那一句回执。

**按 provider 灰度**（plan 的原话）：走不走这条路由 W7 的画像决定 ——
`force_structure`（想）**且** `supports_structure`（**量过**这个 provider 支持）两个都成立才走；
不成立就回落 W2a 的工具循环，而那一条永远在。所以这一条**不会**让任何模型失去能力，
它只让「已经量过能走的那几个」多一条更结实的路。

**流式的取舍**：结构化那一轮**不流式**（一次性拿到 JSON 才算完），所以正文在最后一刻才出现在
界面上。plan 的风险表里写着这一条：普通聊天路径一个字节都不动，只有交付型回合走它。
"""
from __future__ import annotations

import logging

from pydantic import BaseModel, field_validator

log = logging.getLogger(__name__)

# 一回合最多接受几份产出。与 `mcp.MAX_SAVES_PER_KIND` 不是一回事：那个管**同体裁改几版**，
# 这个管**结构里塞了几份**（防的是模型一次列 10 个标题却写不出正文）。
MAX_DRAFTS = 3

# 交给模型的那段规矩。**写清形状**，不写「请尽量」—— 结构要么对要么不对。
#
# **它必须允许读材料**（这一条是被实测打出来的）：第一版把工具全撤了，让模型「只输出 JSON」，
# 结果它对「照着 notes/本周进展.md 写一篇复盘」的正常要求回了一句
# 「我这边读不到 notes/本周进展.md 的实际内容——本地文件我访问不了」，然后交了空结构。
# 那不是它不听话，是**我们把它的手绑上了**：结构化要换掉的是**交付那一步**（谁写回执），
# 不是「能不能找材料」。所以现在：读/搜/列照旧，`save_artifact` 不给 —— 落盘由服务端做。
INSTRUCTION = (
    "这一轮用户要的是一份**成品**。你可以照常用读材料、搜索、列目录这些工具，"
    "但**不要调用 save_artifact**（落盘由服务端按你的结构来做）。"
    "材料看完之后，**最后一条消息只输出下面这个 JSON，不要写别的**：\n"
    '{"reply": "给用户的一句话回执（可以留空）", '
    '"artifacts": [{"kind": "deliver", "title": "标题一行", "body": "完整成品正文（Markdown）"}]}\n'
    f"artifacts 最多 {MAX_DRAFTS} 份；kind 只能是 research / decide / conflict / recap / deliver / compose；"
    "body 里放**完整**的正文（不要摘要、不要省略号）；reply 里**不要复述正文**。"
    "如果这一轮其实不该产出成品（比如确实没有素材），就返回空 artifacts，并在 reply 里说明理由。"
)


class ArtifactDraft(BaseModel):
    """结构里的一份产出。字段名与 `save_artifact` 的参数一致（kind/title/body）。"""

    kind: str = "compose"
    title: str = ""
    body: str = ""

    @field_validator("kind", "title", "body", mode="before")
    @classmethod
    def _text(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v)


class StructuredTurn(BaseModel):
    """一个交付型回合的**全部**输出。之外的东西不接收 —— 这是这一条的意义所在。"""

    reply: str = ""
    artifacts: list[ArtifactDraft] = []

    @field_validator("reply", mode="before")
    @classmethod
    def _reply(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v)

    @field_validator("artifacts", mode="before")
    @classmethod
    def _arts(cls, v):
        if v is None:
            return []
        if isinstance(v, dict):  # 单个对象而不是数组：收下，别因为形状小错丢掉整轮
            return [v]
        return v if isinstance(v, list) else []


def enabled(profile: dict, decision) -> tuple[bool, str]:
    """这一轮走不走强制结构化。返回（是否，不走的原因）。

    两个条件缺一不可，**都不是猜的**：交付型来自 W3 的路由，`force_structure` 来自 W7 的画像
    （而它内部已经把「想」和「量过支持」与在了一起）。
    """
    if not getattr(decision, "delivery", False):
        return False, "这一轮不是交付型（W3 路由）"
    if not profile.get("force_structure"):
        return False, "画像没开强制结构化（要 force_structure 且量过 supports_structure）"
    return True, ""


def receipt_line(artifacts: list[dict]) -> str:
    """服务端自己拼的那句回执（模型没给 reply 时用它）。Pure。"""
    if not artifacts:
        return ""
    names = "、".join(f"{a.get('label') or ''}「{a.get('title') or ''}」" for a in artifacts)
    return f"已存入产出：{names}"


def parse(text: str) -> StructuredTurn | None:
    """把模型最后那段文本当结构来解。**解不出就返回 None**（调用方回落，不猜）。Pure。

    用 `core/structured.py` 的清洗（代码围栏、前后废话、截断修复），不另写一份 JSON 解析。
    """
    from app.core.structured import clean_json

    blob = clean_json(text or "")
    if not blob:
        return None
    try:
        return StructuredTurn.model_validate_json(blob)
    except Exception:  # noqa: BLE001 - 形状不对就是没拿到，回落
        log.debug("structured turn parse failed", exc_info=True)
        return None


async def apply(payload: StructuredTurn, *, save=None) -> dict:
    """把结构化回合**服务端落盘**，并返回（回复文本，回执，丢掉的+原因）。

    `save` 是注入口（测试用）；默认走模型自己那条路（`mcp._save_artifact`）——
    落点目录、索引、零柒成长值读的那些目录都得跟工具那条路一致，不另写一份。

    **这一轮没开过就自己开一个**（`mcp.turn_open()`）：结构化路径不该假设调用方已经开过轮，
    但也不该在开过的时候再开一次（那会抹掉字数预算与修订额度）。
    """
    from app.core import mcp

    if not mcp.turn_open():
        mcp.begin_turn()

    saver = save or mcp._save_artifact
    kept: list[dict] = []
    dropped: list[dict] = []

    for i, draft in enumerate(payload.artifacts or []):
        if i >= MAX_DRAFTS:
            dropped.append({"index": i, "why": f"一轮最多 {MAX_DRAFTS} 份（结构里塞了更多）"})
            continue
        body = (draft.body or "").strip()
        if not body:
            dropped.append(
                {"index": i, "why": f"「{draft.title or draft.kind}」的 body 是空的（只有标题没有正文）"}
            )
            continue
        out = await saver(
            {"kind": (draft.kind or "compose").strip().lower(), "title": draft.title, "content": body}
        )
        meta = (mcp.take_tool_meta() or {}).get("artifact")
        if isinstance(meta, dict) and not str(out).startswith(("[错误]", "[tool error]")):
            kept.append(meta)
        else:
            dropped.append({"index": i, "why": str(out)[:200]})

    reply = (payload.reply or "").strip()
    # 按 path 去重、留最后一条：结构里同体裁给两份 = 改的是同一个文件，
    # 界面上不能出现两条指向同一处的回执（多出来那条是谎话）。与工具那条路同一条不变量。
    deduped: dict[str, dict] = {}
    for a in kept:
        deduped[str(a.get("path"))] = a
    kept = list(deduped.values())
    if not reply and kept:
        reply = receipt_line(kept)
    return {"reply": reply, "artifacts": kept, "dropped": dropped}
