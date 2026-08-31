"""Live test for V16 podcast streaming progress (db copy, port 8787).

Real provider + real edge-tts through the SSE endpoint: asserts the stage
event flow (script → tts×N → assemble → done) arrives over HTTP and the
episode is real. Cleans up note + episode afterwards.
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
SCRATCH = BACKEND / ".live16"
BASE = "http://127.0.0.1:8787"
LOG = SCRATCH / "server.log"
NOTE = Path("D:/TP/A/vault/notes/__livetest_stream__.md")


def wait_health(seconds: int = 180) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            urllib.request.urlopen(BASE + "/api/health", timeout=3)
            return
        except Exception:
            time.sleep(1)
    print(LOG.read_text(encoding="utf-8", errors="ignore")[-2000:])
    raise SystemExit("backend never became healthy")


def main() -> None:
    real_db = Path("D:/TP/A/data/workbench.db")
    conn = sqlite3.connect(real_db)
    try:
        n = conn.execute("SELECT count(*) FROM provider_configs WHERE enabled = 1").fetchone()[0]
    finally:
        conn.close()
    if not n:
        raise SystemExit("没有已启用的 provider")

    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    shutil.copy2(real_db, SCRATCH / "live.db")
    env = {**os.environ, "WB_DB_PATH": str(SCRATCH / "live.db"), "WB_CONFIG_PATH": str(SCRATCH / "config.json")}
    logf = open(LOG, "w")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8787"],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    done: dict = {}
    try:
        wait_health()
        NOTE.parent.mkdir(parents=True, exist_ok=True)
        NOTE.write_text(
            "# 流式进度实测\n\n\n## 要点\n\n- 播客生成现在有逐步进度反馈。\n\n- 后端通过 SSE 推送写脚本、逐句配音、拼接三个阶段。\n\n- 用户体验上等待不再是黑箱。\n",
            encoding="utf-8",
        )

        r = urllib.request.Request(
            BASE + "/api/podcast/generate/stream",
            data=json.dumps({"paths": ["notes/__livetest_stream__.md"]}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        t0 = time.time()
        with urllib.request.urlopen(r, timeout=600) as resp:
            assert resp.headers.get("content-type", "").startswith("text/event-stream")
            raw = resp.read().decode("utf-8")
        took = time.time() - t0

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

        stages = [d.get("stage") for e, d in events if e == "stage"]
        assert stages[0] == "script" and stages[-1] == "assemble", stages
        tts_events = [d for d in (x[1] for x in events if x[0] == "stage") if d["stage"] == "tts"]
        assert tts_events and tts_events[0]["total"] >= 6, tts_events[:2]
        assert [d["index"] for d in tts_events] == list(range(1, len(tts_events) + 1))
        done = events[-1][1]
        assert events[-1][0] == "done" and done["ok"] is True, done
        assert done["turns"] == len(tts_events)
        wav = Path("D:/TP/A/data/podcasts") / done["file"]
        assert wav.exists() and wav.stat().st_size > 200_000
        print(f"stream ok in {took:.0f}s: stages={stages[0]}…tts×{len(tts_events)}…{stages[-1]} → done, {done['duration_sec']}s audio")
        print("LIVE PASS")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        logf.close()
        NOTE.unlink(missing_ok=True)
        # remove the episode created on the REAL data dir
        try:
            sys.path.insert(0, str(BACKEND))
            from app.core import podcast

            if done.get("id"):
                podcast.delete(done["id"])
                print("episode cleaned up")
        except Exception as e:  # noqa: BLE001
            print("cleanup warning:", e)
        for _ in range(5):
            shutil.rmtree(SCRATCH, ignore_errors=True)
            if not SCRATCH.exists():
                break
            time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
