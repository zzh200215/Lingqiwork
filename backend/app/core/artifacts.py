"""Artifacts light execution: run AI-generated python/js code blocks locally.

Strictly opt-in (artifacts_enabled, default off): there is no real sandbox on
Windows for a single-user desktop app, so the consent boundary is the toggle
itself — the same trade-off Open Interpreter and friends make. When enabled,
each run gets a fresh throwaway working directory under data/artifacts/, a
hard subprocess timeout, and truncated stdout/stderr capture. Python runs
with the workbench's own venv (so the model's code can use its deps), js
runs with node when it is on PATH. HTML is never executed server-side — the
frontend previews it in a sandboxed iframe instead.
"""
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

from app.config import DATA_DIR
from app.core.prefs import load_config

ARTIFACTS_DIR = DATA_DIR / "artifacts"
MAX_CODE_CHARS = 30000
MAX_OUTPUT_BYTES = 200_000  # per stream; the head is kept
MAX_TIMEOUT = 120
LANGUAGES = ("python", "javascript", "html")


def enabled() -> bool:
    return bool(load_config().get("artifacts_enabled"))


def resolve_timeout(pref_value=None) -> int:
    try:
        t = int(pref_value if pref_value is not None else load_config().get("artifacts_timeout", 30))
    except (TypeError, ValueError):
        t = 30
    return max(1, min(MAX_TIMEOUT, t))


def _node_path() -> str | None:
    return shutil.which("node")


def status() -> dict:
    return {
        "enabled": enabled(),
        "timeout": resolve_timeout(),
        "python": sys.executable,
        "node": _node_path(),
        "languages": list(LANGUAGES),
    }


def run(code: str, language: str = "python", timeout: int | None = None) -> dict:
    """Execute code in a fresh temp cwd; returns captured output. Blocking.

    Raises PermissionError when the feature is off, ValueError on bad input.
    """
    if not enabled():
        raise PermissionError("轻执行未开启：请到设置页勾选「允许运行 AI 代码」")
    code = (code or "").strip()
    if not code:
        raise ValueError("代码为空")
    if len(code) > MAX_CODE_CHARS:
        raise ValueError(f"代码超过 {MAX_CODE_CHARS} 字上限")
    language = "javascript" if language in ("js", "node") else language
    if language not in ("python", "javascript"):
        raise ValueError(f"只支持运行 python / javascript（html 在前端沙箱预览）: {language}")
    if language == "javascript" and not _node_path():
        raise ValueError("本机没有安装 node，无法运行 JavaScript")
    t = resolve_timeout(timeout)

    if language == "python":
        cmd = [sys.executable, "main.py"]
    else:
        cmd = [_node_path(), "main.js"]

    run_dir = ARTIFACTS_DIR / f"run-{uuid.uuid4().hex[:12]}"
    run_dir.mkdir(parents=True, exist_ok=True)
    script = run_dir / ("main.py" if language == "python" else "main.js")
    script.write_text(code, encoding="utf-8")

    t0 = time.monotonic()
    timed_out = False
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(run_dir),
            capture_output=True,
            timeout=t,
        )
        exit_code = proc.returncode
        stdout, stderr = proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        timed_out = True
        exit_code = -1
        stdout = e.stdout or b""
        stderr = (e.stderr or b"") + f"\n[超过 {t} 秒被终止]".encode("utf-8")
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    result = {
        "ok": exit_code == 0 and not timed_out,
        "exit_code": exit_code,
        "timeout": timed_out,
        "stdout": _cap(stdout.decode("utf-8", "replace")),
        "stderr": _cap(stderr.decode("utf-8", "replace")),
        "elapsed_ms": elapsed_ms,
    }
    # throwaway cwd: best-effort cleanup, keep it when the run failed so the
    # user can inspect whatever the code wrote next to the script
    if result["ok"]:
        shutil.rmtree(run_dir, ignore_errors=True)
    else:
        result["run_dir"] = str(run_dir)
    return result


def _cap(text: str) -> str:
    if len(text.encode("utf-8", "replace")) <= MAX_OUTPUT_BYTES:
        return text
    cut = text[: MAX_OUTPUT_BYTES // 4]  # chars ≈ safe lower bound for bytes cap
    return cut + f"\n…[输出超过 {MAX_OUTPUT_BYTES // 1024}KB 已截断]"
