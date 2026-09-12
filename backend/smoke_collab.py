"""One-off smoke test for V14 agent collaboration (scratch db, port 8783).

HTTP-level guards + SSE error path (no provider on the scratch db). The real
two-agent review run is livetest_collab.py.
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
SCRATCH = BACKEND / ".smoke26"
BASE = "http://127.0.0.1:8783"
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


def post_sse(path: str, body: dict, timeout: int = 120) -> list[tuple[str, dict]]:
    """POST and parse the SSE stream into (event, data) pairs."""
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers=_WB_HEADERS,
        method="POST",
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    events: list[tuple[str, dict]] = []
    for block in raw.split("\n\n"):
        event, data = "message", {}
        for line in block.split("\n"):
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        if data or event != "message":
            events.append((event, data))
    return events


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
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8783"],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        # seed 2 agents + 1 conversation (model points at a nonexistent provider)
        a = req("POST", "/api/agents", {"name": "写手", "avatar": "✍️", "system_prompt": "你是写手"})
        b = req("POST", "/api/agents", {"name": "评审", "avatar": "🔍", "system_prompt": "你是评审"})
        conv = req("POST", "/api/conversations", {"model_id": "ghost/nonexistent"})
        print("agents + conversation seeded")

        # request validation
        expect_error("POST", "/api/agents/collab", {"conversation_id": conv["id"], "goal": "x", "agent_ids": [a["id"], b["id"]], "pattern": "brainstorm"}, 422)
        expect_error("POST", "/api/agents/collab", {"conversation_id": conv["id"], "goal": "  ", "agent_ids": [a["id"], b["id"]]}, 422)
        expect_error("POST", "/api/agents/collab", {"conversation_id": conv["id"], "goal": "x", "agent_ids": [a["id"]]}, 400, "协作需要")
        expect_error("POST", "/api/agents/collab", {"conversation_id": conv["id"], "goal": "x", "agent_ids": [a["id"], a["id"]]}, 400, "重复")
        expect_error("POST", "/api/agents/collab", {"conversation_id": conv["id"], "goal": "x", "agent_ids": [a["id"], 99999]}, 400, "不可用")
        expect_error("POST", "/api/agents/collab", {"conversation_id": 424242, "goal": "x", "agent_ids": [a["id"], b["id"]]}, 404)
        print("collab validation ok")

        # SSE error path: model resolution fails in-stream (no such provider)
        events = post_sse(
            "/api/agents/collab",
            {"conversation_id": conv["id"], "goal": "写一首关于本机的短诗", "agent_ids": [a["id"], b["id"]]},
        )
        kinds = [e for e, _ in events]
        assert "error" in kinds, kinds
        assert kinds[-1] == "done", kinds  # generator still terminates cleanly
        print("no-provider error event ok:", kinds)

        # user goal persisted even on failure; no assistant message yet
        detail = req("GET", f"/api/conversations/{conv['id']}")
        msgs = detail.get("messages") or []
        users = [m for m in msgs if m["role"] == "user"]
        assert len(users) == 1 and "短诗" in users[0]["content"], detail
        print("goal persisted ok")

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
