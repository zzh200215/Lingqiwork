"""并行跑全量测试：一文件一进程（与 run_tests.py 同样的隔离），但同时跑 6 个。

`run_tests.py` 是串行的，本机 75 个文件约 13 分钟；这里只改「同时跑几个」，隔离语义不变。
每个子进程有自己的 TEMP（进程号区分），互不干扰。
"""
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = HERE / ".tmp-test"
BASE.mkdir(parents=True, exist_ok=True)
WORKERS = int(os.environ.get("WB_TEST_WORKERS", "6"))
pattern = sys.argv[1] if len(sys.argv) > 1 else "test_*.py"
only = None if any(ch in pattern for ch in "*?[") else pattern


def _env(tag: str) -> dict:
    base = BASE / f"w{tag}"
    base.mkdir(parents=True, exist_ok=True)
    e = dict(os.environ)
    e["TEMP"] = e["TMP"] = str(base)
    # 子进程把输出写成 UTF-8（父进程就是按 UTF-8 解的）。不设的话子进程按本地代码页
    # 写、父进程按 UTF-8 读，中文断言消息全成乱码——失败详情里最要紧的往往正是那句话。
    e["PYTHONIOENCODING"] = "utf-8"
    return e


def _run(f: Path) -> tuple[str, str]:
    t0 = time.monotonic()
    r = subprocess.run(
        [sys.executable, "-m", "pytest", str(f), "-q", "--no-header", "-p", "no:cacheprovider"],
        cwd=str(HERE),
        env=_env(f.stem[-8:]),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    # **收集阶段的失败重跑一次**（2026-09-17 加，理由是三次实测）：
    # `docs/testing.md` §4 记着同一形状挂过三次——`ERROR collecting test session` +
    # `FileNotFoundError: … 另一个测试模块在同级目录下开的 wb-* 临时目录`（对方的 atexit 把它
    # 删了）。它是跨进程的临时目录竞态，**与被测代码无关**，而且重跑一次就好。
    # 只对「一条测试都没跑起来」的收集失败重试，而且**在结果里写明 retried**——
    # 藏起来就成了第四种「偶发」，那不是这一处的目的。
    retried = ""
    if r.returncode != 0 and "error during collection" in (r.stdout or ""):
        t0 = time.monotonic()
        r = subprocess.run(
            [sys.executable, "-m", "pytest", str(f), "-q", "--no-header", "-p", "no:cacheprovider"],
            cwd=str(HERE),
            env=_env(f.stem[-8:]),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        retried = " [retried after a collection error]"
    tail = [ln for ln in r.stdout.strip().splitlines() if ln.strip()]
    last = tail[-1] if tail else ""
    secs = time.monotonic() - t0
    if r.returncode == 5:
        return f.name, f"SKIP ({secs:.0f}s){retried}"
    if r.returncode != 0:
        # **失败的那一份把尾巴一起带出来**：原来只留最后一行（"1 failed, 10 passed"），
        # 于是「哪条断言炸的」永远丢了——一次未复现的失败就只能靠再跑一遍全量去赌。
        # 复现命令、断言行、异常类型都在这 40 行里。
        #
        # 为什么从 20 加到 40（2026-09-17）：`test_pet_tools.py` 在**收集阶段**炸过一次
        # `FileNotFoundError: ... wb-ocr-…`，而最后 20 行只留下了 `pathlib/_abc.py in lstat`
        # 这一帧——**调用栈上层那几帧（谁 stat 的）正好被切掉**，于是那条线索废了。
        # 收集错误的关键帧在最上面，断言错误的关键帧在最下面，所以只能两头都留宽一点。
        detail = "\n".join(f"      | {ln}" for ln in tail[-40:])
        return f.name, f"FAIL ({secs:.0f}s){retried} :: {last[:120]}\n{detail}"
    return f.name, f"ok ({secs:.0f}s){retried} :: {last[:60]}"


def main() -> int:
    # 控制台是 GBK，而 pytest 的输出里可能有它编不出来的字节——真撞过一次：
    # `UnicodeEncodeError` 把 runner 自己干掉了（失败详情反而成了新的失败）。
    # 统一按 UTF-8 写：子进程也是 UTF-8（见 `_env`），于是重定向到文件、
    # 被别的工具读走时都不会再烂一层；**只把编不出来的字符降级，不吞内容。**
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - 老环境没有 reconfigure 就照旧
        pass
    if only:
        cand = [HERE / "tests" / only, HERE / "tests" / f"{only}.py"]
        files = [p for p in cand if p.exists()]
    else:
        files = sorted((HERE / "tests").glob(pattern))
    if not files:
        print(f"no test files match {pattern!r}")
        return 2

    print(f"{len(files)} files, {WORKERS} workers", flush=True)
    t0 = time.monotonic()
    failed: list[str] = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for name, line in pool.map(_run, files):
            print(f"  {name:44s} {line}", flush=True)
            if line.startswith("FAIL"):
                failed.append(name)
    mins = (time.monotonic() - t0) / 60
    if failed:
        print(f"\nFAILED {len(failed)}/{len(files)} in {mins:.1f}min: {', '.join(failed)}")
        return 1
    print(f"\nALL {len(files)} TEST FILES PASSED in {mins:.1f}min")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
