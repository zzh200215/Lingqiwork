"""对质 drill：真实模型 + 真实索引跑一次「读题 → 取材料 → 扫冲突 → 成文」。

打印：读题结果（这次要比的是什么）、来源构成（你的材料 / 记忆 / 外部各几条）、
**扫描判定对不上的编号对**、以及每处冲突的两侧原句与「什么能定案」。
`--save` 把这次结果存进 `vault/conflicts/` 并立刻检索一次，验证回路的最后一跳真的闭上。

选的话题最好是**真有争议**的（市面上两派说法不同），否则扫描会正确地返回「没有对不上的」
——那是正常结果，但这个 drill 想看的是它**能**把冲突揪出来，所以零冲突会标 SKIP。

用法：
    python smoke_conflict.py
    python smoke_conflict.py "本地向量库 Chroma 和 Qdrant 该选哪个" --save

退出码：0 = 成文且报出了 ≥1 处冲突；1 = 没成文；2 = 成文了但一条来源都没引；
        3 = 成文了但扫描判定「没有对不上的」（话题可能本就没分歧）。
"""
import asyncio
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:  # 来源图标与中文在 GBK 控制台上会炸，先把它掰到 utf-8
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from app.core import conflict  # noqa: E402
from app.core.conflict import Report, Section  # noqa: E402

_ICON = {"kb": "📄", "memory": "🧠", "web": "🌐"}
DEFAULT_TOPIC = "Python 3.13 的 free-threading 现在能不能上生产"


async def main() -> int:
    topic = next((a for a in sys.argv[1:] if not a.startswith("--")), "").strip() or DEFAULT_TOPIC
    do_save = "--save" in sys.argv

    print("=" * 60)
    print(f"对质：{topic}")
    print("=" * 60)

    report: dict | None = None
    sources: list[dict] = []
    pairs: list[dict] = []
    async for ev, data in conflict.run(topic):
        if ev == "framing":
            print("  读题中…")
        elif ev == "frame":
            print("\n  读题结果（读错题整份对质就废了，所以这一节给人看）")
            print(f"    这次比的是：{data['subject']}")
            print(f"    检索式：{' / '.join(data['queries']) or '（没有）'}")
            print()
        elif ev == "gathering":
            print("  取材料（你的知识库 / 长期记忆 / 外部来源）…")
        elif ev == "sources":
            sources = data["sources"]
            kinds = Counter(s["kind"] for s in sources)
            print(f"  取到 {len(sources)} 条材料：" + "、".join(f"{k} {v}" for k, v in kinds.items()))
            for s in sources:
                print(f"    [{s['n']}] {_ICON.get(s['kind'], '📦')} {s['title']} — {s['ref']}")
        elif ev == "finding":
            print("  扫描：哪两处对不上…")
        elif ev == "writing":
            print("  成文中…")
        elif ev == "report":
            report = data
            pairs = list(data.get("pairs") or [])
            by_n = {s["n"]: s for s in sources}
            print()
            if pairs:
                print(f"  判定 {len(pairs)} 处对不上：")
                for p in pairs:
                    a, b = by_n.get(p["a_n"], {}), by_n.get(p["b_n"], {})
                    print(f"    [{p['a_n']}] {a.get('title', '?')} × [{p['b_n']}] {b.get('title', '?')} — {p['basis']}")
            else:
                print("  扫描判定：这批材料里没有对不上的。")
            print()
            print("-" * 60)
            print(f"# {data['title']}")
            for sec in data["sections"]:
                print(f"\n## {sec['heading']}\n{sec['body']}")
            print("-" * 60)
        elif ev == "error":
            print(f"  ✗ {data['message']}")
            print("SMOKE FAIL ❌（没成文）")
            return 1

    if report is None:
        print("SMOKE FAIL ❌（没有 report 事件）")
        return 1

    used = list(report["used"])
    by_kind = Counter(s["kind"] for s in sources if s["n"] in used)
    print(f"\n引用覆盖：用了 {len(used)}/{len(sources)} 条材料 → {used}")
    if by_kind:
        print("其中被引用的材料构成：" + "、".join(f"{k} {v}" for k, v in by_kind.items()))

    if do_save:
        rep = Report(
            title=report["title"],
            sections=[Section(**s) for s in report["sections"]],
            used=used,
        )
        saved = await conflict.save(rep, sources)
        print(f"\n已存：{saved['filename']}（{saved['chunks']} 个 chunk 进索引）")
        from app.core import indexer

        hits = await asyncio.to_thread(indexer.search_auto, report["title"], 5)
        found = [h for h in hits if str(h.get("source") or "").startswith("conflicts/")]
        if found:
            print(f"  ✓ 回路闭上：刚出的对质报告能被检索到（{found[0]['source']}）")
        else:
            print("  ⚠ 刚出的报告暂时没被检索到——watcher 可能还没跑完")

    # 先判「有没有报出冲突」，再判引用——零冲突那条路 used 本来就该是空的，
    # 顺序反了会把一个正常结果误报成「引用没生效」。
    if not pairs:
        print("\nSMOKE SKIP ⚠（扫描判定这批材料里没有对不上的——换个真有分歧的话题再跑；"
              "正向证明见联调 drill 里种下矛盾那一段）")
        return 3
    if not used:
        print("\nSMOKE FAIL ❌（报出了冲突，但一条来源都没引用——引用没生效）")
        return 2
    print("\nSMOKE PASS ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
