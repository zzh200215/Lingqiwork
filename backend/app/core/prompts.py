"""Prompt 注册中心 —— 让散落在各模块的提示词第一次可枚举、可审阅、可防漂移。

设计边界（护栏在这里同样成立）：

- **内容不搬、位置不动。** 每个提示词都紧贴它的调用逻辑，并带着「为什么这么写」
  的校准上下文（例如 tutor._EXTRACT_PROMPT 要求 concept 必须带领域词，是因为丢掉
  领域词的那次召回差 0.018 没响）。把它们抽到数据文件会丢失这些理由，所以本模块
  只**引用**各模块的常量，单一事实来源仍是原模块本身。
- **不做可编辑 / A/B。** 改提示词必须过验收 drill（smoke_tutor_accept.py 之类），
  不能做成「改配置不用改代码」的黑箱。这里的输出只用于**审阅**和**完整性校验**。
- **延迟 import。** cards / providers 等模块的模块级 import 被刻意保持轻量（启动
  失败会拖垮全局），所以 inventory() 用函数内 importlib 加载，`import prompts` 本身
  零副作用。

产出的两个用途：
1. `inventory()` / `dump_markdown()` → 审阅全清单（人看）。
2. `summary()` → 体检报告的 prompt 字段（数量 + 登记漂移，机器看）。
"""
from __future__ import annotations

import hashlib
import importlib
from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(frozen=True)
class Prompt:
    """一条提示词的登记项。content 为 None 表示该模块无法加载（登记漂移）。"""

    name: str
    module: str
    purpose: str
    kind: str
    content: str | None
    sha: str = ""


# (模块, 属性, 用途, 种类)
# kind: system=系统提示词 / prompt=主指令·声部 / instruction=改写·操作指令 / persona=人设
_SPECS: list[tuple[str, str, str, str]] = [
    # ---- 教学引擎（核心资产）----
    ("app.core.tutor", "SOCRATIC_PROMPT", "苏格拉底式教学：先探理解、再讲、必出问题", "prompt"),
    (
        "app.core.tutor",
        "FEYNMAN_PROMPT",
        "费曼反转教学：用户讲，模型当「聪明但没搞懂的学生 + 考官」"
        "（陪伴页「教它」里这个学生就是零柒；身份在界面与状态机里，提示词内容没动）",
        "prompt",
    ),
    ("app.core.tutor", "FUTURE_PROMPT", "「未来的你」：以一年后的自己口吻与用户对话，讲经历不给建议", "prompt"),
    ("app.core.tutor", "_EXTRACT_PROMPT", "教学会话收尾时提取 概念/领域/自评/卡点（concept 必须带领域词，domain 就是那个限定词）", "system"),
    ("app.core.tutor", "_SUMMARY_SYSTEM", "教学会话中段压缩摘要（≤300 字，保概念/讲通点/卡点）", "system"),
    # ---- 研究（学习闭环：学 → 研究 → 产出）----
    ("app.core.research", "_PLAN_PROMPT", "研究规划：把话题拆成 2-4 个互补的检索式", "system"),
    ("app.core.research", "_SYNTH_PROMPT", "研究成文：只依据材料、每个论断带 [编号] 引用", "system"),
    # ---- 产出（学习闭环的出口：把学到的写成一篇东西）----
    ("app.core.compose", "_SYNTH_PROMPT", "产出成文：只依据你自己的材料（知识库/记忆/日记）", "system"),
    # ---- 复盘（把散落的记录合成一次「最近」）----
    ("app.core.recap", "_SYNTH_PROMPT", "复盘成文：三段（关注什么/学到哪/卡在哪），不写建议", "system"),
    # ---- 分析 / 方案（拿不准的事，理清楚再出方案）----
    ("app.core.decide", "_FRAME_PROMPT", "方案读题：话题 → 一次决策（决策/选项/判据/检索式），选项必须补全", "system"),
    ("app.core.decide", "_SYNTH_PROMPT", "方案成文：四节（决定什么/几个选项/我的判断/什么会推翻它）", "system"),
    # ---- 记忆系统 ----
    ("app.core.memory", "_AUTO_SYSTEM", "长期记忆自动抽取（preference/fact/habit 三分类，最多 2 条）", "system"),
    ("app.core.memory_tidy", "_TIDY_SYSTEM", "睡眠期记忆合并：相似记忆合一条或保留（不得编造）", "system"),
    ("app.core.memory_tidy", "_REFLECT_SYSTEM", "睡眠期反思：从记忆流水提炼更高一层的洞察（kind=insight）", "system"),
    # ---- 知识库 / 图谱 / 评测 ----
    ("app.core.kg", "_EXTRACTION_SYSTEM", "从文档抽取知识图谱三元组（实体 + 类型化关系）", "system"),
    ("app.core.evals", "_JUDGE_SYSTEM", "RAG 忠实度判分：回答是否被检索片段支撑（0-5）", "system"),
    # ---- 定时任务 / 自动化 ----
    ("app.core.tasks", "_PARSE_SYSTEM", "自然语言定时需求 → cron + 任务草稿", "system"),
    ("app.core.providers", "PROBE_PROMPT", "provider 健康探测（最小成本，一个字）", "prompt"),
    # ---- 卡片 / 协作 ----
    ("app.core.cards", "_GEN_SYSTEM", "生成复习卡（从学习材料出题）", "system"),
    ("app.core.cards", "_REMEDY_SYSTEM", "薄弱来源补救：反复答错的材料重出卡", "system"),
    ("app.core.collab", "_DEFAULT_SYSTEM", "协作团队默认成员角色", "system"),
    ("app.core.collab", "_REVIEW_SYSTEM", "协作评审：审阅文稿，指事实/逻辑/结构/遗漏", "system"),
    ("app.core.collab", "_REVISION_INSTRUCTION", "协作修订：按评审意见改稿", "instruction"),
    # ---- 媒体生成 ----
    ("app.core.podcast", "_SCRIPT_SYSTEM", "播客编剧：笔记材料 → 双人对话脚本 JSON", "system"),
    # ---- 常驻助手「零柒」----
    ("app.core.pet", "CHAT_SYSTEM", "零柒人设：本地工作台常驻小助手，极简克制偶冷幽默", "persona"),
    (
        "app.routers.pet",
        "_PET_TOOL_RULE",
        "零柒的工具规矩（P3）：该调就调、别替用户决定、别复述工具输出、报错照实说",
        "instruction",
    ),
    # ---- 仪表盘 / 笔记 ----
    ("app.routers.dashboard", "_BRIEFING_SYSTEM", "今日一句话简报（零柒口吻，TTL 缓存 + 模板兜底）", "persona"),
    ("app.routers.notes", "_WRITER_PERSONA", "笔记 AI 写作助手人设", "persona"),
    ("app.routers.notes", "_DEFAULT_REWRITE_INSTRUCTION", "笔记润色默认指令：修错别字语病、保原意篇幅", "instruction"),
    ("app.routers.notes", "_BRIEFING_SYSTEM", "笔记简报（零柒口吻，写作视角一句话）", "persona"),
    # ---- 结构化输出层 ----
    ("app.core.llm", "_JSON_HINT", "L1 原生 JSON 模式的追加提示（openai 兼容要求 prompt 含 JSON 字样）", "system"),
    # ---- 主聊天 ----
    (
        "app.routers.chat",
        "_OUTPUT_RULE",
        "成篇的成品要调 save_artifact 存进产出区，别糊在回复里（提到 system 层后遵从率 0/10 → 6/10）",
        "system",
    ),
]

# 内联 prompt：没有稳定符号名，无法 getattr 引用，故只登记「位置 + 用途」，
# 内容仍活在源码里（复制过来会造成两处维护）。它们是需要时再提取成常量的候补清单。
_INLINE: list[tuple[str, int, str]] = [
    ("app.core.roundtable", 31, "圆桌三个人设（mentor 苏格拉底老师 / peer 费曼同侪 / skeptic 唱反调考官）"),
    ("app.core.compaction", 73, "对话摘要助手（只输出摘要本身）"),
    ("app.routers.ask", 23, "划词翻译（只输出译文）"),
    ("app.routers.ask", 101, "划词助手人设（回答直接简洁）"),
    ("app.routers.chat", 85, "聊天 RAG 上下文注入（检索片段挂系统块）"),
    ("app.routers.chat", 539, "追问生成（3 个 ≤20 字问题）"),
    ("app.routers.notes", 139, "笔记续写 / 润色 / 摘要 / 改写 四种模式指令"),
    ("app.core.structured", 39, "结构化输出自纠正提示（把校验错误喂回重出）"),
]


def _load(spec: tuple[str, str, str, str]) -> Prompt:
    module, attr, purpose, kind = spec
    try:
        mod = importlib.import_module(module)
        content = getattr(mod, attr)
    except Exception:  # noqa: BLE001 - 单个模块加载失败不该中断整个清单
        return Prompt(name=attr, module=module, purpose=purpose, kind=kind, content=None)
    if not isinstance(content, str):
        content = str(content)
    sha = hashlib.sha256(content.encode("utf-8")).hexdigest()[:12]
    return Prompt(name=attr, module=module, purpose=purpose, kind=kind, content=content, sha=sha)


def inventory() -> list[Prompt]:
    """全部登记提示词（延迟 import，best-effort）。"""
    return [_load(s) for s in _SPECS]


def inline_notes() -> list[tuple[str, int, str]]:
    """内联 prompt 的「位置 + 用途」清单（不含内容）。"""
    return list(_INLINE)


def summary() -> dict:
    """给体检报告：数量、模块分布、登记漂移。"""
    items = inventory()
    missing = [p.name for p in items if p.content is None]
    by_module: dict[str, int] = {}
    for p in items:
        by_module[p.module] = by_module.get(p.module, 0) + 1
    return {
        "count": len(items),
        "inline": len(_INLINE),
        "missing": missing,
        "by_module": by_module,
    }


def dump_markdown() -> str:
    """导出全清单的 Markdown 审阅文档。"""
    items = inventory()
    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M %Z")
    mods: dict[str, list[Prompt]] = {}
    for p in items:
        mods.setdefault(p.module, []).append(p)

    out: list[str] = [
        "# WorkBuddy 提示词全清单",
        "",
        f"> 生成时间：{now} ｜ 共 {len(items)} 条命名提示词 + {len(_INLINE)} 处内联提示词",
        "> 说明：本清单由 `app/core/prompts.py` 生成，内容引用自各模块，单一来源仍是源码。",
        "",
    ]
    for module in sorted(mods):
        out.append(f"## `{module}`")
        out.append("")
        for p in mods[module]:
            out.append(f"### `{p.name}`  ·  {p.kind}  ·  `{p.sha}`")
            out.append("")
            out.append(f"**用途**：{p.purpose}")
            out.append("")
            if p.content is None:
                out.append("> ⚠️ 无法加载该模块（登记漂移），内容缺失。")
            else:
                out.append("```text")
                out.append(p.content.rstrip())
                out.append("```")
            out.append("")
    out.append("## 内联提示词（无符号名，仅登记位置）")
    out.append("")
    out.append("| 位置 | 用途 |")
    out.append("|---|---|")
    for module, line, purpose in _INLINE:
        out.append(f"| `{module}:{line}` | {purpose} |")
    out.append("")
    return "\n".join(out)
