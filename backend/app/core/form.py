"""形态（Q3）—— 一个领域长没长出枝，只由**可验证的能力**算。

**它不是什么。** 不是「你往 vault 里灌了 100 篇法律文书，它就长成法务形态」。这个仓库
不微调（`docs/upgrade-plan.md` §3），上传文档**不会**让模型变成法务，它改变的只是检索
覆盖。如果形态由上传量驱动，它的最优解就是把文件往里堆——堆出来的形态是纯装饰，而且
同时违反两条已经定下的家规：「算出来的，不是编的」（`pet.py`）与「诊断不是考核，不设
目标、不催、不做排行榜」（`quality.py`）。外面的老话也是这句：当指标变成目标，它就不再
是好指标（Goodhart）。

**它是什么。** 一个领域长出枝 = 这个领域里三样**可验证**的东西各站得住：

  ① 检索：这个领域标了源的样例题，最近一次评测里命中了几条（命中率 + Wilson 区间）
  ② 概念：这个领域里**已掌握**的概念数（掌握规则沿用 `tutor.is_mastered` 那一条）
  ③ 技能：这个领域里跑过对照的技能卡，金标集过了几条（通过率 + Wilson 区间）

三样都够才长枝——只有一个数好看的时候，那条枝值不了钱。**界面上还必须写明它没学会它**：
「检索得住」和「懂了」是两件事，把前者讲成后者是这个功能最容易撒的那个谎。

**那句话由谁来说。** 这里只给事实：几条命中、区间多宽、几个概念、几张卡。
「它没有学会 X」那句人话写在界面里（`RoomPane.tsx`），和小屋那句「它不饿」同一个地方
——免得同一句承诺在两地各写一半、日后各改一半。

**样本不够就说不够。** 三个数各有下限（`MIN_*`），够不着的那一样标「样本不足」而不是
硬算一个率：两条样本算出来的命中率是噪音，会让人对这把尺子失去信任。这条与
`decision_log.rate()`、对照台的 Wilson 区间是同一条规矩，不是这里新立的。

**领域从哪来。** 手写的一个短词，写在证据自己身上（`EvalItem.domain` /
`TutorSession.domain` / golden set 的 `domain`）。不从 vault 目录推——目录是笔记的组织
方式，不是领域的声明；实测那个库的顶层目录是 `notes/` `sub/` `clippings/`，推出来的
「领域」是文件系统，不是他关心的东西。也不从文本里猜（切词、子串匹配都算猜），
这条规矩仓库里写过：生产逻辑里不猜文本。
"""
from __future__ import annotations

import json
import logging

from app.core.prompt_eval import wilson

log = logging.getLogger(__name__)

# 三个数各自的「够」。三条都是 MIN 而不是目标：它们的唯一作用是**拦住说不出口的率**，
# 界面上不出现「还差 N」——那正是这个项目一直在躲的形状。
MIN_CASES = 3  # ① 这个领域标了源的样例题；③ 这个领域的金标集
MIN_CONCEPTS = 1  # ② 这个领域搞懂的概念（掌握那条规矩本身已经要求不止一场）

RUNS_SCANNED = 50  # 往回找多少次评测，去凑「最近一次包含这个领域题目的那次」

NOT_ENOUGH = "样本不足"


def _domain_of(value) -> str:
    """标签归一：去空白、截 30 字。空 = 还没归类。Pure."""
    return str(value or "").strip()[:30]


def _labelled_cases(domains) -> dict[str, set[int]]:
    """领域 → 这个领域里**标了源**的样例题 id。Pure.

    只收标了源的：没标源的题只测忠实度、不测命中，「检索得住」那句话它撑不起来。
    """
    out: dict[str, set[int]] = {}
    for row in domains:
        d, src = _domain_of(getattr(row, "domain", "")), str(
            getattr(row, "expected_source", "") or ""
        ).strip()
        if d and src:
            out.setdefault(d, set()).add(int(getattr(row, "id", 0)))
    return out


def _rows_in_run(detail_json: str, wanted: set[int]) -> list[dict]:
    """一次评测的结果里，属于这些样例题的那些行。Pure.

    `detail_json` 写坏了当空——形态是派生视图，一份坏 JSON 不该让整根枝消失。
    """
    try:
        detail = json.loads(detail_json or "[]")
    except Exception:  # noqa: BLE001
        return []
    if not isinstance(detail, list):
        return []
    return [
        d
        for d in detail
        if isinstance(d, dict) and d.get("id") is not None and int(d["id"]) in wanted
    ]


def _pick_run(runs, wanted: set[int]):
    """最近一次**包含这个领域至少 MIN_CASES 条题**的评测；没有就返回覆盖最多的那次。

    为什么不是「最近那次评测」：评测集是会长大的。最近一次可能还没包含这个领域的题，
    拿它算命中率会得到 n=0 或 n=1，然后被误读成「这个领域检索不行」。往回找覆盖够的
    那一次，才是这个领域真实的最近一次成绩。
    """
    best = None
    for r in runs:  # 调用方保证 id 倒序
        rows = _rows_in_run(r.detail_json, wanted)
        if not rows:
            continue
        if len(rows) >= MIN_CASES:
            return r, rows
        if best is None or len(rows) > len(best[1]):
            best = (r, rows)
    return best


def _retrieval(picked, labelled: int) -> dict:
    """① 检索：命中率 + Wilson 区间（+ 忠实度，若那次判过分）。Pure."""
    if picked is None:
        return {
            "enough": False,
            "cases": 0,
            "labelled": labelled,
            "hits": 0,
            "hit_rate": None,
            "ci_low": None,
            "ci_high": None,
            "faithfulness": None,
            "judged": 0,
            "run_id": None,
            "at": None,
            "note": (
                "这个领域还没有标了源的样例题"
                if not labelled
                else f"这个领域标了源的样例题有 {labelled} 条，但还没有一次评测跑到过"
            ),
        }
    run, rows = picked
    hits = sum(1 for d in rows if d.get("rank"))
    scores = [float(d["score"]) for d in rows if isinstance(d.get("score"), (int, float))]
    lo, hi = wilson(hits, len(rows))
    return {
        "enough": len(rows) >= MIN_CASES,
        "cases": len(rows),
        "labelled": labelled,
        "hits": hits,
        "hit_rate": round(hits / len(rows), 3),
        "ci_low": round(lo, 3),
        "ci_high": round(hi, 3),
        "faithfulness": round(sum(scores) / len(scores), 2) if scores else None,
        "judged": len(scores),
        "run_id": run.id,
        "at": _iso(run.created_at),
        "note": ""
        if len(rows) >= MIN_CASES
        else f"最近一次评测里只有 {len(rows)} 条这个领域的题，命中率说不出口",
    }


def _concepts(bucket) -> dict:
    """② 概念：这个领域已掌握几条（+ 碰过几条、叫什么）。Pure."""
    seen = (bucket or {}).get("seen") or []
    mastered = (bucket or {}).get("mastered") or []
    return {
        "enough": len(mastered) >= MIN_CONCEPTS,
        "mastered": len(mastered),
        "seen": len(seen),
        "names": [c["concept"] for c in mastered[:8]],
        "at": mastered[0]["last_at"] if mastered else "",
    }


def _skills(cards: list[dict]) -> list[dict]:
    """③ 技能：这个领域里跑过对照的卡。每张自己带区间与「样本够不够」。Pure."""
    out = []
    for c in cards:
        n = int(c.get("cases") or 0)
        k = int(c.get("passed") or 0)
        out.append(
            {
                "name": c.get("name", ""),
                "purpose": c.get("purpose", ""),
                "passed": k,
                "cases": n,
                "rate": c.get("rate"),
                "ci_low": c.get("ci_low"),
                "ci_high": c.get("ci_high"),
                "at": c.get("at"),
                "stale": bool(c.get("stale")),
                "enough": n >= MIN_CASES,
            }
        )
    out.sort(key=lambda s: (s["cases"], s["passed"]), reverse=True)
    return out


def _iso(dt) -> str | None:
    from app.models import iso_utc

    return iso_utc(dt)


async def branches() -> dict:
    """按领域聚合的三个数。`grown` 为真 = 三样都够 = 小屋该长出那根枝。

    纯读：不改任何表、不调模型。评测结果直接从 `EvalRun.detail_json` 里读——那是
    评测唯一落地的地方，不另存一份「领域分」的副本（副本迟早和真值分叉）。
    """
    from sqlalchemy import select

    from app.core import prompt_eval, tutor
    from app.db import SessionLocal
    from app.models import EvalItem, EvalRun

    try:
        async with SessionLocal() as db:
            items = (await db.execute(select(EvalItem).order_by(EvalItem.id))).scalars().all()
            runs = (
                await db.execute(select(EvalRun).order_by(EvalRun.id.desc()).limit(RUNS_SCANNED))
            ).scalars().all()
    except Exception:  # noqa: BLE001 - 派生视图，坏了不该把小屋一起弄空
        log.warning("form: eval set unreadable", exc_info=True)
        return {"domains": [], "min_cases": MIN_CASES, "min_concepts": MIN_CONCEPTS}

    labelled = _labelled_cases(items)
    concepts = await tutor.concepts_by_domain()
    skills = await prompt_eval.cards()

    by_skill: dict[str, list[dict]] = {}
    for c in skills:
        d = _domain_of(c.get("domain"))
        if d:
            by_skill.setdefault(d, []).append(c)

    # 领域的全集 = 三样证据里出现过的所有领域。**只出现在一样里的也要列出来**：
    # 工作页那张诊断表要能回答「为什么这根枝还没长出来」，而答案往往就是另外两样还空着。
    names = sorted(set(labelled) | set(concepts) | set(by_skill))

    out: list[dict] = []
    for d in names:
        ret = _retrieval(_pick_run(runs, labelled.get(d, set())), len(labelled.get(d, ())))
        con = _concepts(concepts.get(d))
        sk = _skills(by_skill.get(d, []))
        out.append(
            {
                "domain": d,
                "retrieval": ret,
                "concepts": con,
                "skills": sk,
                "grown": bool(ret["enough"] and con["enough"] and any(s["enough"] for s in sk)),
            }
        )

    # 长出来的排前面，其余按领域名——不是排行榜，只是让小屋要的东西在最上面。
    out.sort(key=lambda b: (not b["grown"], b["domain"]))
    return {"domains": out, "min_cases": MIN_CASES, "min_concepts": MIN_CONCEPTS}
