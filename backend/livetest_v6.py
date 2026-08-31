"""Live basic test for V6 (port 8770, real provider, db COPY).

Verifies end-to-end with a real model:
  1. skill index injection + skill_load tool loop + token capture (agent task)
  2. chat token capture (message row)
A desktop toast may pop for the agent task — that IS the feature under test.
"""
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8770"
SKILL_DIR = Path("D:/TP/A/skills/__live_v6__")

SKILL_MD = """---
name: live-v6
description: 冒烟问候技能：当任务要求使用本技能时，严格按正文执行
---

# 冒烟问候

执行本技能时，你必须在回复的第一行输出且仅输出：
技能加载成功：早上好，工作台！
然后不要再输出任何其他内容。
"""


def req(method: str, path: str, body: dict | None = None, timeout: int = 300) -> dict:
    p, _, qs = path.partition("?")
    p = urllib.request.quote(p, safe="/")
    r = urllib.request.Request(
        BASE + p + (("?" + qs) if qs else ""),
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read())


def wait_health(seconds: int = 120) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            req("GET", "/api/health", timeout=3)
            return
        except Exception:
            time.sleep(1)
    raise SystemExit("backend never became healthy")


def pick_model() -> str:
    for p in req("GET", "/api/settings/providers"):
        if p["enabled"] and p["models"]:
            return f"{p['name']}/{p['models'][0]}"
    raise SystemExit("no enabled provider in the copy")


def main() -> None:
    wait_health()
    model = pick_model()
    print(f"health ok, using model {model} (key never printed)")

    # ---- 1. agent task: skill_load loop + token capture ----
    shutil.rmtree(SKILL_DIR, ignore_errors=True)
    SKILL_DIR.mkdir(parents=True)
    (SKILL_DIR / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    task = req(
        "POST",
        "/api/tasks",
        {
            "name": "v6实测",
            "prompt": "请先调用 skill_load 工具加载技能 live-v6，然后严格遵循技能内容回复。",
            "cron": "0 12 * * *",
            "mode": "agent",
            "tools_enabled": True,
            "enabled": False,
            "model_id": model,
        },
    )
    try:
        result = req("POST", f"/api/tasks/{task['id']}/run")
        assert result["status"] == "ok", result
        assert "技能加载成功" in result["answer"], result["answer"]
        assert any(e["tool"] == "skill_load" for e in result["log"]), result["log"]
        assert (result.get("tokens_in") or 0) > 0 and (result.get("tokens_out") or 0) > 0, result
        print(f"agent task ok: skill_load called, tokens {result['tokens_in']}/{result['tokens_out']}")
    finally:
        req("DELETE", f"/api/tasks/{task['id']}")
        shutil.rmtree(SKILL_DIR, ignore_errors=True)

    # ---- 2. chat: token capture on the assistant message ----
    conv = req("POST", "/api/conversations", {"model_id": model})
    try:
        sse = urllib.request.Request(
            BASE + "/api/chat",
            data=json.dumps({"conversation_id": conv["id"], "content": "请只回复两个字：收到"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        done = False
        with urllib.request.urlopen(sse, timeout=180) as resp:
            for raw in resp.read().decode("utf-8", "ignore").split("\n\n"):
                if raw.startswith("event: done"):
                    done = True
                    break
                if raw.startswith("event: error"):
                    raise SystemExit(f"chat stream error: {raw}")
        assert done, "chat stream never completed"
        detail = req("GET", f"/api/conversations/{conv['id']}")
        assistant = [m for m in detail["messages"] if m["role"] == "assistant"][-1]
        assert (assistant.get("tokens_in") or 0) > 0 and (assistant.get("tokens_out") or 0) > 0, assistant
        print(f"chat ok: tokens {assistant['tokens_in']}/{assistant['tokens_out']}")
    finally:
        req("DELETE", f"/api/conversations/{conv['id']}")

    print("LIVE TEST PASS")


if __name__ == "__main__":
    sys.exit(main())
