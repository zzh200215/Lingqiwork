"""One entry point for the two heavier verification tiers (PLAN.md 第 9 节 验证节奏).

    T0  seconds   ad-hoc: run the one test file you just touched.
    T1  ~1-2 min  this script, no model calls:
                      backend/.venv/Scripts/python.exe verify.py
    T2  minutes   this script + a real provider + a running server:
                      backend/.venv/Scripts/python.exe verify.py drill
                      backend/.venv/Scripts/python.exe verify.py drill smoke_mcp
                      backend/.venv/Scripts/python.exe verify.py drill --all

Why one entry point: the whole point of batching verification is that a batch
ends with ONE command you can run without remembering which script covers what
and which of them still matter. Exit code is 0 only when every layer is green.
"""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
FRONTEND = HERE.parent / "frontend"

# The drills worth running at a block boundary: each starts its own scratch
# server (or, for smoke_integration, needs one already up) and exercises a real
# end-to-end path. Paths are relative to this file.
DRILLS = ["smoke_health.py", "smoke_mcp.py", "smoke_restore.py", "smoke_integration.py"]


def _venv_guard() -> bool:
    """PATH's `python` is not the venv (it lacks `anthropic`), which shows up as a
    collect-stage explosion that looks like broken code. Say so once, clearly."""
    try:
        import anthropic  # noqa: F401,PLC0415

        return True
    except ImportError:
        print(
            "!! this is not the backend venv python. Run with\n"
            "   backend/.venv/Scripts/python.exe verify.py",
            flush=True,
        )
        return False


def _run(cmd: list[str], cwd: Path) -> int:
    print(f"\n$ {' '.join(cmd)}   (cwd={cwd})", flush=True)
    t0 = time.monotonic()
    rc = subprocess.run(cmd, cwd=str(cwd)).returncode
    print(f"  -> exit {rc} in {time.monotonic() - t0:.1f}s", flush=True)
    return rc


def t1() -> int:
    """Full offline suite + the frontend gates. No model calls."""
    results: list[tuple[str, int]] = []

    results.append(("backend: run_tests.py (one process per file)", _run([sys.executable, "run_tests.py"], HERE)))

    npm = shutil.which("npm")
    if not npm:
        print("\n-- npm not on PATH: frontend gates SKIPPED", flush=True)
        results.append(("frontend: tsc / vitest / build", -1))
    else:
        results.append(("frontend: tsc -b --noEmit", _run([npm, "exec", "--", "tsc", "-b", "--noEmit"], FRONTEND)))
        results.append(("frontend: vitest", _run([npm, "test"], FRONTEND)))
        results.append(("frontend: build", _run([npm, "run", "build"], FRONTEND)))

    return _summary("T1 (offline: backend suite + frontend)", results)


def t2(only: list[str], run_all: bool) -> int:
    """Real-provider drills. Each starts its own sandbox server, except
    smoke_integration which talks to one that is already running."""
    names = sorted(p.name for p in HERE.glob("smoke_*.py")) if run_all else (only or DRILLS)
    env = {**os.environ, "WB_API_TOKEN": os.environ.get("WB_API_TOKEN", "smoke-token")}

    results: list[tuple[str, int]] = []
    for name in names:
        path = HERE / name
        if not path.exists():
            print(f"\n!! no such drill: {name}", flush=True)
            results.append((name, 1))
            continue
        print(f"\n{'=' * 60}\n>> {name}\n{'=' * 60}", flush=True)
        t0 = time.monotonic()
        rc = subprocess.run([sys.executable, str(path)], cwd=str(HERE), env=env).returncode
        print(f"  -> exit {rc} in {time.monotonic() - t0:.1f}s", flush=True)
        results.append((name, rc))

    return _summary("T2 (real-provider drills)", results)


def _summary(title: str, results: list[tuple[str, int]]) -> int:
    print("\n" + "=" * 60)
    print(title)
    print("=" * 60)
    failed = 0
    for name, rc in results:
        # -1 = skipped here (no npm); 3 = the drill ran but skipped a leg it could
        # not exercise (e.g. smoke_integration without a usable model).
        mark = {0: "PASS", -1: "SKIP", 3: "SKIP"}.get(rc, "FAIL")
        if rc not in (0, -1, 3):
            failed += 1
        print(f"  [{mark}] {name}")
    if failed:
        print(f"\n{failed} layer(s) FAILED")
    else:
        print("\nALL GREEN")
    return 1 if failed else 0


def main() -> int:
    if not _venv_guard():
        return 2
    args = sys.argv[1:]
    if not args:
        return t1()
    if args[0] == "drill":
        rest = args[1:]
        return t2([a for a in rest if not a.startswith("--")], "--all" in rest)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
