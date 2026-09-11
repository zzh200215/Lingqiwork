"""One-off smoke test for V6 (scratch db on port 8769).

Skills: drop a temp folder into skills/, verify list/content/tool-spec, clean up.
Tasks: list includes running flag; dashboard exposes token/task stats; prefs
round-trip desktop_notify.
"""
import os
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path

# --- API token (PLAN §10.1 #6): the smoke scripts are exactly the kind of
# external caller the guard exists for, so they present a token. Children
# inherit it because env dicts spread os.environ. ---
_WB_TOKEN = os.environ.setdefault("WB_API_TOKEN", "smoke-token")
_WB_HEADERS = {"Content-Type": "application/json", "X-WB-Token": _WB_TOKEN}

BASE = "http://127.0.0.1:8769"
SKILL_DIR = Path("D:/TP/A/skills/__smoke_v6__")

SKILL_MD = """---
name: smoke-v6
description: 冒烟测试专用技能：验证技能发现与加载链路
---

# 冒烟技能

第一步：确认 SKILL.md 可被 skill_load 工具读取。
"""


def req(method: str, path: str, body: dict | None = None) -> dict:
    p, _, qs = path.partition("?")
    p = urllib.request.quote(p, safe="/")
    r = urllib.request.Request(
        BASE + p + (("?" + qs) if qs else ""),
        data=json.dumps(body).encode() if body is not None else None,
        headers=_WB_HEADERS,
        method=method,
    )
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read())


def wait_health(seconds: int = 120) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            req("GET", "/api/health")
            return
        except Exception:
            time.sleep(1)
    raise SystemExit("backend never became healthy")


def main() -> None:
    wait_health()
    print("health ok")

    # 1. skills discovery — write the folder directly (user-drop scenario)
    shutil.rmtree(SKILL_DIR, ignore_errors=True)
    SKILL_DIR.mkdir(parents=True)
    (SKILL_DIR / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    try:
        skills = req("GET", "/api/skills")["skills"]
        mine = next((s for s in skills if s["name"] == "__smoke_v6__"), None)
        assert mine and "冒烟测试专用技能" in mine["description"], mine

        content = req("GET", "/api/skills/content?name=__smoke_v6__")
        assert "skill_load" in content["content"], content["content"][:200]

        # skill_load must be exposed as a tool for the model
        tools = req("GET", "/api/tasks/tools")
        assert any(t["name"] == "skill_load" for t in tools), [t["name"] for t in tools]
        print("skills discover/content/tool-spec ok")
    finally:
        shutil.rmtree(SKILL_DIR, ignore_errors=True)
    assert not SKILL_DIR.exists()
    print("skills cleanup ok")

    # 2. install-from-URL validation (no network use — invalid scheme rejected)
    try:
        req("POST", "/api/skills/install", {"url": "ftp://example.com/SKILL.md"})
        raise SystemExit("ftp URL should have been rejected")
    except Exception as e:
        assert "400" in str(e) or "502" in str(e), e
    print("install validation ok")

    # 3. tasks: running flag present
    req("POST", "/api/tasks", {"name": "v6冒烟", "prompt": "x", "cron": "0 12 * * *"})
    tasks = req("GET", "/api/tasks")
    t = next(x for x in tasks if x["name"] == "v6冒烟")
    assert t["running"] is False, t
    req("DELETE", f"/api/tasks/{t['id']}")
    print("tasks running flag ok")

    # 4. prefs round-trip desktop_notify
    req("PUT", "/api/settings/prefs", {"desktop_notify": True})
    assert req("GET", "/api/settings/prefs")["desktop_notify"] is True
    print("desktop_notify pref ok")

    # 5. dashboard exposes the new stats
    stats = req("GET", "/api/dashboard")
    assert "tokens_total" in stats and "daily_tokens" in stats and "task_stats" in stats, list(stats)
    assert {"runs_30d", "ok", "error", "rate"} <= set(stats["task_stats"]), stats["task_stats"]
    print("dashboard stats ok")

    print("SMOKE PASS")


if __name__ == "__main__":
    sys.exit(main())
