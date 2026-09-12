"""「今天下一步」——现在只剩一件事：后台是不是坏了。

Pure rule, no I/O, no model: the suggestion must work even when the default
model is broken, because the exact shape of the 2026-09-04 incident is "后台挂
了没人知道"。

复习 / 习惯 / 连续天数三条分支按第 3 节封存删掉了。第 2 节的判断标准是「任何机制一旦
产生『欠着没做』的感觉，就是滑回上一版」，而「今天有 N 张卡到期」「还剩 N 个习惯没
打勾」「连着 N 天 👌」正是那种感觉最集中的三句话 —— 留着它们，导航里撤掉复习页就只是
把债藏起来。剩下的两条不是催办，是报障：模型挂了、作业连着失败了，你必须知道（第 9 节
要求任何功能在模型挂掉时有明确提示）。

`facts` keys（都可选，缺了就当没事）：
  default_model_broken  -> providers.default_model_id + is_unhealthy   (health.py)
  jobs_failing          -> scheduler.job_report consecutive_failures    (health.py)
"""
from __future__ import annotations


def next_suggestion(facts: dict) -> dict:
    """-> {text, tone, action}. tone: bad | idle.

    Priority is the point — the background being broken outranks everything,
    because a suggestion that itself relies on a broken model is worse than none.
    没有故障就没有下一步：这里不再有 normal 那一档，因为唯一会落在那一档的内容
    就是待办。旧的 review / make_card 动作也就永远不再发出。
    """
    f = {"default_model_broken": False, "jobs_failing": 0}
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
            "text": "后台打不通：默认模型挂了，自动化都在等它。先去设置换一个。",
            "tone": "bad",
            "action": {"kind": "settings", "label": "去设置"},
        }
    if f["jobs_failing"] > 0:
        return {
            "text": f"后台有 {f['jobs_failing']} 个作业连续失败，回头看看。",
            "tone": "bad",
            "action": {"kind": "settings", "label": "去设置"},
        }
    return {
        "text": "后台正常，没什么要处理的。",
        "tone": "idle",
        "action": {"kind": "none", "label": ""},
    }
