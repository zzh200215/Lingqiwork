"""交付引擎：把你自己积累的材料改写成一份**能交出去**的东西。

与「产出」（`core/compose.py`）的分工：产出是**给自己看**的整理，落 `vault/notes/`（和用户
自己的笔记同目录，可直接编辑）；这里落 `vault/deliver/`，产物是**给别人看**的体裁——周报 /
汇报要点（结论先行）/ 邮件短稿 / 评审意见 / 一页纸提案，还能按读者（自己 / 同事 / 领导）
调整详略与口气。

**是加体裁，不是加引擎。** 脊梁（`core/report.py` 的结构化 Report → 带 [编号] 的 md → 落
vault + 进索引）与取材（`compose.gather_inward`：知识库 + 长期记忆 + 日记）都现成。这里新增
的只有两张表——`GENRES`（每种体裁一段结构指令）与 `AUDIENCES`（每种读者一段改写指令）——
拼进脊梁的 `system_prompt`。提示词一变，`prompt_sha` 就变，质量闭环按 (kind, sha, model)
自动把每个体裁×读者分开统计，不用人工记「这版是给谁写的」。

护栏：拉取式——点它才跑；没有定时、没有队列、没有设置开关。
"""

import logging

from app.config import VAULT_DIR
from app.core import report as _report
from app.core import usage_ledger
from app.core.compose import gather_inward
from app.core.report import (
    Report,
    Section,
    public_source as _public_source,
    resolve as _resolve,
)

log = logging.getLogger(__name__)

__all__ = [
    "AUDIENCES",
    "DELIVER_DIR",
    "GENRES",
    "Report",
    "Section",
    "catalogue",
    "run",
    "save",
    "synth_prompt",
]

DELIVER_DIR = VAULT_DIR / "deliver"

# 体裁 = 结构指令：写哪些小节、顺序、篇幅。`label` 只是界面文案，进提示词的是 `prompt`。
# 小节名写死是有意的——「汇报要结论先行」「一页纸提案这四段」本身就是体裁的定义，
# 留给模型自由发挥就等于没有体裁。
GENRES: dict[str, dict] = {
    "weekly": {
        "label": "周报",
        "prompt": (
            "体裁：周报。按「本周进展 / 遇到的问题 / 下周计划」三个小节写，小节名就用这三个词、"
            "顺序不要变。进展一条一句；遇到的问题写清卡在哪；下周计划要具体到能直接开始做。"
            "全文不超过 500 字。"
        ),
    },
    "briefing": {
        "label": "汇报要点",
        "prompt": (
            "体裁：汇报要点。**结论先行**——第一个小节必须叫「结论」，一句话说清要汇报的判断或"
            "结果；之后用「要点 1 / 要点 2 / …」列 2-3 条支撑，每条先给结论再跟一句依据。"
            "不铺陈背景、不写过程。全文不超过 300 字。"
        ),
    },
    "email": {
        "label": "邮件短稿",
        "prompt": (
            "体裁：邮件短稿。标题就是邮件主题；正文**只写一个叫「正文」的小节**，是可以直接"
            "粘贴发送的一到两段：开门见山说事，需要对方做什么放在最后一句。不要称呼、不要落款、"
            "不要客套话。全文不超过 250 字。"
        ),
    },
    "review": {
        "label": "评审意见",
        "prompt": (
            "体裁：评审意见。按「总体评价 / 具体问题 / 修改建议」三个小节写。具体问题要逐条、"
            "指到材料里的具体位置或说法，不要泛泛说「不够清晰」；修改建议要能照着改。"
            "就事论事，不评价人。"
        ),
    },
    "proposal": {
        "label": "一页纸提案",
        "prompt": (
            "体裁：一页纸提案。按「问题 / 方案 / 代价与风险 / 下一步」四个小节写，小节名就用"
            "这四个词、顺序不要变。方案要具体到能拍板；代价与风险要写清放弃了什么；"
            "下一步的第一件事要能马上做。全文不超过 600 字。"
        ),
    },
}

# 读者 = 改写指令：改详略与口气，不改结构（结构是体裁管的事）。
AUDIENCES: dict[str, dict] = {
    "self": {"label": "自己", "prompt": "读者是你自己：细节可以留，术语直接用，不用交代背景。"},
    "colleague": {
        "label": "同事",
        "prompt": "读者是同级同事：术语第一次出现时用一句话解释，必要的背景交代一句。",
    },
    "leader": {
        "label": "领导",
        "prompt": "读者是上级：略去实现细节，突出影响、风险与需要什么支持——他要的是判断，不是过程。",
    },
}

DEFAULT_GENRE = "weekly"
AUDIENCE_DEFAULT = "self"

# 脊梁要求的那部分（JSON 形状 + 引用规则）——与 compose 同源，小节划分交给体裁那段。
_SHAPE = """你在把用户**自己积累的材料**改写成一份可以直接交出去的成品。只输出一个 JSON 对象，不要任何解释：

{"title": "标题", "sections": [{"heading": "小节标题", "body": "正文"}], "used": [1, 3]}

硬要求：
1. 只依据下面给的材料写——它们来自用户自己的知识库、长期记忆与日记。材料里没有的
   不要写，也不要补充你自己的记忆或网上常识。
2. 每个论断后面用 [编号] 标出它来自哪条材料，例如「……多数情况够用 [2]」。
3. 材料薄弱时别硬凑：直接写一句「材料里暂时还没有这部分」。这是诚实的交代，不是缺陷。
4. `used` 列出你真正引用到的材料编号，升序，去重。
5. 小节怎么分、按什么顺序、写多长，**以下面的体裁要求为准**。
6. 材料之间冲突时，把冲突说出来，不要挑一个当事实。"""


def synth_prompt(genre: str, audience: str) -> str:
    """体裁 × 读者 → 一份提示词。未知体裁/读者抛 ValueError（路由在建流前转 400）。Pure."""
    g = GENRES.get((genre or "").strip())
    if g is None:
        raise ValueError(f"unknown genre '{genre}'")
    a = AUDIENCES.get((audience or "").strip())
    if a is None:
        raise ValueError(f"unknown audience '{audience}'")
    return f"{_SHAPE}\n\n{g['prompt']}\n\n{a['prompt']}"


def catalogue() -> dict:
    """给界面的唯一真值——体裁与读者都从这里来，前端不硬编码。Pure."""
    return {
        "genres": [{"id": k, "label": v["label"]} for k, v in GENRES.items()],
        "audiences": [{"id": k, "label": v["label"]} for k, v in AUDIENCES.items()],
        "default_genre": DEFAULT_GENRE,
        "default_audience": AUDIENCE_DEFAULT,
    }


# ---------- save ----------


async def save(rep: Report, sources: list[dict]) -> dict:
    """落 `vault/deliver/` 并进索引——成品因此能被下一次取材捞回来。"""
    return await _report.save(rep, sources, DELIVER_DIR, "交付")


# ---------- orchestration ----------


@usage_ledger.traced("deliver")
async def run(
    genre: str,
    topic: str,
    audience: str = AUDIENCE_DEFAULT,
    *,
    kb_fn=None,
    memory_fn=None,
    journal_fn=None,
    stream_fn=None,
    native_fn=None,
):
    """Yield (event, data)，事件：gathering / sources / writing / draft / report / error.

    与 `compose.run` 同一形态（取材那一步复用 `gather_inward`），路由只做 SSE 包装。
    任何一步的失败都变成一条人话的 `error`，不留半句状态。
    """
    topic = (topic or "").strip()[:200]
    if not topic:
        yield "error", {"message": "话题不能为空"}
        return
    try:
        prompt = synth_prompt(genre, audience)
    except ValueError as e:
        yield "error", {"message": str(e)}
        return

    from app.core import providers

    model_id = providers.default_model_id() or ""
    if not model_id:
        yield "error", {"message": "没有已启用的 provider，请先在设置页配置模型"}
        return

    yield "gathering", {}
    sources = await gather_inward(
        topic, kb_fn=kb_fn, memory_fn=memory_fn, journal_fn=journal_fn
    )
    if not sources:
        yield "error", {"message": "你自己的材料里没找到相关内容——先往知识库或日记里放点东西"}
        return
    yield "sources", {
        "sources": [_public_source(s) for s in sources],
        "kb": sum(1 for s in sources if s.get("kind") == "kb"),
    }

    yield "writing", {}
    rep = None
    async for _ev, _payload in _report.synthesize_streaming(
        topic,
        sources,
        prompt,
        model_id,
        stream_fn=stream_fn,
        native_fn=native_fn,
        resolve_fn=_resolve,
    ):
        if _ev == "draft":
            yield "draft", _payload
        else:
            rep = _payload
    if rep is None:
        yield "error", {"message": "成文失败——默认模型不可用，或输出无法解析"}
        return
    yield "report", {
        "title": rep.title,
        "sections": [{"heading": s.heading, "body": s.body} for s in rep.sections],
        "used": rep.used,
        "sources": [_public_source(s) for s in sources],
        "model_id": model_id,
        "prompt_sha": _report.prompt_sha(prompt),
        # 体裁与读者随报告一起回来——存进 vault 之后还看得出这份是给谁写的
        "genre": genre,
        "audience": audience,
    }
