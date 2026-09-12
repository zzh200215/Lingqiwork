"""SPA fallback：打包形态下客户端路由不能 404。

前端从 9 个 HTML 页面收成了一个外壳 + 客户端路由，所以后端必须把未知的**路由形**
路径回落到 `dist/index.html`，否则（dev 走 vite 碰不到，只有打包时才炸）每个深链
都是 404。

反过来，**缺的静态资源必须仍然是 404**：回一份 HTML 会让浏览器报 MIME 错误，
而不是一个能看懂的「没找到」。
"""
import atexit
import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from starlette.exceptions import HTTPException

sys.path.insert(0, ".")

from app.main import NoCacheStaticFiles  # noqa: E402

# 工程内的 scratch：这台机器上 pytest 的 `tmp_path` 落在不可写的 %TEMP%
# （同 test_cards.py / test_indexer_chunk.py）
_DIST = Path(tempfile.mkdtemp(prefix="wb-spa-", dir=Path(__file__).parent))
atexit.register(lambda: shutil.rmtree(_DIST, ignore_errors=True))
(_DIST / "assets").mkdir(parents=True, exist_ok=True)
(_DIST / "index.html").write_text("<!doctype html><div id=root></div>", encoding="utf-8")
(_DIST / "assets" / "app-abc123.js").write_text("console.log(1)", encoding="utf-8")


def _scope(method: str = "GET", path: str = "/"):
    return {"type": "http", "method": method, "path": path, "headers": [], "query_string": b""}


@pytest.fixture()
def static():
    return NoCacheStaticFiles(directory=_DIST, html=True)


# ---------- 纯判断 ----------


@pytest.mark.parametrize("rel", ["kb", "tutor", "notes", "review", "dashboard", "settings"])
def test_a_bare_path_is_a_route(rel):
    assert NoCacheStaticFiles._is_spa_route(rel, _scope()) is True


@pytest.mark.parametrize("rel", ["kb.html", "tutor.html", "review.html"])
def test_a_legacy_html_path_is_still_a_route(rel):
    """存量书签小工具打的是 `/kb.html`——它已经不是真实文件了，必须仍然兜住。"""
    assert NoCacheStaticFiles._is_spa_route(rel, _scope()) is True


@pytest.mark.parametrize("rel", ["assets/typo.js", "assets/app.css", "favicon.ico", "a/b.png"])
def test_a_missing_asset_is_not_a_route(rel):
    assert NoCacheStaticFiles._is_spa_route(rel, _scope()) is False


@pytest.mark.parametrize("rel", ["api/nope", "mcp", "mcp/x"])
def test_api_and_mcp_are_never_fallback(rel):
    assert NoCacheStaticFiles._is_spa_route(rel, _scope()) is False


def test_a_non_get_is_not_a_route():
    assert NoCacheStaticFiles._is_spa_route("kb", _scope(method="POST")) is False


# ---------- 真实返回 ----------


async def test_an_unknown_route_returns_the_shell(static):
    resp = await static.get_response("kb", _scope(path="/kb"))
    assert Path(resp.path).name == "index.html"
    assert resp.headers["cache-control"] == "no-cache"


async def test_a_legacy_html_route_returns_the_shell(static):
    resp = await static.get_response("kb.html", _scope(path="/kb.html"))
    assert Path(resp.path).name == "index.html"


async def test_a_missing_asset_still_404s(static):
    with pytest.raises(HTTPException) as caught:
        await static.get_response("assets/typo.js", _scope(path="/assets/typo.js"))
    assert caught.value.status_code == 404


async def test_a_real_asset_serves_with_immutable_cache(static):
    resp = await static.get_response("assets/app-abc123.js", _scope(path="/assets/app-abc123.js"))
    assert Path(resp.path).name == "app-abc123.js"
    assert "immutable" in resp.headers["cache-control"]


async def test_the_shell_itself_is_no_cache(static):
    resp = await static.get_response("index.html", _scope(path="/"))
    assert resp.headers["cache-control"] == "no-cache"
