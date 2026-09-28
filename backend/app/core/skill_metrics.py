"""技能闭环的度量（PLAN3 §6）：**只画曲线，不进它嘴里**。

§6 的两条，一条问「这一圈转起来没有」，一条问「吃了技能的那几次，产出是不是更好」：

- **试用期漏斗**（`funnel`）：草稿被注入次数 → 挑进用例条数 → 升格份数。
  哪一段断了，哪一段就是下一个要修的。三个数**都不是新真值**：前一个来自运行日志
  （`skill_trials` 的窗口内派生），中间那个来自 `evals/skills/*.json`（进 git，耐久），
  后一个来自 `skill_eval.report()` 的 `registered`（sha 对得上才算）。所以这里只是
  **把同一条 report 换个角度看**，不重算一份。
- **注入命中率**（`injection`）：带注入的运行占比、以及注入了的与没注入的运行**接地分**之别。

**两句限定写在数据里，界面照抄**（`rules`）——它们是这一格能不能被读懂的边界：

1. 这是**观察性差异，不是对照**：技能是因为话题相关才被注入的（自选择），所以两边的分数差
   说明不了因果。真正的对照只有 `skill_eval` 的人造用例；
2. `grounded` 只在「开了检索 + 命中材料 + 有产出」时才有（`tasks._score_run`），所以大多数
   运行那一格是空的。**读不到就说读不到**，不补 0、不拿「没材料」当「0 分」。

还有一条窗口限定：`tasks._RUNS_KEEP = 20`——每个任务只留最近 20 条运行，更早的已经删了。
两个数都是**窗口内的**（同 S3 那行事实）。

**红线**（与 `metrics.py` 同一条）：这些数只进仪表盘曲线——不设目标、不排名、不变成零柒
嘴里的任何一句话。所以本模块里**没有一行 `pet.*`**，有测试盯着。
"""
import logging
from datetime import timedelta

from sqlalchemy import select

# naive UTC 口径唯一实现在 `timeutil.naive_utc_now`（落盘格式 + 文本字典序比较的
# 边界纪律都写在它的 docstring 里）；这里保留 `_naive_utc_now` 名字是为了既有调用（含测试）不动。
from app.core.timeutil import naive_utc_now as _naive_utc_now

log = logging.getLogger(__name__)

__all__ = ["FUNNEL_RULES", "INJECT_RULES", "WINDOW_DAYS", "funnel", "funnel_board", "injection"]

WINDOW_DAYS = 30

# 口径原文：界面上照抄这三句，别让同一个词在代码里与界面上是两个意思。
FUNNEL_RULES = {
    "used": "被用过 = 运行日志里那条 `skill_inject` 记着它的运行次数（不是次数累加，是一次运行算一次）",
    "cases": "用例条数 = `backend/evals/skills/<技能名>.json` 里的条数（进 git、可审、可回滚）",
    "registered": "升格 = 最近一次跑分是**这一版内容**跑出来的（sha 对得上），与技能页同一个判据",
    "window": "被用过的次数是**窗口内**的：每个任务只留最近 20 条运行，更早的已经删了，所以它只会变小",
}
INJECT_RULES = {
    "share": "带注入 = 那次运行的日志里有 `skill_inject`（S1 留的痕）",
    "grounded": "接地分 0-5，只在「开了检索 + 命中材料 + 有产出」时才有；空着不是 0 分",
    "bias": "这是观察性差异、不是对照：技能是因为话题相关才被注入的（自选择），差多少都说明不了因果",
    "window": "每个任务只留最近 20 条运行——「近 30 天」在这个上限内才数得全",
}


def funnel(rows: list[dict]) -> dict:
    """`skill_eval.report()` 的技能行 → 漏斗（逐份 + 合计）。Pure.

    三个数分段数的是**不同的单位**（次数 / 条数 / 份数），所以合计分开给，不做「转化率」——
    比率会把「一份技能被用了 10 次」和「10 份技能各被用 1 次」读成同一件事。
    """
    out = [
        {
            "name": r.get("name") or "",
            "used": int((r.get("trials") or {}).get("n") or 0),
            "last_ts": (r.get("trials") or {}).get("last_ts"),
            "cases": int(r.get("cases") or 0),
            "registered": bool(r.get("registered")),
            "stale": bool(r.get("stale")),
        }
        for r in rows or []
    ]
    return {
        "skills": out,
        "totals": {
            "skills": len(out),
            "used": sum(r["used"] for r in out),  # 被注入的总次数
            "with_cases": sum(1 for r in out if r["cases"] > 0),  # 有用例的技能份数
            "cases": sum(r["cases"] for r in out),  # 用例总条数
            "registered": sum(1 for r in out if r["registered"]),  # 升格份数
        },
    }


def mean_of(values: list[int | None]) -> dict:
    """可读的那几个求均值 → `{"n": k, "mean": x | None}`。Pure.

    **一个都没有时 `mean=None`**（不是 0）：那几格空着是「没材料可判」，不是「判了 0 分」。
    """
    kept = [v for v in values or [] if v is not None]
    if not kept:
        return {"n": 0, "mean": None}
    return {"n": len(kept), "mean": round(sum(kept) / len(kept), 2)}


async def _runs_with_injection(days: int) -> tuple[list[tuple[str, int | None, bool]], str]:
    """近 N 天的引擎运行 → `[(引擎名, 接地分, 那次有没有注入)]`。I/O 只在这里。

    只数**引擎运行**（`tasks.ENGINE_ACTIONS`）：注入发生在引擎那条路上，别的任务
    （转写、普通提示词步）根本没有注入这回事——把它们算进分母，这个比例就被稀释成
    「任务里有多少是引擎」了。
    """
    from app.core.tasks import ENGINE_ACTIONS
    from app.db import SessionLocal
    from app.models import ScheduledTask, TaskRun

    cutoff = (_naive_utc_now() - timedelta(days=max(1, days))).isoformat(sep=" ", timespec="seconds")
    try:
        async with SessionLocal() as db:
            rows = (
                await db.execute(
                    select(ScheduledTask.action, TaskRun.grounded, TaskRun.log_json)
                    .join(ScheduledTask, ScheduledTask.id == TaskRun.task_id)
                    .where(
                        ScheduledTask.action.in_(ENGINE_ACTIONS),
                        TaskRun.started_at.is_not(None),
                        TaskRun.started_at >= cutoff,
                    )
                )
            ).all()
    except Exception as e:  # noqa: BLE001 - 看板是观察面，不能变成故障源
        log.warning("skill injection query failed", exc_info=True)
        return [], f"{type(e).__name__}: {e}"
    return [(str(a or ""), g, "skill_inject" in (lj or "")) for a, g, lj in rows], ""


def split_injected(runs: list[tuple[str, int | None, bool]]) -> dict:
    """运行 → 两半（带注入 / 没带）× 接地分。Pure。"""
    injected = [(g) for _a, g, hit in runs if hit]
    plain = [(g) for _a, g, hit in runs if not hit]
    return {
        "runs": {"total": len(runs), "injected": len(injected), "plain": len(plain)},
        "grounded": {"injected": mean_of(injected), "plain": mean_of(plain)},
    }


def by_engine(runs: list[tuple[str, int | None, bool]]) -> list[dict]:
    """按引擎分开看（「同引擎的基线」那句话要求的就是这个）。Pure。"""
    from app.core.tasks import ENGINE_LABELS

    seen: dict[str, list[tuple[str, int | None, bool]]] = {}
    for r in runs:
        seen.setdefault(r[0], []).append(r)
    out: list[dict] = []
    for engine, group in sorted(seen.items()):
        part = split_injected(group)
        out.append(
            {
                "engine": engine,
                "label": ENGINE_LABELS.get(engine, engine),
                "total": part["runs"]["total"],
                "injected": part["runs"]["injected"],
                "grounded_injected": part["grounded"]["injected"],
                "grounded_plain": part["grounded"]["plain"],
            }
        )
    return out


async def injection(days: int = WINDOW_DAYS) -> dict:
    """注入命中率（带注入的运行占比 + 两边接地分）。**永不抛**：读不到就 `readable=false`。"""
    runs, error = await _runs_with_injection(days)
    if error:
        return {
            "readable": False,
            "error": error,
            "days": days,
            "runs": {"total": 0, "injected": 0, "plain": 0},
            "grounded": {"injected": {"n": 0, "mean": None}, "plain": {"n": 0, "mean": None}},
            "by_engine": [],
            "rules": INJECT_RULES,
        }
    part = split_injected(runs)
    return {
        "readable": True,
        "error": "",
        "days": days,
        **part,
        "by_engine": by_engine(runs),
        "rules": INJECT_RULES,
    }


async def funnel_board() -> dict:
    """试用期漏斗（读 `skill_eval.report()`，与技能页同一个出处）。**永不抛**。"""
    from app.core import skill_eval, skill_trials

    try:
        rep = await skill_eval.report()
    except Exception as e:  # noqa: BLE001 - 看板是观察面
        log.warning("skill funnel board failed", exc_info=True)
        return {
            "readable": False,
            "error": f"{type(e).__name__}: {e}",
            "window": skill_trials.WINDOW,
            "skills": [],
            "totals": {"skills": 0, "used": 0, "with_cases": 0, "cases": 0, "registered": 0},
            "rules": FUNNEL_RULES,
        }
    board = funnel(rep.get("skills") or [])
    return {
        "readable": True,
        "error": "",
        "window": skill_trials.WINDOW,
        **board,
        "rules": FUNNEL_RULES,
    }
