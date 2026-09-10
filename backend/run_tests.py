"""Run backend tests one file per process (PLAN.md 第 9 节).

Every test file sets its own WB_DB_PATH, and the async engine binds the db file
at first import — so running several files in one pytest process silently
reuses the FIRST file's db. The suite's designed usage is one process per file;
this script makes that the default for local runs and CI instead of a
footnote everyone forgets.

Usage:
    uv run python run_tests.py                 # every tests/test_*.py
    uv run python run_tests.py test_tutor      # substring filter

Exit code 0 only when every file passes. Slower than one process, honest
instead.
"""
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    pattern = sys.argv[1] if len(sys.argv) > 1 else "test_*.py"
    if any(ch in pattern for ch in "*?["):
        files = sorted((HERE / "tests").glob(pattern))
    else:
        # 不带通配符：接受带或不带 .py 的文件名
        files = [p for p in ((HERE / "tests") / pattern, (HERE / "tests") / f"{pattern}.py") if p.exists()]
    if not files:
        print(f"no test files match {pattern!r} under tests/")
        return 2

    failed: list[str] = []
    skipped: list[str] = []
    t0 = time.monotonic()
    for i, f in enumerate(files, 1):
        print(f"\n[{i}/{len(files)}] {f.name}", flush=True)
        r = subprocess.run(
            [sys.executable, "-m", "pytest", str(f), "-q", "--no-header"],
            cwd=str(HERE),
        )
        # pytest exit 5 = collected no tests（如 test_websearch_*.py 这类
        # 非 pytest 形状的历史脚本）——按 SKIP 记，不算失败。
        if r.returncode == 5:
            skipped.append(f.name)
            print("  (no tests collected — skipped)")
        elif r.returncode != 0:
            failed.append(f.name)

    mins = (time.monotonic() - t0) / 60
    print("\n" + "=" * 56)
    if skipped:
        print(f"SKIPPED {len(skipped)} (no tests collected): {', '.join(skipped)}")
    if failed:
        print(f"FAILED {len(failed)}/{len(files)} in {mins:.1f}min: {', '.join(failed)}")
        return 1
    print(f"ALL {len(files) - len(skipped)} TEST FILES PASSED in {mins:.1f}min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
