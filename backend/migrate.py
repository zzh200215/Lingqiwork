"""迁移的 CLI（W6）：看看要跑什么、再决定跑不跑。

    backend/.venv/Scripts/python.exe migrate.py --status     # 这个库跑到哪一版了
    backend/.venv/Scripts/python.exe migrate.py --dry-run    # 只说要跑什么，一个字节都不写
    backend/.venv/Scripts/python.exe migrate.py              # 真跑（有待跑的会先自动备份）

应用启动时也会自动跑（`main.lifespan`）——这个脚本存在的理由是**先看看再跑**：
`--dry-run` 以前根本不存在，因为以前那版连「跑过哪些」都没有记录。
"""
import asyncio
import sys

sys.path.insert(0, ".")
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 - 老 Python 或被重定向时无所谓
    pass


async def main() -> int:
    from app.config import settings
    from app.core import migrations

    print(f"库：{settings.db_path}")
    if "--status" in sys.argv:
        st = await migrations.status()
        print(f"当前 v{st['current']} / 最新 v{st['head']}")
        for m in st["applied"]:
            print(f"  已应用 v{m['version']}  {m['name']}  （{m['at']}）")
        for m in st["pending"]:
            print(f"  待应用 v{m['version']}  {m['name']}")
        if not st["pending"]:
            print("  没有待跑的迁移")
        return 0

    dry = "--dry-run" in sys.argv
    out = await migrations.run(dry_run=dry)
    if not out["applied"]:
        print("没有待跑的迁移，什么都没做" + ("（dry-run）" if dry else ""))
        return 0
    for m in out["applied"]:
        print(f"  {'会跑' if dry else '已跑'} v{m['version']}  {m['name']}")
    if dry:
        print("dry-run：一个字节都没写")
    elif out["backup"]:
        print(f"迁移前备份：{out['backup']}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
