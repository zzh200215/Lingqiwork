"""Live test for V12 notes→podcast (db copy, port 8781).

Uses the REAL provider config from the user's db copy and the REAL edge-tts
network path: writes a throwaway note into the real vault, generates an
actual two-person podcast, verifies the WAV, then cleans everything up.

Requires at least one enabled provider; otherwise it exits with a hint.
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".live12"
BASE = "http://127.0.0.1:8781"
NOTE = Path("D:/TP/A/vault/notes/__podcast_livetest__.md")
LOG = SCRATCH / "server.log"

NOTE_TEXT = """# 星尘计划阶段复盘

## 背景
星尘计划由张三在 2025 年 3 月发起，目标是把团队散落在各处的实验数据统一到一套本地优先的工作台里。

## 关键决定
- 存储层选了 SQLite + 本地文件，不上云，原因是可以离线工作且没有账号体系负担。
- 李四负责数据库 schema，王五负责前端交互；两人每周同步一次。
- 第一版只做三个功能：笔记、检索、摘要生成。

## 目前的问题
- 检索延迟在笔记超过 2000 篇后明显上升，考虑加缓存。
- 团队反馈摘要质量不错，但希望支持中文分词的全文搜索。

## 下一步
计划在下个迭代把语音输入接进来，让通勤路上也能记录灵感。
"""


def req(method: str, path: str, body: dict | None = None, timeout: int = 60):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        print(f"!! {method} {path} -> {e.code}: {detail[:500]}")
        raise


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
    if not real_db.exists():
        raise SystemExit("real db not found")
    conn = sqlite3.connect(real_db)
    try:
        row = conn.execute(
            "SELECT count(*) FROM provider_configs WHERE enabled = 1"
        ).fetchone()[0]
    finally:
        conn.close()
    if not row:
        raise SystemExit("没有已启用的 provider —— 请先在设置里配好模型再跑 livetest")

    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    shutil.copy2(real_db, SCRATCH / "live.db")
    # disable scheduled jobs on the copy so nothing fires mid-test
    conn = sqlite3.connect(SCRATCH / "live.db")
    try:
        conn.execute("UPDATE scheduled_tasks SET enabled = 0")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # table may not exist on fresh dbs
    finally:
        conn.close()

    env = {
        **os.environ,
        "WB_DB_PATH": str(SCRATCH / "live.db"),
        "WB_CONFIG_PATH": str(SCRATCH / "config.json"),
    }
    logf = open(LOG, "w")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8781"],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        NOTE.parent.mkdir(parents=True, exist_ok=True)
        NOTE.write_text(NOTE_TEXT, encoding="utf-8")
        print("note seeded:", NOTE)

        t0 = time.time()
        r = req(
            "POST",
            "/api/podcast/generate",
            {"paths": ["notes/__podcast_livetest__.md"]},
            timeout=600,
        )
        took = time.time() - t0
        assert r.get("ok"), r
        assert r["turns"] >= 6, f"too few turns: {r['turns']}"
        assert r["duration_sec"] >= 15, f"too short: {r['duration_sec']}s"
        speakers = {t["speaker"] for t in r["script"]}
        assert speakers == {"host", "guest"}, speakers
        print(f"generated ok in {took:.0f}s: {r['turns']} turns, {r['duration_sec']}s, file={r['file']}")
        for t in r["script"][:4]:
            who = "主持人" if t["speaker"] == "host" else "嘉宾"
            print(f"  {who}: {t['text'][:60]}")

        with urllib.request.urlopen(BASE + f"/api/podcast/audio/{r['file']}", timeout=60) as resp:
            audio = resp.read()
        assert audio[:4] == b"RIFF" and len(audio) > 200_000, len(audio)
        print(f"audio served ok ({len(audio) // 1024} KB WAV)")

        listing = req("GET", "/api/podcast")
        assert any(p["id"] == r["id"] for p in listing["podcasts"]), "entry not in list"

        assert req("DELETE", f"/api/podcast/{r['id']}")["ok"]
        assert not any(p["id"] == r["id"] for p in req("GET", "/api/podcast")["podcasts"])
        print("delete ok")

        print("LIVE PASS")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        logf.close()
        NOTE.unlink(missing_ok=True)
        for _ in range(5):
            shutil.rmtree(SCRATCH, ignore_errors=True)
            if not SCRATCH.exists():
                break
            time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
