"""Smoke test for 第0周使用基线 + 今日建议 (scratch db, port 8786).

Full HTTP loop on a throwaway db: the usage-visit endpoint is idempotent per
(page, day), the dashboard reports open_days_7d, and /api/today/next degrades to
an idle suggestion on an empty DB with no provider. No LLM anywhere.
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

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".smoke_usage"
BASE = "http://127.0.0.1:8786"
LOG = SCRATCH / "server.log"


def req(method: str, path: str, body: dict | None = None, timeout: int = 60):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"!! {method} {path} -> {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}")
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
        headers={"Content-Type": "application/json"},
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
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8786"],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        # visit is idempotent per (page, day) — the reload case is normal
        r = req("POST", "/api/usage/visit", {"page": "review"})
        assert r["recorded"] is True and r["day"], r
        r = req("POST", "/api/usage/visit", {"page": "review"})
        assert r["recorded"] is False, r
        # a second page still counts as the same open day
        r = req("POST", "/api/usage/visit", {"page": "chat"})
        assert r["recorded"] is True, r
        print("usage visit idempotent ok")

        expect_error("POST", "/api/usage/visit", {"page": "../../etc/passwd"}, 400, "未知页面")
        expect_error("POST", "/api/usage/visit", {}, 400, "未知页面")
        print("usage guards ok")

        days = req("GET", "/api/usage/open-days?days=7")
        assert len(days["open_days"]) == 1, days
        print("open_days rollup ok")

        # dashboard reports the open-day baseline
        dash = req("GET", "/api/dashboard")
        assert dash["open_days_7d"] == 1, dash
        print("dashboard open_days_7d ok")

        # empty DB, no provider -> idle suggestion, never a crash
        nxt = req("GET", "/api/today/next")
        assert nxt["tone"] == "idle", nxt
        assert nxt["action"]["kind"] == "make_card", nxt  # no cards at all yet
        assert "卡片" in nxt["text"], nxt
        print("today/next (empty db) ok")

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