"""产出 drill：真实模型 + 真实索引跑一次「翻你自己的材料 → 成文」。

打印：来源数与构成（知识库 / 长期记忆 / 日记各几条）、引用覆盖。
`--save` 把这次结果存进 `vault/notes/` 并立刻检索一次，验证回路的最后一跳
（「下次先捞你自己的」）真的闭上——存进去的东西能被 `indexer.search_auto` 捞回来。

用法：
    python smoke_compose.py "Agentic RAG 的评测"
    python smoke_compose.py "Agentic RAG 的评测" --save

退出码：0 = 成文且至少引用了 1 条来源；1 = 没成文；2 = 成文了但一条都没引用。
"""
import asyncio
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.core import compose  # noqa: E402
from app.core.compose import Report, Section  # noqa: E402

_ICON = {"kb": "📄", "memory": "🧠", "journal": "📔"}


async def main() -> int:
    topic = next((a for a in sys.argv[1:] if not a.startswith("--")), "").strip()
    do_save = "--save" in sys.argv
    if not topic:
        print('用法：python smoke_compose.py "想整理成一篇的话题" [--save]')
        return 2

    print("=" * 60)
    print(f"产出：{topic}")
    print("=" * 60)

    report: dict | None = None
    sources: list[dict] = []
    async for ev, data in compose.run(topic):
        if ev == "gathering":
            print("  翻你自己的材料（知识库 / 长期记忆 / 日记）…")
        elif ev == "sources":
            sources = data["sources"]
            kinds = Counter(s["kind"] for s in sources)
            print(f"  取到 {len(sources)} 条材料：" + "、".join(f"{k} {v}" for k, v in kinds.items()))
            for s in sources:
                print(f"    [{s['n']}] {_ICON.get(s['kind'], '📦')} {s['title']} — {s['ref']}")
        elif ev == "writing":
            print("  成文中…")
        elif ev == "report":
            report = data
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
        saved = await compose.save(rep, sources)
        print(f"\n已存：{saved['filename']}（{saved['chunks']} 个 chunk 进索引）")
        from app.core import indexer

        hits = await asyncio.to_thread(indexer.search_auto, report["title"], 5)
        found = [h for h in hits if str(h.get("source") or "").startswith("notes/")]
        if found:
            print(f"  ✓ 回路闭上：刚产出的笔记能被检索到（{found[0]['source']}）")
        else:
            print("  ⚠ 刚产出的笔记暂时没被检索到——watcher 可能还没跑完，或索引没更新")

    if not used:
        print("\nSMOKE FAIL ❌（成文了，但一条来源都没引用——引用没生效）")
        return 2
    print("\nSMOKE PASS ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
