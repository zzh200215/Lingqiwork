"""One-off smoke test for V10 voice broadcast (scratch db, port 8776).

No network needed: exercises the local SAPI engine through the real HTTP
stack, plus cache hit, guards, and prefs round-trip/validation.
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
SCRATCH = BACKEND / ".smoke22"
BASE = "http://127.0.0.1:8776"


def req(method: str, path: str, body: dict | None = None):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=_WB_HEADERS,
        method=method,
    )
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.loads(resp.read())


def wait_health(seconds: int = 180) -> None:
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
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8776"],
        cwd=str(BACKEND),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        vs = req("GET", "/api/tts/voices")
        assert "zh-CN-XiaoxiaoNeural" in vs["voices"] and {"edge", "sapi"} <= set(vs["engines"]), vs
        print(f"voices ok ({len(vs['voices'])} entries)")

        # local SAPI engine end-to-end (no network)
        r = req("POST", "/api/tts", {"text": "语音播报冒烟测试", "engine": "sapi"})
        assert r["engine"] == "sapi" and r["url"].endswith(".wav"), r
        with urllib.request.urlopen(BASE + r["url"], timeout=30) as resp:
            audio = resp.read()
        assert audio[:4] == b"RIFF" and len(audio) > 5000, len(audio)
        print(f"sapi synth ok ({len(audio)} bytes)")

        r2 = req("POST", "/api/tts", {"text": "语音播报冒烟测试", "engine": "sapi"})
        assert r2["cached"] is True and r2["url"] == r["url"], r2
        print("cache hit ok")

        try:
            req("POST", "/api/tts", {"text": ""})
            raise SystemExit("empty text should be rejected")
        except urllib.error.HTTPError as e:
            assert e.code == 400, e.code
        print("empty-text guard ok")

        req("PUT", "/api/settings/prefs", {"tts_auto": True, "tts_voice": "zh-CN-YunxiNeural", "tts_engine": "edge"})
        prefs = req("GET", "/api/settings/prefs")
        assert prefs["tts_auto"] is True and prefs["tts_voice"] == "zh-CN-YunxiNeural", prefs
        try:
            req("PUT", "/api/settings/prefs", {"tts_voice": "bogus"})
            raise SystemExit("bad voice should be rejected")
        except urllib.error.HTTPError as e:
            assert e.code == 422, e.code
        print("tts prefs round-trip + validation ok")

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
