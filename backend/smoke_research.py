"""研究 drill：真实模型 + 真实网络跑一次「搜 → 读 → 成文」，回答验收的第一问。

打印：检索式计划、来源数（其中你自己的材料几条、是否被引用）、引用覆盖。
`--save` 会把这次结果存进 `vault/research/` 并立刻检索一次，验证回路的最后一跳
（「下次先捞你自己的」）真的闭上——存进去的东西能被 `indexer.search_auto` 捞回来。

用法：
    python smoke_research.py "Agentic RAG 现在的主流架构"
    python smoke_research.py "Agentic RAG 现在的主流架构" --save

退出码：0 = 成文且至少引用了 1 条来源；1 = 没成文；2 = 成文了但一条都没引用。
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.core import research  # noqa: E402
from app.core.research import ResearchReport, Section  # noqa: E402


def _icon(kind: str) -> str:
    return "📄" if kind == "kb" else "🌐"


async def main() -> int:
    topic = next((a for a in sys.argv[1:] if not a.startswith("--")), "").strip()
    do_save = "--save" in sys.argv
    if not topic:
        print('用法：python smoke_research.py "想搞懂的话题" [--save]')
        return 2

    print("=" * 60)
    print(f"研究：{topic}")
    print("=" * 60)

    report: dict | None = None
    sources: list[dict] = []
    async for ev, data in research.run(topic):
        if ev == "plan":
            print(f"  检索式：{data['queries']}")
        elif ev == "gathering":
            print("  检索知识库与网络…")
        elif ev == "round":
            miss = "、".join(data.get("missing") or []) or "（没说清）"
            print(f"  第 {data['round']} 轮：还缺 {miss} → 补搜 {data['queries']}")
        elif ev == "sources":
            sources = data["sources"]
            added = data.get("added")
            tail = f"，本轮又添 {added} 条" if added is not None else ""
            print(f"  取到 {len(sources)} 条材料（你自己的材料 {data['kb']} 条）{tail}：")
            for s in sources:
                print(f"    [{s['n']}] {_icon(s['kind'])} {s['title']} — {s['ref']}")
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
            print("SMOKE FAIL ❌（研究没成文）")
            return 1

    if report is None:
        print("SMOKE FAIL ❌（没有 report 事件）")
        return 1

    used = list(report["used"])
    kb_used = [s["n"] for s in sources if s["kind"] == "kb" and s["n"] in used]
    print(f"\n引用覆盖：用了 {len(used)}/{len(sources)} 条材料 → {used}")
    print(f"其中你自己的材料被引用 {len(kb_used)} 条 {'（✓ 对照了你自己的材料）' if kb_used else ''}")

    if do_save:
        rep = ResearchReport(
            title=report["title"],
            sections=[Section(**s) for s in report["sections"]],
            used=used,
        )
        saved = await research.save(rep, sources)
        print(f"\n已存：{saved['filename']}（{saved['chunks']} 个 chunk 进索引）")
        from app.core import indexer

        hits = await asyncio.to_thread(indexer.search_auto, report["title"], 5)
        found = [h for h in hits if str(h.get("source") or "").startswith("research/")]
        if found:
            print(f"  ✓ 回路闭上：刚存的笔记能被检索到（{found[0]['source']}）")
        else:
            print("  ⚠ 刚存的笔记暂时没被检索到——watcher 可能还没跑完，或索引没更新")

    if not used:
        print("\nSMOKE FAIL ❌（成文了，但一条来源都没引用——引用没生效）")
        return 2
    print("\nSMOKE PASS ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
