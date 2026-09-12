"""Smoke test for habits (scratch db, port 8784).

Full HTTP loop on a throwaway db: seed, check/count tick semantics, idempotency,
untick, the auto habit deriving itself from a real card review, streaks, and every
guard. No LLM anywhere — habits never call a model.
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
SCRATCH = BACKEND / ".smoke_habits"
BASE = "http://127.0.0.1:8784"
LOG = SCRATCH / "server.log"


def req(method: str, path: str, body: dict | None = None, timeout: int = 60):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=_WB_HEADERS,
        method=method,
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"!! {method} {path} -> {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}")
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


def by_name(view: dict, name: str) -> dict:
    return next(h for h in view["habits"] if h["name"] == name)


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
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8784"],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        v = req("GET", "/api/habits/today")
        assert v["habits"] == [] and v["done"] == 0 and v["total"] == 0, v
        assert v["pending"] == [] and v["heatmap_days"] == 30, v
        print("empty view ok")

        # seeding is idempotent — an empty grid is what kills a daily page
        assert req("POST", "/api/habits/seed")["added"] == 3
        assert req("POST", "/api/habits/seed")["added"] == 0
        v = req("GET", "/api/habits/today")
        assert len(v["habits"]) == 3 and v["total"] == 3 and v["done"] == 0, v
        auto = by_name(v, "今日复习")
        assert auto["auto"] == "cards" and auto["done"] is False, auto
        print("seed ok (idempotent, auto habit present)")

        doc = by_name(v, "读技术文档")
        code = by_name(v, "写代码")
        assert doc["kind"] == "check" and code["kind"] == "count" and code["target"] == 30.0

        # check habit: tick sets 1, a second tick is a no-op (unique (habit,day))
        r = req("POST", f"/api/habits/{doc['id']}/tick")
        assert r["value"] == 1.0 and r["done"] is True, r
        r = req("POST", f"/api/habits/{doc['id']}/tick")
        assert r["value"] == 1.0, r
        v = req("GET", "/api/habits/today")
        assert v["done"] == 1 and by_name(v, "读技术文档")["streak"] == 1, v
        print("check tick + idempotency + streak ok")

        # count habit: accumulates, done only at target, overshoot clamped
        for _ in range(3):
            r = req("POST", f"/api/habits/{code['id']}/tick")
        assert r["value"] == 3.0 and r["done"] is False, r
        r = req("POST", f"/api/habits/{code['id']}/tick", {"value": 27})
        assert r["value"] == 30.0 and r["done"] is True, r
        r = req("POST", f"/api/habits/{code['id']}/tick", {"value": 9999})
        assert r["value"] == 90.0, r  # target * OVERSHOOT
        print("count tick + clamp ok")

        # untick clears the day — a mis-tap must always be undoable
        r = req("DELETE", f"/api/habits/{code['id']}/tick")
        assert r["ok"] and r["deleted"] == 1, r
        assert req("DELETE", f"/api/habits/{code['id']}/tick")["deleted"] == 0
        assert by_name(req("GET", "/api/habits/today"), "写代码")["value"] == 0.0
        print("untick ok")

        # the auto habit ticks itself off a REAL card review — this is the whole
        # reason the grid is non-empty on day one
        req(
            "POST",
            "/api/cards/batch",
            {
                "cards": [{"kind": "concept", "front": "什么是间隔复习", "back": "按遗忘曲线重排"}],
                "source": "notes/x.md",
                "source_label": "x",
                "origin": "manual",
            },
        )
        cid = req("GET", "/api/cards/queue")["fresh"][0]["id"]
        req("POST", f"/api/cards/{cid}/review", {"grade": 3})
        v = req("GET", "/api/habits/today")
        auto = by_name(v, "今日复习")
        assert auto["done"] is True and auto["streak"] == 1, auto
        assert v["done"] == 2, v
        print("auto habit derived from card_reviews ok")

        # an auto habit must never be tickable by hand, or the streak lies
        expect_error("POST", f"/api/habits/{auto['id']}/tick", {}, 400, "自动判定")
        print("auto habit is not hand-tickable ok")

        # guards
        expect_error("POST", f"/api/habits/{doc['id']}/tick", {"day": "2026/09/04"}, 400, "YYYY-MM-DD")
        expect_error("POST", "/api/habits/999999/tick", {}, 404)
        expect_error("POST", "/api/habits", {"name": ""}, 400, "名称")
        expect_error("POST", "/api/habits", {"name": "x", "weekdays": "111"}, 400, "7 位")
        expect_error("POST", "/api/habits", {"name": "x", "weekdays": "0000000"}, 400, "至少要选一天")
        expect_error("POST", "/api/habits", {"name": "x", "kind": "quiz"}, 400, "kind")
        expect_error("POST", "/api/habits", {"name": "x", "kind": "count", "target": 0}, 400, "目标")
        expect_error("PUT", f"/api/habits/{doc['id']}", {"weekdays": "abc"}, 400, "7 位")
        expect_error("PUT", "/api/habits/999999", {"name": "x"}, 404)
        print("validation ok")

        # weekday scheduling: a habit not due today is still listed but not counted
        other = req("POST", "/api/habits", {"name": "只在周日", "weekdays": "0000001"})
        v = req("GET", "/api/habits/today")
        row = by_name(v, "只在周日")
        assert len(v["habits"]) == 4, v  # 3 seeded + this one, all listed…
        assert v["total"] == (4 if row["scheduled"] else 3), v  # …but only today's counted
        print("weekday scheduling ok")

        # cap: 20 live habits max (a 40-row grid is a chore, not a tracker)
        for i in range(16):  # 4 live + 16 = 20
            req("POST", "/api/habits", {"name": f"填充{i}"})
        expect_error("POST", "/api/habits", {"name": "第 21 个"}, 400, "最多")
        print("habit cap ok")

        # archiving frees a slot and keeps history; deleting removes the logs
        req("PUT", f"/api/habits/{other['id']}", {"archived": True})
        req("POST", "/api/habits", {"name": "归档后腾出的位置"})
        r = req("DELETE", f"/api/habits/{doc['id']}")
        assert r["ok"]
        assert all(h["name"] != "读技术文档" for h in req("GET", "/api/habits/today")["habits"])
        expect_error("DELETE", f"/api/habits/{doc['id']}", None, 404)
        print("archive + delete cascade ok")

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
