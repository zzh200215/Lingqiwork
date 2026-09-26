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
from datetime import datetime, timezone

from pydantic import BaseModel, Field, field_validator

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
    "Outline",
    "Report",
    "Section",
    "all_genres",
    "catalogue",
    "create_template",
    "delete_template",
    "genre_spec",
    "list_templates",
    "make_outline",
    "run",
    "save",
    "synth_prompt",
    "update_template",
]

DELIVER_DIR = VAULT_DIR / "deliver"

# 体裁 = 结构指令：写哪些小节、顺序、篇幅。`label` 只是界面文案，进提示词的是 `prompt`。
# 小节名写死是有意的——「汇报要结论先行」「一页纸提案这四段」本身就是体裁的定义，
# 留给模型自由发挥就等于没有体裁。
#
# `long`（§8.1 双模的判据）：**结构值得先定下来再写**的体裁。它决定界面走哪一模——
# 长稿先出提纲、点头后才取材成文；短稿一键直出。判据留在后端是有意的：哪个体裁算长稿
# 是体裁的属性，不是界面的属性（与「体裁唯一真值在后端」同一条纪律）。
# 短稿那两种的结构本来就只有一两段（邮件就一个「正文」小节），先确认提纲只是多一次点击。
GENRES: dict[str, dict] = {
    "weekly": {
        "label": "周报",
        "long": True,
        "prompt": (
            "体裁：周报。按「本周进展 / 遇到的问题 / 下周计划」三个小节写，小节名就用这三个词、"
            "顺序不要变。进展一条一句；遇到的问题写清卡在哪；下周计划要具体到能直接开始做。"
            "全文不超过 500 字。"
        ),
    },
    "briefing": {
        "label": "汇报要点",
        "long": False,
        "prompt": (
            "体裁：汇报要点。**结论先行**——第一个小节必须叫「结论」，一句话说清要汇报的判断或"
            "结果；之后用「要点 1 / 要点 2 / …」列 2-3 条支撑，每条先给结论再跟一句依据。"
            "不铺陈背景、不写过程。全文不超过 300 字。"
        ),
    },
    "email": {
        "label": "邮件短稿",
        "long": False,
        "prompt": (
            "体裁：邮件短稿。标题就是邮件主题；正文**只写一个叫「正文」的小节**，是可以直接"
            "粘贴发送的一到两段：开门见山说事，需要对方做什么放在最后一句。不要称呼、不要落款、"
            "不要客套话。全文不超过 250 字。"
        ),
    },
    "review": {
        "label": "评审意见",
        "long": True,
        "prompt": (
            "体裁：评审意见。按「总体评价 / 具体问题 / 修改建议」三个小节写。具体问题要逐条、"
            "指到材料里的具体位置或说法，不要泛泛说「不够清晰」；修改建议要能照着改。"
            "就事论事，不评价人。"
        ),
    },
    "proposal": {
        "label": "一页纸提案",
        "long": True,
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


def _label(table: dict[str, dict], key: str) -> str:
    """体裁 / 读者的**界面名**（写进文件的是「周报」「领导」，不是 `weekly` / `leader`）。Pure.

    文件是给人读的（Obsidian 里打开就能看懂）；机器那边要的是 id，而 id 早就钉在
    `prompt_sha` 上了（质量闭环按它分组）——两处各取所需，不混。
    """
    row = table.get((key or "").strip())
    return str((row or {}).get("label") or (key or "")).strip()


# ---------- 提纲（§8.1 双模的长稿那一模） ----------

# 提纲那一步的提示词。**它自己不进 `prompt_sha`**：用户确认提纲之后才成文，被评价的是
# 成文那一次；提纲只是一步便宜的预演。理由同 `skill_match` 的注入——见 `synth_prompt`。
_OUTLINE_PROMPT = """你在给一份**还没动笔**的交付稿定提纲。只输出一个 JSON 对象，不要任何解释：

{"title": "标题", "sections": ["小节标题", "小节标题"]}

硬要求：
1. **只定小节标题，不要写正文**——正文等提纲定下来再写。这一条最容易违反，注意。
2. 小节怎么分、按什么顺序，**以下面的体裁要求为准**：体裁要求里已经写死了小节名的
   （「本周进展」这种），原样用那几个名字；只给了规矩没给名字的，按话题拟具体的名字。
3. 小节数照体裁要求来，一般 2-5 个；标题不超过 12 个字，让人一眼看得出这一节要写什么。
4. 标题要落到**这个话题**上，不要「背景」「概述」这种换个题目也能用的空壳。"""

OUTLINE_MAX = 8  # 小节数封顶：模型偶尔会一口气列十几节，那不是提纲是目录
OUTLINE_NAME_CHARS = 40


class Outline(BaseModel):
    """提纲的形状：一个标题 + 一串小节名。**没有正文**——正文等提纲定下来再写。

    宽容度同 `Report`（字段类型不对就当空/丢掉，一次模型抖动不该丢掉整份提纲）：模型
    见过成文的形状，所以偶尔会把 `sections` 给成 `[{"heading": "…"}]`——照收，只要能
    取出名字。
    """

    title: str = ""
    sections: list[str] = Field(default_factory=list)

    @field_validator("title", mode="before")
    @classmethod
    def _title_text(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()

    @field_validator("sections", mode="before")
    @classmethod
    def _names(cls, v):
        if v is None:
            return []
        if isinstance(v, (str, dict)):
            v = [v]
        if not isinstance(v, (list, tuple)):
            return []
        out: list[str] = []
        for x in v:
            if isinstance(x, dict):
                x = x.get("heading") or x.get("title") or x.get("name") or ""
            if isinstance(x, (list, dict)):
                continue
            s = str(x).strip()
            if s:
                out.append(s)
        return out


def _outline_block(outline: list[str]) -> str:
    """定稿的小节 → 一段**覆盖**指令。Pure.

    是覆盖不是追加：体裁那段提示词里写着默认的小节名（「小节名就用这三个词、顺序不要变」），
    用户删了一节或改了名之后，那套默认值就作废了。模型收到两段互相矛盾的要求时未必听后面
    那段，所以这里明说「上面那套只是默认值，用户已经改过了」。
    """
    return (
        "**本次小节已由用户定稿，就按这些写**："
        + " / ".join(outline)
        + "\n小节名与顺序以此为准，不要增、不要删、不要改名——上面体裁要求里给的那套小节名"
        "只是默认值，用户已经改过了。"
    )


def synth_prompt(
    genre: str, audience: str, outline: list[str] | None = None, *, custom: dict | None = None
) -> str:
    """体裁 × 读者（× 定稿的提纲）→ 一份提示词。未知体裁/读者抛 ValueError（路由转 400）。Pure.

    `custom`（§8.1 行2）：`genre_spec` 查出来的那条定义。传了它就用它，**不查 `GENRES`**
    ——内置与自定义是同一个形状，这个函数因此不需要知道它拿到的是哪一种。
    不传时行为与以前**逐字节相同**。

    **不传提纲时逐字节等于以前**——这一点是硬要求：`prompt_sha` 是这个串的指纹，存量
    反馈按它分版本，多一个字符就把历史劈成两半。

    传了提纲也只是**追加**一段覆盖指令，不重写体裁那段。理由同上：sha 必须继续认得出
    「这是周报×领导那一版」，而提纲是**每一次运行的输入**（像注入的技能工序），不是
    提示词版本。`run()` 因此把 sha 算在**不带提纲**的那个串上——与 `skill_match.with_skills`
    的处理完全一致（`core/quality.py` 顶部记过这条口径）。
    """
    g = custom if custom else GENRES.get((genre or "").strip())
    if g is None:
        raise ValueError(f"unknown genre '{genre}'")
    a = AUDIENCES.get((audience or "").strip())
    if a is None:
        raise ValueError(f"unknown audience '{audience}'")
    base = f"{_SHAPE}\n\n{g['prompt']}\n\n{a['prompt']}"
    names = [str(x).strip() for x in (outline or []) if str(x or "").strip()]
    return f"{base}\n\n{_outline_block(names)}" if names else base


@usage_ledger.traced("deliver")
async def make_outline(
    topic: str,
    genre: str,
    audience: str,
    *,
    stream_fn=None,
    native_fn=None,
    resolve_fn=None,
) -> dict | None:
    """话题 + 体裁 × 读者 → 一份**还没写正文**的提纲（None = 模型不可用或输出解析不了）。

    **它不取材**——方案 §8.1 的原话是「点头后才取材成文」。这是这一步便宜的全部原因：
    取材（检索 + 记忆合成 + 日记）与成文才是贵的那两段，而提纲只是问一次结构。

    记账走 `traced("deliver")`：这是**真花钱的一次模型调用**，不记的话「这个月钱花在哪」
    里就少了这一截（与 `run` 同一个 kind、同一个 ref=话题）。
    """
    topic = (topic or "").strip()[:200]
    if not topic:
        return None
    # 体裁定义先查出来（内置或自定义）——未知就直接说不知道，别去问模型
    spec = await genre_spec(genre)
    if spec is None:
        return None
    prompt = synth_prompt(genre, audience, custom=spec)

    from app.core import providers

    model_id = providers.default_model_id() or ""
    if not model_id:
        return None
    resolve_fn = resolve_fn or _resolve
    resolved = await resolve_fn(model_id)
    if resolved is None:
        return None
    info, model = resolved

    from app.core.structured import extract_json

    obj, meta = await extract_json(
        info,
        model,
        [
            {"role": "system", "content": f"{_OUTLINE_PROMPT}\n\n{prompt}"},
            {"role": "user", "content": f"话题：{topic}"},
        ],
        Outline,
        stream_fn=stream_fn,
        native_fn=native_fn,
    )
    if obj is None:
        log.info("deliver outline unavailable: %s", meta.error)
        return None
    names = [s[:OUTLINE_NAME_CHARS] for s in obj.sections][:OUTLINE_MAX]
    if not names:
        return None
    return {"title": obj.title, "sections": names, "model_id": model}


# ---------- 体裁：内置的 + 你自己写的（§8.1 行2） ----------
#
# 内置那五条是**代码**（`GENRES` 常量表）：随版本走、可 review、进 git。
# 自定义的那些是**数据**（`deliver_templates` 表）：你自己写的，随时改。
# 两者在下面这几个函数里合流，形状完全一样（`{label, long, prompt}`）——
# 所以 `synth_prompt` 那边不需要知道它拿到的是哪一种。

CUSTOM_PREFIX = "t-"  # 自定义模板 id 的前缀：内置体裁的 id 因此永远不可能被顶掉
LABEL_MAX = 40
PROMPT_MAX = 2000  # 结构指令不是长篇散文；封顶是为了让它保持是「一段指令」


def _row_out(row) -> dict:
    """`DeliverTemplate` 行 → 与 `GENRES[*]` 同一个形状。Pure（只读字段）。"""
    return {
        "id": row.slug,
        "label": row.label,
        "long": bool(row.long),
        "prompt": row.prompt,
        "custom": True,
    }


def _slugify(label: str, taken: set[str]) -> str:
    """界面名 → 稳定 id（`t-` 前缀 + 去重）。Pure。

    **id 与名字分开是有意的**：`prompt_sha` 按体裁 id 分版本，改名不该让质量闭环的历史
    断裂（同 `_label` 那条注释）。所以名字随便改，id 建了就不动。
    """
    base = _report.slug(label, "tpl")[:40] or "tpl"
    slug = f"{CUSTOM_PREFIX}{base}"
    n = 2
    while slug in taken:
        slug = f"{CUSTOM_PREFIX}{base}-{n}"
        n += 1
    return slug


def check_template(label: str, prompt: str, *, taken_labels: set[str]) -> tuple[str, str]:
    """名字与结构指令的校验 → `(label, prompt)`。不合法抛 ValueError（路由转 400）。Pure.

    三条判据都是「不拦就会出事」的那种：
    - 空名字 → chips 上一个没有字的胶囊，点下去不知道选了什么；
    - 空结构指令 → 模板退化成只有公共 JSON 形状，跟没有体裁一样（而那正是体裁存在的意义）；
    - 与**内置体裁**重名 → 界面上两个「周报」，选哪个都不是你想的那个。
    """
    lab = (label or "").strip()[:LABEL_MAX]
    if not lab:
        raise ValueError("模板得有个名字")
    if lab in taken_labels:
        raise ValueError(f"已经有叫「{lab}」的体裁了")
    body = (prompt or "").strip()[:PROMPT_MAX]
    if not body:
        raise ValueError("结构指令不能空——它就是这种体裁的定义")
    return lab, body


def builtin_labels() -> set[str]:
    """内置体裁的界面名。新建/改名时拿它挡重名。Pure."""
    return {str(v["label"]) for v in GENRES.values()}


async def list_templates() -> list[dict]:
    """你自己写的体裁模板（含结构指令——编辑要用）。按名字排。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import DeliverTemplate

    async with SessionLocal() as db:
        rows = (
            await db.execute(select(DeliverTemplate).order_by(DeliverTemplate.label))
        ).scalars().all()
    return [_row_out(r) for r in rows]


async def genre_spec(genre_id: str) -> dict | None:
    """体裁 id → 它的定义（`{label, long, prompt}`）；两边都没有就 None。

    **内置优先**：`t-` 前缀保证不会撞，但这个顺序让「查库」只发生在真的是自定义的时候
    ——绝大多数请求（内置体裁）一次库都不碰。
    """
    key = (genre_id or "").strip()
    g = GENRES.get(key)
    if g is not None:
        return {**g, "id": key, "custom": False}

    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import DeliverTemplate

    async with SessionLocal() as db:
        row = (
            await db.execute(select(DeliverTemplate).where(DeliverTemplate.slug == key))
        ).scalars().first()
    return _row_out(row) if row is not None else None


async def all_genres() -> list[dict]:
    """内置的在前、你自己写的在后——界面上那一排 chips 就是它。**不含结构指令**（列表用不上）。"""
    out = [
        {"id": k, "label": v["label"], "long": bool(v.get("long")), "custom": False}
        for k, v in GENRES.items()
    ]
    out.extend(
        {k: v for k, v in t.items() if k != "prompt"} for t in await list_templates()
    )
    return out


async def create_template(label: str, prompt: str, long: bool = True) -> dict:
    """存一种新体裁。名字与内置体裁（或已有模板）重名抛 ValueError。"""
    from app.db import SessionLocal
    from app.models import DeliverTemplate

    existing = await list_templates()
    taken = builtin_labels() | {t["label"] for t in existing}
    lab, body = check_template(label, prompt, taken_labels=taken)

    async with SessionLocal() as db:
        row = DeliverTemplate(
            slug=_slugify(lab, {t["id"] for t in existing}), label=lab, prompt=body, long=bool(long)
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return _row_out(row)


async def update_template(genre_id: str, *, label=None, prompt=None, long=None) -> dict | None:
    """改一个模板。只改传进来的字段（None = 不动）。找不到返回 None。

    **`slug` 不动**——见 `_slugify`：改了它，这份模板此前所有评价的版本 key 就断了。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import DeliverTemplate

    # 重名判据先备齐（`list_templates` 自己开一个 session——别套在下面那个里面）
    others = [t for t in await list_templates() if t["id"] != (genre_id or "").strip()]
    taken = builtin_labels() | {t["label"] for t in others}

    async with SessionLocal() as db:
        row = (
            await db.execute(
                select(DeliverTemplate).where(DeliverTemplate.slug == (genre_id or "").strip())
            )
        ).scalars().first()
        if row is None:
            return None

        new_label, new_prompt = check_template(
            label if label is not None else row.label,
            prompt if prompt is not None else row.prompt,
            taken_labels=taken,
        )
        row.label, row.prompt = new_label, new_prompt
        if long is not None:
            row.long = bool(long)
        row.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(row)
    return _row_out(row)


async def delete_template(genre_id: str) -> bool:
    """删一个模板。找不到返回 False。

    **已经写出去的东西一份都不动**：那些 md 早落在 `vault/deliver/` 里了，文件头的
    `genre:` 写的是**界面名**（`save` 的 `_label`），所以模板删了之后那些成品照样读得懂
    「这是给谁写的、什么体裁」。删模板只是以后不再拿它当选项。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import DeliverTemplate

    async with SessionLocal() as db:
        row = (
            await db.execute(
                select(DeliverTemplate).where(DeliverTemplate.slug == (genre_id or "").strip())
            )
        ).scalars().first()
        if row is None:
            return False
        await db.delete(row)
        await db.commit()
    return True


async def catalogue() -> dict:
    """给界面的唯一真值——体裁（内置 + 自定义）与读者都从这里来，前端不硬编码。

    `long` 一起给出去：界面靠它决定长稿走「先出提纲」、短稿走「一键直出」。
    `custom` 一起给出去：界面靠它决定这个 chip 能不能编辑/删除。

    **它现在要读库了**（自定义模板在库里），所以不再是 Pure 的——这一点如实反映在
    `async` 上，而不是偷偷在模块级缓存一份（缓存那份会在你新建模板之后继续撒谎）。
    """
    return {
        "genres": await all_genres(),
        "audiences": [{"id": k, "label": v["label"]} for k, v in AUDIENCES.items()],
        "default_genre": DEFAULT_GENRE,
        "default_audience": AUDIENCE_DEFAULT,
    }


def pinned_sources(specs: list[str]) -> list[dict]:
    """**钉进来的材料**（检索命中的 `spec`）→ 带正文的来源。

    这是「任何检索命中能一键加进这次产出」的落点（§4-14）：取材本来是引擎按话题自己捞的，
    钉进来的那几条是人指的——所以它们排在最前，且**取不到就跳过**，一条材料读不出来不该
    拖垮整次产出。

    `spec` 的三种形状（vault 相对路径 / `repo:` / `dir:`）由 `cards.collect_material` 认。
    """
    from app.core import cards as cards_core

    out: list[dict] = []
    for spec in specs or []:
        s = (spec or "").strip()
        if not s:
            continue
        try:
            rel, label, text = cards_core.collect_material(source_path=s)
        except Exception:  # noqa: BLE001 - 一条钉不上只是少一条材料
            log.warning("pinned material unreadable: %s", s, exc_info=True)
            continue
        if not (text or "").strip():
            continue
        out.append({"kind": "kb", "title": label or s, "ref": rel or s, "text": text})
    return out


def merge_pinned(pinned: list[dict], gathered: list[dict]) -> list[dict]:
    """钉进来的排在最前，按 `ref` 去重后重新编号。Pure.

    人指定的一定优先于引擎自己捞的；同一份材料被两边都拿到时只留钉的那条。
    """
    seen = {str(p.get("ref") or "") for p in pinned}
    merged = [*pinned, *(g for g in gathered if str(g.get("ref") or "") not in seen)]
    return [dict(s, n=i) for i, s in enumerate(merged, 1)]


# ---------- save ----------


async def save(rep: Report, sources: list[dict], genre: str = "", audience: str = "") -> dict:
    """落 `vault/deliver/` 并进索引——成品因此能被下一次取材捞回来。

    **体裁与读者一起写进文件头**（M5）：这两个值本来就随 `run()` 的 payload 回来，可在这之前
    存完就丢了——「这份是给谁写的」只剩文件名。交付的事后见证靠的就是文件本身
    （`core/delivery.py`：mtime = 交出去的时刻，frontmatter = 给谁写的），所以它必须落盘。

    写的是**界面名**，所以自定义模板也要能查出来——查不到就退回 id 本身（那说明这个模板
    刚被删了，而这份成品确实是用它写的：**写 id 比写一个空字段诚实**）。
    """
    spec = await genre_spec(genre) if (genre or "").strip() else None
    return await _report.save(
        rep,
        sources,
        DELIVER_DIR,
        "交付",
        front={
            "genre": str((spec or {}).get("label") or (genre or "")).strip(),
            "audience": _label(AUDIENCES, audience),
        },
    )


# ---------- orchestration ----------


@usage_ledger.traced("deliver")
async def run(
    genre: str,
    topic: str,
    audience: str = AUDIENCE_DEFAULT,
    *,
    pinned: list[str] | None = None,
    outline: list[str] | None = None,
    kb_fn=None,
    memory_fn=None,
    journal_fn=None,
    stream_fn=None,
    native_fn=None,
):
    """Yield (event, data)，事件：gathering / sources / writing / draft / report / error.

    与 `compose.run` 同一形态（取材那一步复用 `gather_inward`），路由只做 SSE 包装。
    任何一步的失败都变成一条人话的 `error`，不留半句状态。

    `outline`（§8.1）：用户在提纲确认区定稿的小节名。传了它就按这些小节写，不再由体裁
    那段提示词决定结构；**不传时行为一个字节没变**（一键直出的短稿、以及没走提纲那条路
    的调用照旧）。
    """
    topic = (topic or "").strip()[:200]
    if not topic:
        yield "error", {"message": "话题不能为空"}
        return
    # 体裁定义先查出来（内置或自定义）。**校验在建流前也做过一遍**（`routers/deliver.py`
    # 的 `_check`），这里是第二道——`run` 也能被别的入口直接调（定时任务、测试）。
    spec = await genre_spec(genre)
    if spec is None:
        yield "error", {"message": f"unknown genre '{genre}'"}
        return
    try:
        # 基准提示词（不带提纲）——`prompt_sha` 算的是它，见 `synth_prompt` 的注释。
        base_prompt = synth_prompt(genre, audience, custom=spec)
        prompt = synth_prompt(genre, audience, outline, custom=spec)
    except ValueError as e:
        yield "error", {"message": str(e)}
        return

    from app.core import providers

    model_id = providers.default_model_id() or ""
    if not model_id:
        yield "error", {"message": "没有已启用的 provider，请先在设置页配置模型"}
        return

    yield "gathering", {}
    gathered = await gather_inward(
        topic, kb_fn=kb_fn, memory_fn=memory_fn, journal_fn=journal_fn
    )
    # 钉进来的材料排在最前（人指的优先），再去重编号——见 `merge_pinned`
    sources = merge_pinned(pinned_sources(pinned or []), gathered)
    if not sources:
        yield "error", {"message": "你自己的材料里没找到相关内容——先往知识库或日记里放点东西"}
        return
    yield "sources", {
        "sources": [_public_source(s) for s in sources],
        "kb": sum(1 for s in sources if s.get("kind") == "kb"),
    }

    # S1 引擎吃 skill：匹配键 = 这次的话题（体裁与读者已经在 `prompt` 里了，
    # 所以「给领导写汇报要结论先行」这类技能是能被命中的）。没命中就一个字都不多。
    from app.core import skill_match

    inj = skill_match.injection(topic)
    if inj["names"]:
        yield "skills", skill_match.event_data(inj)

    yield "writing", {}
    rep = None
    async for _ev, _payload in _report.synthesize_streaming(
        topic,
        sources,
        skill_match.with_skills(prompt, inj),
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
        # sha 算在**不带提纲**的基准串上（同 `skill_match.with_skills` 的口径）：
        # 提纲是每一次运行的输入，不是提示词版本——算进去的话每份定稿都自成一版，
        # 满意率再也聚不起来（`core/quality.py` 顶部记过这条）。
        "prompt_sha": _report.prompt_sha(base_prompt),
        # 体裁与读者随报告一起回来——存进 vault 之后还看得出这份是给谁写的
        "genre": genre,
        "audience": audience,
        # 这次是按哪份提纲写的（空 = 没用提纲）。界面靠它说清「你确认的那份确实生效了」。
        "outline": [str(x).strip() for x in (outline or []) if str(x or "").strip()],
    }
