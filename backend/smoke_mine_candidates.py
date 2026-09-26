"""挖硬负样本的**工作台**：体检候选题 + 免费跑一遍检索 + 把读数写回候选文件（供人复核）。

     backend/.venv/Scripts/python.exe smoke_mine_candidates.py --dry        # 只体检，不读索引
     backend/.venv/Scripts/python.exe smoke_mine_candidates.py              # 免费一遍 + 写回
     backend/.venv/Scripts/python.exe smoke_mine_candidates.py --k 5 --no-write

**为什么要有它**（2026-09-24）：质量门要动运行点，先得有**硬负样本**——而 10 条不够
（`smoke_quality_gate.py` 末尾那节交叉验证量过：在这种样本量上挑阈值，挑出来的是噪声）。
挖法是 2026-09-23 那批定下的：**写候选题 → 免费跑一遍检索 → 没命中的才是 `bad`**
（命中的进 `good`）。这一步**不调任何模型**，只借本地 embedder 与现有索引，
与线上调同一个 `indexer.search_auto`。

**它不写金标**：候选留在 `evals/retrieval/candidates.jsonl`，人对完「期望源真是答案吗」
再决定入库（`golden.jsonl` 是**真值**，只有人能改）。写回的只有 `probe` 这一栏——
那是**读数**（什么时候、用什么方法量的、撞上了谁），复核时要在同一条上看见它。
`--dry` 免费且不碰文件：验证期望源在不在索引里、跟现有金标有没有重题。
"""
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:  # noqa: BLE001
        pass

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

CAND = HERE / "evals" / "retrieval" / "candidates.jsonl"
GOLD = HERE / "evals" / "retrieval" / "golden.jsonl"
TAGS = ("lexical", "paraphrase", "competing")  # `no_answer` 不用挖：它没有期望源

from app.core import evals, indexer  # noqa: E402


def load(path: Path) -> list[dict]:
    """读 jsonl：跳过空行与 `//` 注释行（与 `agent_eval.load_tasks` 同一条规矩）。坏行当场炸。"""
    out: list[dict] = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        text = line.strip()
        if not text or text.startswith("//"):
            continue
        try:
            out.append(json.loads(text))
        except ValueError as e:
            raise SystemExit(f"{path.name} 第 {i} 行不是合法 JSON：{e}") from e
    return out


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


def main() -> int:
    dry = "--dry" in sys.argv
    write = "--no-write" not in sys.argv and not dry
    k = 5
    if "--k" in sys.argv:
        k = int(sys.argv[sys.argv.index("--k") + 1])

    rows = load(CAND)
    gold_queries = {r.get("query") for r in load(GOLD)}
    print("=" * 92)
    print(f"候选题体检：{len(rows)} 条 · 指纹 {sha(CAND)}")
    print("=" * 92)

    problems: list[str] = []
    for i, r in enumerate(rows, 1):
        if not str(r.get("query") or "").strip():
            problems.append(f"  第 {i} 条：没有 query")
        if r.get("tag") not in TAGS:
            problems.append(f"  第 {i} 条：tag「{r.get('tag')}」不在 {TAGS} 里（no_answer 不用挖）")
        if not str(r.get("expected_source") or "").strip():
            problems.append(f"  第 {i} 条：没有 expected_source")
        if r.get("query") in gold_queries:
            problems.append(f"  第 {i} 条：与现有金标重题——{r.get('query')}")
    if problems:
        print("体检不通过：")
        print("\n".join(problems))
        return 1
    print("体检通过：字段齐、tag 合法、没有跟现有金标重题")
    if dry:
        print("（`--dry` 到此为止：没读索引、没写文件、没调模型）")
        return 0

    data = indexer.get_collection().get(include=["metadatas"])
    have = {(m or {}).get("source") for m in data["metadatas"]}
    print(f"索引：{len(have)} 个源")

    missing = [r for r in rows if r["expected_source"] not in have]
    if missing:
        print(f"\n⚠ 期望源不在索引里 {len(missing)} 条（这些不入库）：")
        for r in missing:
            print(f"  {r['expected_source']}  ← {r['query']}")
        return 1

    stamp = "smoke_mine_candidates.py"
    at = datetime.now().strftime("%Y-%m-%d %H:%M")
    for r in rows:
        hits = indexer.search_auto(r["query"], k)
        rank = evals._rank_of(r["expected_source"], hits)
        r["probe"] = {
            "by": stamp,
            "at": at,
            "k": k,
            "rank": rank,
            "top1": (hits[0]["source"] if hits else ""),
            "verdict": "hit" if rank else "miss",
        }

    hits_rows = [r for r in rows if r["probe"]["verdict"] == "hit"]
    miss_rows = [r for r in rows if r["probe"]["verdict"] == "miss"]
    print(f"\n免费一遍：命中 top-{k} 的 {len(hits_rows)} 条 · **没命中的（硬负样本候选）{len(miss_rows)} 条**")

    print("\n" + "=" * 92)
    print("硬负样本候选 —— 复核时判两件事：① `expected_source` 真是这句问话的答案吗")
    print("                        ② 挤掉它的那份**是不更像话，还是也是对的**（后者说明题出糊了）")
    print("=" * 92)
    for i, r in enumerate(miss_rows, 1):
        print(f"\n{i:>2}. 「{r['query']}」")
        print(f"    期望源 : {r['expected_source']}")
        print(f"    依据   : {str(r.get('note',''))[:150]}")
        print(f"    实测   : 没进 top-{k}；检索回来的是 {r['probe']['top1']}")

    print("\n" + "=" * 92)
    print(f"命中 top-{k} 的那些（会进 good；rank 越大越擦边，越值得看一眼）")
    print("=" * 92)
    for r in sorted(hits_rows, key=lambda x: -x["probe"]["rank"]):
        print(f"  rank {r['probe']['rank']}  [{r['tag']:<10}] {r['query'][:38]:<40} "
              f"{r['expected_source'][-56:]}")

    if write:
        CAND.write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8"
        )
        print(f"\n已把 probe 写回 {CAND.name}（新指纹 {sha(CAND)}）——`probe` 是读数，不是判决。")
    print("\nDONE（只是度量，不判对错）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
