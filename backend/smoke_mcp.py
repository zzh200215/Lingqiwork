"""Smoke test for 能力开放 (scratch db, port 8790).

MCP server 端挂在**真实 main.py 的 lifespan** 下——单测里是 mini Starlette
app，没覆盖真实启动链路；这条 drill 补上：spawn 完整后端（watcher、scheduler、
mcp_manager 全在跑）→ 真 mcp 客户端连 /mcp → initialize / list_tools /
call_tool 全部走通，并做一次「HTTP 写记忆 → MCP 读」的跨界往返。顺带验语音
日记的 HTTP 往返与 ASR status（不跑真转写——那要下模型）。

scratch DB/config/chroma；语音日记写进真实 vault 但 drill 结束前还原原样，
不留痕。无网络、无 LLM 调用。
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# --- API token: the smoke scripts are exactly the kind of
# external caller the guard exists for, so they present a token. Children
# inherit it because env dicts spread os.environ. ---
_WB_TOKEN = os.environ.setdefault("WB_API_TOKEN", "smoke-token")
_WB_HEADERS = {"Content-Type": "application/json", "X-WB-Token": _WB_TOKEN}

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".smoke_mcp"
BASE = "http://127.0.0.1:8790"
LOG = SCRATCH / "server.log"
MARKER = "smoke语音日记往返检查桩"
MEMO = "smoke记忆跨界往返探测桩"


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


def _payload(result):
    for attr in ("structured_content", "structuredContent"):
        sc = getattr(result, attr, None)
        if sc is not None:
            return sc.get("result", sc) if isinstance(sc, dict) else sc
    for c in reversed(result.content):
        text = getattr(c, "text", None)
        if text:
            try:
                return json.loads(text)
            except ValueError:
                continue
    return None


async def mcp_drill() -> None:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    # /mcp 现在也要 token：真实 MCP 客户端连进来同样得带 header。
    # SDK 只在 http_client 上收 header，所以要自己包一个带 header 的 client。
    import httpx2

    async with httpx2.AsyncClient(headers={"X-WB-Token": _WB_TOKEN}) as http_client:
        async with streamable_http_client(BASE + "/mcp", http_client=http_client) as streams:
            read_stream, write_stream = streams[0], streams[1]
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                print("mcp initialize ok（真实 lifespan 下的 session manager 活着）")

                tools = await session.list_tools()
                names = {t.name for t in tools.tools}
                expected = {
                    "search_knowledge",
                    "search_history",
                    "get_user_memory",
                    "get_learning_profile",
                    "get_today_briefing",
                }
                assert expected <= names, f"缺工具: {expected - names}"
                print("mcp list_tools ok:", " · ".join(sorted(names)))

                res = await session.call_tool("get_user_memory", {"limit": 10})
                assert res.is_error is False, res
                rows = _payload(res)
                assert any(r["content"] == MEMO for r in rows), f"HTTP 写的记忆 MCP 读不到: {rows}"
                print("mcp call_tool ok：HTTP 写 → MCP 读 跨界往返成立")

                res = await session.call_tool("get_today_briefing", {})
                assert res.is_error is False and "text" in _payload(res), res

                res = await session.call_tool("search_history", {"q": "一个不存在的检索词xyz"})
                assert res.is_error is False and _payload(res) == [], res

                res = await session.call_tool("search_knowledge", {"query": "协程", "limit": 3})
                assert res.is_error is False and isinstance(_payload(res), list), res
                print("mcp 其余工具 ok（briefing / 空库 search_history / 空索引 search_knowledge）")


def journal_roundtrip() -> None:
    day_file = Path("D:/TP/A/vault/journal") / f"{datetime.now():%Y-%m-%d}.md"
    existed = day_file.exists()
    original = day_file.read_bytes() if existed else b""
    try:
        r = req("POST", "/api/journal", {"text": MARKER})
        assert r["count"] >= 1, r
        view = req("GET", "/api/journal/recent")
        assert view["today"] == r["count"], (view, r)
        assert any(MARKER in e["text"] for e in view["entries"]), view["entries"][:2]
        assert day_file.exists() and MARKER in day_file.read_text(encoding="utf-8")
        print(f"journal HTTP 往返 ok（今天第 {r['count']} 条，vault 文件已核对）")
    finally:
        # 还原 vault 原样：drill 不留痕
        if existed:
            day_file.write_bytes(original)
        else:
            day_file.unlink(missing_ok=True)
            try:
                day_file.parent.rmdir()
            except OSError:
                pass


def main() -> int:
    env = {
        **os.environ,
        "WB_DB_PATH": str(SCRATCH / "smoke.db"),
        "WB_CONFIG_PATH": str(SCRATCH / "config.json"),
        "WB_CHROMA_PATH": str(SCRATCH / "chroma"),
    }
    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    logf = open(LOG, "w")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8790"],
        cwd=str(BACKEND),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_health()
        print("health ok")

        # HTTP 写一条记忆，给 MCP 的跨界往返当数据
        req("POST", "/api/settings/memories", {"content": MEMO, "kind": "fact"})
        print("seed memory ok")

        asyncio.run(mcp_drill())

        journal_roundtrip()

        st = req("GET", "/api/asr/status")
        assert st["model"] in ("tiny", "base", "small", "medium") and "loaded" in st, st
        print(f"asr status ok（model={st['model']}, loaded={st['loaded']}，转写不跑——要下模型）")

        print("SMOKE PASS")
        return 0
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
