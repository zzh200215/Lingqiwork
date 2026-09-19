"""一份材料 → 一个**能力候选**（环一：「学习 → 工作」）。

## 它要解决的问题

你在学习模块读了一篇论文 / 一份材料，里面有一套值得反复用的工序（评测口径、复现步骤、
审查清单）。现在这条路只能靠你自己记住，然后下次手打一遍。这个模块把它变成**一个能力包**：
一份 `SKILL.md` ——「何时用它、按什么步骤做」，模型按需加载（`core/skills.py` 的既有机制）。

## 为什么落地成 SKILL.md，而不是「自动生成一个小工具」

`docs/loops.md` 里写过这条判断，这里只留结论：这个仓库造能力从来不贵，**贵的是证明它有用**
（Q1 的对照台、`ai-dev-plan` 的「技能卡必须有基线才展示」都是同一句话）。
一份自动生成的脚本既不在工具白名单里、也没有基线、也没有地方"装"——那是装饰。
而 SKILL.md 是**指令包**：它进 `skills/`、被索引、被 `skill_load` 按需加载，
而且它天生可以**被对照**（同一套用例，有它 / 没它跑一遍，看分数差）。

## 硬规矩（这个模块最要紧的部分）

1. **不是每份材料都能出能力。** 判断不了就直说 `usable=false` 并给理由 —— 硬凑一份
   SKILL.md 是负收益：`skills/` 里多一份没人用的指令，索引里就多一条噪音。
2. **正文是工序，不是摘要。** 「这篇讲了什么」是笔记的活；这里是「**下次怎么做**」。
3. **不覆盖已有的技能。** 同名就停下来，把决定交给人（`overwrite=False`，报出已有的那份）。
4. **写下去不等于登记。** 落盘的是一份**草稿**：它没跑过对照、没有基线，所以
   `report()` 里它 `registered=False`。要变成"技能卡"得先量过 —— 与 W7 的画像、
   Q2 的技能卡同一条纪律：**没有基线的东西不许当成能力展示。**
"""
import logging
from pathlib import Path

from pydantic import BaseModel, field_validator

from app.core import skills as skills_core

log = logging.getLogger(__name__)

# 材料进模型的上限。一整篇论文塞进去会把上下文吃光，而「出能力」看的是其中的
# **工序段**（方法 / 评测 / 步骤），不是全文。与 `cards.MAX_INPUT_CHARS` 同一个量级。
MATERIAL_CHARS = 12000

CANDIDATE_SYSTEM = """你在把一份材料（论文 / 文档 / 你自己的笔记）读成**一个可复用的能力包**。

你要判断的是：**这份材料里有没有一套值得反复执行的工作工序？**
（评测口径、复现步骤、审查清单、排查顺序、写作套路……）

规则：
1. 有工序 → `usable=true`，把它写成一份 SKILL.md 的正文：**「什么时候用它」+「按什么步骤做」**。
   步骤要能照着执行（祈使句、有判断点、有输出长什么样），不要写成「这篇讲了什么」的摘要。
2. **没有工序 → `usable=false`**，`reason` 里一句话说清为什么（只是背景知识 / 只是一堆结论 /
   材料太碎）。**不要硬凑**——凑出来的技能没人用，只是给索引添噪音。
3. `name`：短、能当文件夹名（2–20 字，中文可以，不含空格与斜杠）。
4. `description`：**一行，何时使用它**（它会进每轮对话的技能索引，太长就是浪费上下文）。
5. `instructions`：Markdown 正文，不要重复 frontmatter 的内容。
6. `existing`：如果这份材料明显与某个**已知技能**重叠，把那个技能名填进来（没有就留空）。
   它只用来提醒人「这个可能已经有了」。

只输出 JSON，不要解释、不要代码块。"""


# 从**运行**读能力（S2，PLAN3 §2 S2）：与上面那份的区别只有一处——输入不是一份材料，
# 而是**你自己干过的活**（题目 + 产出）。所以第 2 条问的也从「摘要」换成了「纪要」：
# 「这次做了什么」讲一遍没有价值，「下次怎么做」才有。四条硬规矩一个字没放松。
RUN_CANDIDATE_SYSTEM = """你在把**一段真实的工作**（一次成文引擎的运行，或者「处理一项工作」那样的几步链）
读成**一个可复用的能力包**。

规则：
1. 有工序 → `usable=true`，把它写成一份 SKILL.md 的正文：**「什么时候用它」+「按什么步骤做」**。
   步骤要能照着执行（祈使句、有判断点、有输出长什么样），**不要写成「这次做了什么」的纪要**。
2. **没有工序 → `usable=false`**，`reason` 里一句话说清为什么（只是一次性的结果 / 只是把材料
   换了个说法 / 题目太特定）。**不要硬凑**——凑出来的技能没人用，只是给索引添噪音。
3. `name`：短、能当文件夹名（2–20 字，中文可以，不含空格与斜杠）。
4. `description`：**一行，何时使用它**（它会进每轮对话的技能索引，太长就是浪费上下文）。
5. `instructions`：Markdown 正文，不要重复 frontmatter 的内容。
6. `existing`：如果这段工作明显与某个**已知技能**重叠，把那个技能名填进来（没有就留空）。

只输出 JSON，不要解释、不要代码块。"""

# 一次运行最多带几步进材料：「处理一项工作」三步就是三份；再多只会把不同趟的活混在一起。
RUN_STEPS = 3


class SkillCandidate(BaseModel):
    """模型给的一份候选。字段少是刻意的：**读得懂的结构胜过一堆可选字段**。"""

    usable: bool = False
    name: str = ""
    description: str = ""
    instructions: str = ""
    reason: str = ""
    existing: list[str] = []

    @field_validator("name", "description", "reason", mode="before")
    @classmethod
    def _text(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()

    @field_validator("instructions", mode="before")
    @classmethod
    def _body(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()

    @field_validator("existing", mode="before")
    @classmethod
    def _names(cls, v):
        if not isinstance(v, list):
            return []
        return [str(x).strip() for x in v if str(x).strip()]


def skill_text(c: SkillCandidate) -> str:
    """候选 → SKILL.md 的完整文本（frontmatter + 正文）。Pure.

    frontmatter 只有 `name` 与 `description` 两个键：`skills._parse_skill_text` 认的就是
    这两个（`model` / `tools` 是可选的，一份材料生成不出「该用哪个模型」这种判断，
    留空比瞎填好）。
    """
    return (
        "---\n"
        f"name: {c.name}\n"
        f"description: {c.description}\n"
        "---\n\n"
        f"{c.instructions}\n"
    )


def _why(reason: str, meta=None) -> str:
    """给人看的一句话理由：优先用模型的，其次用抽取层的错误。"""
    r = (reason or "").strip()
    if r:
        return r[:300]
    err = getattr(meta, "error", "") or ""
    return (err or "模型没有给出可用的结构").strip()[:300]


async def draft(
    *,
    source_path: str = "",
    text: str = "",
    model_id: str = "",
    overwrite: bool = False,
) -> dict:
    """读一份材料 → 判断能不能成能力 → 落一份 SKILL.md 草稿。

    `source_path` / `text` 二选一，读取与守卫都复用 `cards.collect_material`（vault 包含性
    检查、外部 `repo:`/`dir:` 规格、粘贴文本的长度下限，那一处早就写好了）。
    **永不抛异常**：失败返回 `{"ok": False, "reason": ...}` —— 它是顺手做的一件事，
    不该把调用方的流程打断（与 `_distill` / `_score_run` 同一条纪律）。
    """
    from app.core import cards as cards_core

    try:
        rel, label, material = await _read(source_path, text, cards_core)
    except ValueError as e:
        return {"ok": False, "reason": str(e), "usable": False}

    return await _land(
        label=label,
        material=material,
        system=CANDIDATE_SYSTEM,
        model_id=model_id,
        overwrite=overwrite,
        source=rel or "（粘贴文本）",
    )


async def draft_from_run(
    run_id: int,
    *,
    model_id: str = "",
    overwrite: bool = False,
) -> dict:
    """读一次**运行**（连带它那条链的最近几步）→ 判断这段工作里有没有一套工序 → 落草稿。

    这是 S2 的入口（PLAN3 §2 S2）：与 `draft()` 并列，共用 `SkillCandidate`、`install`
    与四条硬规矩；差异只在**输入**（题目 + 产出，不是一份材料）与**提示词**
    （问的是「这段工作里有没有下次还能照着做的工序」）。

    **永不抛异常**（同 `draft()`）：判不出来、读不到、没有 provider 都是正常结论。
    """
    try:
        got = await _run_material(run_id)
    except ValueError as e:
        return {"ok": False, "reason": str(e), "usable": False}

    out = await _land(
        label=got["label"],
        material=got["material"],
        system=RUN_CANDIDATE_SYSTEM,
        model_id=model_id,
        overwrite=overwrite,
        source=f"run#{run_id}",
    )
    # 这次读了哪几步一并报出去：界面要能说清「按哪几次运行判断的」
    return {**out, "run_id": run_id, "runs": got["runs"], "topic": got["topic"]}


async def _run_material(run_id: int) -> dict:
    """一次运行 → `(label, 材料, 用了哪几次运行, 题目)`。

    **合集按 `task_runs.thread_id` 归堆**（PLAN3 §9.2 决策2）：「这趟运行在处理哪件事」的真值
    记在 run 上，链条下游一路继承——所以「处理一项工作」的三步天然同堆，不用去猜任务之间的关系。
    只往回取到这次运行为止的最近 `RUN_STEPS` 次（**从这次往前看**：按钮挂在哪一次，就按哪一次
    之前的活判断）。

    题目优先取那件「事」的名字（起链时按你输入的题目落地，`Thread.name`），没有那件事时退回
    任务名 + 任务指令。取不到就是没有话题——那不是错误，材料里就少一行。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import ScheduledTask, TaskRun, Thread

    async with SessionLocal() as db:
        run = await db.get(TaskRun, run_id)
        if run is None:
            raise ValueError(f"没有这次运行（id={run_id}）")
        task = await db.get(ScheduledTask, run.task_id)
        rows: list[TaskRun] = [run]
        topic = ""
        if run.thread_id:
            th = await db.get(Thread, run.thread_id)
            topic = ((th.name if th else "") or "").strip()
            earlier = (
                await db.execute(
                    select(TaskRun)
                    .where(
                        TaskRun.thread_id == run.thread_id,
                        TaskRun.id < run.id,
                    )
                    .order_by(TaskRun.id.desc())
                    .limit(RUN_STEPS - 1)
                )
            ).scalars().all()
            rows = [*reversed(earlier), run]
        names = {
            t.id: t.name
            for t in (
                await db.execute(
                    select(ScheduledTask).where(ScheduledTask.id.in_({r.task_id for r in rows}))
                )
            ).scalars().all()
        }

    task_name = (task.name if task else "") or "一次运行"
    from app.core.tasks import run_topic

    topic = run_topic((task.prompt if task else "") or "", topic)
    parts = [f"题目：{topic}"] if topic else []
    used: list[int] = []
    for r in rows:
        body = (r.answer or "").strip()
        if not body:
            continue  # 失败或空的那一步不进材料：它是「没干活」，不是「干过的活」
        used.append(r.id)
        parts.append(f"## 第 {len(used)} 步 · {names.get(r.task_id) or '一次运行'}\n\n{body}")
    if not used:
        raise ValueError(f"这次运行没有可读的产出（run#{run_id}）——可能是还没跑完或跑失败了")

    material = "\n\n".join(parts)[:MATERIAL_CHARS]
    return {
        "label": f"运行 #{run_id} · {topic or task_name}",
        "material": material,
        "runs": used,
        "topic": topic,
    }


async def _land(
    *,
    label: str,
    material: str,
    system: str,
    model_id: str,
    overwrite: bool,
    source: str,
) -> dict:
    """材料（或一段工作）→ 判一次 → 落一份草稿。`draft()` 与 `draft_from_run()` 共用这一处。

    两条入口只差输入与提示词；**判据、落盘、台词、四条硬规矩都只有这一份**
    （「两处各写一遍迟早给出两个答案」）。
    """
    from app.core import providers, structured, usage_ledger
    from app.core.llm import ProviderInfo, stream_chat

    try:
        provider, model = await _resolve(model_id, providers)
    except Exception as e:  # noqa: BLE001 - 没有可用 provider 是最常见的一种"没成"
        return {"ok": False, "reason": f"{type(e).__name__}: {e}", "usable": False}

    info = ProviderInfo(kind=provider.kind, base_url=provider.base_url, api_key=provider.api_key)
    known = [s["name"] for s in skills_core.list_skills()]
    hint = f"\n\n（已知技能：{'、'.join(known[:40])}）" if known else ""
    messages = [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": f"来源：{label}\n\n---\n{material}\n---{hint}",
        },
    ]

    async with usage_ledger.span("candidate", label):
        obj, meta = await structured.extract_json(
            info, model, messages, SkillCandidate, stream_fn=stream_chat
        )
    if obj is None:
        return {"ok": False, "reason": _why("", meta), "usable": False}
    cand: SkillCandidate = obj  # type: ignore[assignment]

    base = {
        "usable": bool(cand.usable),
        "name": cand.name,
        "description": cand.description,
        "instructions": cand.instructions,
        "reason": cand.reason,
        "existing": cand.existing,
        "source": source,
        "model_id": f"{provider.name}/{model}",
        "strategy": meta.strategy,
    }
    if not cand.usable:
        return {"ok": True, **base, "written": False, "already": ""}

    # 名字/描述/正文缺一样就不落盘：`skills._install_text` 会拒，但先在这里说清楚为什么
    if not (cand.name and cand.description and cand.instructions):
        return {
            "ok": True,
            **base,
            "usable": False,
            "written": False,
            "already": "",
            "reason": cand.reason or "候选缺 name / description / instructions，不落盘",
        }

    text_md = skill_text(cand)
    try:
        out = skills_core.install(text_md, overwrite=overwrite)
    except ValueError as e:
        # 同名（最常见）：**不覆盖**，把已有的那份报出去，决定交给人
        return {
            "ok": True,
            **base,
            "written": False,
            "already": cand.name,
            "reason": f"{e}",
            "registered": False,
        }
    # 落盘了才说（M2 · PLAN §3 G2 第 2 条）：**不能复用 `pet.note_output()`**——
    # `skills/` 不在 `_OUTPUT_DIRS` 里，那个函数会（正确地）保持沉默。
    # 这句顺带把纪律念出来：草稿不算数，量过才算（§4 第四条）。
    try:
        from app.core import pet

        pet.emit("skill_draft", name=(cand.name or "")[:60], count=out.get("chars") or 0)
    except Exception:  # noqa: BLE001 - 一句台词绝不拖累落盘
        log.debug("pet skill_draft line failed", exc_info=True)
    return {
        "ok": True,
        **base,
        "written": True,
        "already": "",
        "path": f"skills/{out['name']}/SKILL.md",
        "chars": out["chars"],
        "registered": False,  # 草稿：还没跑过对照、没有基线（见模块开头第 4 条）
    }


async def report() -> dict:
    """现有技能 + 它们**有没有基线**（旧入口；界面现在读 `skill_eval.report()`）。

    留着它是为了「谁在回答这个问题」只有一处：`skill_eval.report()` 会给同一个问题更细的
    答案（sha / 用例数 / 成绩）。两个入口都指向同一条纪律：**没基线的东西不许当能力展示**。

    硬塞一个"分数"比空着更坏——那会让人以为它量过。
    """
    out = []
    for s in skills_core.list_skills():
        out.append(
            {
                "name": s["name"],
                "description": s["description"],
                "files": len(s["files"]),
                "chars": s["chars"],
                "registered": False,
                "baseline": None,
            }
        )
    return {"skills": out, "measured": False}


async def _read(source_path: str, text: str, cards_core) -> tuple[str, str, str]:
    """读材料（放线程里：可能是一次磁盘读或 PDF 解析）。"""
    import asyncio

    rel, label, material = await asyncio.to_thread(
        cards_core.collect_material,
        source_path=source_path,
        text=text,
        max_chars=MATERIAL_CHARS,
    )
    if not material.strip():
        raise ValueError("这份材料是空的，读不出东西")
    return rel, label, material


async def _resolve(model_id: str, providers):
    """拿到 (provider, model)：先认显式给的 `名/模型`，否则用默认的那个。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import ProviderConfig

    async def _by_name(pname: str):
        async with SessionLocal() as db:
            return (
                await db.execute(select(ProviderConfig).where(ProviderConfig.name == pname))
            ).scalar_one_or_none()

    if model_id and "/" in model_id:
        pname, model = model_id.split("/", 1)
        p = await _by_name(pname)
        if p is not None and p.enabled:
            return p, model

    mid = providers.default_model_id()
    if not mid or "/" not in mid:
        raise RuntimeError("没有已启用且配置了模型的 provider")
    pname, model = mid.split("/", 1)
    p = await _by_name(pname)
    if p is None or not p.enabled:
        raise RuntimeError("默认模型对应的 provider 不可用")
    return p, model
