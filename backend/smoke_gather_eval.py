"""引擎侧检索尺子的壳：**攒材料攒得全不全**（`RAG升级.md` §3「P1 收口」留给 P2 的那笔欠账）。

     backend/.venv/Scripts/python.exe smoke_gather_eval.py --dry              # 免费：体检金标 + 语料
     backend/.venv/Scripts/python.exe smoke_gather_eval.py                    # 免费臂：单次检索（对照）
     backend/.venv/Scripts/python.exe smoke_gather_eval.py --strategy rewrite  # 付费：现役默认
     backend/.venv/Scripts/python.exe smoke_gather_eval.py --all --out data/gather.json

**它量的是取材那一步**（`compose.gather_inward` → `retriever.deep_search`），不是成品质量——
成品那把尺子是 `core/engine_eval.py`，别混。金标 `evals/retrieval/gather.jsonl`：每题的
`required` 是「一份完整材料必须包含的那几份源」，命中看集合、**不看排名**。

**为什么要钱的那两臂**：`single` 只搜原话（免费、确定），`rewrite` / `decompose` 是 P1c 的
查询策略（各多一次便宜模型调用）。P1c 在**文件级召回**那把尺子上量出「三档都没超过单次检索」，
但**没据此改引擎默认**——理由是那把尺子量的是「找一条准的」，而引擎要的是「攒一把全的」。
这个脚本就是把那句话量出来：**同一批题，两把尺子上的结论是不是一回事**。

退出码：0 = 跑完（指标好不好看表）；1 = 金标不合格 / 索引里没有那些源 / 没跑成。
"""
import asyncio
import json
import sys
import time
from pathlib import Path

# 这台机器的控制台默认 gbk：不显式设一次，一个 ✅ 就能让脚本死在最后一行。
# 长跑还要**行缓冲**：管道下 stdout 是块缓冲，收尾一炸整轮输出会全空（docs/testing.md §6.3）。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:  # noqa: BLE001
        pass

BACKEND = Path(__file__).parent
sys.path.insert(0, str(BACKEND))

from app.core import gather_eval as ge  # noqa: E402

DEFAULT_OUT = BACKEND.parent / "data" / "gather_eval.json"
FREE = "single"  # 不花模型钱的对照臂
PAID = ("rewrite", "decompose")


def _arg(name: str, default: str = "") -> str:
    if name not in sys.argv:
        return default
    i = sys.argv.index(name)
    return sys.argv[i + 1] if len(sys.argv) > i + 1 else default


def _corpus() -> list[str]:
    """索引里真有的源清单（免费、只读 Chroma，不加载模型）。"""
    import chromadb

    from app.config import settings

    client = chromadb.PersistentClient(path=str(settings.chroma_path))
    names = [c.name for c in client.list_collections()]
    if not names:
        return []
    col = client.get_collection(names[0])
    got = col.get(limit=5000, include=["metadatas"])
    return sorted({str((m or {}).get("source") or "") for m in got.get("metadatas") or [] if m})


async def _arm(strategy: str, topic: str) -> tuple[list[dict], int]:
    """跑一臂 → (命中, 调了几次模型)。**免费臂不碰模型**。"""
    from app.core import retriever

    k = int(_arg("--k", "6"))
    if strategy == FREE:
        hits = await asyncio.to_thread(retriever.search_multi, [topic], k)
        return hits or [], 0
    hits = await retriever.deep_search(topic, k, strategy=strategy)
    # 一臂 = 一次生成（rewrite 出几条变体 / decompose 出几个子问题），生成失败会退回原话；
    # 这里**不猜**它内部调了几次，只记「这一臂要一次生成」这个事实。
    return hits or [], 1


async def _run(strategy: str, golden: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for item in golden:
        t0 = time.time()
        try:
            hits, calls = await _arm(strategy, item["topic"])
            err = ""
        except Exception as e:  # noqa: BLE001 - 一题挂了不该毁掉整轮
            hits, calls, err = [], 0, f"{type(e).__name__}: {e}"
        cov = ge.coverage(hits, item["required"])
        row = {"id": item["id"], "topic": item["topic"], "tag": item["tag"], **cov,
               "seconds": round(time.time() - t0, 1), "calls": calls, "error": err}
        rows.append(row)
        mark = "✅" if cov["full"] else ("~" if cov["hit"] else "✗")
        # 缺的是谁要说清楚：只印 basename 时，「index.md」这种重名根本分不出是哪一章
        miss = (
            "  缺：" + "、".join("/".join(x.split("/")[-3:]) for x in cov["missing"])
            if cov["missing"]
            else ""
        )
        print(f"  {mark} {cov['hit']}/{cov['total']} {item['id']:<6} {item['topic'][:38]}"
              f"（{row['seconds']}s）{miss}", flush=True)
    return rows


def _table(arms: dict[str, list[dict]]) -> None:
    print("\n" + "=" * 78)
    print("攒材料的覆盖率（命中看集合，不看排名）")
    print("=" * 78)
    print(f"{'臂':<12}{'覆盖率':>8}{'整题凑齐':>10}{'平均份数':>10}{'秒':>8}{'生成次数':>10}")
    for name, rows in arms.items():
        s = ge.summarize(rows)
        print(
            f"{name:<12}{s['coverage']:>8.4f}{s['full_rate']:>10.0%}{s['distinct']:>10.2f}"
            f"{s['seconds']:>8.1f}{s['calls']:>10d}"
        )


def _pairing(arms: dict[str, list[dict]]) -> None:
    if FREE not in arms:
        return
    for name, rows in arms.items():
        if name == FREE:
            continue
        try:
            d = ge.pair(arms[FREE], rows)
        except ValueError as e:
            print(f"\n（{name} 配不了对：{e}）")
            continue
        print(
            f"\n同题配对 · {FREE} → {name}：胜 {d['win']} / 平 {d['tie']} / 负 {d['loss']}"
            f" · 符号检验双侧 p = {d['p']}"
        )
        print("    " + " · ".join(d["detail"]))
        print("    （平局 = 覆盖率一样：两臂都满、或都没找到）")


def main() -> int:
    # `--pair "臂A报告,臂B报告"`：**不花钱**，只读已落盘的报告做同题配对（照
    # `smoke_collab_eval.py --pair` 那个先例：多臂分几次跑，跑完再对起来）。
    if "--pair" in sys.argv:
        import glob as _glob

        pats = [p.strip() for p in _arg("--pair").split(",") if p.strip()]
        if len(pats) != 2:
            print('--pair 要两段 glob，用逗号分开（先 A 后 B），例：--pair "..\\data\\gather_single.json,..\\data\\gather_rewrite.json"')
            return 1
        arms: dict[str, list[dict]] = {}
        for label, pat in zip(("A", "B"), pats):
            paths = sorted({p for p in _glob.glob(pat)})
            if not paths:
                print(f"--pair 没匹配到报告：{pat!r}")
                return 1
            rows_all: list[dict] = []
            names: list[str] = []
            for p in paths:
                blob = json.loads(Path(p).read_text(encoding="utf-8"))
                for name, arm in (blob.get("arms") or {}).items():
                    names.append(name)
                    rows_all.extend(arm.get("rows") or [])
            arms[label] = rows_all
            print(f"{label} = {pat} → {len(paths)} 份报告 · 臂 {sorted(set(names))} · {len(rows_all)} 行")
        _table(arms)
        try:
            d = ge.pair(arms["A"], arms["B"])
        except ValueError as e:
            print(f"配不了对：{e}")
            return 1
        print(
            f"\n同题配对 A → B：胜 {d['win']} / 平 {d['tie']} / 负 {d['loss']}"
            f" · 符号检验双侧 p = {d['p']}"
        )
        print("    " + " · ".join(d["detail"]))
        print("    （平局 = 覆盖率一样：两臂都满、或都没找到）")
        return 0

    golden = ge.load_golden(_arg("--golden") or None)
    corpus = _corpus()
    problems = ge.validate(golden, corpus)
    print("=" * 78)
    print(f"引擎侧检索金标：{len(golden)} 题 · 索引里 {len(corpus)} 个源")
    print("=" * 78)
    if problems:
        print("金标不合格（这些题的期望源在索引里根本不存在——覆盖率永远到不了 1）：")
        for p in problems:
            print(f"  · {p}")
        return 1
    if "--dry" in sys.argv:
        tags: dict[str, int] = {}
        for g in golden:
            tags[g["tag"] or "?"] = tags.get(g["tag"] or "?", 0) + 1
        sizes: dict[int, int] = {}
        for g in golden:
            sizes[len(g["required"])] = sizes.get(len(g["required"]), 0) + 1
        print(f"体检通过：每题都有 topic 与 required，且**每一份期望源都在索引里**")
        print(f"类型分布：{tags}")
        print(f"每题要几份：{dict(sorted(sizes.items()))}")
        print(f"\n免费臂（{FREE}，不调模型）：smoke_gather_eval.py")
        print(f"付费臂：smoke_gather_eval.py --strategy rewrite|decompose（各多一次生成/题）")
        return 0

    only = [x for x in _arg("--only").split(",") if x.strip()]
    if only:
        golden = [g for g in golden if g["id"] in set(only)] or golden

    if "--all" in sys.argv:
        wanted = [FREE, *PAID]
    elif _arg("--strategy"):
        wanted = [_arg("--strategy")]
    else:
        wanted = [FREE]

    arms: dict[str, list[dict]] = {}
    for name in wanted:
        print(f"\n--- {name} ---", flush=True)
        arms[name] = asyncio.run(_run(name, golden))

    _table(arms)
    _pairing(arms)

    if "--no-save" not in sys.argv:
        out = Path(_arg("--out", str(DEFAULT_OUT)))
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {
                    "at": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "k": int(_arg("--k", "6")),
                    "golden": len(golden),
                    "arms": {name: {"summary": ge.summarize(rows), "rows": rows} for name, rows in arms.items()},
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        print(f"\n报告落盘：{out}")
    print("\nSMOKE PASS ✅（跑完了；结论看上面那张表与配对——**两把尺子分开读**）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
