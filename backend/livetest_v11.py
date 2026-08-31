"""Live test for V11 knowledge-graph RAG — happy path against the user's
REAL local Neo4j + real LLM extraction.

Prerequisite: fill the Neo4j password once (KB page → 知识图谱 → 保存并测试连接),
which stores it in data/config.json. This script then reads it (never prints).
It creates a scratch note in the vault, extracts entities/relations with the
real model, writes to Neo4j, and runs a retrieval.
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
SCRATCH = BACKEND / ".livetest11"
BASE = "http://127.0.0.1:8779"
NOTE = BACKEND.parent / "vault" / "notes" / "__kg_livetest__.md"

NOTE_MD = """# 工作台实测笔记

星尘计划是张三在 2026 年发起的个人知识管理项目，采用 FastAPI 和 SQLite 构建。
星尘计划使用了 ChromaDB 做向量检索。
张三的搭档李四负责 Neo4j 图数据库的部署。
"""


def req(method: str, path: str, body: dict | None = None, timeout: int = 300):
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
    raise SystemExit("backend never became healthy")


def main() -> None:
    import hashlib

    # password must already be configured (KB page → 知识图谱)
    with open(BACKEND.parent / "data" / "config.json", encoding="utf-8") as f:
        cfg = json.load(f)
    if not cfg.get("kg_password"):
        raise SystemExit("请先在知识库页「知识图谱」tab 填写 Neo4j 密码并保存，再运行本脚本")

    NOTE.parent.mkdir(parents=True, exist_ok=True)
    NOTE.write_text(NOTE_MD, encoding="utf-8")
    env = {
        **os.environ,
        "WB_DB_PATH": str(SCRATCH / "live.db"),
        "WB_CONFIG_PATH": str(BACKEND.parent / "data" / "config.json"),
    }
    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    log_file = SCRATCH / "server.log"
    with open(log_file, "w", encoding="utf-8") as lf:
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8779"],
            cwd=str(BACKEND),
            env=env,
            stdout=lf,
            stderr=subprocess.STDOUT,
        )
        try:
            wait_health()
            print("health ok")

            # enable the feature for the run
            req("PUT", "/api/settings/prefs", {"kg_enabled": True})
            st = req("GET", "/api/kg/status")
            assert st["ok"], f"Neo4j 连接失败：{st.get('error')}"
            print(f"neo4j connected · entities {st.get('entities')} / relations {st.get('relations')}")

            # wipe any previous run of this note, then extract just it
            before = st.get("entities") or 0
            r = req("POST", "/api/kg/build", {"max_files": 30})
            assert not r["failed"], r["failed"][:1]
            print(f"build ok: extracted {r['extracted']}, unchanged {r['unchanged']}")

            st2 = req("GET", "/api/kg/status")
            assert st2["entities"] > before, (before, st2)
            print(f"graph grew: entities {before} → {st2['entities']}")

            # retrieval must find entities we know are in the note
            found = 0
            for q in ("星尘计划是谁发起的", "李四负责什么数据库"):
                res = req("POST", "/api/kg/query", {"q": q})
                names = {e["name"] for e in res["entities"]}
                print(f"  q={q!r} → {sorted(names)[:6]}")
                found += bool({"星尘计划", "张三", "李四", "Neo4j"} & names)
            assert found >= 1, "retrieval never matched note entities"
            print("LIVE TEST PASS")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
            NOTE.unlink(missing_ok=True)
            tail = log_file.read_text(encoding="utf-8", errors="ignore")[-600:]
    if "LIVE TEST PASS" not in tail:
        print("server log tail:\n" + tail)
    shutil.rmtree(SCRATCH, ignore_errors=True)


if __name__ == "__main__":
    main()
