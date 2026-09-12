"""One-off smoke for V16 podcast streaming endpoint (scratch db, port 8786).

Validates fail-fast HTTP errors before the stream and the in-stream SSE
terminal done event when no provider is configured. Real stage-event flow
over HTTP is covered by the collab smoke's identical SSE serialization.
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
SCRATCH = BACKEND / ".smoke28"
BASE = "http://127.0.0.1:8786"
LOG = SCRATCH / "server.log"


def req(method: str, path: str, body: dict | None = None, timeout: int = 60):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=_WB_HEADERS,
        method=method,
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return resp, json.loads(resp.read())


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
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8786"],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        # fail-fast validation BEFORE the stream opens
        expect_error("POST", "/api/podcast/generate/stream", {"paths": []}, 400, "没有指定笔记")
        expect_error("POST", "/api/podcast/generate/stream", {"paths": ["ghost.md"]}, 400, "不存在")
        expect_error("POST", "/api/podcast/generate/stream", {"paths": ["x.md"], "host_voice": "bogus"}, 422)
        print("stream validation ok")

        # in-stream failure: no provider on the scratch db → SSE done ok:false
        note = BACKEND.parent / "vault" / "__smoke_v16__.md"
        note.write_text("# smoke\n\n流式进度冒烟。\n", encoding="utf-8")
        try:
            r = urllib.request.Request(
                BASE + "/api/podcast/generate/stream",
                data=json.dumps({"paths": ["__smoke_v16__.md"]}).encode(),
                headers=_WB_HEADERS,
                method="POST",
            )
            with urllib.request.urlopen(r, timeout=120) as resp:
                ctype = resp.headers.get("content-type", "")
                raw = resp.read().decode("utf-8")
            assert ctype.startswith("text/event-stream"), ctype
            events = []
            for block in raw.split("\n\n"):
                ev, data = "message", {}
                for line in block.split("\n"):
                    if line.startswith("event: "):
                        ev = line[7:]
                    elif line.startswith("data: "):
                        data = json.loads(line[6:])
                if data:
                    events.append((ev, data))
            assert events and events[-1][0] == "done", events
            done = events[-1][1]
            assert done["ok"] is False and "provider" in done.get("error", ""), done
            print(f"sse error path ok: {[e for e, _ in events]}")
        finally:
            note.unlink(missing_ok=True)

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
