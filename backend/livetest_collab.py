"""Live test for V14 agent collaboration (db copy, port 8784).

Real provider, two real agents, review pattern end-to-end: SSE happy path,
transcript sections, conversation persistence. Cleans everything up.
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".live14"
BASE = "http://127.0.0.1:8784"
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


def post_sse(path: str, body: dict, timeout: int = 600) -> list[tuple[str, dict]]:
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    events = []
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


def main() -> None:
    real_db = Path("D:/TP/A/data/workbench.db")
    conn = sqlite3.connect(real_db)
    try:
        row = conn.execute(
            "SELECT name, models FROM provider_configs WHERE enabled = 1 ORDER BY id LIMIT 1"
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise SystemExit("没有已启用的 provider —— 先在设置页配置模型")
    model_id = f"{row[0]}/{json.loads(row[1])[0]}"
    print("using model:", model_id)

    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    shutil.copy2(real_db, SCRATCH / "live.db")
    conn = sqlite3.connect(SCRATCH / "live.db")
    try:
        conn.execute("UPDATE scheduled_tasks SET enabled = 0")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    finally:
        conn.close()

    env = {**os.environ, "WB_DB_PATH": str(SCRATCH / "live.db"), "WB_CONFIG_PATH": str(SCRATCH / "config.json")}
    logf = open(LOG, "w")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8784"],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    writer = reviewer = conv_id = None
    try:
        wait_health()
        print("health ok")

        writer = req("POST", "/api/agents", {"name": "__livetest写手__", "avatar": "✍️", "system_prompt": "你是简洁的写手，只用中文。"})
        reviewer = req("POST", "/api/agents", {"name": "__livetest评审__", "avatar": "🔍", "system_prompt": ""})
        conv = req("POST", "/api/conversations", {"model_id": model_id})
        conv_id = conv["id"]

        t0 = time.time()
        events = post_sse(
            "/api/agents/collab",
            {
                "conversation_id": conv_id,
                "goal": "用三句话介绍「星尘计划」：一个由张三在 2025 年发起的本地优先个人知识库项目，特点是 SQLite 存储和不上云。",
                "agent_ids": [writer["id"], reviewer["id"]],
                "pattern": "review",
            },
        )
        took = time.time() - t0
        kinds = [e for e, _ in events]
        assert kinds[0] == "meta" and kinds[-1] == "done", kinds
        assert "error" not in kinds, next(d for e, d in events if e == "error")
        meta = events[0][1]
        assert meta["pattern"] == "review" and len(meta["steps"]) == 3, meta
        done = events[-1][1]
        assert done["ok"] is True
        tr = done["transcript"]
        assert "评审回路" in tr and "初稿" in tr and "评审" in tr and "修订终稿" in tr, tr[:300]
        assert len(tr) > 300, len(tr)
        print(f"collab run ok in {took:.0f}s: 3 steps, transcript {len(tr)} chars")
        for line in tr.splitlines():
            if line.startswith("## "):
                print("  ", line)

        detail = req("GET", f"/api/conversations/{conv_id}")
        msgs = detail.get("messages") or []
        assert [m["role"] for m in msgs] == ["user", "assistant"], [(m["role"], m["content"][:20]) for m in msgs]
        assert "协作 · 评审回路" in msgs[1]["content"]
        print("persistence ok (goal + transcript saved)")

        print("LIVE PASS")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        logf.close()
        # cleanup created rows on the REAL db (agents + conversation);
        # the server is already terminated, so direct sqlite is the safe path
        import sqlite3 as s3

        conn = s3.connect(real_db)
        try:
            if writer:
                conn.execute("DELETE FROM agents WHERE id = ?", (writer["id"],))
            if reviewer:
                conn.execute("DELETE FROM agents WHERE id = ?", (reviewer["id"],))
            if conv_id:
                conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
                conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
            conn.commit()
        except s3.OperationalError as e:
            print("cleanup warning:", e)
        finally:
            conn.close()
        for _ in range(5):
            shutil.rmtree(SCRATCH, ignore_errors=True)
            if not SCRATCH.exists():
                break
            time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
