"""Smoke test for V20 后台可信 (scratch db, port 8785).

Covers the job report, the self-check and the model probe over HTTP. The probe is
pointed at a closed local port rather than a real provider, which is enough to
exercise the whole loop the 2026-09-04 incident needed: probe fails → result is
cached → default_model_id() reports the default as broken. No network, no LLM.
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

# --- API token (PLAN §10.1 #6): the smoke scripts are exactly the kind of
# external caller the guard exists for, so they present a token. Children
# inherit it because env dicts spread os.environ. ---
_WB_TOKEN = os.environ.setdefault("WB_API_TOKEN", "smoke-token")
_WB_HEADERS = {"Content-Type": "application/json", "X-WB-Token": _WB_TOKEN}

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".smoke_health"
BASE = "http://127.0.0.1:8785"
LOG = SCRATCH / "server.log"
DEAD = "http://127.0.0.1:9/v1"  # discard port: connection refused immediately


def req(method: str, path: str, body: dict | None = None, timeout: int = 120):
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
        urllib.request.urlopen(r, timeout=120)
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
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8785"],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        # ---- 作业报告：关掉的功能也必须出现，不能凭空消失 ----
        jobs = {j["job_id"]: j for j in req("GET", "/api/health/jobs")["jobs"]}
        for known in ("daily_digest", "auto_backup", "feeds_sync", "memory_tidy",
                      "pet_morning", "pet_evening"):
            assert known in jobs, f"{known} 不在报告里"
            assert jobs[known]["enabled_by"], known
        # scratch config = defaults: digest/backup/feeds/tidy off, pet on
        assert jobs["daily_digest"]["disabled"] is True, jobs["daily_digest"]
        assert jobs["pet_morning"]["disabled"] is False, jobs["pet_morning"]
        assert jobs["pet_morning"]["registered"] is True, jobs["pet_morning"]
        assert jobs["daily_digest"]["registered"] is False, jobs["daily_digest"]
        # 卡片方向封存后 cards_remind / cards_remediate 被 cards.reschedule() prune，
        # 报告里本就不该出现 —— 断言「不出现」，而不是把这条检查丢掉。
        assert "cards_remind" not in jobs and "cards_remediate" not in jobs, list(jobs)
        print("job report ok（已关 vs 应跑未注册 分得开）")

        # ---- 自检：还没有 provider ----
        c = req("GET", "/api/health/self")
        assert c["never_probed"] is True and c["models_total"] == 0, c
        assert c["default_model"] is None and c["default_model_broken"] is False, c
        assert c["jobs_missing"] == [] and c["jobs_failing"] == [], c
        assert "daily_digest" in c["jobs_off"], c["jobs_off"]
        print("self-check（空状态）ok")

        # ---- 探测守卫 ----
        expect_error("POST", "/api/settings/providers/999/probe", None, 404)
        empty = req("POST", "/api/settings/providers",
                    {"name": "nomodels", "base_url": DEAD, "api_key": "k", "models": []})
        expect_error("POST", f"/api/settings/providers/{empty['id']}/probe", None, 400, "模型")
        nokey = req("POST", "/api/settings/providers",
                    {"name": "nokey", "base_url": DEAD, "api_key": "", "models": ["m"]})
        expect_error("POST", f"/api/settings/providers/{nokey['id']}/probe", None, 400, "api_key")
        req("DELETE", f"/api/settings/providers/{empty['id']}")
        req("DELETE", f"/api/settings/providers/{nokey['id']}")
        print("probe 守卫 ok")

        # ---- 完整闭环：探测失败 → 结果落库 → 默认模型被判为不可用 ----
        # 这就是 2026-09-04 那次的形状，只是把「额度耗尽」换成「端口不通」
        p = req("POST", "/api/settings/providers",
                {"name": "dead", "base_url": DEAD, "api_key": "k", "models": ["a", "b"]})
        before = req("GET", "/api/health/self")
        assert before["default_model"] == "dead/a", before["default_model"]
        assert before["default_model_broken"] is False, before  # 还没探测过 = 未知，不算坏

        r = req("POST", f"/api/settings/providers/{p['id']}/probe", None, timeout=180)
        assert len(r["results"]) == 2, r
        for x in r["results"]:
            assert x["ok"] is False and x["code"], x
        print("probe 结果:", [(x["model_id"], x["code"]) for x in r["results"]])

        after = req("GET", "/api/health/self")
        assert after["never_probed"] is False, after
        assert {m["model_id"] for m in after["models_broken"]} == {"dead/a", "dead/b"}, after
        # 全坏时仍返回第一个而不是 None：None 会让调用方谎报「没有已启用的 provider」
        assert after["default_model"] == "dead/a", after
        assert after["default_model_broken"] is True, after
        print("探测 → 缓存 → 默认模型判坏 全链路 ok")

        # ---- 一个能用的模型排在坏的后面时，默认值要跳过坏的 ----
        req("PUT", f"/api/settings/providers/{p['id']}",
            {"name": "dead", "kind": "openai", "base_url": DEAD, "api_key": "",
             "models": ["a", "b", "fresh"], "enabled": True})
        skipped = req("GET", "/api/health/self")
        # "fresh" 从没探测过 → 未知 → 可用；这正是那天本该发生的事
        assert skipped["default_model"] == "dead/fresh", skipped["default_model"]
        assert skipped["default_model_broken"] is False, skipped
        print("默认模型跳过已知打不通的 ok")

        req("DELETE", f"/api/settings/providers/{p['id']}")
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
