"""Smoke test for the review-cards module (scratch db, port 8783).

Full HTTP loop on a throwaway db: card CRUD, the daily queue, SM-2 grading
including the requeue flag, undo, weak-source rollup, export, and the fail-fast
guards. No LLM — /generate/stream is only exercised as far as its input guard
(validation must happen before the SSE stream, so it is a plain 400/422).
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
SCRATCH = BACKEND / ".smoke_cards"
BASE = "http://127.0.0.1:8783"
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
        detail = e.read().decode("utf-8", "ignore")
        print(f"!! {method} {path} -> {e.code}: {detail[:200]}")
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
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8783"],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        # empty state
        q = req("GET", "/api/cards/queue")
        assert q["fresh"] == [] and q["due"] == [] and q["due_total"] == 0, q
        assert q["caps"] == {"new_per_day": 20, "review_per_day": 200}, q
        print("empty queue ok")

        # input guards fail BEFORE the SSE stream opens (plain status codes)
        expect_error("POST", "/api/cards/generate/stream", {}, 400, "必须给且只给一个")
        expect_error(
            "POST", "/api/cards/generate/stream", {"source_path": "a.md", "text": "x" * 200}, 400
        )
        expect_error("POST", "/api/cards/generate/stream", {"text": "短"}, 400, "太短")
        expect_error("POST", "/api/cards/generate/stream", {"source_path": "../x.md"}, 400, "越出")
        expect_error(
            "POST", "/api/cards/generate/stream", {"text": "x" * 200, "kinds": ["bogus"]}, 422
        )
        expect_error("POST", "/api/cards/batch", {"cards": []}, 400, "没有要保存")
        print("fail-fast guards ok")

        # ---- 划词挖空（纯字符串，零 LLM，不写库）----
        para = "RRF 融合的分数是 1/(k + rank + 1)，k 默认取 60。\n\n下一段无关内容。"
        at = para.index("60")
        cloze = req(
            "POST",
            "/api/cards/cloze",
            {"text": para, "start": at, "end": at + 2, "topic": "检索"},
        )
        assert cloze["kind"] == "cloze" and cloze["origin"] == "manual", cloze
        assert "____" in cloze["front"] and "60" not in cloze["front"], cloze
        assert cloze["back"] == "60" and cloze["topic"] == "检索", cloze
        assert "下一段" not in cloze["front"], cloze  # the next paragraph is another block
        expect_error("POST", "/api/cards/cloze", {"text": para, "start": 5, "end": 5}, 400)
        expect_error("POST", "/api/cards/cloze", {"text": "短句。", "start": 0, "end": 3}, 400, "线索")
        print("cloze ok")

        # ---- 取材来源（vault + repo: / dir:）----
        srcs = req("GET", "/api/cards/sources")
        assert set(srcs) == {"vault", "repos", "dirs", "totals", "card_counts"}, srcs
        assert all(isinstance(srcs[k], list) for k in ("vault", "repos", "dirs")), srcs
        full = srcs["totals"]["vault"]
        assert full == len(srcs["vault"]), srcs["totals"]

        # filtering is server-side on purpose: a monorepo would otherwise ship
        # ~1500 paths on every panel open
        one = req("GET", "/api/cards/sources?limit=1")
        assert len(one["vault"]) == 1 and one["totals"]["vault"] == full, one["totals"]
        none = req("GET", "/api/cards/sources?q=zzz-no-such-file")
        assert none["vault"] == [] and none["totals"]["vault"] == 0, none

        # /search only gets its guard exercised here: a real retrieval would load
        # the embedder + reranker and open the live chroma dir from a second
        # process. The happy path is covered by the end-to-end pass instead.
        expect_error("GET", "/api/cards/search?q=", None, 400, "问题")

        expect_error("GET", "/api/cards/material?source=repo:nope/x.py", None, 400, "仓库")
        expect_error("GET", "/api/cards/material?source=dir:nope/x.md", None, 400, "目录")
        expect_error("GET", "/api/cards/material?source=../secrets.md", None, 400, "越出")
        print("sources 筛选 + material/search 守卫 ok")

        # save cards, then exact-duplicate resubmission is skipped
        cards = [
            {"kind": "cloze", "front": "RRF 融合 score = Σ 1/(____ + rank + 1)", "back": "60"},
            {"kind": "scenario", "front": "watcher 线程 import onnxruntime 卡死不返回怎么办", "back": "主线程预热"},
            {"kind": "debug", "front": "SMTP 掩码为何被存成问号", "back": "掩码判定只比等于 bullet"},
        ]
        r = req("POST", "/api/cards/batch", {"cards": cards, "source": "notes/项目笔记.md", "source_label": "项目笔记"})
        assert r["added"] == 3 and len(r["ids"]) == 3, r
        r = req("POST", "/api/cards/batch", {"cards": cards[:1], "source": "notes/项目笔记.md"})
        assert r["added"] == 0 and r["skipped"] == 1, r
        print("batch + dedup ok")

        q = req("GET", "/api/cards/queue")
        assert len(q["fresh"]) == 3 and len(q["due"]) == 0, q
        ids = [c["id"] for c in q["fresh"]]

        # new card, grade=1 → learning 10min, requeue flag true, not a lapse
        r = req("POST", f"/api/cards/{ids[0]}/review", {"grade": 1})
        assert r["interval_days"] == 0 and r["due_seconds"] == 600, r
        assert r["requeue"] is True and r["lapses"] == 0 and r["ease"] == 2.5, r
        print("grade=1 on new card ok (requeue, no lapse, ease untouched)")

        # new card, grade=3 → graduates to 1 day
        r = req("POST", f"/api/cards/{ids[1]}/review", {"grade": 3})
        assert r["interval_days"] == 1.0 and r["due_seconds"] == 86400 and r["requeue"] is False, r
        print("grade=3 graduates to 1 day ok")

        # today's counts / streak move. due_now = immediately reviewable cards:
        # the untouched fresh card (due ~ now) plus any due review cards — the
        # grade=1 card is rescheduled to +10min and the grade=3 to +1day, so
        # neither counts yet.
        st = req("GET", "/api/cards/stats")
        assert st["today_reviewed"] == 2 and st["streak"] == 1, st
        assert st["due_now"] == 1 and st["remaining_today"] == 1, st
        print("stats ok")

        # undo rolls the graded card back exactly
        r = req("POST", f"/api/cards/{ids[1]}/undo")
        assert r["ok"] and r["card"]["interval_days"] == 0 and r["card"]["reps"] == 0, r
        st = req("GET", "/api/cards/stats")
        assert st["today_reviewed"] == 1, st
        print("undo ok")

        # weak sources: one lapse isn't enough sample (<5 reviews) → not weak
        w = req("GET", "/api/cards/weak?days=14")
        assert all(x["weak"] is False for x in w["sources"]), w
        assert w["sources"] and w["sources"][0]["source"] == "notes/项目笔记.md", w
        print("weak rollup ok (no premature tripping)")

        # export is plain markdown with headers
        req_, resp = urllib.request.Request(BASE + "/api/cards/export"), None
        with urllib.request.urlopen(req_) as r:
            ct = r.headers.get("Content-Type", "")
            assert ct.startswith("text/markdown"), ct
            body = r.read().decode("utf-8")
        assert "# 复习卡片导出" in body and "项目笔记" in body, body[:200]  # export shows source_label
        print("export ok")

        # bad inputs
        expect_error("POST", f"/api/cards/{ids[0]}/review", {"grade": 9}, 422, "必须是 1-4")
        expect_error("POST", "/api/cards/999999/review", {"grade": 3}, 404)
        expect_error("PUT", f"/api/cards/{ids[0]}", {"front": ""}, 400, "不能为空")
        expect_error("PUT", f"/api/cards/{ids[0]}", {"kind": "quiz"}, 422)
        print("validation ok")

        # delete a card, then it is gone (with its revlog)
        r = req("DELETE", f"/api/cards/{ids[0]}")
        assert r["ok"]
        expect_error("GET", f"/api/cards/{ids[0]}", None, 404)
        print("delete cascade ok")

        # the hand-made cloze card enters through the same batch path, tagged manual
        r = req(
            "POST",
            "/api/cards/batch",
            {"cards": [cloze], "source": "notes/项目笔记.md", "source_label": "项目笔记"},
        )
        assert r["added"] == 1, r
        saved = req("GET", f"/api/cards/{r['ids'][0]}")["card"]
        assert saved["origin"] == "manual" and saved["kind"] == "cloze", saved
        print("manual cloze card stored with origin=manual ok")

        # the picker's "already carded" badge reads from this rollup
        counts = req("GET", "/api/cards/sources")["card_counts"]
        assert counts.get("notes/项目笔记.md") == 3, counts  # 2 batch survivors + the cloze
        print("card_counts rollup ok")

        # prefs round-trip (the two-gate trap: key must survive _DEFAULTS + PrefsIn)
        req("PUT", "/api/settings/prefs", {"cards_review_per_day": 5})
        p = req("GET", "/api/settings/prefs")
        assert p["cards_review_per_day"] == 5, p.get("cards_review_per_day")
        q = req("GET", "/api/cards/queue")
        assert q["caps"]["review_per_day"] == 5, q
        print("prefs gates ok")

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