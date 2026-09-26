"""提示词对照台（Q1）——把「这条提示词改了以后是变好还是变坏」变成一次可复算的跑分。

**为什么需要它。** `prompts.py` 的登记表把每一条系统提示词锁住了（改了就测试红），但**没人
回答得了「改完到底好没好」**：`docs/upgrade-plan.md` §7 自己记着「提示词改动带 A/B 证据
的比例：**0**」。这台机器补的就是这一步：读登记表 → 按 golden set 重放 → 确定性断言 →
`k/n` + Wilson 区间 + 成本。

**三条边界，与 `prompts.py` 已有的护栏一致：**

1. **不做「改配置不用改代码」的黑箱。** 提示词的单一事实来源仍然是源码里的常量，这里
   **从不写回内容**。候选变体只在这一次跑分里活着（连正文一起留在 run 记录里，只为复算），
   人看完报告仍然要去改代码——改完 sha 会变，`test_prompts.py` 会告诉你登记漂移了。
2. **断言是被声明出来的，不是猜的。** 每条断言都对应提示词**自己的一句话**（`why` 逐条
   写明，见 `CHECKS`），写在 `backend/evals/prompts/*.json` 里，人能审、能改、能加。
   这与「在生产逻辑里猜文本」是两件事：这里断言的是**已经承诺过的行为**，而且失败时把
   原文摊出来给人看。
3. **跑分要花钱，所以边界要明说。** n 条用例 = n 次模型调用；报告带 Wilson 区间，
   n 小的时候区间宽得下不了结论——那就如实输出「无法判定」，不给一个好看的比例。

**重放走的是产品自己那条路**：`tutor.build_messages(..., voice=提示词)` +
`tutor._stream(...)`（后者本来就是为「换一次模型调用」留的缝）。不另写一套拼装逻辑，
否则测的是另一个产品。
"""
from __future__ import annotations

import json
import logging
import math
import re
import time
from collections.abc import Awaitable, Callable

from app.config import BASE_DIR

log = logging.getLogger(__name__)

FIXTURE_DIR = BASE_DIR / "backend" / "evals" / "prompts"

# 规则 6「每轮只做一件事」的**代理指标**：单问句超过这个长度，基本已经不是一件事了。
# 明说是代理：它不是「有没有接管讲解」的直接判定，只是一个便宜的上界。
MAX_CHARS = 260

_ANSWER_CAP = 1200  # 报告里保留的回复长度（足够人审，不至于撑爆 detail_json）

_QUESTION_MARKS = ("？", "?")
_LIST_RE = re.compile(r"(?m)^\s*(?:\d+[.、)）]|[-*•])\s")
_FLATTERY_RE = re.compile(r"很好的解释|说得很好|讲得很好|非常好|很棒|太棒了|很不错|厉害")
_PLAIN_RE = re.compile(r"大白话|说人话|自己的话|别用术语|不用术语|通俗|外行话")
_EXAMPLE_RE = re.compile(r"例子|举个例子|举个|具体点|具体一点")
_LAYMAN_RE = re.compile(r"外行|完全不懂|没学过|三句话|没接触过")
_KEEP_GOING_RE = re.compile(r"你先|你先试|试试|随便说|讲一句|别急|自己讲|你说说|你先说")


def _questions(text: str) -> int:
    return sum(text.count(m) for m in _QUESTION_MARKS)


# 「用户要回答几个问题」的代理指标。**它不是数问号**：数问号会把「一个问题带一串选项」
# 当成好几个问题（「你想听哪一块？——索引结构？B+ 树分裂？」）。
#
# 两条规则，各自对着一个**实测到的**形状（尺子与样本在 `backend/smoke_question.py`）：
#
# 1. **空行分段，一段至少算一个问题。** 「三个独立问题分三段抛出」是实测形状；
#    而「空行」是这段话在视觉上换了话题的地方，比标点可靠。
# 2. **同一段里，连着几个问号之间的文字若只是短的并列选项，算同一个问题。**
#    「是任务？是代码片段？还是别的什么？」是一个问题带选项；而
#    「让给谁？如果每个协程都有自己的线程，那这个线程去哪了？」是**两个**问题——
#    区别就在两个问号之间那段字是「一个短名词」还是「一整句话」。
OPTION_CHARS = 24  # 两个问号之间的文字短于这个长度 → 才有资格被当成「并列选项」
# 长度只是**兜底**（别把一整段话当选项），真正在分「短选项」和「短问题」的是下面那层疑问词 ——
# 「B+ 树的分裂」「Transformer架构」是选项，「为什么」「事件循环怎么调度」是问题，**
# 它们一样短**。所以长度放到 24 是为了容得下「Transformer架构」这种词，而不会放走一个问题。
_BREAK_CHARS = "，。；！,;!…【"  # 出现这些就不是「一个短选项」了
# 紧跟在这些字符后面的问号**不是这一轮在问**：那是引用/举例里带出来的
# （「你说『什么是闭包？』这个问题问反了」）。
_CLOSERS = "」』”\"'）)】>》"
# 「是 A？还是 B？」这类**并列选项**的起头词 —— 它们出现时，后面的疑问词不算新问题
# （「还是别的什么？」里那个「什么」是选项的一部分，不是第二个问题）。
_OPTION_LEAD = ("还是", "或者", "或是", "以及", "还有", "比如", "例如", "是", "或", "又")
# 疑问词。**光看长度分不开「短选项」和「短问题」**（「B+ 树的分裂」 vs 「为什么」），
# 这一层就是那个区分：短的、又不含疑问词的，才是选项。
_INTERROGATIVE = ("什么", "为什么", "怎么", "怎样", "如何", "哪", "谁", "多少", "是否", "吗", "呢")
_OPTION_DECOR = "*`\"'「」『』（）()《》 \t…-—、,，"


def _is_option_segment(seg: str) -> bool:
    """两个问号之间的那截文字，是不是「同一个问题的另一个选项」。Pure.

    三层，顺序是刻意的：
    1. **以并列连接词起头的，一律算选项**（不看长度）——「还是 `some_coro` 内部某行代码…」
       可以很长，但它在语用上就是在接着上一个问题；
    2. 太长的（> `OPTION_CHARS`）不算 —— 那是另一段话，不是选项；
    3. 短的里面，**含疑问词的算新问题** —— 这是「短选项」与「短问题」唯一分得开的地方。
    """
    s = seg.strip().strip(_OPTION_DECOR)
    if not s:
        return False
    if s.startswith(_OPTION_LEAD):
        return True
    if len(s) > OPTION_CHARS:
        return False
    if any(ch in s for ch in _BREAK_CHARS):
        return False
    return not any(w in s for w in _INTERROGATIVE)


def question_count(text: str) -> int:
    """这段回复里，用户大概要回答**几个**问题。Pure。

    空 → 0。规则见文件上方那段注释：空行分段 + 段内并列选项合并 + 引号里的问号不算。
    """
    total = 0
    for block in (text or "").split("\n\n"):
        if not any(m in block for m in _QUESTION_MARKS):
            continue  # 这一段没问问题
        block_n = 0
        seg_start = 0
        for i, ch in enumerate(block):
            if ch not in _QUESTION_MARKS:
                continue
            nxt = block[i + 1 : i + 2]
            if nxt and nxt in _CLOSERS:
                continue  # 引用里的问号
            # 段内第一个问号总是算数；后面的要看它前面那截是不是只是并列选项
            if block_n == 0 or not _is_option_segment(block[seg_start:i]):
                block_n += 1
            seg_start = i + 1
        total += block_n
    return total


# ---------- 断言表：名字 → （判定, 「为什么」——引提示词自己的那句话） ----------
#
# 加断言的门槛：它必须能指着提示词里的**某一句话**。指不出来，就不该在这里——
# 那是"我觉得它应该这样"，不是"它承诺过这样"。
CHECKS: dict[str, tuple[Callable[[str], bool], str]] = {
    "asks_a_question": (
        lambda t: _questions(t) >= 1,
        "规则 1「像一个真诚困惑的学生那样提问」",
    ),
    "one_question_only": (
        lambda t: question_count(t) == 1,
        "规则 6「每轮只做一件事：提一个最好的问题」+ 不要做的事「不要一次抛三个问题」"
        "（按**空行分段 + 段内并列选项合并**数，不是数问号：尺子与样本在 backend/smoke_question.py）",
    ),
    "no_list": (
        lambda t: not _LIST_RE.search(t),
        "规则 6「不要列清单」",
    ),
    "no_flattery": (
        lambda t: not _FLATTERY_RE.search(t),
        "不要做的事「不要客套，不要说『很好的解释』」",
    ),
    "concise": (
        lambda t: len(t) <= MAX_CHARS,
        f"规则 6 的**代理指标**：超过 {MAX_CHARS} 字基本已不是「一件事」",
    ),
    "asks_for_plain_language": (
        lambda t: bool(_PLAIN_RE.search(t)),
        "规则 2「他甩术语而不解释时，要求他用大白话重说一遍」",
    ),
    "asks_for_example": (
        lambda t: bool(_EXAMPLE_RE.search(t)),
        "规则 2「他类比含糊时，要一个具体例子」",
    ),
    "asks_for_layperson": (
        lambda t: bool(_LAYMAN_RE.search(t)),
        "规则 7「让他用三句话给完全外行的人再讲一遍」",
    ),
    "keeps_him_speaking": (
        lambda t: bool(_KEEP_GOING_RE.search(t)),
        "不要做的事「不要接管讲解」+ 规则 5「才给一次最小提示，然后继续让他自己往下讲」",
    ),
}


def check_names() -> list[dict]:
    """断言清单（名字 + 它对应提示词的哪句话）——给界面用，别在界面里抄一份。"""
    return [{"name": n, "why": why} for n, (_, why) in CHECKS.items()]


def run_checks(text: str, names: list[str]) -> tuple[bool, list[dict]]:
    """对一段回复跑一组断言 → （是否全过, 失败项）。未知断言名算失败（不静默忽略）。"""
    failed: list[dict] = []
    for n in names:
        spec = CHECKS.get(n)
        if spec is None:
            failed.append({"name": n, "why": "（未知断言名：scenario 文件可能写错了）"})
            continue
        fn, why = spec
        try:
            ok = bool(fn(text))
        except Exception:  # noqa: BLE001 - 断言自己炸了也算这条不过
            ok = False
        if not ok:
            failed.append({"name": n, "why": why})
    return (not failed, failed)


# ---------- golden set ----------


def fixtures() -> dict[str, dict]:
    """`backend/evals/prompts/*.json` 里所有 golden set，按它自己声明的 `key` 索引。

    文件名不参与索引——**key 由文件内容说**，改名不会把用例弄丢。坏文件跳过并记日志：
    一个写坏的 JSON 不该让整个实验室打不开。

    `domain`（Q3 形态）在这里**归一化**成字符串：文件里没写就是 `""`（= 还没归类）。
    写成 null / 数组 / 数字都当空字符串——它是给分组用的标签，一种坏写法不该让整个
    golden set 读不出来。
    """
    out: dict[str, dict] = {}
    if not FIXTURE_DIR.is_dir():
        return out
    for p in sorted(FIXTURE_DIR.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            log.warning("prompt fixture 读不动：%s", p.name, exc_info=True)
            continue
        key = str(data.get("key") or "").strip()
        if key:
            raw = data.get("domain")
            domain = str(raw).strip()[:30] if isinstance(raw, str) else ""
            out[key] = {**data, "file": p.name, "domain": domain}
    return out


def cases_for(key: str) -> dict | None:
    return fixtures().get(key)


# ---------- golden set 的两种形状 ----------
#
# **形状是这套用例自己的属性，不是调用方的选择。** 聊天型提示词的用例是「一句真实输入 +
# 它必须满足的断言」，重放走 `tutor.build_messages`；判分型（P2-1 的重讲判分）的用例是
# 「卡三样 + 重讲原文 + 人工档位」，重放走 `retell.card_prompt` 那条路，**判据是与人比对**，
# 不是断言。
#
# 少了这道标记，`check()` 会拿聊天那套拼装逻辑去跑判分提示词——那会**静默地**产出一次
# 什么都不测的跑分，而且它还会被当成这条提示词的基线存下来（`variant_sha=""`）。
# 那比没有基线更坏：它看起来像一条基线。
FIXTURE_KINDS = ("chat", "grade")


def fixture_kind(key: str) -> str:
    """这套 golden set 是哪种形状（没写 = `chat`）。"""
    fx = cases_for(key) or {}
    kind = str(fx.get("kind") or "chat").strip().lower()
    return kind if kind in FIXTURE_KINDS else "chat"


def is_grading(key: str) -> bool:
    return fixture_kind(key) == "grade"


# ---------- golden set 的写：把一次事故变成一条用例（喂食）----------
#
# 这是本模块**唯一**会写盘的地方，而且写的不是提示词，是**用例文件**：
# `backend/evals/prompts/*.json` 本来就该跟代码同版本演进（`engine_eval` 那套的同一约定），
# 所以从界面喂进来的用例也落在这里——它进 git、可审、可回滚，不会变成第二个真值。
#
# 规范格式很重要：从界面追加一条时若整份重排，diff 就没法看了。所以这里统一按
# `_canonical()` 写，并有一条测试盯着「磁盘上的文件必须是规范格式」。


def _canonical(data: dict) -> str:
    """golden set 的规范文本：2 空格缩进、中文不转义、结尾一个换行。"""
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def _fixture_path(file_name: str):
    return FIXTURE_DIR / file_name


def canonical_ok(text: str, data: dict) -> bool:
    """磁盘上的内容是不是规范格式（测试用；也用来解释「为什么每次追加都重排」。"""
    return text == _canonical(data)


def _slug(text: str, fallback: str = "case") -> str:
    """用例 id：小写、空白转横线、只留字母数字与横线。中文保留（id 只是给人看的标签）。"""
    s = re.sub(r"\s+", "-", (text or "").strip().lower())
    s = re.sub(r"[^\w\u4e00-\u9fff-]", "", s)
    return (s or fallback)[:40]


def add_case(key: str, *, user: str, intent: str, checks: list[str], case_id: str = "") -> dict:
    """把一条真实踩到的输入喂进金标集，返回新用例。

    三个必填项都有理由：`user` 是那次真实输入（空的用例没意义）；`intent` 是**「它当时
    应该怎样」**（没有这句话的用例只是一段文本，日后没人知道它为什么在集合里）；
    `checks` 是它必须满足的断言（一条都没有 = 这条用例永远算过）。
    """
    fx = cases_for(key)
    if not fx:
        raise ValueError(f"{key} 还没有 golden set（backend/evals/prompts/）")
    if is_grading(key):
        raise ValueError(
            "这套是**判分金标集**：用例是「卡三样 + 重讲原文 + 人工档位」，喂不进聊天型用例"
            "（它的判据是人工档位，不是断言）。要加一条就去改那个 JSON，并在 intent 里写清"
            "为什么是这一档。"
        )
    user = (user or "").strip()
    intent = (intent or "").strip()
    if not user:
        raise ValueError("用例得有一个真实输入（user 不能为空）")
    if not intent:
        raise ValueError("写一句「它当时应该怎样」（intent 不能为空）——没有它的用例日后没人看得懂")
    names = [str(c).strip() for c in (checks or []) if str(c).strip()]
    if not names:
        raise ValueError("至少勾一条断言——一条都没有的用例永远算过，等于没喂")
    unknown = [n for n in names if n not in CHECKS]
    if unknown:
        raise ValueError(f"未知断言：{'、'.join(unknown)}")

    taken = {str(c.get("id")) for c in (fx.get("cases") or [])}
    cid = _slug(case_id or user[:20])
    if cid in taken:  # 同名不覆盖：加个后缀，免得把已有的用例顶掉
        n = 2
        while f"{cid}-{n}" in taken:
            n += 1
        cid = f"{cid}-{n}"

    data = {k: v for k, v in fx.items() if k != "file"}
    data.setdefault("cases", []).append({"id": cid, "intent": intent, "user": user, "checks": names})
    _fixture_path(fx["file"]).write_text(_canonical(data), encoding="utf-8")
    log.info("prompt golden set 喂进来一条：%s/%s", key, cid)
    return {"id": cid, "intent": intent, "user": user, "checks": names}


def remove_case(key: str, case_id: str) -> dict:
    """从金标集里去掉一条。坏用例会污染指标，所以给的出口和入口一样大。

    删的是**文件里的一行**，git 里看得见；提示词本身一个字节都不动。

    **判分型那套的出口在文件里，不在这里**：它的条数有下限（30 条，见
    `judge_eval.MIN_CASES`），从界面上一条条删很容易在不知情的情况下把整套跑到跑不动
    （那时报的是「用例数 29 不在 30–50」——一个跟「我删了一条坏用例」看不出关系的信息）。
    要删就去改那个 JSON，顺手补一条替换的。
    """
    fx = cases_for(key)
    if not fx:
        raise ValueError(f"{key} 还没有 golden set（backend/evals/prompts/）")
    if is_grading(key):
        raise ValueError(
            "判分金标集不从界面删：它的条数有下限（30 条），删到线以下整套就跑不了了。"
            "要换一条就去改那个 JSON——顺手补上一条替换的。"
        )
    cases = [c for c in (fx.get("cases") or []) if str(c.get("id")) != str(case_id)]
    if len(cases) == len(fx.get("cases") or []):
        raise ValueError(f"没有这条用例：{case_id}")
    if not cases:
        raise ValueError("最后一条用例不能删——没有用例的 golden set 跑不了对照")
    data = {k: v for k, v in fx.items() if k != "file"}
    data["cases"] = cases
    _fixture_path(fx["file"]).write_text(_canonical(data), encoding="utf-8")
    log.info("prompt golden set 删掉一条：%s/%s", key, case_id)
    return {"key": key, "removed": case_id, "left": len(cases)}


def set_domain(key: str, domain: str) -> dict:
    """给一套 golden set 标上它测的是哪个领域（Q3 形态的分组键）。

    **写在用例文件里，不写在提示词上。** 领域是「这套用例在问什么」的属性，不是
    「这段提示词是什么」的属性：同一条提示词换一套用例就是在测另一个领域了。写在这里
    它也跟着进 git、可审、可回滚，和喂一条用例是同一条路。

    只收一个短词（≤30 字，和 `DecisionLog.topic`、`EvalItem.domain` 同规矩）。空字符串
    是合法值，含义是**还没归类**。同一个领域必须写成同一个词——分组按精确相等，写
    「sqlite」和「SQLite」就是两个领域；这条也写在 `_EXTRACT_PROMPT` 里给模型看。
    """
    fx = cases_for(key)
    if not fx:
        raise ValueError(f"{key} 还没有 golden set（backend/evals/prompts/）")
    d = (domain or "").strip()[:30]
    data = {k: v for k, v in fx.items() if k != "file"}
    data["domain"] = d
    _fixture_path(fx["file"]).write_text(_canonical(data), encoding="utf-8")
    log.info("prompt golden set 领域：%s → %r", key, d)
    return {"key": key, "domain": d}


# ---------- Wilson 区间 ----------


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval。**这是报告格式的硬要求**：裸比例会让人把噪声当结论。

    n=0 → (0, 1)，即「什么都不知道」。n 小的时候区间会很宽——那是真相，不是 bug。
    """
    if n <= 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    center = p + z * z / (2 * n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, (center - half) / d), min(1.0, (center + half) / d))


# 「下得了结论」的那条线。**给它一个名字**是因为仪表盘那一格的口径原文要引它
# （`BOARD_RULES`）：把 0.34 在两处各写一遍，改一处忘一处的那天，界面说的和代码做的
# 就不是一回事了——这个仓库为这类分叉付过账（§4-7 一事一处）。
CAN_TELL_WIDTH = 0.34


def can_tell(lo: float, hi: float) -> bool:
    """这次跑分下得了结论吗：区间宽度 ≤ `CAN_TELL_WIDTH`（约 ±0.17）才算有分辨力。

    宽度这件事要摆在明面上：n=8 且全过时区间是 [0.68, 1.00]（宽 0.32），
    也就是说「8 个用例全过」**还不足以**说它比 [0.53, 0.99] 的那版更好。
    """
    return (hi - lo) <= CAN_TELL_WIDTH


# ---------- 一次跑分 ----------


async def _generate(model_id: str, messages: list[dict]) -> str:
    """默认的模型调用：走 tutor 自己的那条缝（它有 provider 回落，别另写一份）。"""
    from app.core import tutor

    parts: list[str] = []
    async for delta in tutor._stream(model_id, messages):  # noqa: SLF001 - 它本来就是留的缝
        parts.append(delta)
    return "".join(parts).strip()


def _entry(key: str):
    """从登记表里取一条。找不到 / 登记漂移（模块加载失败）都抛 ValueError。"""
    from app.core import prompts

    for p in prompts.inventory():
        if p.name == key:
            if p.content is None:
                raise ValueError(f"提示词 {key} 登记漂移：{p.module} 加载不出内容")
            return p
    raise ValueError(f"登记表里没有 {key}")


def _summarize(run) -> dict:
    """一次 run → 给界面/接口的字面量。

    `at` **必须过 `iso_utc`**：这一列是 `utcnow()` 写的、SQLite 往返之后是 naive，
    直接 `isoformat()` 给浏览器，`new Date(...)` 会当成**本地时间**读——UTC+8 下就成了
    「8 小时前」。小屋的技能卡第一版就是栽在这上面（一张刚跑出来的卡写着「8 小时前」），
    和 P1 那个 `pet.status()` 的时区错是同一个病。"""
    from app.models import iso_utc

    return {
        "id": run.id,
        "at": iso_utc(run.created_at) or "",
        "key": run.key,
        "prompt_sha": run.prompt_sha,
        "variant_sha": run.variant_sha,
        "variant_label": run.variant_label,
        "model_id": run.model_id,
        "cases": run.cases,
        "passed": run.passed,
        "rate": run.rate,
        "ci_low": run.ci_low,
        "ci_high": run.ci_high,
        "seconds": run.seconds,
        "detail_json": run.detail_json,
    }


# 一次最多捞多少行「最新成绩」。400 行够覆盖登记表里每条提示词的很多轮历史；
# 它同时是**说话的上限**（别为了一页墙把整张表捞进内存）。
LATEST_ROWS = 400


async def _latest_rows(limit: int = LATEST_ROWS) -> list:
    """`variant_sha` 为空的最新若干行，**新 → 旧**。**I/O 只在这一处**。

    与 `turn_trace._summary_rows` / `metrics._day_counts` 同一个形状（那两处留同样的缝）：
    要验「读不到」时 monkeypatch 这一条，不必去跟 sessionmaker 较劲。

    **它抛出去**：吞掉的话调用方就分不清「一条都没有」和「读不出来」了（§4-8）。
    要吞的是它上面那一层（`latest_baselines` 给小屋用，那里空列表是安全的）。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import PromptEvalRun

    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(PromptEvalRun)
                .where(PromptEvalRun.variant_sha == "")
                .order_by(PromptEvalRun.id.desc())
                .limit(max(1, int(limit)))
            )
        ).scalars().all()
    return list(rows)


async def latest_baselines() -> dict[str, dict]:
    """每条提示词**已登记内容**的最新一次成绩，一个查询搞定。

    小屋那张技能卡要读它，而挂件每 60 秒就会拉一次房间——按 key 各查一次就是登记表条数
    那么多个往返，没必要。`registry` 那种一次性面（人打开才看）用 `baseline()` 逐条查没关系，这里不行。
    """
    out: dict[str, dict] = {}
    try:
        rows = await _latest_rows()
    except Exception:  # noqa: BLE001
        log.warning("prompt eval latest baselines failed", exc_info=True)
        return out
    for r in rows:  # 已按 id 倒序：每个 key 的第一条就是最新的
        out.setdefault(r.key, _summarize(r))
    return out


async def cards() -> list[dict]:
    """屋里的**技能卡**：跑过对照的提示词。

    「技能只有一个到手方式：它被证明有效过」——所以这里只收**有基线**的：没跑过的
    提示词不是技能，是一段还没验过的文本，宠物不展示它。`stale` 是诚实的一部分：
    基线跑完之后内容又改过（sha 变了），这张卡上的分数就不是现在这版的了。

    注意它的成本：房间每 60 秒拉一次，所以分数走 `latest_baselines()` **一次查询**，
    领域只读那个很小的 golden set 目录（同步、几个小 JSON），不按 key 各查一次。
    """
    from app.core import prompts

    base = await latest_baselines()
    fx = fixtures()
    out: list[dict] = []
    for p in prompts.inventory():
        b = base.get(p.name)
        if not b or p.content is None:
            continue
        out.append(
            {
                "name": p.name,
                "module": p.module,
                "purpose": p.purpose,
                "kind": p.kind,
                "sha": p.sha,
                # 领域（Q3 形态）：写在这条提示词的 golden set 里，没标就是 ""
                "domain": str((fx.get(p.name) or {}).get("domain") or ""),
                "passed": b["passed"],
                "cases": b["cases"],
                "rate": b["rate"],
                "ci_low": b["ci_low"],
                "ci_high": b["ci_high"],
                "at": b["at"],
                "model_id": b["model_id"],
                # 这张卡上的成绩是不是**这一版**内容跑出来的
                "stale": b["prompt_sha"] != p.sha,
            }
        )
    out.sort(key=lambda c: (c["rate"], c["cases"]), reverse=True)
    return out


# ---------- R1 补齐：提示词评测上墙（PLAN5 §2-2 点名的九条之一）----------
#
# **这一格量的是「尺子本身有没有被量过」，不是「哪条提示词更好」。** 它是资产指标
# （与接地分同族）：登记表里那些提示词，其中跑过 golden set 的有几条、量出来的结论
# 站得住的又有几条——回答的是「提示词这一层到底有没有基线」。
#
# **为什么不摆每条提示词的分数。** `cards()` 是给小屋的技能卡用的，它按 rate 倒序排
# （「技能只有一个到手方式：它被证明有效过」）。原样搬上墙就成了一面排行榜——§4-2 明令
# 不许，而且墙上那些数一旦能比大小，下一个人就会去追它。所以这里**只给计数**。
#
# **读不到就说读不到**（§4-8）：`_latest_rows` 抛了就 `readable=false`，不给一排 0
# 充数——「一条都没读到」与「读到了、一条都没跑过」是两件事。
BOARD_RULES = {
    "registered": "分母 = 登记表里的提示词条数（`prompts.inventory()`；内容活在源码里，这里只数）",
    "measured": "分子 = 其中跑过 golden set、有成绩的条数（`prompt_eval_runs` 里 `variant_sha` 为空的最新一条）",
    "decidable": f"「站得住」= Wilson 区间宽度 ≤ {CAN_TELL_WIDTH}（`can_tell`）——样本小的时候区间很宽，那是真相不是 bug",
    "stale": "「过期」= 基线跑完之后这条提示词的内容又改过（sha 变了）：那个分数不是现在这版的",
}


async def board() -> dict:
    """墙上那一格：登记了多少条、量过几条、其中几条站得住、几条已经过期。

    **输出里没有任何一条提示词的名字或分数**——它不排座次（见上面那段）。
    """
    from app.core import prompts

    out = {
        "readable": False,
        "error": "",
        "registered": 0,
        "measured": 0,
        "decidable": 0,
        "stale": 0,
        "cases": 0,
        "rules": BOARD_RULES,
        "bias": "基线是**某一个模型**跑出来的（每行都记着 `model_id`）：换模型之后这个分数不适用。",
    }
    try:
        rows = await _latest_rows()
        inventory = prompts.inventory()
    except Exception as e:  # noqa: BLE001 - 派生视图，坏了照实说，不假装零
        log.warning("prompt eval board failed", exc_info=True)
        out["error"] = f"{type(e).__name__}: {e}"
        return out

    latest: dict[str, dict] = {}
    for r in rows:  # 已按 id 倒序：每个 key 的第一条就是最新的
        latest.setdefault(r.key, _summarize(r))

    measured = decidable = stale = cases = 0
    for p in inventory:
        b = latest.get(p.name)
        # `content is None` = 登记的那段文字在源码里找不到了（漂移）。判据与 `cards()`
        # 同一份，免得「量过几条」在小屋和墙上给出两个答案（§4-7 一事一处）。
        if not b or p.content is None:
            continue
        measured += 1
        cases += int(b["cases"] or 0)
        if can_tell(float(b["ci_low"]), float(b["ci_high"])):
            decidable += 1
        if b["prompt_sha"] != p.sha:
            stale += 1

    out.update(
        readable=True,
        error="",
        registered=len(inventory),
        measured=measured,
        decidable=decidable,
        stale=stale,
        cases=cases,
    )
    return out


async def history(key: str, limit: int = 10) -> list[dict]:
    """这条提示词跑过的对照，新 → 旧。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import PromptEvalRun

    try:
        async with SessionLocal() as db:
            rows = (
                await db.execute(
                    select(PromptEvalRun)
                    .where(PromptEvalRun.key == key)
                    .order_by(PromptEvalRun.id.desc())
                    .limit(max(1, min(limit, 50)))
                )
            ).scalars().all()
    except Exception:  # noqa: BLE001 - 历史读不动不该挡住跑分
        log.warning("prompt eval history failed", exc_info=True)
        return []
    return [_summarize(r) for r in rows]


async def baseline(key: str, model_id: str = "", prompt_sha: str = "") -> dict | None:
    """这条提示词**已登记内容**最近一次跑出的成绩（对照的基准）。

    只认 `variant_sha` 为空、且（给了 sha 就）指纹相同的那些 run——拿一个候选变体的分数
    当基准，会让「变好还是变坏」整个失去意义。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import PromptEvalRun

    try:
        async with SessionLocal() as db:
            q = select(PromptEvalRun).where(
                PromptEvalRun.key == key, PromptEvalRun.variant_sha == ""
            )
            if prompt_sha:
                q = q.where(PromptEvalRun.prompt_sha == prompt_sha)
            if model_id:
                q = q.where(PromptEvalRun.model_id == model_id)
            row = (
                await db.execute(q.order_by(PromptEvalRun.id.desc()).limit(1))
            ).scalar_one_or_none()
    except Exception:  # noqa: BLE001
        log.warning("prompt eval baseline failed", exc_info=True)
        return None
    return _summarize(row) if row else None


def _case_states(detail_json: str) -> dict[str, bool]:
    """从一次 run 的 `detail_json` 里取出「每条用例过没过」。

    **同时认两种形状**：列表（引擎那套 `EngineEvalRun` 的写法）与
    `{"variant_text", "cases"}`（本模块现在写的）。这里只认一种的话，「和基准比」
    会**静默地永远比不出东西**——第一版就是这个 bug，靠测试逮住的。
    """
    try:
        data = json.loads(detail_json or "[]")
    except Exception:  # noqa: BLE001
        return {}
    cases = data.get("cases") if isinstance(data, dict) else data
    if not isinstance(cases, list):
        return {}
    out: dict[str, bool] = {}
    for c in cases:
        if isinstance(c, dict) and c.get("id") is not None:
            out[str(c["id"])] = bool(c.get("passed"))
    return out


def _flips(now_cases: list[dict], before: dict | None) -> list[dict]:
    """和基准比，哪几条用例翻面了（新过 / 新挂）。纯函数。"""
    if not before:
        return []
    old = _case_states(before.get("detail_json") or "")
    if not old:
        return []
    out: list[dict] = []
    for c in now_cases:
        was = old.get(str(c["id"]))
        if was is None or was == c["passed"]:
            continue
        out.append({"id": c["id"], "was": was, "now": c["passed"]})
    return out


async def check(
    key: str,
    *,
    variant: str | None = None,
    variant_label: str = "",
    model_id: str = "",
    generate: Callable[[str, list[dict]], Awaitable[str]] | None = None,
    save: bool = True,
    cancel_key: str = "",
) -> dict:
    """跑一次对照。

    `variant` 为空 = 重放**已登记的内容**（跑基线/回归）；给了就是拿一段候选内容比一比。
    候选内容不进配置、不进登记表——它只出现在这一次的 run 记录里，供复算与审阅。

    `cancel_key` 非空 = 这一趟**可被取消**（合作式：每条用例之间查一次，见 `core/inflight`）。
    HTTP 层传 `prompt-eval:<key>`；内部调用方不传，就不查——一次纯函数式的跑分不该
    因为进程里别处的状态而半路停下。
    """
    import hashlib

    from app.core import inflight, providers, tutor

    entry = _entry(key)
    fx = cases_for(key)
    if not fx:
        raise ValueError(f"{key} 还没有 golden set（backend/evals/prompts/）")
    if is_grading(key):
        raise ValueError(
            f"{key} 的用例是**判分型**（卡三样 + 重讲原文 + 人工档位），不走这条重放路："
            "它的判据是跟人工档位比对，不是对回复跑断言。跑它用 `core/judge_eval.py`"
            "（界面上的「跑一次」会自动走对的那条）。"
        )
    cases = [c for c in (fx.get("cases") or []) if c.get("id") and c.get("user")]
    if not cases:
        raise ValueError(f"{key} 的 golden set 里没有用例")

    text = entry.content if variant is None else variant
    if not text or not text.strip():
        raise ValueError("候选内容是空的")
    variant_sha = "" if variant is None else hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
    model_id = model_id or (providers.default_model_id() or "")
    gen = generate or _generate

    started = time.time()
    rows: list[dict] = []
    stopped = False
    for case in cases:
        # 每条用例之间查一次：一次生成动辄几十秒，所以停下来的粒度是「当前这条跑完」。
        # 界面上因此写「正在停…（这一条跑完就停）」，不写「已停止」。
        if cancel_key and inflight.cancel_requested(cancel_key):
            stopped = True
            break
        names = [str(n) for n in (case.get("checks") or [])]
        # 重放走产品自己那条路：同 build_messages、同 stream 缝，空上下文（无召回/材料/画像）。
        # 这条边界要写在报告里——上下文会显著改变行为（upgrade-plan 缺口五：0/4 vs 15/16）。
        messages = tutor.build_messages([{"role": "user", "content": str(case["user"])}], voice=text)
        t0 = time.time()
        err = ""
        try:
            reply = await gen(model_id, messages)
        except Exception as e:  # noqa: BLE001 - 一次失败是一条用例失败，不是整次跑分失败
            reply, err = "", f"{type(e).__name__}: {e}"[:200]
        ok, failed = (False, [{"name": "generate", "why": err}]) if err else run_checks(reply, names)
        rows.append(
            {
                "id": str(case["id"]),
                "intent": str(case.get("intent") or ""),
                "user": str(case["user"]),
                "checks": names,
                "passed": ok,
                "failed": failed,
                "reply": reply[:_ANSWER_CAP],
                "chars": len(reply),
                "seconds": round(time.time() - t0, 2),
                "error": err,
            }
        )

    if stopped:
        # **半趟跑分不落记录、也不给区间。** 「跑分」这个数的全部意义是「这一版内容在
        # 一整套用例上怎么样」；跑了一半的 k/n 会被读成「变差了」，而它只是被打断了
        # ——那正是质量闭环最怕的污染。已经跑完的那几条照原样返回：点了停止的人该看见
        # 「停在哪一条」，而不是一片空白。
        done = len(rows)
        return {
            "key": key,
            "module": entry.module,
            "purpose": entry.purpose,
            "kind": entry.kind,
            "prompt_sha": entry.sha,
            "variant_sha": variant_sha,
            "variant_label": variant_label.strip()[:60],
            "model_id": model_id,
            "cases": rows,
            "total": done,
            "planned": len(cases),
            "passed": sum(1 for r in rows if r["passed"]),
            "rate": None,
            "ci": None,
            "tell": False,
            "assertions": {
                "total": sum(len(r["checks"]) for r in rows),
                "failed": sum(len(r["failed"]) for r in rows),
            },
            "seconds": round(time.time() - started, 1),
            "calls": done,
            "baseline": None,
            "flips": [],
            "stopped": True,
            "context": "空上下文（无召回 / 无材料 / 无画像）——上下文会显著改变行为",
        }

    passed = sum(1 for r in rows if r["passed"])
    total = len(rows)
    lo, hi = wilson(passed, total)
    seconds = round(time.time() - started, 1)
    before = await baseline(key, model_id=model_id, prompt_sha=entry.sha)
    report = {
        "key": key,
        "module": entry.module,
        "purpose": entry.purpose,
        "kind": entry.kind,
        "prompt_sha": entry.sha,
        "variant_sha": variant_sha,
        "variant_label": variant_label.strip()[:60],
        "model_id": model_id,
        "cases": rows,
        "total": total,
        "passed": passed,
        "rate": round(passed / total, 3) if total else 0.0,
        "ci": [round(lo, 3), round(hi, 3)],
        "tell": can_tell(lo, hi),
        "assertions": {
            "total": sum(len(r["checks"]) for r in rows),
            "failed": sum(len(r["failed"]) for r in rows),
        },
        "seconds": seconds,
        "calls": total,
        "baseline": (
            {
                "at": before["at"],
                "passed": before["passed"],
                "total": before["cases"],
                "variant_label": before["variant_label"],
            }
            if before
            else None
        ),
        "flips": _flips(rows, before),
        "context": "空上下文（无召回 / 无材料 / 无画像）——上下文会显著改变行为",
    }

    if save:
        from app.db import SessionLocal
        from app.models import PromptEvalRun

        try:
            async with SessionLocal() as db:
                row = PromptEvalRun(
                    key=key,
                    prompt_sha=entry.sha,
                    variant_sha=variant_sha,
                    variant_label=report["variant_label"],
                    model_id=model_id,
                    cases=total,
                    passed=passed,
                    rate=report["rate"],
                    ci_low=report["ci"][0],
                    ci_high=report["ci"][1],
                    seconds=seconds,
                    # 逐条明细（含**候选正文**）：它是**证据**，不是配置——没有任何代码
                    # 会从这里读回提示词。要采纳就去改源码，改完 sha 会变。
                    detail_json=json.dumps(
                        {
                            "variant_text": "" if variant is None else text,
                            "cases": rows,
                        },
                        ensure_ascii=False,
                    ),
                )
                db.add(row)
                await db.commit()
                await db.refresh(row)
                report["run_id"] = row.id
        except Exception:  # noqa: BLE001 - 存不下不该让报告丢掉
            log.warning("prompt eval persist failed", exc_info=True)

    return report
