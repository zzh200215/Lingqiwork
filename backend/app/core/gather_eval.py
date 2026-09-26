"""引擎侧检索尺子：**攒材料**攒得全不全（RAG 升级 P1c 留给 P2 的那笔欠账）。

**为什么另造一把。** `evals/retrieval/golden.jsonl`（44 条）量的是**文件级召回**——一句事实型
提问，看期望的那**一条**源在不在 top-k。而四个成文引擎取材走的是 `compose.gather_inward` →
`retriever.deep_search`：它们的用途是**攒材料写东西**，要的是「**一把全的**」。同一批检索结果
在两把尺子上的得分可以完全不同：多带两份相关材料在「找一条准的」那里是噪声，在「攒一把全的」
这里是**必需**。P1c 当年因此**没有据那把尺子改引擎默认**——原话是「那把尺子得另造」。这就是那一把。

**与 `core/engine_eval.py` 是两把尺子，别混**：那一把量的是四个引擎**成品**的质量（结构判分 +
接地判分，生成与检索混在一起）；这一把只量**取材那一步**，不看生成。RAG 文档自己写着
「`engine_eval` 的接地分不能替代它」。

**量什么**（三条都要，合起来才叫「攒齐了」）：

1. **覆盖率**：这一题需要的几份源，检索回来的集合里命中了几份（`ratio`）；
2. **凑齐率**：整题全命中的比例（`full`）——「攒材料」的失败常常是「差一份」，平均值看不出来；
3. **成本**：回到几份源、花了几秒、调了几次模型（`distinct` / `seconds` / `calls`）——
   覆盖率不是白来的：多搜几轮总能多捞几份，问题是值不值。

**策略之间下结论用同题配对**（哪一题赢、平、输），不看总分差——分母小的时候一分就是几个点，
那是噪声（P1c 的原话）。
"""
import json
import pathlib

# 期望源出现在返回集合里就算命中，**刻意不看排名**：引擎要的是「手里有没有这份材料」。
DEFAULT_GOLDEN = (
    pathlib.Path(__file__).resolve().parents[2] / "evals" / "retrieval" / "gather.jsonl"
)


def load_golden(path=None) -> list[dict]:
    """读金标题。坏行**当场抛**（缺 topic / 缺 required / 有重复）——这是尺子的尺子。"""
    p = pathlib.Path(path) if path else DEFAULT_GOLDEN
    out: list[dict] = []
    for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError as e:
            raise ValueError(f"{p.name} 第 {i} 行不是 JSON：{e}") from e
        topic = str(row.get("topic") or "").strip()
        required = [str(s).strip() for s in (row.get("required") or []) if str(s).strip()]
        if not topic:
            raise ValueError(f"{p.name} 第 {i} 行没有 topic")
        if not required:
            raise ValueError(f"{p.name} 第 {i} 行没有 required——那这一题就没法量覆盖率")
        if len(set(required)) != len(required):
            raise ValueError(f"{p.name} 第 {i} 行 required 里有重复")
        out.append(
            {
                "id": str(row.get("id") or f"g{i:02d}"),
                "topic": topic,
                "required": required,
                "tag": str(row.get("tag") or ""),
                "note": str(row.get("note") or ""),
            }
        )
    if not out:
        raise ValueError(f"{p.name} 是空的")
    return out


def sources_of(hits: list | None) -> list[str]:
    """检索结果 → **去重后的源清单**（保持第一次出现的顺序）。Pure。

    引擎要材料要的是「哪几份」，不是「哪几块」——同一个文件被切成 8 块捞回来只算一份。
    """
    out: list[str] = []
    for h in hits or []:
        if not isinstance(h, dict):
            continue
        s = str(h.get("source") or "").strip()
        if s and s not in out:
            out.append(s)
    return out


def coverage(got: list | None, required: list | None) -> dict:
    """这一题攒得全不全。Pure。`full` = 整题凑齐（差一份就不是完整材料）。"""
    want = [str(s) for s in (required or [])]
    have = set(sources_of(got))
    hits = [s for s in want if s in have]
    return {
        "total": len(want),
        "hit": len(hits),
        "ratio": round(len(hits) / len(want), 4) if want else 0.0,
        "full": bool(want) and len(hits) == len(want),
        "missing": [s for s in want if s not in have],
        "distinct": len(have),
    }


def summarize(rows: list | None) -> dict:
    """一批题 → 一张表。Pure。**不做配对**（配对在 `pair` 里，两件事分开）。"""
    rows = [r for r in (rows or []) if isinstance(r, dict)]
    n = len(rows)
    if not n:
        return {
            "tasks": 0,
            "coverage": 0.0,
            "full_rate": 0.0,
            "distinct": 0.0,
            "seconds": 0.0,
            "calls": 0,
        }
    return {
        "tasks": n,
        "coverage": round(sum(float(r.get("ratio") or 0) for r in rows) / n, 4),
        "full_rate": round(sum(1 for r in rows if r.get("full")) / n, 4),
        "distinct": round(sum(float(r.get("distinct") or 0) for r in rows) / n, 2),
        "seconds": round(sum(float(r.get("seconds") or 0) for r in rows), 1),
        "calls": int(sum(int(r.get("calls") or 0) for r in rows)),
    }


def pair(a_rows: list | None, b_rows: list | None) -> dict:
    """两臂**同题配对**（按 id 对齐）：覆盖率更高的赢。Pure。

    平局 = 覆盖率一样（含两臂都满、或都没找到）。两臂题目对不上时**当场抛**——
    那种输入配出来的东西没人能解释（与 `collab_eval.pair_reps` 同一条纪律）。
    """
    from app.core.stats import sign_test_p

    a = {str(r.get("id")): r for r in (a_rows or []) if isinstance(r, dict)}
    b = {str(r.get("id")): r for r in (b_rows or []) if isinstance(r, dict)}
    if set(a) != set(b):
        raise ValueError(
            f"两臂的题不一样：只在 A {sorted(set(a) - set(b))}，只在 B {sorted(set(b) - set(a))}"
        )
    win = loss = tie = 0
    detail: list[str] = []
    for i in sorted(a):
        x = float(a[i].get("ratio") or 0)
        y = float(b[i].get("ratio") or 0)
        if x == y:
            tie += 1
            detail.append(f"{i} 平({x:g})")
        elif y > x:
            win += 1
            detail.append(f"{i} B 更全({x:g}→{y:g})")
        else:
            loss += 1
            detail.append(f"{i} B 更差({x:g}→{y:g})")
    return {"win": win, "loss": loss, "tie": tie, "p": sign_test_p(win, loss), "detail": detail}


def validate(golden: list | None, corpus: list | None) -> list[str]:
    """金标 vs **索引里真有的源** → 问题清单（空 = 合格）。Pure。

    **为什么要这一道**：`required` 里写错一个路径，那一题的覆盖率永远到不了 1——而报告上只会
    显示「这一题没凑齐」，读起来像检索不行。**声明的期望必须有人读得到**，这与 §0 第 3 条
    「`--dry` 要能查出『声明了没人读的期望』」是同一条纪律。
    """
    have = {str(s).strip() for s in (corpus or [])}
    if not have:
        return ["索引里一个源都没有——先跑一次索引，或在有语料的库上跑"]
    problems: list[str] = []
    for row in golden or []:
        missing = [s for s in row["required"] if s not in have]
        if missing:
            problems.append(f"{row['id']}：required 里有索引里不存在的源 {missing}")
    return problems
