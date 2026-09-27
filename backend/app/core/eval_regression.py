"""夜间评测回归（eval_regression，2026-09-26 · 评测自动挡）。

promptfoo / Braintrust / Langfuse 收敛到同一个骨架：**定时**用金标集跑一遍 →
**和上一版比分数** → 回退了**报警**。这个模块就是那根 cron——「跑」与「比」
`core/evals.py` 里都有（`run_eval` / `compare_history`），这里只补「定时 + 报警」。

**默认关**：每天烧一次真金白银的模型调用（每个用例至少一次调用）。
开关在设置里（`eval_regression_enabled`）——打开那一刻，钱花在哪写在明面上。
报警只对**回归**响：分数回落才叫人，变好不吵（「看板不是考核」同一口径）。
"""

import asyncio
import logging

log = logging.getLogger(__name__)

JOB_ID = "eval-regression"


async def run_nightly() -> dict:
    """跑一遍金标集并与上一夜对比；**回归了要响**——不响等于没跑。"""
    from app.core import evals

    out = await evals.run_eval()
    cmp = await evals.compare_history()
    regressions = list((cmp.get("comparison") or {}).get("regressions") or [])
    if regressions:
        body = (
            f"评测回归：{'、'.join(regressions)} 分数回落了"
            f"（第 {out.get('id')} 夜）。改过提示词或模型的话，先看评测区的对比。"
        )
        log.warning("eval regression: %s", ", ".join(regressions))
        # 桌面要响一声；邮件 best-effort（没配 SMTP 就跳过）——与 tasks 的同一套。
        from app.core import mailer, notify

        try:
            await asyncio.to_thread(notify.desktop, "评测回归", body)
        except Exception:  # noqa: BLE001
            log.debug("eval regression desktop notify failed", exc_info=True)
        try:
            await asyncio.to_thread(mailer.send, "评测回归", body)
        except Exception:  # noqa: BLE001
            log.debug("eval regression mail skipped/failed", exc_info=True)
    return {"run": out.get("id"), "regressions": regressions, "comparison": cmp.get("comparison")}


def reschedule() -> None:
    """按配置挂/摘夜间回归这一个 job（settings 一存就会来重挂）。"""
    from app.core import scheduler as sched
    from app.core.prefs import load_config
    from app.core.tasks import validate_cron

    cfg = load_config()
    if not cfg.get("eval_regression_enabled"):
        sched.prune_jobs(JOB_ID, set())
        return
    expr = str(cfg.get("eval_regression_cron") or "0 5 * * *")
    try:
        sched.set_cron(JOB_ID, run_nightly, validate_cron(expr))
        log.info("eval regression scheduled: %s", expr)
    except ValueError:
        log.warning("eval regression cron %r invalid, job not scheduled", expr)
