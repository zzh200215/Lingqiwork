"""技能包的量法：**有它 / 没它，同一套用例跑一遍**（环一最后缺的那一格）。

## 为什么需要它

`core/candidates.py` 能把一份材料读成一份 `SKILL.md` 草稿，但**没有任何东西回答得了
「这份技能到底有没有用」**。这个仓库对这件事的立场写在三处、完全一致：

- W7：**没有基线的画像不生效**；
- Q2 / `prompt_eval.cards()`：技能只收**跑过对照**的，「没跑过的提示词不是技能，是一段还没验过的文本」；
- 环一的界面：「这是草稿，还不叫技能卡」。

所以这个模块补的就是那一格：给一份技能跑一遍，输出 `k/n` + Wilson 区间 + **有它 / 没它
的逐条差**，跑完它才从「草稿」变成「量过的」。

## 与提示词对照台（Q1）的关系：同一把尺子，两种对照

| | Q1 对照台 | 这里 |
|---|---|---|
| 量什么 | 一条**登记提示词** | 一份**技能包**（instruction pack） |
| 比什么 | 改前（基线）vs 改后（候选正文） | **没它** vs **有它** |
| 尺子 | `prompt_eval.CHECKS` + `wilson` + `can_tell` | `prompt_eval.wilson` / `can_tell`（同一份）+ 本模块的 `CHECKS` |
| 用例 | `backend/evals/prompts/*.json` | `backend/evals/skills/*.json` |

**刻意不做的两件事：**

1. **不复用 `prompt_eval.CHECKS`。** 那张表里每条断言的 `why` 都指着**某一条提示词自己的
   一句话**（「规则 6 不要列清单」）。技能包没有那种句子——把别人的断言搬过来，量的就是
   别的东西。这里的断言是**与具体工序无关**的那几条（见 `CHECKS`）。
2. **不自动生成用例。** 用例是**尺子**：它得由人/真实需求来定（`prompt_eval.add_case` 的
   门槛是同一句话：`intent` 必须写清「它当时应该怎样」）。模型自己出题自己考，
   考的是「模型会不会出题」。技能刚生成时可以把材料本身当第一份用例的素材，那是人的决定。

## 「跟着工序做」怎么判

`follows_method` 是唯一的 LLM 判分，而且**只判有它那一侧**（没它那一侧压根没有工序可跟，
不知道跟什么）。它拿技能正文当评分标准，问「这份产出是不是按它说的做的」——
判分器自己走 `structured.extract_json` 的三级降级，与 `engine_eval.judge_grounded` 同一个路子。
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Callable
from pathlib import Path

from pydantic import BaseModel, field_validator

from app.config import BASE_DIR

log = logging.getLogger(__name__)

FIXTURE_DIR = BASE_DIR / "backend" / "evals" / "skills"
SKILLS_DIR = BASE_DIR / "skills"

_ANSWER_CAP = 1200  # 报告里保留的回复长度（够人审，不至于撑爆 detail_json）
DEFAULT_CAP_CHARS = 1200
MIN_CASES = 3  # 少于这个数连区间都懒得算——如实说「用例太少，下不了结论」

METHOD_JUDGE_SYSTEM = (
    "你在判断一份产出**有没有按给定工序做**。工序是唯一标准：\n"
    "- 5=每一步都照着做了，判断点也交代了；\n"
    "- 3=大方向对，但漏了关键步骤或跳过了判断点；\n"
    "- 1=只有结果长得像，过程是它自己另起的一套；\n"
    "- 0=答非所问，或者完全没理会这份工序。\n"
    "不看文笔、不看结论对不对，只看**有没有按那套工序走**。\n"
    '只输出 JSON，不要解释、不要代码块：{"score": 0-5 整数, "reason": "20 字以内理由"}'
)


def _cap(text: str) -> bool:
    return len(text) <= DEFAULT_CAP_CHARS


# 断言表：名字 → （判定, 「为什么」）。
# 与 `prompt_eval.CHECKS` 的分工：那边一条断言指着**某条提示词的一句话**；这里的断言与
# 具体工序无关，任何技能都能用。`follows_method` 需要判分器，是这一层唯一的模型调用。
CHECKS: dict[str, tuple[Callable[[str], bool], str]] = {
    "not_a_wall_of_text": (
        _cap,
        f"产出不超过 {DEFAULT_CAP_CHARS} 字——工序再全，糊成一堵墙也没人照着做",
    ),
}

# 用例没写 `checks` 时跑分会用哪一条。**一处常量**：界面上的「默认」也读它，
# 免得两边各写一个名字、改一处忘一处。
DEFAULT_CHECK = "not_a_wall_of_text"


def check_names() -> list[dict]:
    """给界面用的断言清单（名字 + 为什么）。**不在界面里再抄一份。**"""
    return [{"name": n, "why": why} for n, (_, why) in CHECKS.items()]


def run_checks(text: str, names: list[str]) -> tuple[bool, list[dict]]:
    """跑一组断言（**本表**的），未知断言名算失败（不静默忽略）。Pure.

    **为什么不复用 `prompt_eval.run_checks`**（踩过一次）：那一份查的是**提示词**那张
    `CHECKS` 表，于是这里的 `not_a_wall_of_text` 在它眼里是「未知断言」——每一条用例
    都判失败，而且看着像模型的错。两张表是两套断言，跑分器也就得各有一份。
    """
    failed: list[dict] = []
    for n in names:
        spec = CHECKS.get(n)
        if spec is None:
            failed.append({"name": n, "why": "（未知断言：用例文件可能写错了）"})
            continue
        fn, why = spec
        try:
            ok = bool(fn(text))
        except Exception:  # noqa: BLE001 - 断言自己炸了也算这条不过
            ok = False
        if not ok:
            failed.append({"name": n, "why": why})
    return (not failed, failed)


def _fixture_path(name: str) -> Path:
    return FIXTURE_DIR / f"{name}.json"


def cases_for(name: str) -> dict | None:
    """一份技能的用例文件（`backend/evals/skills/<技能名>.json`）。坏文件当没有。"""
    p = _fixture_path(name)
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 一个写坏的 JSON 不该把整个页面弄塌
        log.warning("skill fixture 读不动：%s", p.name, exc_info=True)
        return None
    return {**data, "file": p.name}


def all_cases() -> dict[str, dict]:
    """所有技能的用例文件，按技能名索引（文件里的 `skill` 说了算，不看文件名）。"""
    out: dict[str, dict] = {}
    if not FIXTURE_DIR.is_dir():
        return out
    for p in sorted(FIXTURE_DIR.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        key = str(data.get("skill") or "").strip() or p.stem
        out[key] = {**data, "file": p.name}
    return out


def cases_payload(name: str) -> dict:
    """给**编辑界面**用的那份：这份技能的用例 + 默认会用哪条断言。

    与 `cases_for()` 的区别：那个是跑分器读的原始数据，这个是界面读的——它还要知道
    **哪些字段是界面上能改的**（`ask` / `intent` / `checks`），以及不给 `checks` 时
    跑分会用哪一条。前端不自己拼默认值（抄一份迟早和 `CHECKS` 分叉）。
    """
    fx = cases_for(name) or {}
    cases = []
    for c in fx.get("cases") or []:
        cases.append(
            {
                "id": str((c or {}).get("id") or ""),
                "intent": str((c or {}).get("intent") or ""),
                "ask": str((c or {}).get("ask") or ""),
                "checks": [str(n) for n in ((c or {}).get("checks") or [])],
            }
        )
    return {
        "skill": name,
        "cases": cases,
        "model_id": str(fx.get("model_id") or ""),
        "checks": check_names(),
        "default_checks": [DEFAULT_CHECK],
        "file": str(fx.get("file") or f"{name}.json"),
    }


def save_cases(name: str, cases: list[dict], model_id: str = "") -> dict:
    """写一份技能的用例文件（界面上填的）。**唯一的写盘入口**，规范格式与提示词那套相同。"""
    from app.core.prompt_eval import _canonical  # 同一份格式：2 空格缩进、中文不转义

    clean: list[dict] = []
    for c in cases or []:
        ask = str((c or {}).get("ask") or "").strip()
        if not ask:
            continue
        item = {
            "id": str((c or {}).get("id") or ask[:24]).strip()[:40],
            "intent": str((c or {}).get("intent") or "").strip()[:200],
            "ask": ask[:1000],
        }
        # `checks` 是可选的一栏（不给就用跑分时的默认那条）。**不认识的名字照样写下去**：
        # 跑的时候它会被判失败并标「未知断言」——那比在这里悄悄删掉它诚实。
        names = [str(n).strip() for n in ((c or {}).get("checks") or []) if str(n).strip()]
        if names:
            item["checks"] = names
        clean.append(item)
    if not clean:
        raise ValueError("至少给一条用例（「它会收到什么」那一栏不能空）")
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    data = {"skill": name, "model_id": model_id, "cases": clean}
    _fixture_path(name).write_text(_canonical(data), encoding="utf-8")
    return {"skill": name, "cases": len(clean), "file": _fixture_path(name).name}


class MethodVerdict(BaseModel):
    score: float = 0.0
    reason: str = ""

    @field_validator("score", mode="before")
    @classmethod
    def _s(cls, v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0

    @field_validator("reason", mode="before")
    @classmethod
    def _r(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()


async def judge_method(model_id: str, method: str, ask: str, produced: str) -> tuple[int | None, str]:
    """产出有没有按这套工序做（0-5；None = 判分没跑成）。

    判分器与 `engine_eval.judge_grounded` 同一个路子：走 `extract_json` 的三级降级，
    provider 不支持原生 JSON 也能跑。
    """
    from app.core import providers
    from app.core.candidates import _resolve
    from app.core.llm import ProviderInfo, stream_chat
    from app.core.structured import extract_json

    try:
        provider, model = await _resolve(model_id, providers)
    except Exception:  # noqa: BLE001 - 判分没跑成不等于跑分失败
        return None, "没有可用的 provider"
    info = ProviderInfo(kind=provider.kind, base_url=provider.base_url, api_key=provider.api_key)
    obj, meta = await extract_json(
        info,
        model,
        [
            {"role": "system", "content": METHOD_JUDGE_SYSTEM},
            {
                "role": "user",
                "content": f"工序：\n{method[:4000]}\n\n收到的要求：\n{ask}\n\n产出：\n{produced[:6000]}",
            },
        ],
        MethodVerdict,
        stream_fn=stream_chat,
    )
    if obj is None:
        return None, (meta.error or "判分没跑成")[:120]
    return max(0, min(5, int(obj.score))), obj.reason


def _skill_text(name: str) -> str:
    from app.core import skills as skills_core

    return skills_core.load_skill(name)


def _sha(name: str, text: str) -> str:
    return hashlib.sha256(f"{name}|{text}".encode("utf-8")).hexdigest()[:12]


async def run(
    name: str,
    *,
    model_id: str = "",
    save: bool = True,
    generate=None,
    judge=None,
    cancel_key: str = "",
) -> dict:
    """给一份技能跑一遍：每条用例问两次（没它 / 有它），逐条比对。

    `generate` / `judge` 可注入（测试用：不碰网络）。
    **一次跑分 = 用例数 × 2 次生成 + 有它那一侧各有一次判分** —— 成本要写在报告里。

    `cancel_key` 非空 = 这一趟**可被取消**（合作式，见 `core/inflight`）。这里比评测那边
    更值得有：一条用例要问两次 + 判分，用例一多就是好几分钟，而「停下来」是按条生效的。
    """
    from app.core import inflight, prompt_eval, providers, usage_ledger

    try:
        method = _skill_text(name)
    except ValueError as e:
        raise ValueError(str(e)) from e

    fx = cases_for(name) or {}
    cases = [c for c in (fx.get("cases") or []) if str((c or {}).get("ask") or "").strip()]
    if not cases:
        raise ValueError(
            f"「{name}」还没有用例（backend/evals/skills/{name}.json）—— "
            "没有用例就没有尺子：模型自己出题自己考，考的是它会不会出题"
        )

    model = model_id or fx.get("model_id") or (providers.default_model_id() or "")
    gen = generate or prompt_eval._generate
    judge_fn = judge or judge_method
    sha = _sha(name, method)

    started = time.time()
    rows: list[dict] = []
    stopped = False
    async with usage_ledger.span("skill_eval", name):
        for case in cases:
            # 每条用例之间查一次（一条 = 两次生成 + 一次判分，所以粒度就是「当前这条跑完」）
            if cancel_key and inflight.cancel_requested(cancel_key):
                stopped = True
                break
            ask = str(case["ask"])
            names = [str(n) for n in (case.get("checks") or [DEFAULT_CHECK])]
            row: dict = {"id": str(case.get("id") or ask[:24]), "intent": str(case.get("intent") or ""), "ask": ask}

            # 没它：同一句话、同一模型，只少了那份工序
            t0 = time.time()
            try:
                plain = await gen(model, [{"role": "user", "content": ask}])
                row["without_ok"], row["without_failed"] = run_checks(plain, names)
                row["without_reply"] = plain[:_ANSWER_CAP]
                row["error_without"] = ""
            except Exception as e:  # noqa: BLE001 - 一次失败是一条用例失败，不是整次跑分失败
                plain = ""
                row["without_ok"] = False
                row["without_failed"] = [{"name": "generate", "why": f"{type(e).__name__}: {e}"[:200]}]
                row["without_reply"] = ""
                row["error_without"] = f"{type(e).__name__}: {e}"[:200]

            # 有它：工序以 system 注入（技能本来就是这个用法：`skill_load` 之后进上下文）
            try:
                with_skill = await gen(
                    model,
                    [
                        {"role": "system", "content": f"按这套工序做：\n\n{method}"},
                        {"role": "user", "content": ask},
                    ],
                )
                row["with_ok"], row["with_failed"] = run_checks(with_skill, names)
                row["with_reply"] = with_skill[:_ANSWER_CAP]
                row["error_with"] = ""
            except Exception as e:  # noqa: BLE001
                with_skill = ""
                row["with_ok"] = False
                row["with_failed"] = [{"name": "generate", "why": f"{type(e).__name__}: {e}"[:200]}]
                row["with_reply"] = ""
                row["error_with"] = f"{type(e).__name__}: {e}"[:200]

            # 「跟着工序做」只判有它那一侧：没它那一侧压根没有工序可跟
            score, why = (None, "") if not with_skill else await judge_fn(model, method, ask, with_skill)
            row["follows_method"] = score
            row["judge_why"] = why
            row["delta"] = int(bool(row["with_ok"])) - int(bool(row["without_ok"]))
            row["seconds"] = round(time.time() - t0, 2)
            rows.append(row)

    if stopped:
        # **半趟不落库、也不给区间与 delta 汇总**：跑了一半的「过了 k/n」会被读成
        # 「这份技能变差了」，而它只是被打断了——那正是质量闭环最怕的污染。
        # 已经跑完的那几条照原样带回去，停在哪一条看得见。
        done = len(rows)
        return {
            "skill": name,
            "sha": sha,
            "model_id": model,
            "cases": rows,
            "total": done,
            "planned": len(cases),
            "with_passed": sum(1 for r in rows if r["with_ok"]),
            "rate": None,
            "ci": None,
            "tell": False,
            "deltas": {
                "helped": sum(1 for r in rows if r["delta"] > 0),
                "hurt": sum(1 for r in rows if r["delta"] < 0),
                "same": sum(1 for r in rows if r["delta"] == 0),
            },
            "follows_method": None,
            "seconds": round(time.time() - started, 1),
            "calls": done * 2,
            "cases_needed": max(0, MIN_CASES - done),
            "stopped": True,
        }

    total = len(rows)
    helped = sum(1 for r in rows if r["delta"] > 0)
    hurt = sum(1 for r in rows if r["delta"] < 0)
    same = total - helped - hurt
    with_passed = sum(1 for r in rows if r["with_ok"])
    lo, hi = prompt_eval.wilson(with_passed, total)
    steps = [r["follows_method"] for r in rows if r["follows_method"] is not None]
    seconds = round(time.time() - started, 1)

    report = {
        "skill": name,
        "sha": sha,
        "model_id": model,
        "cases": rows,
        "total": total,
        "with_passed": with_passed,
        "rate": round(with_passed / total, 3) if total else 0.0,
        "ci": [round(lo, 3), round(hi, 3)],
        "tell": prompt_eval.can_tell(lo, hi) and total >= MIN_CASES,
        "deltas": {"helped": helped, "hurt": hurt, "same": same},
        "follows_method": round(sum(steps) / len(steps), 2) if steps else None,
        "seconds": seconds,
        "calls": total * 2 + len(steps),
        "cases_needed": max(0, MIN_CASES - total),
    }
    if save:
        report["run_id"] = await _save(name, sha, report)
    return report


async def _save(name: str, sha: str, report: dict) -> int | None:
    """把这次跑分落库。存不下不该让报告丢掉（与 Q1 同一条纪律）。"""
    from app.db import SessionLocal
    from app.models import SkillEvalRun

    try:
        async with SessionLocal() as db:
            row = SkillEvalRun(
                skill=name,
                skill_sha=sha,
                model_id=report["model_id"],
                cases=report["total"],
                with_passed=report["with_passed"],
                rate=report["rate"],
                ci_low=report["ci"][0],
                ci_high=report["ci"][1],
                helped=report["deltas"]["helped"],
                hurt=report["deltas"]["hurt"],
                follows_method=report["follows_method"] if report["follows_method"] is not None else -1.0,
                seconds=report["seconds"],
                detail_json=json.dumps({"cases": report["cases"]}, ensure_ascii=False),
            )
            db.add(row)
            await db.commit()
            await db.refresh(row)
            return row.id
    except Exception:  # noqa: BLE001
        log.warning("skill eval run 存不下", exc_info=True)
        return None


async def latest(name: str, *, sha: str = "") -> dict | None:
    """这份技能最近一次跑分（`sha` 给了就只认那一版内容跑出来的）。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import SkillEvalRun, iso_utc

    try:
        async with SessionLocal() as db:
            stmt = select(SkillEvalRun).where(SkillEvalRun.skill == name)
            if sha:
                stmt = stmt.where(SkillEvalRun.skill_sha == sha)
            row = (
                await db.execute(stmt.order_by(SkillEvalRun.id.desc()).limit(1))
            ).scalar_one_or_none()
    except Exception:  # noqa: BLE001
        log.warning("skill eval 读取失败", exc_info=True)
        return None
    if row is None:
        return None
    return {
        "at": iso_utc(row.created_at) or "",
        "model_id": row.model_id,
        "cases": row.cases,
        "with_passed": row.with_passed,
        "rate": row.rate,
        "ci_low": row.ci_low,
        "ci_high": row.ci_high,
        "helped": row.helped,
        "hurt": row.hurt,
        "follows_method": (
            row.follows_method if (row.follows_method or 0) >= 0 else None
        ),
        "seconds": row.seconds,
        "skill_sha": row.skill_sha,
    }


async def report() -> dict:
    """现有技能 + **量过没有** —— 「没基线不许当能力展示」的唯一出处。

    `registered` = 最近一次跑分是**这一版内容**跑出来的（sha 对得上）。
    `stale` = 有旧成绩、但内容改过了：那张分数不是现在这版的（与 Q1 技能卡的 `stale` 同义）。
    两者都不是「分数好不好」——分数好不好由 `baseline` 里的数自己说。
    """
    from app.core import skills as skills_core

    measured_any = False
    out: list[dict] = []
    for s in skills_core.list_skills():
        try:
            method = _skill_text(s["name"])
        except ValueError:
            method = ""
        sha = _sha(s["name"], method)
        # 取这一份技能的**最近一次**（不限 sha）：既要判断"这一版量过没有"，
        # 也要判断"有没有旧版本的分数"——两个问题，同一个查询答得了。
        last = await latest(s["name"]) if method else None
        fresh = last is not None and last.get("skill_sha") == sha
        base = last if fresh else None
        fx = cases_for(s["name"]) or {}
        if fresh:
            measured_any = True
        out.append(
            {
                "name": s["name"],
                "description": s["description"],
                "files": len(s["files"]),
                "chars": s["chars"],
                "sha": sha,
                "registered": fresh,
                "cases": len(fx.get("cases") or []),
                "baseline": base,
                "stale": bool(last is not None and not fresh),
            }
        )
    # S3：草稿卡上那一行事实——**真实工作里被用过几次**。派生自运行日志（`skill_trials`），
    # 不是第二份真值；一次查询算全部，免得一份技能一个查询。
    from app.core import skill_trials

    used = await skill_trials.counts([r["name"] for r in out])
    for r in out:
        r["trials"] = used.get(r["name"], {"n": 0, "last_at": None})
    out.sort(key=lambda r: (not r["registered"], r["name"]))
    return {
        "skills": out,
        "measured": measured_any,
        "checks": check_names(),
        "fixture_dir": str(FIXTURE_DIR),
        # 数字的窗口：界面要说「最近 N 次运行内」，不许说「共 N 次」（PLAN3 §9.2 决策1）
        "trial_window": skill_trials.WINDOW,
    }
