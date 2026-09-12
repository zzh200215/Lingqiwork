"""One-off smoke test for V12 notes→podcast (scratch db, port 8780).

Guard-focused: list empty, input validation, no-provider failure, audio file
name guards, prefs round-trip. Real LLM+TTS generation is livetest_v12.
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

# --- API token: the smoke scripts are exactly the kind of
# external caller the guard exists for, so they present a token. Children
# inherit it because env dicts spread os.environ. ---
_WB_TOKEN = os.environ.setdefault("WB_API_TOKEN", "smoke-token")
_WB_HEADERS = {"Content-Type": "application/json", "X-WB-Token": _WB_TOKEN}

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".smoke24"
BASE = "http://127.0.0.1:8780"
LOG = SCRATCH / "server.log"


def req(method: str, path: str, body: dict | None = None, timeout: int = 60):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=_WB_HEADERS,
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


def expect_error(method: str, path: str, body: dict | None, code: int, needle: str = ""):
    try:
        req(method, path, body)
    except urllib.error.HTTPError as e:
        assert e.code == code, f"{method} {path}: expected {code}, got {e.code}: {e.read()[:200]}"
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
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8780"],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        # empty list on a fresh install
        r = req("GET", "/api/podcast")
        assert r == {"podcasts": []}, r
        print("empty list ok")

        # input validation
        expect_error("POST", "/api/podcast/generate", {"paths": []}, 400, "没有指定笔记")
        expect_error("POST", "/api/podcast/generate", {"paths": ["nope.md"]}, 400, "不存在")
        expect_error("POST", "/api/podcast/generate", {"paths": ["x.md"], "host_voice": "bogus"}, 422)
        print("generate validation ok")

        # no provider configured → friendly failure (scratch db has none).
        # VAULT_DIR is not env-overridable: use a temp note in the real vault
        # (project root /vault, i.e. ../vault relative to backend/)
        note = BACKEND.parent / "vault" / "__smoke_v12__.md"
        note.write_text("# smoke\n\n播客冒烟测试内容。\n", encoding="utf-8")
        try:
            expect_error("POST", "/api/podcast/generate", {"paths": ["__smoke_v12__.md"]}, 400, "provider")
        finally:
            note.unlink(missing_ok=True)
        print("no-provider guard ok")

        # audio file name guard + 404
        expect_error("GET", "/api/podcast/audio/bad-name.wav", None, 400)
        expect_error("GET", "/api/podcast/audio/pod-20990101-000000-abc123.wav", None, 404)
        expect_error("DELETE", "/api/podcast/pod-20990101-000000-abc123", None, 404)
        print("audio guards ok")

        # prefs round-trip + validation
        req("PUT", "/api/settings/prefs", {"podcast_host_voice": "zh-CN-YunjianNeural"})
        prefs = req("GET", "/api/settings/prefs")
        assert prefs["podcast_host_voice"] == "zh-CN-YunjianNeural", prefs
        assert prefs["podcast_guest_voice"] == "zh-CN-XiaoxiaoNeural", prefs
        expect_error("PUT", "/api/settings/prefs", {"podcast_guest_voice": "bogus"}, 422)
        print("podcast prefs round-trip + validation ok")

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
