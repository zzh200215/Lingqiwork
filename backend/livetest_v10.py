"""Live check for V10 voice broadcast (scratch db, port 8777): the real
edge-tts network synthesis through the HTTP API. If Microsoft's endpoint is
unreachable the backend auto-falls back to local SAPI — reported, not fatal.
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".livetest10"
BASE = "http://127.0.0.1:8777"


def req(method: str, path: str, body: dict | None = None, timeout: int = 180):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(r, timeout=180) as resp:
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
    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    env = {
        **os.environ,
        "WB_DB_PATH": str(SCRATCH / "live.db"),
        "WB_CONFIG_PATH": str(BACKEND.parent / "data" / "config.json"),
    }
    log_file = SCRATCH / "server.log"
    with open(log_file, "w", encoding="utf-8") as lf:
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8777"],
            cwd=str(BACKEND),
            env=env,
            stdout=lf,
            stderr=subprocess.STDOUT,
        )
        try:
            wait_health()
            print("health ok")

            r = req(
                "POST",
                "/api/tts",
                {"text": "你好，我是你的个人工作台，今天有三条待办事项需要处理。"},
            )
            assert r["url"].endswith((".mp3", ".wav")), r
            with urllib.request.urlopen(BASE + r["url"], timeout=60) as resp:
                audio = resp.read()
            assert len(audio) > 10000, len(audio)
            if r["engine"] == "edge":
                assert audio[:3] == b"ID3" or audio[0] == 0xFF, "not an mp3 stream"
                print(f"edge-tts ok ({len(audio)} bytes mp3, cached={r['cached']})")
            else:
                print(f"NOTE: edge unreachable, fell back to local SAPI ({len(audio)} bytes)")
            print("LIVE TEST PASS")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
    tail = log_file.read_text(encoding="utf-8", errors="ignore")[-800:]
    if "LIVE TEST PASS" not in tail:
        print("server log tail:\n" + tail)
    shutil.rmtree(SCRATCH, ignore_errors=True)


if __name__ == "__main__":
    main()
