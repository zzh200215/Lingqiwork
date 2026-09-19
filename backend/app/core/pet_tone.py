"""零柒的语气微调（P2）：按**读出来的**喂养分布，调它的**用词**。

**它解决什么。** 零柒是一只被喂养出来的宠物——你喂它什么，它身上就长什么（§8.8：
「它的样子由喂养史决定，不由钱包决定」）。这一格把这句话从「长什么样」推到「怎么说话」：
你最近在学的领域，它张口就能用得上那个领域的词，而不必绕开或者先解释一遍。

**它只改用词，不改性格、不改立场。** 三条自锁写在 `TONE_RULE` 里（模型看得见，测试也钉着）：

1. **不夸**——「你最近很努力」「学了这么多」这类话一句都不说，那是教练不是陪着的那个；
2. **不评**——不点评进度、不建议接下来学什么（`diagnostic not evaluative` 那条线）；
3. **不猜**——只说**数出来的**领域；数不出来就一个字都不加。

**证据门槛**：一个领域至少 `MIN_SAMPLE` 个概念才算数。一两个概念就给用户贴一张
「你在学 X」的标签，是拿噪声当性格——与「没有基线就不许说它行」是同一条纪律。

**运行时追加，不动登记过的人设常量。** `pet.CHAT_SYSTEM` 是 `prompts._SPECS` 里的一等
提示词（kind=persona、带 sha）：改它等于把整条人设换了个版本，而这个仓库的质量闭环正是
按 sha 分开统计的。这一格要的不是换人设，是在**同一套人设上加一句用词倾向**——
所以 `apply()` 只往 system 后面追加，而那条规矩自己**单独登记**（`TONE_RULE`，
同 `routers/pet._PET_TOOL_RULE` 的先例：运行时注入的规矩也要是一等公民，不夹带）。

**默认开着**（就是这一句温和的用词倾向），要关在设置里关。默认关掉的后果这个仓库已经
吃过一次——`models.Habit` 那段注释写着「the empty-list cold start is what killed every
other opt-in feature in this project」。
"""

import logging

from app.core.prefs import load_config

log = logging.getLogger(__name__)

__all__ = [
    "MAX_DOMAINS",
    "MIN_SAMPLE",
    "TONE_RULE",
    "apply",
    "enabled",
    "feeding",
    "flavor",
    "flavor_enabled",
    "hint",
]

MIN_SAMPLE = 3  # 一个领域至少碰过几个概念才算「他在学这个」
MAX_DOMAINS = 2  # 最多提两个领域：说三个以上就成了给用户画学习画像

TONE_RULE = """他最近在碰的领域会写在下面。跟他说话时：
- 那些领域的词可以直接用，不用绕开、也不用先解释一遍——他懂；
- **不要夸他**（「最近很努力」「学了这么多」这类话一句都不要说）；
- **不要点评他的进度**，也不要建议他接下来该学什么——记住他在碰什么就够了；
- 下面没有给领域时，就照你平常的说法，别硬凑。"""


def enabled(prefs: dict | None = None) -> bool:
    """这个开关是不是开着。读不到配置就按默认（开）。Pure-ish（读一次配置，不碰库）。"""
    try:
        return bool((prefs if prefs is not None else load_config()).get("pet_tone", True))
    except Exception:  # noqa: BLE001 - 配置坏了不该让宠物不会说话
        return True


async def feeding() -> list[dict]:
    """喂养分布：`[{domain, seen, mastered}]`，碰得多的在前。**纯派生**，读不出来就空表。

    「喂养」在这个仓库里的真值只有一处——`tutor.concepts_by_domain()`（领域维度的学习
    轨迹）。**不另算一份**：材料路径（`digest_points.source`）是文件不是领域，从路径里
    猜领域就是在生产逻辑里猜文本，那正是这个仓库明令不做的事。
    """
    from app.core import tutor

    try:
        by_domain = await tutor.concepts_by_domain()
    except Exception:  # noqa: BLE001 - 性格是增强，读不出来就不加这一句
        log.debug("pet tone feeding failed", exc_info=True)
        return []
    rows = [
        {
            "domain": str(d).strip(),
            "seen": len(v.get("seen") or []),
            "mastered": len(v.get("mastered") or []),
        }
        for d, v in by_domain.items()
        if str(d).strip()
    ]
    rows.sort(key=lambda r: (-r["seen"], r["domain"]))
    return rows


async def hint(prefs: dict | None = None) -> str:
    """该往 system 里追加的那一句；不加就返回**空串**（开关关着、或数不出够分量的领域）。"""
    if not enabled(prefs):
        return ""
    rows = [r for r in await feeding() if r["seen"] >= MIN_SAMPLE][:MAX_DOMAINS]
    if not rows:
        return ""
    what = "、".join(f"「{r['domain']}」（{r['seen']} 个概念）" for r in rows)
    return f"{TONE_RULE}\n他最近在碰的领域：{what}。"


def flavor_enabled(prefs: dict | None = None) -> bool:
    """Z4 那一行风味小注的开关（与 `pet_tone` 分开：一个改用词、一个多一行字）。"""
    try:
        return bool((prefs if prefs is not None else load_config()).get("pet_flavor", True))
    except Exception:  # noqa: BLE001 - 配置坏了不该让成长页少一行字
        return True


def _flavor_line(rows: list[dict]) -> str:
    """分布 → 那一句。**纯函数**（读起来是事实，不是评价）。"""
    if not rows:
        return ""
    first = f"「{rows[0]['domain']}」（{rows[0]['seen']} 个概念）"
    if len(rows) == 1:
        return f"这阵子喂它最多的是{first}。"
    second = f"「{rows[1]['domain']}」（{rows[1]['seen']} 个概念）"
    return f"这阵子喂它最多的是{first}，其次是{second}。"


async def flavor(prefs: dict | None = None) -> str:
    """称号旁那一行**风味小注**（Z4 · PLAN4）：把喂养分布说成一句事实。

    与 `hint()` 读**同一份**分布、**同一个门槛**（`MIN_SAMPLE`，最多两个领域）：一个领域
    至少 3 个概念才算数。数不出来就返回**空串**——界面上那一行干脆不出现，不猜、不硬凑
    （「没有基线就不许说它行」同一条纪律）。

    它说的仍然是**事实**（哪个领域、几个概念），只是摆到台面上给人看；说话的语气也守
    `TONE_RULE` 那三条：不夸、不评、不猜。「喂养史决定它是什么」**到措辞为止**——
    不改称号本体、不做称号替换、不做皮肤（PLAN4 §8.5）。
    """
    if not flavor_enabled(prefs):
        return ""
    rows = [r for r in await feeding() if r["seen"] >= MIN_SAMPLE][:MAX_DOMAINS]
    return _flavor_line(rows)


async def apply(system: str, prefs: dict | None = None) -> str:
    """把那一句追加到 system 后面。**只追加，绝不替换**：关掉或没数据时原样返回。

    调用方（`routers/pet.pet_chat`）拿到的是同一个字符串对象还是追加过的版本，
    取决于这里；人设常量本身**在任何情况下都不会被改写**。
    """
    line = await hint(prefs)
    return f"{system}\n\n{line}" if line else system
