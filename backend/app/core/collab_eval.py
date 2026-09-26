"""A2 的尺子：协作（含并行）的**判据与聚合**，一次模型都不调（跑分在 `smoke_collab.py`）。

**它量的是什么。** A0 量的是「一件件事交出去办成了没有」（一个聊天回合 = 一个任务），
协作是**另一种形状**：一句话交出去，几个 agent 分头做、再合成。它的产物是**一段纪要**
（对话里的一条消息），不是产出区的成品——所以 A0 那套「落盘了没有」在这里不适用，
硬套进去会把正确答案判成失败。

**判据全是机械的**（不请 LLM 判分）：
  - `step_failed`：某一步报错或返回空；
  - `missing_marker`：材料里的**具体事实**没出现在纪要里（读没读到材料，这是最直接的证据）；
  - `not_parallel`：该并行的那一波没并行（编排器说了算，模型无从影响）；
  - `tool_not_allowed`：某一步用了它那一步不允许用的工具（**A2 的验收之一**）；
  - `tools_expected_but_absent`（裸 LLM 那一臂专用）：这一臂本来就不该有工具，用到了就是臂串了。

**配对对比**（验收那句「collab 任务完成率 ≥ 裸 LLM 版」）就是同一批任务跑两臂：
`tools`（A2：每步可带工具）与 `bare`（v1：每一步都是裸 LLM 调用）。两臂用**同一份材料、
同一套 RAG**——差别只有「手上有不有工具」，否则比出来的东西说不清。

**单遍不算数（A2 挂账① 的落地）**：同一套金标三次实测的符号是翻的（平 → 带工具赢 →
带工具输），n=1 时那是掷硬币。所以：`--reps k` 各跑 k 遍，`pair_reps` 把 2k 份单臂报告
**逐遍配对**（第 i 遍 vs 第 i 遍），配一个符号检验当刹车——它拦的是「5 胜 2 负 → 工具更好」
这种读法，不是拿来证明什么的（同一任务的多遍之间并不独立）。

**形状也是变量（A2 挂账②）**：fanout 有材料清单时会把「读」拆成单独的 step（每份材料一步），
再按 agent 合成结论、最后汇总——理由是实测的瓶颈「每步 3 轮，而找文件+读+提炼+成文挤在
一步里必然烧光」。拆小之后的机制读数是 **`exhausted_steps`**（烧光了几步），不是完成率：
步数变多本身会把完成率抬上去，那不算「形状改对了」。

**并行的收益怎么量**：同一波里各路的耗时，**逐路相加是串行要花的时间、取最大是并行实际花的**
（`parallel_seconds` / `serial_sum_seconds`）。这是同一个 run 里的两个读数，不额外花钱，
也不用跑第二遍——比「再跑一次串行版」更干净。

**红线**：只进脚本与报告，不进任何运行时路径（同 `agent_eval`）。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from pathlib import Path

# 比 marker 的判据（**抹掉标点与空白再比**）只有一份，在 `turn_eval` 里——A2 的协作臂与
# A4 的 `agent_eval` 都要用它，各写一份的那天两份就会漂。这里只 re-export，
# 好让本模块的读者一眼看见「协作这一臂拿的就是同一把尺子」。
from app.core.turn_eval import has_marker, normalize

log = logging.getLogger(__name__)

BACKEND = Path(__file__).resolve().parents[2]
TASKS_DIR = BACKEND / "evals" / "collab"
DEFAULT_TASKS = TASKS_DIR / "tasks.jsonl"
TRANSCRIPT_CAP = 4000  # 报告里留的纪要长度（够人审）

ARMS = ("tools", "bare")
ARM_LABELS = {"tools": "带工具（A2）", "bare": "裸 LLM（v1）"}

# 每一步允许用的工具**恒为**：只读基线 ∪ 该步声明的额外工具（`delegate` 永远不在里面）。
# 这条与 `delegate.allowed_tools` 是同一个事实，但这里**独立算一遍**：尺子要是直接调被测代码
# 的那把尺子，「白名单生效」就成了一句自我证明。
STEP_TOOL_CEILING = ("vault_read_file", "vault_list_files", "kb_search", "memory_list", "skill_load")


def load_tasks(path: Path | str | None = None) -> list[dict]:
    """读协作金标（jsonl）。坏行当场炸——同 `agent_eval.load_tasks` 的理由。"""
    p = Path(path) if path is not None else DEFAULT_TASKS
    if not p.is_file():
        raise FileNotFoundError(f"没有这份协作金标：{p}")
    out: list[dict] = []
    for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        text = line.strip()
        if not text or text.startswith("//"):
            continue
        try:
            obj = json.loads(text)
        except json.JSONDecodeError as e:
            raise ValueError(f"{p.name} 第 {i} 行不是合法 JSON：{e}") from e
        if not isinstance(obj, dict):
            raise ValueError(f"{p.name} 第 {i} 行不是对象")
        obj["_line"] = i
        out.append(obj)
    return out


def validate(tasks: list[dict]) -> list[str]:
    """体检金标集 → 问题清单（空 = 合格）。**一个字节都不发给模型**，`--dry` 的全部内容。"""
    from app.core import collab

    problems: list[str] = []
    seen: set[str] = set()
    for t in tasks:
        tid = str(t.get("id") or "").strip()
        where = tid or f"第 {t.get('_line')} 行"
        if not tid:
            problems.append(f"{where}：缺 id")
        elif tid in seen:
            problems.append(f"{where}：id 重复")
        seen.add(tid)
        if not str(t.get("goal") or "").strip():
            problems.append(f"{where}：缺 goal（一句话交出去的那件事）")
        if not str(t.get("note") or "").strip():
            problems.append(f"{where}：缺 note（出处与期望的理由）")
        pattern = str(t.get("pattern") or "")
        agents = t.get("agents")
        if pattern not in collab.PATTERNS:
            problems.append(f"{where}：pattern 不认识：{pattern!r}")
            continue
        if not isinstance(agents, list) or not all(isinstance(a, dict) for a in agents):
            problems.append(f"{where}：agents 必须是对象列表")
            continue
        for i, a in enumerate(agents):
            if not str(a.get("name") or "").strip():
                problems.append(f"{where}：第 {i + 1} 个 agent 缺 name")
            if not str(a.get("system_prompt") or "").strip():
                # 每一步的人设是编排器明确给 `delegate` 的（那边不再猜），所以这里必须写
                problems.append(f"{where}：第 {i + 1} 个 agent 缺 system_prompt")
        try:
            collab.build_waves(pattern, agents)
        except ValueError as e:
            problems.append(f"{where}：{e}")
        exp = t.get("expected")
        if not isinstance(exp, dict) or not exp:
            problems.append(f"{where}：缺 expected")
            continue
        for key in exp:
            if key not in ("required_markers", "min_steps", "parallel", "tool_markers"):
                problems.append(f"{where}：expected 里的 `{key}` 没有判据消费它")
        marks = exp.get("required_markers")
        if not isinstance(marks, list) or not marks or not all(isinstance(m, str) and m for m in marks):
            problems.append(f"{where}：required_markers 必须是非空字符串列表（否则这条量不了）")
        if exp.get("parallel") and pattern != "fanout":
            problems.append(f"{where}：写了 parallel，但 pattern 不是 fanout——并行是编排器定的")
        vault = t.get("vault")
        if vault is not None and not isinstance(vault, dict):
            problems.append(f"{where}：vault 必须是对象（相对路径 → 正文）")
        for rel in vault or {}:
            if not isinstance(rel, str) or rel.startswith(("/", "\\")) or ".." in rel.split("/"):
                problems.append(f"{where}：vault 里的路径必须是 vault 内的相对路径：{rel!r}")
    if not tasks:
        problems.append("协作金标是空的")
    return problems


def tasks_sha(tasks_or_path=None) -> str:
    """金标指纹（与 A0/用例同一个算法）——**金标改了要看得出来**。"""
    if isinstance(tasks_or_path, (str, Path)):
        raw = Path(tasks_or_path).read_text(encoding="utf-8")
    else:
        raw = json.dumps(tasks_or_path or [], ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def _steps_of(task: dict, split_reads: bool = True) -> list[dict]:
    """这条任务**实际会跑的那几步**（含材料清单，所以 fanout 是拆开后的那 10 步）。

    `materials` 必须传：② 之后 fanout 的形状取决于「有没有材料清单」（有 → 读/结论/汇总三波，
    没有 → 老的单段式）。不传的话尺子拿到的步骤表与真跑的**不是同一张**，而它还要用
    `steps[idx]` 去算「这一步允许用什么工具」——那就是两份真值（今天因为白名单恒为只读基线
    而看不出差别，将来给某一步开了额外工具就会静默判错）。

    `split_reads` 同理由调用方给（对照臂跑的是单段式），**不猜**。
    """
    from app.core import collab

    return collab.build_steps(
        str(task.get("pattern") or ""),
        task.get("agents") or [],
        sorted((task.get("vault") or {}).keys()) or None,
        split_reads=split_reads,
    )


def judge(task: dict, result: dict, *, arm: str) -> list[dict]:
    """一条协作任务的结果 → findings（空 = 干净）。Pure。

    `result`：`{ok, transcript, facts, meta, parallel_seconds, serial_sum_seconds, seconds}`。
    """
    exp = task.get("expected") or {}
    facts = [f for f in (result.get("facts") or []) if isinstance(f, dict)]
    # 判据读的是**每一步产出的全文**（`facts[i].text`，报告里留全了），**不是**报告里那份
    # 截断过的纪要：`TRANSCRIPT_CAP` 是「报告文件别太大」的上限、是给人审的，拿它当判据的
    # 输入是错的。② 撞出来的——fanout 拆成 10 步之后那一轮产出 45190 字被截到 4000，
    # 6 个 marker 里 5 个掉在截断外，于是「每步都跑成了、事实也都写出来了」被读成
    # `missing_marker`。旧报告不用重跑：全文一直都在 `facts` 里，`--rejudge` 免费重判。
    transcript = "".join(str(f.get("text") or "") for f in facts) or str(
        result.get("transcript") or ""
    )
    # 形状从**结果自己**读（② 之后有两种 fanout 形状，对照臂跑的是单段式）。
    # 缺字段（旧报告）→ 按拆开的那版算，与现在的默认值一致。
    steps = _steps_of(task, bool(result.get("split_reads", True)))
    out: list[dict] = []

    if result.get("error"):
        out.append({"code": "run_failed", "detail": f"整轮没跑起来：{result['error']}"})
        return out
    # 「整轮都跑成了没有」**从 facts 推**，不读存下来的那个布尔：
    # facts 才是原始事实，`ok` 只是它的一句摘要。读存下来的布尔有两个坏处——一是
    # 一开始没存它（2026-09-20 重判旧报告时全被读成「都没跑成」），二是两份真值打架时
    # 没人知道该信哪个。缺字段时自己推，也顺手让旧报告可以重判。
    ok = result.get("ok")
    if ok is None:
        ok = all(bool(f.get("text")) and not f.get("error") for f in facts) and bool(facts)
    if not ok:
        bad = "、".join(f"{f.get('title')}（{f.get('error') or '空产出'}）" for f in facts if f.get("error") or not f.get("text"))
        out.append({"code": "step_failed", "detail": f"有一步没跑成：{bad or '见逐条'}"})

    # **轮数烧光 ≠ 跑成了**（2026-09-20 第二次真跑撞出来的）：烧光那一步返回的是一句
    # 占位符（`llm.ROUNDS_EXHAUSTED_TEXT`），**长得很像一段正常回答** —— 第一版的 `ok`
    # 只看「有没有文字」，于是「三路只读了文件、一个字没写」被读成了「干净」。
    # 这条与 `trace_missing` 同族：**量不出来 / 其实没有，都要响**。
    #
    # 两条判据一起看：新的记录有机器可读的 `rounds_exhausted`；**老报告只有那段文字**，
    # 所以也认文字（同一个常量，不硬编码句子）。
    from app.core.llm import ROUNDS_EXHAUSTED_TEXT

    def _gave_up(f: dict) -> bool:
        return bool(f.get("rounds_exhausted")) or str(f.get("text") or "").strip() == ROUNDS_EXHAUSTED_TEXT

    exhausted = [f for f in facts if _gave_up(f)]
    if exhausted:
        out.append(
            {
                "code": "rounds_exhausted",
                "detail": "这几步把轮数烧光了，交回来的是占位符不是答案："
                + "、".join(str(f.get("title")) for f in exhausted),
            }
        )

    missing = [m for m in (exp.get("required_markers") or []) if not has_marker(transcript, m)]
    if missing:
        out.append(
            {
                "code": "missing_marker",
                "detail": "材料里的这些事实没出现在**任何一步的产出**里：" + "、".join(missing),
            }
        )

    want_steps = int(exp.get("min_steps") or 0)
    if want_steps and len(facts) < want_steps:
        out.append(
            {"code": "missing_steps", "detail": f"只跑了 {len(facts)} 步，期望至少 {want_steps} 步"}
        )

    if exp.get("parallel") and not (result.get("meta") or {}).get("parallel"):
        out.append({"code": "not_parallel", "detail": "该并行的那一波没有并行（编排器说了算）"})

    # **每步工具白名单**（A2 的验收之一）：用了不该用的、或者这一臂本来不该有工具
    for f in facts:
        allowed = set(STEP_TOOL_CEILING)
        idx = int(f.get("step") or 0) - 1
        if 0 <= idx < len(steps):
            allowed |= set(steps[idx].get("tools") or [])
        used = [str(n) for n in (f.get("tools") or [])]
        if arm == "bare" and used:
            out.append(
                {
                    "code": "tools_expected_but_absent",
                    "detail": f"裸 LLM 那一臂不该有工具，但「{f.get('title')}」调了：" + "、".join(used),
                }
            )
            continue
        bad = sorted({n for n in used if n not in allowed})
        if bad:
            out.append(
                {
                    "code": "tool_not_allowed",
                    "detail": f"「{f.get('title')}」用了这一步不该用的工具：" + "、".join(bad),
                }
            )
    return out


def _exhausted_steps(row: dict) -> int:
    """这一条任务里有几步把轮数烧光了（`rounds_exhausted` 的原始事实，不看 findings）。"""
    return sum(
        1 for f in (row.get("facts") or []) if isinstance(f, dict) and f.get("rounds_exhausted")
    )


def _arm_stats(rows: list[dict]) -> dict:
    """一臂的若干遍合起来看：办成几条、跑了几步、调了几次工具、烧光几步。Pure。"""
    n = len(rows)
    done = sum(1 for r in rows if is_done(r))
    return {
        "runs": n,
        "tasks": n,
        "done": done,
        "rate": round(done / n, 4) if n else 0.0,
        "steps": sum(len(r.get("facts") or []) for r in rows),
        "tool_calls": sum(
            len(f.get("tools") or []) for r in rows for f in (r.get("facts") or [])
        ),
        # **②那条挂账的读法**：把 step 拆小是为了不让某一步的轮数烧光，所以「烧光了几步」
        # 是机制读数——比完成率更能说明形状改对没有（完成率会被「步数变多」本身抬高）。
        "exhausted_rows": sum(1 for r in rows if _exhausted_steps(r)),
        "exhausted_steps": sum(_exhausted_steps(r) for r in rows),
    }


# 符号检验搬去了 `core/stats.py`：它不只这一把尺子用（引擎侧那把 `gather_eval` 也要配对），
# 而**运行时代码不许 import 尺子**那条红线是按模块扫的——两把尺子互相 import，谁都会撞上去。
# 这里**转出去**，老调用方（`smoke_collab_eval` / 本模块的报告）一个字不用改。
from app.core.stats import sign_test_p  # noqa: E402,F401  （转出：见上面那段理由）


def pair_reps(reports: list[dict]) -> dict:
    """k 遍 × 两臂的单臂报告 → **逐遍配对**（第 i 遍 vs 第 i 遍）。Pure。

    **为什么不把 2k 份合起来交给 `summarize`**：那个函数的配对照 `(任务, 臂)` 只留一条，
    同一臂的多遍会**互相覆盖**——跑 3 遍静默只剩最后一遍，读起来却像有 9 对。
    「以为在量、其实没量」是这个仓库反复防的那一类失败（`docs/testing.md` §6.5 的邻居）。

    配对单位是 **(任务, 遍)**：同一遍里两臂跑的是同一套材料、同一个模型，那一遍才叫一对。
    平局的定义沿用 `summarize`（两臂都成或都不成）。两臂遍数不一样时**当场抛**——
    那种输入配出来的东西没人能解释。
    """
    by_arm: dict[str, list[dict]] = {}
    for rep in reports or []:
        arm = str((rep or {}).get("arm") or "")
        if arm:
            by_arm.setdefault(arm, []).append(rep)
    t_reports, b_reports = by_arm.get("tools") or [], by_arm.get("bare") or []
    if not t_reports or not b_reports:
        raise ValueError(f"缺一臂：tools {len(t_reports)} 份 / bare {len(b_reports)} 份")
    if len(t_reports) != len(b_reports):
        raise ValueError(
            f"两臂的遍数不一样（tools {len(t_reports)} 遍 / bare {len(b_reports)} 遍）——配不起来"
        )

    per_task: dict[str, dict] = {}
    paired = {"win": 0, "tie": 0, "loss": 0, "unpaired": 0}
    all_rows: dict[str, list[dict]] = {"tools": [], "bare": []}
    for t_rep, b_rep in zip(t_reports, b_reports):
        t_by_id = {str(r.get("id")): r for r in (t_rep.get("detail") or [])}
        b_by_id = {str(r.get("id")): r for r in (b_rep.get("detail") or [])}
        all_rows["tools"].extend(t_by_id.values())
        all_rows["bare"].extend(b_by_id.values())
        for tid in sorted(set(t_by_id) | set(b_by_id)):
            slot = per_task.setdefault(
                tid, {"tools": [], "bare": [], "win": 0, "tie": 0, "loss": 0}
            )
            a, b = t_by_id.get(tid), b_by_id.get(tid)
            if a is None or b is None:
                paired["unpaired"] += 1
                continue
            slot["tools"].append(1 if is_done(a) else 0)
            slot["bare"].append(1 if is_done(b) else 0)
            if is_done(a) and not is_done(b):
                slot["win"] += 1
                paired["win"] += 1
            elif is_done(b) and not is_done(a):
                slot["loss"] += 1
                paired["loss"] += 1
            else:
                slot["tie"] += 1
                paired["tie"] += 1

    return {
        "reps": len(t_reports),
        "reports": len(reports or []),
        "arms": {arm: _arm_stats(rows) for arm, rows in all_rows.items()},
        "per_task": per_task,
        "paired": paired,
        "sign_test_p": sign_test_p(paired["win"], paired["loss"]),
    }


def _codes(findings) -> set[str]:
    return {str(f.get("code") or "") for f in findings or []}


def is_done(row: dict) -> bool:
    """协作任务的「办成了」= 每一步都跑成 + 材料里那几个事实进了纪要。**不使用轮数。**"""
    return not (
        _codes(row.get("findings"))
        & {"run_failed", "step_failed", "missing_marker", "missing_steps", "rounds_exhausted"}
    )


def summarize(rows: list[dict]) -> dict:
    """一批协作任务结果 → 报告。Pure。**按臂分组**（配对对比的那两半）。"""
    n = len(rows)
    counts: dict[str, int] = {}
    for r in rows:
        for code in _codes(r.get("findings")):
            counts[code] = counts.get(code, 0) + 1

    def _done(rs):
        return [r for r in rs if is_done(r)]

    tools_rows = [r for r in rows if r.get("arm") == "tools"]
    bare_rows = [r for r in rows if r.get("arm") == "bare"]

    # 配对：同一 id 在两臂上的完成情况（win/tie/loss 是这一层的习惯口径）
    by_id: dict[str, dict] = {}
    for r in rows:
        by_id.setdefault(str(r.get("id")), {})[str(r.get("arm"))] = r
    paired = {"win": 0, "tie": 0, "loss": 0, "unpaired": 0}
    for tid, arms in by_id.items():
        a, b = arms.get("tools"), arms.get("bare")
        if a is None or b is None:
            paired["unpaired"] += 1
        elif is_done(a) and not is_done(b):
            paired["win"] += 1
        elif is_done(b) and not is_done(a):
            paired["loss"] += 1
        else:
            paired["tie"] += 1

    parallel_rows = [r for r in rows if (r.get("meta") or {}).get("parallel")]
    par_seconds = sum(float(r.get("parallel_seconds") or 0) for r in parallel_rows)
    ser_seconds = sum(float(r.get("serial_sum_seconds") or 0) for r in parallel_rows)

    return {
        "tasks": n,
        "done": len(_done(rows)),
        "done_rate": round(len(_done(rows)) / n, 4) if n else 0.0,
        "clean": sum(1 for r in rows if not r.get("findings")),
        "tools_arm": {
            "tasks": len(tools_rows),
            "done": len(_done(tools_rows)),
            "rate": round(len(_done(tools_rows)) / len(tools_rows), 4) if tools_rows else 0.0,
        },
        "bare_arm": {
            "tasks": len(bare_rows),
            "done": len(_done(bare_rows)),
            "rate": round(len(_done(bare_rows)) / len(bare_rows), 4) if bare_rows else 0.0,
        },
        "paired": paired,
        "tool_calls": sum(len(f.get("tools") or []) for r in rows for f in (r.get("facts") or [])),
        "steps": sum(len(r.get("facts") or []) for r in rows),
        "parallel_seconds": round(par_seconds, 1),
        "serial_sum_seconds": round(ser_seconds, 1),
        "seconds": round(sum(float(r.get("seconds") or 0) for r in rows), 1),
        "counts": counts,
        "detail": rows,
    }


def compare(old: dict, new: dict) -> str:
    """两臂的差 —— 验收那句「≥ 裸 LLM 版」就念这一句。Pure。

    **两份报告合起来看，不是各看各的**（2026-09-20 第一次真跑时这里出过错）：一次调用只跑
    一臂，所以每份报告里只有一个 `*_arm` 有数——第一版直接读 `new["tools_arm"]` 与
    `new["bare_arm"]`，于是裸 LLM 那份报告打出了「带工具 0.0 vs 裸 LLM 1.0（-100%）」，
    看着像带工具把任务全搞砸了。**配对也一样**：配对要跨报告按 id 配（同一批任务跑了两臂），
    只看单份报告的话全是 `unpaired`。
    """
    if not old or not new:
        return "没有可比的报告。"
    reps = [old, new]
    bits: list[str] = []
    if old.get("tasks_sha") and new.get("tasks_sha") and old["tasks_sha"] != new["tasks_sha"]:
        bits.append(f"金标从 {old['tasks_sha']} 变成了 {new['tasks_sha']}（不可比）")

    def _rate(arm: str):
        for r in reps:
            b = r.get(f"{arm}_arm") or {}
            if b.get("tasks"):
                return b.get("rate")
        return None

    t, b = _rate("tools"), _rate("bare")
    if t is not None and b is not None:
        bits.append(f"带工具 {t} vs 裸 LLM {b}（{round(float(t) - float(b), 4):+.2%}）")

    # 配对：按 id 把两臂的**行**配起来（完成判据是 `is_done`，与 `summarize` 同一个）
    rows = {arm: {str(r.get("id")): r for r in (next((x for x in reps if x.get("arm") == arm), {}).get("detail") or [])} for arm in ARMS}
    win = tie = loss = unpaired = 0
    for tid in sorted(set(rows["tools"]) | set(rows["bare"])):
        a, c = rows["tools"].get(tid), rows["bare"].get(tid)
        if a is None or c is None:
            unpaired += 1
        elif is_done(a) and not is_done(c):
            win += 1
        elif is_done(c) and not is_done(a):
            loss += 1
        else:
            tie += 1
    if win or tie or loss or unpaired:
        bits.append(f"配对 胜 {win} / 平 {tie} / 负 {loss}" + (f"（{unpaired} 条只有一臂）" if unpaired else ""))

    par = sum(float(r.get("parallel_seconds") or 0) for r in rows["tools"].values())
    ser = sum(float(r.get("serial_sum_seconds") or 0) for r in rows["tools"].values())
    if par:
        bits.append(f"并行那一波 {round(par, 1)}s（串行相加 {round(ser, 1)}s，省 {round(ser - par, 1)}s）")
    return "；".join(bits) + "。"


def rejudge(rows: list[dict], tasks: list[dict]) -> tuple[list[dict], list[dict]]:
    """**只重算判据**，不重跑模型。→ (新记录, 差异清单)。Pure。

    为什么需要它：判据本身会改（第一次真跑就把「marker 要逐字」改成了「忽略标点」），
    而**原始事实（纪要正文、每步的工具与耗时）报告里留全了** —— 那就没有理由再花一次钱，
    更没理由让模型的随机性混进「判据改了」这件事里。`--rejudge` 走的就是这里。
    """
    by_id = {str(t.get("id") or ""): t for t in tasks}
    out: list[dict] = []
    diff: list[dict] = []
    for r in rows:
        tid = str(r.get("id") or "")
        task = by_id.get(tid)
        if task is None:
            raise KeyError(f"报告里的任务 {tid!r} 不在当前协作金标里——不猜，当场停")
        fresh = judge(task, r, arm=str(r.get("arm") or "tools"))
        before = sorted(_codes(r.get("findings")))
        after = sorted({f["code"] for f in fresh})
        out.append({**r, "findings": fresh})
        if before != after:
            diff.append({"id": tid, "arm": r.get("arm"), "before": before, "after": after})
    return out, diff


async def _drop_usage(max_id: int | None) -> int:
    """把评测刚写下的用量行删掉（**best-effort**）。

    为什么必须删：`usage_ledger.traced("collab")` 会往 `model_usage` 写行，而设置页的
    「用量按事记」读的就是它——评测跑一轮就在用户自己的账上留下几条他没做过的协作，
    和 A0 收走 `turn_traces` 是同一条纪律。**只删自己这个窗口里写下的那些**（id 比开跑前大），
    不按 kind 大扫除：用户自己真跑过的协作一条都不动。

    **它必须是 async**（2026-09-20，被管道测试当场抓住）：第一版用 `asyncio.run(go())`，
    而调用点就在 `run_tasks` 这个**已经在跑的事件循环里** —— `asyncio.run` 会抛
    「cannot be called from a running event loop」，于是清理**一次都没生效过**。

    `max_id` 是 `None`（**读不到**）与 `0`（**表还是空的**）是**两件事**：第一版写成
    `if not max_id: return 0`，于是空表上的评测**一行都不收**（`id > 0` 本来能全收）。
    这个项目的老毛病又犯了一次：读不到 ≠ 零。
    """
    if max_id is None:
        return 0
    try:
        from sqlalchemy import delete

        from app.db import SessionLocal

        from app.models import ModelUsage

        async with SessionLocal() as db:
            res = await db.execute(
                delete(ModelUsage).where(ModelUsage.id > max_id, ModelUsage.kind == "collab")
            )
            await db.commit()
            return int(res.rowcount or 0)
    except Exception:  # noqa: BLE001 - 清理失败不该毁掉已经跑完的评测
        log.warning("collab eval: 用量行没清掉", exc_info=True)
        return 0


async def _max_usage_id() -> int | None:
    """开跑前的 `MAX(id)`：清理只删这之后写下的行（**用户自己的账一条都不动**）。

    **读不到时返回 `None`，不是 0** —— 见 `_drop_usage` 里那段：把两者混成一个值，
    空表上的评测就一行都收不走，而这种「没清掉」在报告里看着和「本来就没写」一模一样。
    """
    try:
        from sqlalchemy import func, select

        from app.db import SessionLocal

        from app.models import ModelUsage

        async with SessionLocal() as db:
            return int((await db.execute(select(func.max(ModelUsage.id)))).scalar() or 0)
    except Exception:  # noqa: BLE001
        return None


async def run_tasks(
    tasks: list[dict],
    *,
    model_id: str = "",
    arm: str = "tools",
    rag: bool = True,
    split_reads: bool = True,
    on_task=None,
) -> dict:
    """真跑（要花钱）。每个任务跑一臂；**两臂分两次调用**（`--arm` 分开跑也好、一起跑也好）。

    材料与索引走 `turn_eval` 那套临时 vault / 临时向量库：**不碰用户自己的 vault 与索引**。
    """
    from app.core import collab, turn_eval

    if arm not in ARMS:
        raise ValueError(f"未知的臂：{arm}（只能是 {'/'.join(ARMS)}）")
    rows: list[dict] = []
    t0 = time.time()
    usage_max = await _max_usage_id()

    with turn_eval._scratch_vault() as vault, turn_eval._scratch_index():  # noqa: SLF001
        for task in tasks:
            vdir = vault
            rec: dict = {
                "id": str(task.get("id")),
                "pattern": str(task.get("pattern")),
                "goal": str(task.get("goal")),
                "arm": arm,
                "model_id": model_id,
                "transcript": "",
                "facts": [],
                "artifacts": [],
                "error": "",
                "seconds": 0.0,
                "vault_files": 0,
                "findings": [],
            }
            started = time.time()
            try:
                turn_eval._reset_vault(vdir)  # noqa: SLF001
                turn_eval._reset_index()  # noqa: SLF001
                rec["vault_files"] = turn_eval._seed_vault(task, vdir)  # noqa: SLF001
                if rec["vault_files"]:
                    rec["indexed"] = await asyncio.to_thread(turn_eval._index_vault, vdir)  # noqa: SLF001

                async def resolve(mid: str, _model_id=model_id):
                    from app.core.report import resolve as resolve_model_info

                    got = await resolve_model_info(mid or _model_id)
                    if got is None:
                        raise RuntimeError(f"解析不出模型 {mid or _model_id or '(默认)'}")
                    return got

                async def retrieve(query: str, top_k: int):
                    from app.routers.chat import indexer_retrieve

                    return await indexer_retrieve(query, top_k)

                meta: dict = {}
                done: dict = {}
                async for event, data in collab.run(
                    str(task.get("goal") or ""),
                    [dict(a) for a in (task.get("agents") or [])],
                    str(task.get("pattern") or ""),
                    resolve,
                    retrieve if rag else None,
                    # A2：`tools=False` 就是 v1 的行为（每一步都是裸 LLM 调用）
                    tools=(arm == "tools"),
                    # 材料清单交给编排器**分给各路**（「谁能读什么」由编排器判定）。
                    # 排序后再给：同一批材料每次分到的结果一样，两次跑才可比。
                    materials=sorted((task.get("vault") or {}).keys()) or None,
                    # ②：拆读步（默认）还是单段式（对照臂，`--no-split`）
                    split_reads=split_reads,
                ):
                    if event == "meta":
                        meta = data
                    elif event == "done":
                        done = data
                facts = [f for f in (done.get("facts") or []) if isinstance(f, dict)]
                # 并行那一波：**逐路相加 = 串行要花的时间**，取最大 = 并行实际花的
                par = [f for f in facts if f.get("parallel")]
                rec.update(
                    {
                        "transcript": str(done.get("transcript") or "")[:TRANSCRIPT_CAP],
                        "facts": facts,
                        "artifacts": [p for f in facts for p in (f.get("artifacts") or [])],
                        "ok": bool(done.get("ok")),
                        "meta": {"pattern": meta.get("pattern"), "parallel": bool(meta.get("parallel"))},
                        "split_reads": bool(meta.get("split_reads", split_reads)),
                        "parallel_seconds": float(done.get("parallel_seconds") or 0),
                        "serial_sum_seconds": round(sum(float(f.get("seconds") or 0) for f in par), 1),
                        "seconds": round(time.time() - started, 1),
                    }
                )
            except Exception as e:  # noqa: BLE001 - 一条任务挂了不该毁掉整轮
                log.warning("collab eval task failed: %s", task.get("id"), exc_info=True)
                rec.update({"error": f"{type(e).__name__}: {e}", "seconds": round(time.time() - started, 1)})
            rec["findings"] = judge(task, rec, arm=arm)
            rows.append(rec)
            if on_task is not None:
                on_task(rec)

    dropped = await _drop_usage(usage_max)
    report = summarize(rows)
    report.update(
        {
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "seconds": round(time.time() - t0, 1),
            "tasks_sha": tasks_sha(tasks),
            "arm": arm,
            "rag": bool(rag),
            "usage_rows_dropped": dropped,
        }
    )
    return report
