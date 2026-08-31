"""One-off smoke test for V2.3 (run against a scratch db on port 8765).

Verifies over real HTTP: task CRUD round-trips new fields, /tasks/tools,
manual agent run (error path, run row), run-history endpoint, and the
watch trigger firing on a vault file change.
"""
import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8765"
VAULT_FILE = "D:/TP/A/vault/smoke-trigger-dir/hello.md"


def req(method: str, path: str, body: dict | None = None) -> dict:
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(r, timeout=120) as resp:
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

    # 1. CRUD round-trip of the new fields
    a = req(
        "POST",
        "/api/tasks",
        {
            "name": "烟测智能体",
            "prompt": "列出 vault 根目录文件并总结",
            "cron": "*/5 * * * *",
            "mode": "agent",
            "tool_whitelist": "vault_list_files, kb_search",
            "max_rounds": 8,
            "retry": 0,
            "trigger_kind": "cron",
        },
    )
    assert a["mode"] == "agent" and a["max_rounds"] == 8, a
    assert a["tool_whitelist"] == "vault_list_files, kb_search", a  # normalized form
    print("create agent task ok")

    b = req(
        "POST",
        "/api/tasks",
        {
            "name": "烟测下游",
            "prompt": "基于上游产出写一句话",
            "mode": "simple",
            "trigger_kind": "watch",
            "watch_path": "smoke-trigger-dir/",
        },
    )
    assert b["trigger_kind"] == "watch" and b["watch_path"] == "smoke-trigger-dir", b
    try:
        req("POST", "/api/tasks", {"name": "自环", "prompt": "x", "chain_next_id": 999999})
        raise SystemExit("chain to missing task should have failed")
    except Exception as e:
        assert "400" in str(e), e
    print("watch task + chain validation ok")

    # 2. tools endpoint
    tools = req("GET", "/api/tasks/tools")
    names = {t["name"] for t in tools}
    assert "vault_write_file" in names and "web_search" in names, names
    print(f"tools endpoint ok ({len(tools)} tools)")

    # 3. manual run of the agent task — no provider in the scratch db, so the
    # run must fail cleanly and still leave a history row with a log
    r = req("POST", f"/api/tasks/{a['id']}/run")
    assert r["status"] == "error" and r["run_id"] > 0, r
    assert "provider" in r["error"], r
    runs = req("GET", f"/api/tasks/{a['id']}/runs")
    assert len(runs) == 1 and runs[0]["status"] == "error" and runs[0]["trigger"] == "manual", runs
    print("manual run + run history ok")

    # 4. watch trigger: write a file into the watched dir → run fires
    import pathlib

    p = pathlib.Path(VAULT_FILE)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("smoke 触发文件", encoding="utf-8")
    deadline = time.time() + 45
    while time.time() < deadline:
        runs = req("GET", f"/api/tasks/{b['id']}/runs")
        if runs:
            break
        time.sleep(2)
    else:
        raise SystemExit("watch trigger never fired")
    assert runs[0]["trigger"] == "watch", runs[0]
    print("watch trigger ok")

    # 5. chain wiring survives the CRUD round-trip
    req("PUT", f"/api/tasks/{b['id']}", {"chain_next_id": a["id"]})
    b2 = req("GET", "/api/tasks")
    chained = next(t for t in b2 if t["id"] == b["id"])
    assert chained["chain_next_id"] == a["id"], chained
    print("chain field round-trip ok")

    print("SMOKE PASS")


if __name__ == "__main__":
    sys.exit(main())
