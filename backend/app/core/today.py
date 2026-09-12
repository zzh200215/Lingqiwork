"""「今天下一步」——背景坏了要报障，没事就从你最近那件事接上。

Pure rule, no I/O, no model: the suggestion must work even when the default
model is broken, because the exact shape of the 2026-09-04 incident is "后台挂
了没人知道"。§4-17 加的「一件事」那一档同样**不碰模型**，只读一张表。

复习 / 习惯 / 连续天数三条分支封存删掉了。判断标准是「任何机制一旦产生『欠着没做』的
感觉，就是滑回上一版」，而「今天有 N 张卡到期」「还剩 N 个习惯没打勾」「连着 N 天 👌」
正是那种感觉最集中的三句话 —— 留着它们，导航里撤掉复习页就只是把债藏起来。剩下的两条
不是催办，是报障：模型挂了、作业连着失败了，你必须知道（任何功能在模型挂掉时都该有明确
提示）。

**「一件事」那一档同样不是催办**：它只说你最近动过什么、到哪了，**不说你还欠哪一步**，
也不把「未归类」的条数摆上来（那条规则是"允许长期存在、不计数"）。状态 ≠ 债。

`facts` keys（都可选，缺了就当没事）：
  default_model_broken  -> providers.default_model_id + is_unhealthy   (health.py)
  jobs_failing          -> scheduler.job_report consecutive_failures    (health.py)
  threads               -> core.threads.recent()  [{id, name, summary}]  (§4-17)
"""
from __future__ import annotations


def next_suggestion(facts: dict) -> dict:
    """-> {text, tone, action}. tone: bad | idle.

    Priority is the point — the background being broken outranks everything,
    because a suggestion that itself relies on a broken model is worse than none.
    故障之后才轮到「最近那件事」：它只是"从哪接着看"，不是待办。
    """
    f = {"default_model_broken": False, "jobs_failing": 0, "threads": []}
    if isinstance(facts, dict):
        for k in f:
            if k not in facts or facts[k] is None:
                continue
            if k == "default_model_broken":
                f[k] = bool(facts[k])
            elif k == "threads":
                f[k] = [t for t in (facts[k] or []) if isinstance(t, dict) and t.get("name")]
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
    if f["threads"]:
        t = f["threads"][0]
        return {
            "text": f"「{t['name']}」最近动过：{t['summary']}。",
            "tone": "idle",
            "action": {"kind": "thread", "thread_id": t["id"], "label": "去这件事"},
        }
    return {
        "text": "后台正常，没什么要处理的。",
        "tone": "idle",
        "action": {"kind": "none", "label": ""},
    }
