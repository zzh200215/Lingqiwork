"""Prompt 注册中心冒烟：离线导出全清单 + 完整性校验 + 延迟 import 验证。

零成本、零网络、不碰任何数据。用法：
    python smoke_prompts.py              # 打印清单 + 校验结果
    python smoke_prompts.py --out path   # 另存 Markdown 审阅文档

退出码：0 = 通过；1 = 有登记漂移（某模块 import 失败 / 某常量缺失）。
"""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.core.prompts import dump_markdown, inventory, summary  # noqa: E402


def _check_lazy_import() -> bool:
    """验证「import prompts 不触发业务模块加载」——这是注册中心不拖垮启动的关键。

    用子进程隔离：干净解释器里只 import app.core.prompts，然后确认 tutor 等
    业务模块没有被顺带加载。
    """
    probe = (
        "import sys; import app.core.prompts; "
        "loaded = [m for m in ('app.core.tutor','app.core.cards','app.core.providers',"
        "'app.core.tasks','app.core.kg') if m in sys.modules]; "
        "print('LEAK:' + ','.join(loaded) if loaded else 'CLEAN')"
    )
    r = subprocess.run([sys.executable, "-c", probe], cwd=str(Path(__file__).parent),
                       capture_output=True, text=True, timeout=60)
    out = (r.stdout or "").strip()
    return out == "CLEAN"


def main() -> int:
    out_path = None
    if "--out" in sys.argv:
        out_path = sys.argv[sys.argv.index("--out") + 1]

    items = inventory()
    missing = [f"{p.module}.{p.name}" for p in items if p.content is None]

    print("=" * 60)
    print(f"Prompt 注册中心 · {len(items)} 条命名提示词 + {summary()['inline']} 处内联")
    print("=" * 60)
    for p in items:
        status = "OK " if p.content is not None else "MISS"
        print(f"  [{status}] {p.module}.{p.name}  ({p.kind}, {len(p.content or '')}c, {p.sha})")
    print()

    lazy_ok = _check_lazy_import()
    print(f"延迟 import 验证：{'PASS（import prompts 零副作用）' if lazy_ok else 'FAIL（触发了业务模块加载）'}")
    print(f"登记漂移：{'无' if not missing else '有 -> ' + ', '.join(missing)}")
    print()

    if out_path:
        Path(out_path).write_text(dump_markdown(), encoding="utf-8")
        print(f"审阅文档已写出：{out_path}")
    else:
        print(dump_markdown())

    ok = not missing and lazy_ok
    print("\n" + ("SMOKE PASS ✅" if ok else "SMOKE FAIL ❌"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
