"""复盘 drill：真实模型 + 真实记录跑一次「把散落的记录合成一篇『最近』」。

打印：四路各取到多少条、成文、以及落盘路径。
不需要 `--save`——复盘自成文就落 `vault/recap/` 并进索引（`run` 的最后一步）。

用法：
    python smoke_recap.py
    python smoke_recap.py --days 60

退出码：0 = 成文且至少引用了 1 条来源；1 = 没成文；2 = 成文了但一条都没引用。
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.core import recap  # noqa: E402


async def main() -> int:
    days = recap.DAYS
    if "--days" in sys.argv:
        i = sys.argv.index("--days")
        if i + 1 < len(sys.argv):
            days = int(sys.argv[i + 1])

    print("=" * 60)
    print(f"复盘：最近 {days} 天")
    print("=" * 60)

    report: dict | None = None
    sources: list[dict] = []
    saved: dict | None = None

    async for ev, data in recap.run(days=days):
        if ev == "gathering":
            print("  在翻你的记录（信念线 / 日记 / 最近动过的文件 / 学习画像 / 卡点）…")
        elif ev == "sources":
            sources = data["sources"]
            print(f"  取到 {len(sources)} 条记录：")
            for s in sources:
                print(f"    [{s['n']}] {s['kind']:8} {s['title']}")
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
        elif ev == "saved":
            saved = data
            print(f"\n已存：{data['filename']}（{data['chunks']} 个 chunk 进索引）")
        elif ev == "error":
            print(f"  ✗ {data['message']}")
            print("SMOKE FAIL ❌（没成文）")
            return 1

    if report is None:
        print("SMOKE FAIL ❌（没有 report 事件）")
        return 1

    used = list(report["used"])
    print(f"\n引用覆盖：用了 {len(used)}/{len(sources)} 条记录 → {used}")

    if saved:
        from app.core import indexer

        hits = await asyncio.to_thread(indexer.search_auto, report["title"], 5)
        found = [h for h in hits if str(h.get("source") or "").startswith("recap/")]
        if found:
            print(f"  ✓ 回路闭上：刚生成的复盘能被检索到（{found[0]['source']}）")
        else:
            print("  ⚠ 刚生成的复盘暂时没被检索到——watcher 可能还没跑完，或索引没更新")

    if not used:
        print("\nSMOKE FAIL ❌（成文了，但一条记录都没引用——引用没生效）")
        return 2
    print("\nSMOKE PASS ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
