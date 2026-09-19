"""判分金标集（PLAN2 P2-1）：把「这台判分器判得准不准」变成一次可复算的跑分。

**它补的是哪一格。** M1 的重讲判分从上线起就没有基线：`core/retell.py` 的判分器把一次
重讲判成 1–4 档，而**没有人知道它跟人的判断差多远**。于是 PLAN2 T2 那条校准曲线量的是
「你 vs 这台判分器」，不是「你 vs 真理」——页脚只能写一句「读趋势不读绝对值」。
这个模块就是那句话的解药：拿一套人已经定过档的用例重放一遍，给出 `k/n` + Wilson 区间。

**与 `prompt_eval` 的分工**（两个模块共用一把尺子、同一张结果表）：

| | `prompt_eval` | `judge_eval`（本模块） |
|---|---|---|
| 测什么 | 聊天型提示词：回复满不满足断言 | 判分型提示词：档位跟人对不对得上 |
| 用例 | `{id, intent, user, checks}` | `{id, intent, front, back, excerpt, retell, grade}` |
| 重放 | `tutor.build_messages(..., voice=...)` | `retell.card_prompt(..., template=...)` |
| 判据 | `CHECKS` 里的确定性断言 | **人工档位**（这套集合自己声明的基准） |
| 尺子 | `wilson` / `can_tell` | 同一个（**从这里 import，不重写**） |
| 结果 | `PromptEvalRun`（`key` = 属性名） | 同一张表、同一个 `key` —— 对照台与技能卡直接读得到 |

**四条纪律：**

1. **人工档位是基准，不是真理。** 每一条的 `intent` 里写着「为什么是这一档」，人可以审、
   可以改；有争议的那几条标了 `contested`，**不进 `k/n`**（计进去等于把我的犹豫算成它的错）。
2. **只有完全一致才算过**（`k/n` 的分子）；同时给**差一档内**的第二个数——四档是有序的，
   「判低一档」与「判反了」不是一件事。另外单列**高判 / 低判**：提示词自己承诺
   「宁可低判不高判」，这一对数就是那句话的尺子。
3. **走产品自己那条路**：`retell.card_prompt` 拼装 + `retell.judge_card` 那一次调用。
   跑候选提示词时只换模板（`template=`），不另写拼装逻辑——否则测的是另一个产品。
4. **`fallback` 不算过，但要单独数出来。** 「判不了」是一个**正当结论**（卡上没有答案时
   唯一正确的动作），可它跟「判对了」不是一回事：混在一起会让分数虚高。所以它对 `k/n`
   计为不过、单独报一个数，理由也写在报告里。

**怎么跑**（要花钱：n 条 = n 次模型调用）：

    cd backend && .venv/Scripts/python.exe smoke_judge_eval.py          # 真模型，逐条打印
    cd backend && .venv/Scripts/python.exe smoke_judge_eval.py --dry    # 只校验金标集，不调用

界面上是同一个入口：对照台里 `JUDGE_SYSTEM` 那条 →「跑一次对照」。
"""
from __future__ import annotations

import json
import logging
import time
from collections.abc import Awaitable, Callable

log = logging.getLogger(__name__)

# 判分器在登记表里的属性名。金标集文件、对照台的 key、`PromptEvalRun.key` 三处同一个词。
KEY = "JUDGE_SYSTEM"

# 四档 + 一个「不判」。**0 不是一档**：它是「人工也认为这时候不该给分」
# （卡上没有答案 / 重讲与题完全无关）——与 `retell.read_card` 里那个 `grade: 0` 同义。
GRADES = (1, 2, 3, 4)
NO_GRADE = 0

# 判分型用例至少要有这几样（PLAN2 P2-1 的数据规格：卡三样 + 重讲原文 + 人工档位）。
CASE_FIELDS = ("front", "back", "excerpt", "retell")

MIN_CASES = 30  # PLAN2 写的是 30–50 条：少于此数 Wilson 区间宽得下不了结论
MAX_CASES = 50

CONTEXT = (
    "走产品自己那条路（`retell.card_prompt` 拼装 + 那一次判分调用，一次调用/条）；"
    "判据是**人工档位**（这套金标集自己声明的基准，不是真理），有争议的条目不进 k/n。"
)


# ---------- 纯函数：一条用例怎么判 ----------


def load_cases() -> list[dict]:
    """金标集里的判分用例（坏条目跳过并记日志——一条写坏的 JSON 不该让整套跑不了）。"""
    from app.core import prompt_eval

    fx = prompt_eval.cases_for(KEY) or {}
    out: list[dict] = []
    for c in fx.get("cases") or []:
        if not isinstance(c, dict):
            continue
        cid = str(c.get("id") or "").strip()
        if not cid:
            continue
        out.append({**c, "id": cid})
    return out


def validate(cases: list[dict] | None = None) -> list[str]:
    """金标集自己的体检：返回问题清单（空 = 合格）。**纯函数，不花一分钱。**

    `--dry` 与测试都走它：金标集是一份要长期维护的数据，它能自己说自己哪里不合格
    （缺字段、档位不在 0–4、条数不在 30–50、id 重复、没有 intent）。
    """
    cases = load_cases() if cases is None else cases
    problems: list[str] = []
    if not (MIN_CASES <= len(cases) <= MAX_CASES):
        problems.append(f"用例数 {len(cases)} 不在 {MIN_CASES}–{MAX_CASES} 之间（PLAN2 P2-1 的规格）")
    seen: set[str] = set()
    for c in cases:
        cid = str(c.get("id") or "")
        if cid in seen:
            problems.append(f"{cid}: id 重复")
        seen.add(cid)
        try:
            grade = int(c.get("grade"))
        except (TypeError, ValueError):
            problems.append(f"{cid}: grade 读不出整数（{c.get('grade')!r}）")
            continue
        if grade not in (*GRADES, NO_GRADE):
            problems.append(f"{cid}: grade={grade} 不在 0–4（0 = 人工也认为「不判」）")
        for f in CASE_FIELDS:
            if f == "excerpt":  # 出处片段允许为空（`card_prompt` 会写成「（没有）」）
                continue
            if f == "back":
                # **背面可以是空的，但只有一种情况**：这张卡本来就没有答案，而那时
                # 人工档位必须是 0（判不了）。背面空着却给了档位 = 拿空气当基准。
                if not str(c.get("back") or "").strip() and grade != NO_GRADE:
                    problems.append(
                        f"{cid}: back 是空的，但 grade={grade}——没有答案就没有基准，这种用例只能是 0"
                    )
                continue
            if not str(c.get(f) or "").strip():
                problems.append(f"{cid}: {f} 是空的")
        if not str(c.get("intent") or "").strip():
            problems.append(f"{cid}: 没有 intent——日后没人知道它为什么在集合里")
    return problems


def score_case(expect: int, got: dict) -> dict:
    """一条用例的判定结果。Pure。

    - `expect`：人工档位。`0` = 人工也认为该「判不了」；
    - `got`：判分器的结论（`retell.read_card` 那个形状：`{ok, grade, label, reason}`）；
    - `passed`：**完全一致**才算过。`expect=0` 时「判不了」才算过——那时**给出任何档位
      都是错的**（提示词自己写着「不要编分」）；
    - `near`：差一档以内。`expect=0` 时与 `passed` 同义（没有「差一档」这回事）；
    - `fallback`：它说了「判不了」（这是**正当结论**，但不算判对）；
    - `over` / `under`：高判 / 低判。提示词承诺「宁可低判不高判」——这一对数就是那句话的尺子。
    """
    expect = int(expect)
    ok = bool(got.get("ok"))
    grade = int(got.get("grade") or 0)
    if expect == NO_GRADE:
        return {
            "passed": not ok,
            "near": not ok,
            "fallback": not ok,
            "over": ok,
            "under": False,
            "off": 0 if not ok else grade,
        }
    if not ok:
        return {"passed": False, "near": False, "fallback": True, "over": False, "under": False, "off": -1}
    return {
        "passed": grade == expect,
        "near": abs(grade - expect) <= 1,
        "fallback": False,
        "over": grade > expect,
        "under": grade < expect,
        "off": grade - expect,
    }


def summarize(rows: list[dict]) -> dict:
    """逐条结果 → 报告里的那几个数。Pure。

    `k/n` 只算**没有争议**的用例（`contested` 的那些单列出来给人看）：把「我自己拿不准」
    计进分子或分母，都是在拿犹豫冒充一个数。Wilson 区间来自 `prompt_eval.wilson`——
    **同一把尺子**，不在这里重写一个。
    """
    from app.core.prompt_eval import can_tell, wilson

    scored = [r for r in rows if not r.get("contested")]
    skip = [r for r in rows if r.get("contested")]
    total = len(scored)
    passed = sum(1 for r in scored if r["passed"])
    near = sum(1 for r in scored if r["near"])
    lo, hi = wilson(passed, total)
    nlo, nhi = wilson(near, total)
    matrix: dict[str, dict[str, int]] = {str(g): {str(h): 0 for h in (*GRADES, NO_GRADE)} for g in GRADES}
    for r in scored:
        exp = int(r["expect"])
        got = int(r["got"])
        if str(exp) in matrix and str(got) in matrix[str(exp)]:
            matrix[str(exp)][str(got)] += 1
    return {
        "total": total,
        "passed": passed,
        "rate": round(passed / total, 3) if total else 0.0,
        "ci": [round(lo, 3), round(hi, 3)],
        "tell": can_tell(lo, hi),
        "near": near,
        "near_rate": round(near / total, 3) if total else 0.0,
        "near_ci": [round(nlo, 3), round(nhi, 3)],
        "fallback": sum(1 for r in scored if r["fallback"]),
        "over": sum(1 for r in scored if r["over"]),
        "under": sum(1 for r in scored if r["under"]),
        "matrix": matrix,
        "contested": [{"id": r["id"], "expect": r["expect"], "got": r["got"], "why": r.get("why", "")} for r in skip],
    }


def baseline_note(base: dict | None, *, stale: dict | None = None, count: int = 0) -> str:
    """校准曲线页脚那一行（PLAN2 P2-1 结尾那句话）。Pure。

    三种情况**必须分开说**，因为它们是三件不同的事：
    1. 这一版跑过 → 把数说出来（那条曲线的误差量级就是这个）；
    2. 跑过，但那是**上一版提示词**（sha 变了）→ 说清是旧版，别让旧分数给新版背书；
    3. 一次都没跑过 → 照实说没跑过，并说清「读趋势不读绝对值」。
    """
    if base:
        lo, hi = base.get("ci_low") or 0.0, base.get("ci_high") or 0.0
        return (
            f"判分器基线：{base.get('cases')} 条金标集上「档位与人完全一致」"
            f"{base.get('passed')}/{base.get('cases')}（95% Wilson {lo:.0%}–{hi:.0%}）"
            "——这是这把尺子自身的误差量级，读趋势之前先看它。"
        )
    if stale:
        return (
            f"判分器跑过金标集，但那是**上一版**提示词（{str(stale.get('prompt_sha') or '')[:6]}，"
            f"{stale.get('passed')}/{stale.get('cases')}）——这一版还没跑过：读趋势不读绝对值。"
        )
    return (
        f"这一版判分器还没跑过金标集（{count} 条，`backend/evals/prompts/{KEY}.json`）："
        "读趋势不读绝对值。"
    )


# ---------- 一次跑分 ----------


async def check(
    *,
    variant: str | None = None,
    variant_label: str = "",
    model_id: str = "",
    judge: Callable[..., Awaitable[dict]] | None = None,
    save: bool = True,
) -> dict:
    """跑一次判分金标集。`variant` 为空 = 重放**已登记**的判分提示词（跑基线/回归）。

    报告的**顶层形状与 `prompt_eval.check()` 一致**（key/cases/total/passed/rate/ci/tell/
    baseline/flips/context），所以对照台那一页不用为它长一个分支；多出来的是判分专有的
    那几个数（`near` / `over` / `under` / `matrix` / `fallback` / `contested`）。
    """
    import hashlib

    from app.core import prompt_eval, providers, retell

    entry = prompt_eval._entry(KEY)  # noqa: SLF001 - 同一条登记表读取
    cases = load_cases()
    problems = validate(cases)
    if problems:
        raise ValueError("金标集不合格：" + "；".join(problems[:5]))
    text = entry.content if variant is None else variant
    if not text or not text.strip():
        raise ValueError("候选内容是空的")
    variant_sha = "" if variant is None else hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
    model_id = model_id or (providers.default_model_id() or "")
    run_one = judge or retell.judge_card

    started = time.time()
    rows: list[dict] = []
    for case in cases:
        expect = int(case["grade"])
        t0 = time.time()
        err = ""
        try:
            # 走产品自己那条路：同一个 `card_prompt`、同一个 `judge_card`，只换模板
            got = await run_one(
                str(case.get("front") or ""),
                str(case.get("back") or ""),
                str(case.get("excerpt") or ""),
                str(case.get("retell") or ""),
                model_id=model_id,
                template=text,
            )
        except Exception as e:  # noqa: BLE001 - 一次失败是一条用例失败，不是整次跑分失败
            got, err = {"ok": False, "grade": 0, "label": "", "reason": ""}, f"{type(e).__name__}: {e}"[:200]
        got = dict(got or {})
        scored = score_case(expect, got)
        rows.append(
            {
                "id": case["id"],
                "intent": str(case.get("intent") or ""),
                "expect": expect,
                "got": int(got.get("grade") or 0),
                "label": str(got.get("label") or ""),
                "contested": bool(case.get("contested")),
                "why": str(case.get("why") or ""),
                "missed_points": list(got.get("missed_points") or [])[:5],
                "reason": str(got.get("reason") or ""),
                "checks": ["grade_matches"],
                "passed": scored["passed"],
                "near": scored["near"],
                "fallback": scored["fallback"],
                "over": scored["over"],
                "under": scored["under"],
                "off": scored["off"],
                "failed": (
                    []
                    if scored["passed"] or case.get("contested")
                    else [{"name": "grade_matches", "why": _why(expect, got, scored)}]
                ),
                # 报告里留一手证据：它到底说了什么（判分器给的是结构化的那一小段）
                "reply": json.dumps(
                    {
                        "grade": got.get("grade"),
                        "label": got.get("label"),
                        "missed_points": got.get("missed_points") or [],
                        "hint": got.get("hint") or "",
                        "fallback": not got.get("ok"),
                        "reason": got.get("reason") or "",
                    },
                    ensure_ascii=False,
                )[:1200],
                "seconds": round(time.time() - t0, 2),
                "error": err,
            }
        )

    out = summarize(rows)
    seconds = round(time.time() - started, 1)
    before = await prompt_eval.baseline(KEY, model_id=model_id, prompt_sha=entry.sha)
    report = {
        # 界面据此换一套说法（档位一致 vs 断言）。**不占用 `kind`**：那个键在这份报告里
        # 与 `prompt_eval` 一样指的是提示词自己的种类（system/prompt/persona）。
        "report_kind": "grade",
        "key": KEY,
        "module": entry.module,
        "purpose": entry.purpose,
        "kind": entry.kind,
        "prompt_sha": entry.sha,
        "variant_sha": variant_sha,
        "variant_label": variant_label.strip()[:60],
        "model_id": model_id,
        "cases": rows,
        "assertions": {"total": out["total"], "failed": out["total"] - out["passed"]},
        "seconds": seconds,
        "calls": len(rows),
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
        "flips": prompt_eval._flips(rows, before),  # noqa: SLF001 - 同一份「哪条翻面了」
        "context": CONTEXT,
        "expect_source": "人工档位（`backend/evals/prompts/%s.json` 里每条自己的 grade）" % KEY,
        **out,
    }

    if save:
        from app.db import SessionLocal
        from app.models import PromptEvalRun

        try:
            async with SessionLocal() as db:
                row = PromptEvalRun(
                    key=KEY,
                    prompt_sha=entry.sha,
                    variant_sha=variant_sha,
                    variant_label=report["variant_label"],
                    model_id=model_id,
                    cases=out["total"],
                    passed=out["passed"],
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
                            "near": out["near"],
                            "over": out["over"],
                            "under": out["under"],
                            "fallback": out["fallback"],
                            "matrix": out["matrix"],
                            "contested": out["contested"],
                        },
                        ensure_ascii=False,
                    ),
                )
                db.add(row)
                await db.commit()
                await db.refresh(row)
                report["run_id"] = row.id
        except Exception:  # noqa: BLE001 - 存不下不该让报告丢掉
            log.warning("judge eval persist failed", exc_info=True)

    return report


def _why(expect: int, got: dict, scored: dict) -> str:
    """一条不一致的**人话**理由（报告里给人看的，不是给机器看的）。Pure。"""
    if scored["fallback"]:
        return f"人工定「{_label(expect)}」，它说判不了（{got.get('reason') or '没说为什么'}）"
    g = int(got.get("grade") or 0)
    if expect == NO_GRADE:
        return f"人工认为这一条不该给分（卡上没有答案），它却编了一个「{_label(g)}」"
    if scored["over"]:
        return f"人工定「{_label(expect)}」，它判「{_label(g)}」——**高判**（提示词承诺宁可低判不高判）"
    if scored["under"]:
        return f"人工定「{_label(expect)}」，它判「{_label(g)}」——低判"
    return f"人工定「{_label(expect)}」，它判「{_label(g)}」"


def _label(grade: int) -> str:
    from app.core.retell import grade_label

    return grade_label(int(grade)) or "不判"


async def baseline_note_for_curve() -> str:
    """给校准曲线页脚的那句话（`cards.calibration` 调它，best-effort）。"""
    from app.core import prompt_eval, prompts

    sha = prompts.fingerprint("app.core.retell", KEY)
    try:
        base = await prompt_eval.baseline(KEY, prompt_sha=sha)
        stale = None if base else await prompt_eval.baseline(KEY)
    except Exception:  # noqa: BLE001 - 读不到就照实说没跑过
        log.warning("judge baseline lookup failed", exc_info=True)
        base, stale = None, None
    return baseline_note(base, stale=stale, count=len(load_cases()))
