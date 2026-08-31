"""One-off smoke test for V11 knowledge-graph RAG (scratch db, port 8778).

Runs against the user's REAL local Neo4j (auth-enabled, wrong password) to
verify graceful failure: status reports disconnected, config test surfaces
the auth error as 502, build/query fail fast. Happy-path graph writes are
covered by unit tests + livetest_v11 (needs the real password).
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
SCRATCH = BACKEND / ".smoke23"
BASE = "http://127.0.0.1:8778"


def req(method: str, path: str, body: dict | None = None, timeout: int = 60):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read())


def wait_health(seconds: int = 180) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            req("GET", "/api/health", timeout=3)
            return
        except Exception:
            time.sleep(1)
    raise SystemExit("backend never became healthy")


def main() -> None:
    env = {
        **os.environ,
        "WB_DB_PATH": str(SCRATCH / "smoke.db"),
        "WB_CONFIG_PATH": str(SCRATCH / "config.json"),
    }
    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8778"],
        cwd=str(BACKEND),
        env=env,
        stdout=open(SCRATCH / "server.log", "w", encoding="utf-8"),
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        # 1. status: configured-but-unauthenticated → graceful disconnected
        st = req("GET", "/api/kg/status")
        assert st["enabled"] is False and st["ok"] is False and st["error"], st
        print(f"status graceful ok (error: {st['error'][:60]}…)")

        # 2. config test with a wrong password against the real Neo4j → 502
        try:
            req("PUT", "/api/kg/config", {"uri": "bolt://localhost:7687", "user": "neo4j", "password": "definitely-wrong", "enabled": True})
            raise SystemExit("wrong password should have failed")
        except urllib.error.HTTPError as e:
            assert e.code == 502, e.code
            assert "Neo4j 连接失败" in e.read().decode("utf-8", "ignore")
        print("wrong-password config surfaces real Neo4j error ok")

        # 3. enabled was saved even though the test failed; build must fail fast
        st = req("GET", "/api/kg/status")
        assert st["enabled"] is True and st["ok"] is False, st
        try:
            req("POST", "/api/kg/build", {"max_files": 2})
            raise SystemExit("build with broken connection should fail")
        except urllib.error.HTTPError as e:
            assert e.code == 502, e.code
        try:
            req("POST", "/api/kg/query", {"q": "测试"})
            raise SystemExit("query with broken connection should fail")
        except urllib.error.HTTPError as e:
            assert e.code == 502, e.code
        print("build/query fail fast on broken connection ok")

        print("SMOKE PASS")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(SCRATCH, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
