"""外观 / 换肤的后端副本：`/api/settings/theme`。

**为什么这一份存在**：真值在前端 localStorage（首屏要同步读到，不能等一次网络往返），
后端存一份是为了「浏览器数据被清掉 / 换台机器打开」时外观还在。所以这个测试钉的
不是「主题长什么样」（那是前端 `theme.test.ts` 的账），而是三件后端才管得着的事：

1. **原样保管**：前端给的形状后端不解释、不裁剪、不补字段 —— 形状的真相在前端
   `src/theme.ts`，后端一插手就会出现「两个地方各有一份默认值」。
2. **落盘**：写完之后 `config.json` 里真的有它，且重启（重新 `load_config`）还在。
3. **白名单**：`theme` 必须在 `prefs._DEFAULTS` 里 —— `save_config` 会把表外的键
   **静默丢弃**（`eval_regression_*` 那两个键就踩过这个坑，`prefs.py` 里写着）。
   这条测试就是为了让那个坑不可能再踩第二次。
"""
import json

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.core import auth

TOKEN = "test-token-123"

# 一份**完整**的前端形状（与 `frontend/src/theme.ts` 的 ThemeConfig 对应）
THEME = {
    "version": 1,
    "skin": "forest",
    "dark": True,
    "accent": "#0d9488",
    "bg": {
        "mode": "image",
        "color": "#f5f6f8",
        "from": "#eef1f6",
        "to": "#dfe5ee",
        "angle": 160,
        "image": "/api/images/img-20261001-120000-abcdef.png",
        "fit": "cover",
        "blur": 6,
        "scrim": 62,
    },
}


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("WB_API_TOKEN", TOKEN)
    monkeypatch.setattr(auth, "_cached", None)
    from app.main import app

    return TestClient(app)


def _headers():
    return {auth.HEADER: TOKEN}


def test_default_is_none_not_empty_object(client):
    """「从没设置过」与「设置成了空」是两件事。

    前端靠 `theme == null` 决定「要不要回读后端」；给一个空 dict 的话，
    它会当成「后端有一份设置」，于是每次清掉浏览器数据都读回一份空主题。
    """
    r = client.get("/api/settings/theme", headers=_headers())
    assert r.status_code == 200
    assert r.json() == {"theme": None}


def test_put_then_get_round_trips_verbatim(client):
    r = client.put("/api/settings/theme", json={"theme": THEME}, headers=_headers())
    assert r.status_code == 200
    assert r.json()["theme"] == THEME

    back = client.get("/api/settings/theme", headers=_headers()).json()["theme"]
    assert back == THEME, "后端解释或裁剪了前端的形状"
    assert back["bg"]["scrim"] == 62  # 嵌套的那一层也得原样在


def test_lands_on_disk_and_survives_reload(client):
    client.put("/api/settings/theme", json={"theme": THEME}, headers=_headers())

    raw = json.loads(settings.config_path.read_text(encoding="utf-8"))
    assert raw["theme"]["skin"] == "forest"

    from app.core.prefs import load_config

    assert load_config()["theme"] == THEME


def test_theme_is_whitelisted_in_defaults():
    """`save_config` 只收 `_DEFAULTS` 里有的键——不在表里就是**静默丢弃**。"""
    from app.core.prefs import _DEFAULTS

    assert "theme" in _DEFAULTS


def test_put_null_clears_it(client):
    """`null` = 清掉（与前端「恢复默认」同义）。"""
    client.put("/api/settings/theme", json={"theme": THEME}, headers=_headers())
    r = client.put("/api/settings/theme", json={"theme": None}, headers=_headers())
    assert r.status_code == 200
    assert client.get("/api/settings/theme", headers=_headers()).json() == {"theme": None}


def test_put_rejects_non_object(client):
    """形状不对就报错，而不是把一串字符串塞进 config.json ——
    那份文件是给人看的，写进去一个孤儿字符串会让下一个人以为配置坏了。

    **422 而不是 400**：这是 `ThemeIn` 注解（`dict | None`）的请求校验，
    不是路由里的业务判断——所以这里钉的是「它被挡住了」，不是某个具体码。
    """
    r = client.put("/api/settings/theme", json={"theme": "dark"}, headers=_headers())
    assert r.status_code == 422
    assert client.get("/api/settings/theme", headers=_headers()).json() == {"theme": None}


def test_other_prefs_untouched(client):
    """存主题不该碰到别的偏好——它们是同一份 config.json 里的邻居。"""
    client.put("/api/settings/prefs", json={"rag_top_k": 9}, headers=_headers())
    client.put("/api/settings/theme", json={"theme": THEME}, headers=_headers())

    prefs = client.get("/api/settings/prefs", headers=_headers()).json()
    assert prefs["rag_top_k"] == 9
    assert prefs["theme"] == THEME


def test_requires_token(client):
    assert client.get("/api/settings/theme").status_code == 401
    assert client.put("/api/settings/theme", json={"theme": THEME}).status_code == 401
