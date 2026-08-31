"""Offline test of the DDG result parser with a realistic HTML fixture."""
import asyncio
import sys
import unittest.mock as mock

sys.path.insert(0, ".")

from app.core import mcp

FIXTURE = """
<html><body>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffastapi.tiangolo.com%2Fadvanced%2Fsse%2F&rut=abc123">
      Server-Sent Events - FastAPI
    </a>
  </h2>
  <a class="result__snippet" href="#">How to stream responses with <b>SSE</b> in FastAPI using StreamingResponse.</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://example.com/direct-link">Direct link result</a>
  </h2>
  <a class="result__snippet" href="#">Snippet without redirect wrapping.</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fthird.example.com%2Fx&rut=zzz">Third</a>
</div>
</body></html>
"""


async def main():
    def fake_urlopen(req, timeout=15):
        import io

        return mock.MagicMock(
            __enter__=lambda s: io.BytesIO(FIXTURE.encode()),
            read=lambda n=-1: FIXTURE.encode(),
        )

    # patch urlopen used inside _web_search's thread fn
    with mock.patch("app.core.mcp.urlopen", fake_urlopen):
        out = await mcp._web_search({"query": "fastapi sse"})
    print(out)


asyncio.run(main())
