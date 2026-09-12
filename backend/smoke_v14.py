"""One-off smoke test for V1.4 memory endpoints (scratch db on port 8766).

No LLM involved: checks prefs round-trip, memory add/edit/list with source,
semantic-dedup rejection path is unit-tested separately (embeddings faked).
"""
import os
import json
import sys
import time
import urllib.request

# --- API token: the smoke scripts are exactly the kind of
# external caller the guard exists for, so they present a token. Children
# inherit it because env dicts spread os.environ. ---
_WB_TOKEN = os.environ.setdefault("WB_API_TOKEN", "smoke-token")
_WB_HEADERS = {"Content-Type": "application/json", "X-WB-Token": _WB_TOKEN}

BASE = "http://127.0.0.1:8766"


def req(method: str, path: str, body: dict | None = None) -> dict:
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=_WB_HEADERS,
        method=method,
    )
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read())


def wait_health(seconds: int = 90) -> None:
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

    # automemory pref round-trip
    req("PUT", "/api/settings/prefs", {"automemory_enabled": True})
    prefs = req("GET", "/api/settings/prefs")
    assert prefs["automemory_enabled"] is True, prefs
    req("PUT", "/api/settings/prefs", {"automemory_enabled": False})
    assert req("GET", "/api/settings/prefs")["automemory_enabled"] is False
    print("automemory pref round-trip ok")

    # add -> list carries source; edit -> content changes
    req("POST", "/api/settings/memories", {"content": "烟测记忆：用户偏好深色主题"})
    rows = req("GET", "/api/settings/memories")
    target = next(r for r in rows if "深色主题" in r["content"])
    assert target["source"] == "manual", target
    req("PUT", f"/api/settings/memories/{target['id']}", {"content": "烟测记忆：用户偏好浅色主题"})
    rows = req("GET", "/api/settings/memories")
    target = next(r for r in rows if r["id"] == target["id"])
    assert "浅色主题" in target["content"], target
    req("DELETE", f"/api/settings/memories/{target['id']}")
    print("memory list/edit/delete ok")

    print("SMOKE PASS")


if __name__ == "__main__":
    sys.exit(main())
