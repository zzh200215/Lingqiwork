"""One-off smoke for V15 podcast deepening (scratch db, port 8785).

Only HTTP surface is the new pref key; verifies it survives the settings
round-trip (save_config filters unknown keys — a missing _DEFAULTS entry
would silently drop it) and coexists with digest prefs.
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
SCRATCH = BACKEND / ".smoke27"
BASE = "http://127.0.0.1:8785"
LOG = SCRATCH / "server.log"


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
    print(LOG.read_text(encoding="utf-8", errors="ignore")[-2000:])
    raise SystemExit("backend never became healthy")


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
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8785"],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        req("PUT", "/api/settings/prefs", {"digest_enabled": True, "digest_time": "08:30", "podcast_daily_enabled": True})
        prefs = req("GET", "/api/settings/prefs")
        assert prefs["podcast_daily_enabled"] is True, prefs
        assert prefs["digest_enabled"] is True and prefs["digest_time"] == "08:30", prefs
        # default voices still intact on a fresh config
        assert prefs["podcast_host_voice"] == "zh-CN-YunxiNeural", prefs
        print("digest+podcast-daily prefs round-trip ok")

        # toggle back off — stored value must follow
        req("PUT", "/api/settings/prefs", {"podcast_daily_enabled": False})
        assert req("GET", "/api/settings/prefs")["podcast_daily_enabled"] is False
        print("toggle-off persists ok")

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
