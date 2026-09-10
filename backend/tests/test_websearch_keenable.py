"""Offline test: _web_search routes through Keenable when configured, else Bing first."""
import asyncio
import io
import json
import sys
import unittest.mock as mock

sys.path.insert(0, ".")

from app.core import mcp

KEENABLE_FIXTURE = json.dumps(
    {
        "query": "fastapi sse",
        "mode": "pro",
        "results": [
            {
                "title": "Server-Sent Events (SSE) - FastAPI",
                "url": "https://fastapi.tiangolo.com/tutorial/server-sent-events/",
                "description": "",
                "snippet": "SSE is a standard for streaming data from the server to the client over HTTP.",
            },
            {"title": "坏数据应被跳过", "url": "javascript:void(0)", "snippet": "x"},
        ],
    }
)


async def main():
    # 1. key configured -> first request hits api.keenable.ai, javascript: URL dropped
    hits: list[str] = []

    def fake_urlopen_keenable(req, timeout=15):
        hits.append(req.full_url if hasattr(req, "full_url") else str(req))
        return mock.MagicMock(__enter__=lambda s: io.BytesIO(KEENABLE_FIXTURE.encode()))

    cfg = {"websearch_api": "keenable", "websearch_api_key": "keen_test"}
    with mock.patch("app.core.mcp.urlopen", fake_urlopen_keenable), mock.patch(
        "app.core.mcp.load_config", return_value=cfg
    ):
        out = await mcp._web_search({"query": "fastapi sse"})
    assert hits and hits[0].startswith("https://api.keenable.ai/v1/search"), hits
    assert "fastapi.tiangolo.com" in out, out
    assert "javascript:" not in out, out
    print("keenable path OK")

    # 2. no key -> chain starts at bing (no request to keenable)
    hits.clear()

    def fake_urlopen_bing(req, timeout=15):
        hits.append(req.full_url if hasattr(req, "full_url") else str(req))
        return mock.MagicMock(__enter__=lambda s: io.BytesIO(b"<html></html>"))

    with mock.patch("app.core.mcp.urlopen", fake_urlopen_bing), mock.patch(
        "app.core.mcp.load_config", return_value={"websearch_api": "", "websearch_api_key": ""}
    ):
        out = await mcp._web_search({"query": "fastapi sse"})
    assert hits and hits[0].startswith("https://www.bing.com/search"), hits
    print("fallback order OK")

    # 3. keenable selected but empty key -> treated as not configured
    hits.clear()
    with mock.patch("app.core.mcp.urlopen", fake_urlopen_bing), mock.patch(
        "app.core.mcp.load_config", return_value={"websearch_api": "keenable", "websearch_api_key": ""}
    ):
        await mcp._web_search({"query": "fastapi sse"})
    assert hits and hits[0].startswith("https://www.bing.com/search"), hits
    print("empty-key guard OK")


asyncio.run(main())
