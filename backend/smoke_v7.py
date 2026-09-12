"""One-off smoke test for V7 sleep-time memory tidying (scratch db, port 8771).

Verifies: tidy status endpoint (disabled default), prefs round-trip actually
registers the nightly job (next_run becomes non-null), manual run against an
empty-ish memory set returns a report, and the report persists for the status
endpoint. No provider is configured in the scratch db, so any LLM merge would
report the provider error — either way the pipeline must stay ok-shaped.
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

# --- API token: the smoke scripts are exactly the kind of
# external caller the guard exists for, so they present a token. Children
# inherit it because env dicts spread os.environ. ---
_WB_TOKEN = os.environ.setdefault("WB_API_TOKEN", "smoke-token")
_WB_HEADERS = {"Content-Type": "application/json", "X-WB-Token": _WB_TOKEN}

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".smoke19"
BASE = "http://127.0.0.1:8771"


def req(method: str, path: str, body: dict | None = None) -> dict:
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=_WB_HEADERS,
        method=method,
    )
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read())


def wait_health(seconds: int = 120) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            req("GET", "/api/health")
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
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8771"],
        cwd=str(BACKEND),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        # 1. default: tidy off, nothing scheduled, no report
        st = req("GET", "/api/settings/memories/tidy")
        assert st["enabled"] is False and st["next_run"] is None and st["report"] == {}, st
        print("tidy status default off ok")

        # 2. prefs round-trip registers the nightly job for real
        req("PUT", "/api/settings/prefs", {"memory_tidy_enabled": True, "memory_tidy_time": "04:00"})
        st = req("GET", "/api/settings/memories/tidy")
        assert st["enabled"] is True and st["time"] == "04:00", st
        assert st["next_run"] and "T04:00" in st["next_run"], st
        print(f"schedule registered, next_run={st['next_run']}")

        # 3. manual run (no memories yet → noop report)
        rep = req("POST", "/api/settings/memories/tidy")
        assert rep["ok"] and rep["before"] == 0 and "message" in rep, rep

        # 4. with a couple of memories the endpoint still answers; report persists
        req("POST", "/api/settings/memories", {"content": "冒烟记忆：用户喜欢喝咖啡"})
        req("POST", "/api/settings/memories", {"content": "冒烟记忆：用户每周三早上跑步"})
        rep = req("POST", "/api/settings/memories/tidy")
        assert "ok" in rep and "ran_at" in rep and "clusters" in rep, rep
        st = req("GET", "/api/settings/memories/tidy")
        assert st["report"] == rep, (st["report"], rep)
        print(f"manual run ok (ok={rep['ok']}, clusters={rep.get('clusters')}, msg={rep.get('message', rep.get('error', ''))[:30]})")

        # 5. turning it off unregisters the job
        req("PUT", "/api/settings/prefs", {"memory_tidy_enabled": False})
        st = req("GET", "/api/settings/memories/tidy")
        assert st["enabled"] is False and st["next_run"] is None, st
        print("schedule unregistered ok")

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
