"""话题 × 技能 的确定性匹配（PLAN3 S1 · 让引擎吃 skill）。

## 这一层的判据（先写死，免得事后改口径）

引擎是固定流水线、不是多轮 agent，所以不走 chat 的「索引注入 + 模型自己调 `skill_load`」，
而是跑之前**确定性匹配**：话题命中某份技能，就把那份工序按 `skill_eval` 的「有它」侧
**同一个形态**注进 system（`按这套工序做：\n\n{正文}`）。

  · **硬要求：一份错的工序都不许注入。** 注错了会悄悄改掉模型的 system，这是这一层唯一的害处。
  · **允许漏。** 漏 = 现状不变（引擎照旧跑，只是没吃到这份技能），「本该注入却没注入」
    不留任何代价。所以阈值往保守那边定，而不是往「尽量多接住」那边定。
  · **严口径（该中的一条不漏 且 不该中的一条不过）做不到**，别拿它当验收标准。

## 阈值是量出来的，不是拍的（`backend/smoke_skill_match.py`，可复跑）

2026-09-17 那一跑：16 该命中 + 18 必不中（其中 8 条是同领域隔壁工序），技能池 10 份 → 15 份。

  · **本模块这一档**：技能文本 = 名字 + description，2-gram 包含率 ≥ `SKILL_FLOOR`
    → 命中 **12/16**，**两个池子上误报都是 0**，天花板 **0.273** 不随池子动。
    （只用名字 3/16，只用 description 10/16，合起来 12/16——所以两者一起给。）
  · **被否的那一档**（embedding 余弦，bge-small-zh-v1.5，技能文本 = 名字 + description，
    话题侧加检索前缀）：最好时命中 11/16、误报 0，但天花板 **0.592**，离出厂阈值 0.62
    只剩 0.028；不加前缀的两个变体在同一个阈值上直接误报 3–4 条。余弦两条分布重叠约 0.2，
    与 PLAN2 P2-2 同一个结论——**短中文短语被挤在一个很窄的锥里**。
  · 近重复技能（「同一件事的两种写法」）拉高的是**多命中**而不是天花板，第一名一次都没被
    抢走；所以 `MAX_INJECT = 2` 正好容得下。S2 的「同名不覆盖」管不住这种，记在 PLAN3 §9.3。
  · **池子再大就重跑那一页。** 换模型、换语言、池子上百份，这里的数都不作数。

## 纯函数在哪

`bigrams` / `cover` / `skill_text` / `hits` / `with_skills` / `event_data` / `log_entry`
不碰盘、不碰库、不调模型。唯一的 I/O 在 `injection()`（读 `skills/` 的清单与正文），
而且**永不抛异常**：匹配挂了不能把一次引擎运行变成失败（与 `_score_run`、
`candidates.draft` 同一条纪律）。
"""
import logging

log = logging.getLogger(__name__)

# 出厂阈值：实测天花板 0.273，取 0.30（留一点余量，且是个好记的数）。
SKILL_FLOOR = 0.30
# 实测的负样本最高分（10 份与 15 份池子都一样）。阈值必须比它高。
FLOOR_CEILING = 0.273
# 一次最多注入几份。2 是量出来的：近重复会让两条一起过线，而第一名不会被抢走。
MAX_INJECT = 2
# 量出这些数的那一页（可复跑；改阈值先跑它）。
RULER = "backend/smoke_skill_match.py"
# 多份工序之间的接缝。一份时整段与 `skill_eval` 的「有它」侧逐字一致。
_JOIN = "\n\n---\n\n"


def bigrams(text: str) -> set[str]:
    """中文没有空格：2-gram 是最省事、也最不挑分词器的确定性表示。Pure."""
    s = "".join(ch for ch in (text or "").lower() if ch.isalnum())
    if len(s) > 1:
        return {s[i : i + 2] for i in range(len(s) - 1)}
    return {s} if s else set()


def cover(topic: str, text: str) -> float:
    """话题的 2-gram 有多少出现在技能文本里（0–1）。Pure."""
    t, d = bigrams(topic), bigrams(text)
    if not t or not d:
        return 0.0
    return len(t & d) / len(t)


def skill_text(s: dict) -> str:
    """技能侧拿去匹配的文本 = 名字 + 一行「何时使用」。Pure.

    名字是那份工序的标题（`candidates.draft` 落盘时必有），description 是它的适用场合。
    两者一起给是量出来的（见模块开头：3/16 + 10/16 → 12/16）。
    """
    return f"{s.get('name') or ''} {s.get('description') or ''}".strip()


def hits(
    topic: str,
    skills: list[dict],
    *,
    floor: float = SKILL_FLOOR,
    limit: int = MAX_INJECT,
) -> list[dict]:
    """命中集：过线的按分数降序，同分按名字排（**同输入同输出**）。Pure.

    `skills` 是 `skills.list_skills()` 的形状（`name` / `description`）。
    """
    scored: list[tuple[float, str]] = []
    for s in skills or []:
        name = (s.get("name") or "").strip()
        if not name:
            continue
        score = cover(topic, skill_text(s))
        if score >= floor:
            scored.append((score, name))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [{"name": n, "score": round(v, 4)} for v, n in scored[: max(0, limit)]]


def with_skills(system_prompt: str, inj: dict) -> str:
    """把命中的工序接在引擎自己的 system 后面。Pure.

    接在后面是 PLAN3 §9.3 定下的：技能**可以**覆盖体裁里同名的要求，但不动体裁的结构
    ——小节名就是体裁的定义（`deliver.GENRES` 的注释原话）。
    """
    block = (inj or {}).get("block") or ""
    if not block:
        return system_prompt
    return f"{system_prompt}\n\n{block}"


def event_data(inj: dict) -> dict:
    """给 SSE 用的载荷。Pure.

    手动跑引擎没有运行记录（`TaskRun` 只在 `tasks._new_run` 落地），不给它这条事件，
    那条**用得最多**的路就永远看不见自己吃到了什么。
    """
    return {"skills": list((inj or {}).get("names") or []), "picked": list((inj or {}).get("picked") or [])}


def log_entry(inj: dict) -> dict:
    """写进 `task_runs.log_json` 的那一项（现有 `{tool, args, ok, result}` 形状）。Pure.

    这是 S3 试用期唯一的真值来源：草稿被真实工作用过几次，靠聚合它。
    `injection()` 的返回与 SSE 事件的载荷都吃得下（`names` / `skills` 两种键）。
    """
    src = inj or {}
    names = list(src.get("names") or src.get("skills") or [])
    return {
        "tool": "skill_inject",
        "args": {"skills": names},
        "ok": True,
        "result": f"本次注入：{'、'.join(names)}",
    }


def injection(topic: str) -> dict:
    """这次运行该注入哪些工序 —— I/O 只在这里，**永不抛异常**。

    返回 `{"names": [...], "picked": [{name, score}], "block": "..."}`；
    没命中（或读不到、或没有技能）就是三个空值——**空集是一条正常结论**，
    不是错误（与 `candidates.draft` 的 `usable=false` 同一条纪律）。

    没有话题的运行（`recap.run(*, days=…)`）自然拿到空集：这一层不猜。
    """
    empty = {"names": [], "picked": [], "block": ""}
    topic = (topic or "").strip()
    if not topic:
        return empty
    try:
        from app.core import skills as skills_core

        picked = hits(topic, skills_core.list_skills())
        if not picked:
            return empty
        parts: list[str] = []
        kept: list[dict] = []
        for h in picked:
            body = skills_core.load_skill(h["name"])
            # 清单与正文之间被删掉了：跳过——绝不能把「[未找到] 技能…」这句注进 system
            if body.startswith("[未找到]"):
                continue
            kept.append(h)
            parts.append(f"按这套工序做：\n\n{body}")
        if not parts:
            return empty
        return {"names": [h["name"] for h in kept], "picked": kept, "block": _JOIN.join(parts)}
    except Exception:  # noqa: BLE001 - 匹配挂了不能把一次引擎运行变成失败
        log.warning("skill match failed for topic %r", topic[:60], exc_info=True)
        return empty
