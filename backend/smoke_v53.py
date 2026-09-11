"""One-off smoke test for V5.3 local-dir ingestion (scratch db on port 8768).

Real embedding + real chroma (scratch collection dir), real watcher thread:
add dir -> indexed & RAG-searchable -> live edit picked up -> remove unindexes.
"""
import os
import json
import sys
import time
import urllib.request
from pathlib import Path

# --- API token (PLAN §10.1 #6): the smoke scripts are exactly the kind of
# external caller the guard exists for, so they present a token. Children
# inherit it because env dicts spread os.environ. ---
_WB_TOKEN = os.environ.setdefault("WB_API_TOKEN", "smoke-token")
_WB_HEADERS = {"Content-Type": "application/json", "X-WB-Token": _WB_TOKEN}

BASE = "http://127.0.0.1:8768"
DOCS = Path("D:/TP/A/backend/.smoke16/docs")


def req(method: str, path: str, body: dict | None = None) -> dict:
    p, _, qs = path.partition("?")
    p = urllib.request.quote(p, safe="/")
    url = BASE + p + (("?" + qs) if qs else "")
    r = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers=_WB_HEADERS,
        method=method,
    )
    with urllib.request.urlopen(r, timeout=300) as resp:
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
    try:
        run()
    finally:
        # best-effort cleanup: the scratch server shares the real chroma store,
        # so never leave the smoke source indexed
        try:
            req("DELETE", "/api/dirs/冒烟文档")
        except Exception:
            pass


def run() -> None:
    wait_health()
    print("health ok")

    # reset any leftover state from an earlier crashed run
    try:
        req("DELETE", "/api/dirs/冒烟文档")
    except Exception:
        pass

    # seed a scratch docs folder outside the vault
    DOCS.mkdir(parents=True, exist_ok=True)
    (DOCS / "量子退火.md").write_text(
        "# 量子退火\n\n量子退火是一种利用量子涨落寻找全局最优解的优化算法，"
        "常用于组合优化问题，D-Wave 机器是其代表硬件实现。\n",
        encoding="utf-8",
    )

    # 1. add -> indexed
    entry = req("POST", "/api/dirs", {"name": "冒烟文档", "path": str(DOCS)})
    assert entry["files"] == 1 and entry["chunks"] >= 1, entry
    print(f"add ok: {entry['files']} file(s), {entry['chunks']} chunk(s), {entry['seconds']}s")

    # 2. validation errors
    for body, why in [
        ({"name": "x", "path": "relative/path"}, "relative path"),
        ({"name": "x", "path": str(DOCS / "nope")}, "missing dir"),
        ({"name": "x", "path": "D:/TP/A/vault"}, "vault overlap"),
    ]:
        try:
            req("POST", "/api/dirs", body)
            raise SystemExit(f"{why} should have failed: {body}")
        except Exception as e:
            assert "400" in str(e), (why, e)
    print("validation ok")

    # 3. RAG search must hit the dirs/ source
    hits = req("GET", "/api/kb/search?q=" + urllib.request.quote("量子退火 优化"))
    assert hits["hits"], "search returned nothing"
    top = hits["hits"][0]
    assert top["source"].startswith("dirs/冒烟文档/"), top
    print(f"RAG hit ok: {top['source']} score={top['score']}")

    # 4. live watcher: append content, wait for reindex, sync check
    time.sleep(3)  # let the watcher settle
    p = DOCS / "量子退火.md"
    p.write_text(p.read_text(encoding="utf-8") + "\n\n新增段落：量子退火与模拟退火的区别在于跳跃势垒的方式。\n", encoding="utf-8")
    deadline = time.time() + 30
    got_live = False
    while time.time() < deadline:
        listing = req("GET", "/api/dirs")
        entry2 = next(d for d in listing["dirs"] if d["name"] == "冒烟文档")
        # the watcher updates chroma but not the stored stats; verify via search instead
        s = req("GET", "/api/kb/search?q=" + urllib.request.quote("模拟退火 区别"))
        if s["hits"] and s["hits"][0]["source"].startswith("dirs/"):
            got_live = True
            break
        time.sleep(2)
    assert got_live, "live watcher never picked up the edit"
    print("live watcher ok")

    # 5. disable unindexes, enable reindexes
    req("PUT", "/api/dirs/冒烟文档", {"enabled": False})
    s = req("GET", "/api/kb/search?q=" + urllib.request.quote("量子退火"))
    assert not any(h["source"].startswith("dirs/") for h in s["hits"]), s["hits"]
    req("PUT", "/api/dirs/冒烟文档", {"enabled": True})
    s = req("GET", "/api/kb/search?q=" + urllib.request.quote("量子退火"))
    assert any(h["source"].startswith("dirs/") for h in s["hits"]), s["hits"]
    print("disable/enable ok")

    # 6. remove unindexes and drops the entry
    r = req("DELETE", "/api/dirs/冒烟文档")
    assert r["sources_removed"] >= 1, r
    listing = req("GET", "/api/dirs")
    assert all(d["name"] != "冒烟文档" for d in listing["dirs"])
    s = req("GET", "/api/kb/search?q=" + urllib.request.quote("量子退火"))
    assert not any(h["source"].startswith("dirs/") for h in s["hits"])
    print("remove ok")

    print("SMOKE PASS")


if __name__ == "__main__":
    sys.exit(main())
