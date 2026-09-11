"""One-off smoke test for V13 artifacts light execution (scratch db, 8782).

Real subprocess runs (python + node) through the HTTP stack: opt-in guard,
success/failure/timeout paths, output truncation, prefs validation.
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# --- API token (PLAN §10.1 #6): the smoke scripts are exactly the kind of
# external caller the guard exists for, so they present a token. Children
# inherit it because env dicts spread os.environ. ---
_WB_TOKEN = os.environ.setdefault("WB_API_TOKEN", "smoke-token")
_WB_HEADERS = {"Content-Type": "application/json", "X-WB-Token": _WB_TOKEN}

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".smoke25"
BASE = "http://127.0.0.1:8782"
LOG = SCRATCH / "server.log"


def req(method: str, path: str, body: dict | None = None, timeout: int = 60):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=_WB_HEADERS,
        method=method,
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        print(f"!! {method} {path} -> {e.code}: {detail[:200]}")
        raise


def wait_health(seconds: int = 180) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            req("GET", "/api/health", timeout=3)
            return
        except Exception:
            time.sleep(1)
    print(LOG.read_text(encoding="utf-8", errors="ignore")[-2000:])
    raise SystemExit("backend never became healthy")


def expect_error(method: str, path: str, body: dict | None, code: int, needle: str = ""):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=_WB_HEADERS,
        method=method,
    )
    try:
        urllib.request.urlopen(r, timeout=60)
    except urllib.error.HTTPError as e:
        assert e.code == code, f"expected {code}, got {e.code}"
        if needle:
            assert needle in e.read().decode("utf-8", "ignore"), needle
        return
    raise SystemExit(f"{method} {path} should have failed with {code}")


def main() -> None:
    env = {
        **os.environ,
        "WB_DB_PATH": str(SCRATCH / "smoke.db"),
        "WB_CONFIG_PATH": str(SCRATCH / "config.json"),
    }
    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    logf = open(LOG, "w")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8782"],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        # opt-in: disabled by default
        st = req("GET", "/api/artifacts/status")
        assert st["enabled"] is False and st["node"], st
        expect_error("POST", "/api/artifacts/run", {"code": "print(1)"}, 403, "未开启")
        print("disabled-by-default guard ok")

        # enable
        req("PUT", "/api/settings/prefs", {"artifacts_enabled": True, "artifacts_timeout": 15})
        st = req("GET", "/api/artifacts/status")
        assert st["enabled"] is True and st["timeout"] == 15, st

        r = req("POST", "/api/artifacts/run", {"code": "print('smoke ok')"})
        assert r["ok"] and "smoke ok" in r["stdout"] and r["elapsed_ms"] < 30000, r
        print("python run ok")

        r = req("POST", "/api/artifacts/run", {"code": "console.log('js ok')", "language": "javascript"})
        assert r["ok"] and "js ok" in r["stdout"], r
        print("node run ok")

        r = req("POST", "/api/artifacts/run", {"code": "1/0"})
        assert not r["ok"] and r["exit_code"] == 1 and "ZeroDivisionError" in r["stderr"], r
        assert "run_dir" in r
        shutil.rmtree(r["run_dir"], ignore_errors=True)
        print("failure path ok")

        r = req("POST", "/api/artifacts/run", {"code": "import time; time.sleep(20)", "timeout": 2}, timeout=30)
        assert r["timeout"] is True and "被终止" in r["stderr"], r
        print("timeout kill ok")

        r = req("POST", "/api/artifacts/run", {"code": "print('y' * 600_000)"})
        assert len(r["stdout"]) < 400_000 and "截断" in r["stdout"], len(r["stdout"])
        print("output truncation ok")

        # guards + prefs validation
        expect_error("POST", "/api/artifacts/run", {"code": ""}, 400, "代码为空")
        expect_error("POST", "/api/artifacts/run", {"code": "print(1)", "language": "ruby"}, 422)
        expect_error("PUT", "/api/settings/prefs", {"artifacts_timeout": 500}, 422)
        print("validation ok")

        print("SMOKE PASS")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        logf.close()
        for _ in range(5):
            shutil.rmtree(SCRATCH, ignore_errors=True)
            if not SCRATCH.exists():
                break
            time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
