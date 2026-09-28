"""只读孤儿盘点（方向 8 前置）：软引用指向已不存在的父行时报出来。

**为什么先盘后动**：SQLite 补 FK 要重建表、历史孤儿会挡迁移（方案 7.1-4），所以第一步
是拿事实——现在库里到底有没有孤儿、在哪几对关系上。**这条脚本只读**：不 UPDATE、不
DELETE、不建索引，盘点是给决策提供事实的，自己动手就变成第二份清理逻辑。

用法（backend 目录下）：

    .venv/Scripts/python.exe orphan_audit.py            # 全部关系，人读输出
    .venv/Scripts/python.exe orphan_audit.py --json     # 机读输出

- 退出码 0 = 无孤儿；1 = 有孤儿（CI/定时任务可以直接拿退出码当信号）。
- 两张有真 FK 的关系（messages→conversations、tutor_turns→tutor_sessions）也盘：
  `PRAGMA foreign_keys=ON` 管得住现在，管不住开关之前落下的历史行。
- 盘点范围刻意收敛在「删父行会留悬空引用」的关系上；纯派生/缓存表不在账。
"""
import argparse
import asyncio
import sys

# (子表, 子列, 父表)。父表一律 `id` 主键。
RELATIONS = [
    ("task_runs", "task_id", "tasks"),
    ("task_runs", "thread_id", "threads"),
    ("model_usage", "thread_id", "threads"),
    ("thread_items", "thread_id", "threads"),
    ("card_reviews", "card_id", "cards"),
    ("messages", "conversation_id", "conversations"),
    ("tutor_turns", "session_id", "tutor_sessions"),
]


async def audit() -> list[dict]:
    from sqlalchemy import text

    from app.db import SessionLocal

    out: list[dict] = []
    async with SessionLocal() as db:
        for child, col, parent in RELATIONS:
            rows = (
                await db.execute(
                    text(
                        f"SELECT c.{col}, COUNT(*) FROM {child} c "
                        f"LEFT JOIN {parent} p ON c.{col} = p.id "
                        f"WHERE c.{col} IS NOT NULL AND p.id IS NULL "
                        f"GROUP BY c.{col} ORDER BY c.{col} LIMIT 6"
                    )
                )
            ).all()
            total = (
                await db.execute(
                    text(
                        f"SELECT COUNT(*) FROM {child} c "
                        f"LEFT JOIN {parent} p ON c.{col} = p.id "
                        f"WHERE c.{col} IS NOT NULL AND p.id IS NULL"
                    )
                )
            ).scalar_one()
            out.append(
                {
                    "child": child,
                    "column": col,
                    "parent": parent,
                    "orphans": int(total or 0),
                    "samples": [r[0] for r in rows],
                }
            )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="只读孤儿盘点（方向 8 前置）")
    parser.add_argument("--json", action="store_true", help="机读输出（一行一关系）")
    args = parser.parse_args()

    try:
        results = asyncio.run(audit())
    except Exception as e:  # noqa: BLE001 - 盘点挂了要给明确信号，不是静默 0
        print(f"audit failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 2

    dirty = False
    for r in results:
        dirty = dirty or r["orphans"] > 0
        if args.json:
            print(*[f"{k}={v}" for k, v in r.items()], sep=" ")
        elif r["orphans"]:
            print(f"[有] {r['child']}.{r['column']} -> {r['parent']}: {r['orphans']} 行, 样例 {r['samples']}")
        else:
            print(f"[净] {r['child']}.{r['column']} -> {r['parent']}")
    if not dirty:
        print("无孤儿。")
    return 1 if dirty else 0


if __name__ == "__main__":
    sys.exit(main())
