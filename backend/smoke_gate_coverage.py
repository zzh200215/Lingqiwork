"""质量门的**行覆盖**尺子：标准库自己数，不引入 pytest-cov。

方案 §2 P2 的验收里写着「**质量门纯函数 100% 单测覆盖**」。本环境没装 pytest-cov，
而为一个自检再拉一个依赖进来不划算——所以用标准库：`dis.findlinestarts` 收集「可执行行」，
`trace` 收集「真跑到的行」，两边一减就是漏的。

**只覆盖 `app/core/retrieval_gate.py` 这一个模块**，因为只有它对覆盖有硬要求（纯函数层，
是编排图的退路：图塌了它一行不动）。改了这个模块就跑一遍。

跑法：backend/.venv/Scripts/python.exe smoke_gate_coverage.py
免费、确定；退出码 0 = 满覆盖。
"""
import dis
import importlib
import sys
import trace
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "tests"))
try:  # gbk 控制台：见 docs/testing.md §5 末
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:  # noqa: BLE001
    pass

TARGET = "retrieval_gate.py"


def _executable_lines(code, acc: set[int]) -> None:
    """递归收集「会开始执行的行」（含函数体与模块级）。Pure。"""
    for _, lineno in dis.findlinestarts(code):
        if lineno:  # findlinestarts 会吐 None/0（人造条目），不是真行号
            acc.add(lineno)
    for const in code.co_consts:
        if hasattr(const, "co_code"):
            _executable_lines(const, acc)


def main() -> int:
    tracer = trace.Trace(count=1, trace=0)
    holder: dict = {}

    def runner():
        mod = importlib.import_module("app.core.retrieval_gate")
        tests = importlib.import_module("test_retrieval_gate")  # tests/ 已在 sys.path 上
        ran = []
        for name in sorted(dir(tests)):
            if name.startswith("test_"):
                getattr(tests, name)()
                ran.append(name)
        return mod, ran

    tracer.runfunc(lambda: holder.setdefault("r", runner()))
    mod, ran = holder["r"]

    executed = {
        lineno
        for (fname, lineno), n in tracer.results().counts.items()
        if fname.endswith(TARGET) and n
    }
    want: set[int] = set()
    src = Path(mod.__file__).read_text(encoding="utf-8")
    _executable_lines(compile(src, mod.__file__, "exec"), want)

    missing = sorted(want - executed)
    total = len(want)
    print(f"{TARGET}：跑了 {len(ran)} 条测试，可执行行 {total}，覆盖 {total - len(missing)}"
          f"（{(total - len(missing)) / total:.1%}）")
    if missing:
        print("未覆盖的行：")
        lines = src.splitlines()
        for ln in missing:
            print(f"  {ln:>4}: {lines[ln - 1].strip()[:90]}")
        return 1
    print("未覆盖的行：无 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
