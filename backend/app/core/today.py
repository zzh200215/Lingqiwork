"""今日页「今天下一步」——把现成零件聚成一条建议（PLAN 第0周）。

Pure rule, no I/O, no model: the suggestion must work even when the default
model is broken, because the exact shape of the 2026-09-04 incident is "后台挂
了没人知道". The backend just assembles facts from functions that already exist
(cards.queue / cards.stats / habits.today_view / providers), the priority lives
here as a pure function so it is plain-integer unit-testable.

`facts` keys and where they come from (all optional, default to zeros):
  default_model_broken  -> providers.default_model_id + is_unhealthy   (health.py)
  jobs_failing          -> scheduler.job_report consecutive_failures    (health.py)
  queue_total           -> len(queue()["due"]) + len(queue()["fresh"])  (cards.py)
  total_cards           -> stats()["total"]                             (cards.py)
  streak                -> stats()["streak"]                            (cards.py)
  habits_pending        -> habits.today_view()["pending"]               (habits.py)
"""
from __future__ import annotations


def next_suggestion(facts: dict) -> dict:
    """-> {text, tone, action}. tone: bad | normal | idle.

    Priority is the point — the background being broken outranks everything,
    because a suggestion that itself relies on a broken model is worse than none.
    """
    f = {
        "default_model_broken": False,
        "jobs_failing": 0,
        "queue_total": 0,
        "total_cards": 0,
        "streak": 0,
        "habits_pending": 0,
    }
    if isinstance(facts, dict):
        for k in f:
            if k in facts and facts[k] is not None:
                if k == "default_model_broken":
                    f[k] = bool(facts[k])
                else:
                    try:
                        f[k] = int(str(facts[k]).strip() or 0)
                    except (TypeError, ValueError):
                        f[k] = 0

    if f["default_model_broken"]:
        return {
            "text": "后台打不通：默认模型挂了，自动化都在等它。修复前复习照常，先去看一眼。",
            "tone": "bad",
            "action": {"kind": "settings", "label": "去设置"},
        }
    if f["jobs_failing"] > 0:
        return {
            "text": f"后台有 {f['jobs_failing']} 个作业连续失败，回头看看。复习不受影响。",
            "tone": "bad",
            "action": {"kind": "settings", "label": "去设置"},
        }
    if f["queue_total"] > 0:
        return {
            "text": f"今天有 {f['queue_total']} 张卡到期，十分钟的事。",
            "tone": "normal",
            "action": {"kind": "review", "label": "开始复习"},
        }
    if f["habits_pending"] > 0:
        return {
            "text": f"复习清完了，还有 {f['habits_pending']} 个习惯没打勾。",
            "tone": "idle",
            "action": {"kind": "none", "label": ""},
        }
    if f["total_cards"] == 0:
        return {
            "text": "还没有卡片。最快的开法：打开一篇笔记，选中一句话按「🎴 挖空」。",
            "tone": "idle",
            "action": {"kind": "make_card", "label": "建第一张卡"},
        }
    if f["streak"] > 0:
        return {
            "text": f"今天都收尾了，连着 {f['streak']} 天 👌",
            "tone": "idle",
            "action": {"kind": "none", "label": ""},
        }
    return {
        "text": "今天都收尾了，休息一下。",
        "tone": "idle",
        "action": {"kind": "none", "label": ""},
    }