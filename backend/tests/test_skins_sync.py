"""导入皮肤的后端副本（`/api/settings/skins`）。

正本在前端 localStorage，这里只做镜像。钉的四件事都来自那条分工：
1. **原样保管**：PUT 什么存什么（形状真相在前端 `theme/manifest.ts`）；
2. **落盘**：`data/skins.json` 真的有它，重启（重新 load）还在；
3. **版本闸**：不认识的 `version` 400，拒了就不落盘；
4. **形状闸**：`skins` 不是数组也 400——镜像坏掉的症状是「恢复出一份空皮肤库」，
   用户想不到去查一个 JSON 文件，所以在写进去之前挡住。
"""
import sys

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

sys.path.insert(0, ".")

from app.core import auth, skins_store  # noqa: E402

TOKEN = "test-token-123"

PAYLOAD = {
    "version": 1,
    "skins": [
        {
            "format": 1,
            "id": "photo-abc",
            "label": "海边",
            "hint": "从「海边.jpg」取的色",
            "accent": "#c2703a",
            "light": {"bg": {"image": "/api/images/img-20261001-120000-abcdef.png"}},
            "dark": {},
        }
    ],
}


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("WB_API_TOKEN", TOKEN)
    monkeypatch.setattr(auth, "_cached", None)
    from app.main import app

    return TestClient(app)


def _headers():
    return {auth.HEADER: TOKEN}


def test_get_returns_null_when_never_synced(client):
    assert client.get("/api/settings/skins", headers=_headers()).json() == {"skins": None}


def test_put_round_trips_and_survives_reload(client):
    r = client.put("/api/settings/skins", json=PAYLOAD, headers=_headers())
    assert r.status_code == 200
    assert r.json()["skins"] == PAYLOAD  # 原样保管：不裁剪、不补字段
    # 落盘：直接从磁盘读，且重新 load 还在
    assert skins_store.load() == PAYLOAD


def test_put_rejects_unknown_version(client):
    newer = {**PAYLOAD, "version": 99}
    r = client.put("/api/settings/skins", json=newer, headers=_headers())
    assert r.status_code == 400
    assert skins_store.load() != newer  # 拒了就不落盘


def test_put_rejects_non_list_skins(client):
    r = client.put("/api/settings/skins", json={**PAYLOAD, "skins": "all"}, headers=_headers())
    assert r.status_code == 422  # list[dict] 的请求校验，FastAPI 管


def test_save_leaves_no_tmp_residue():
    skins_store.save(PAYLOAD)
    assert not skins_store.path().with_name(skins_store.path().name + ".tmp").exists()


def test_requires_token(client):
    assert client.get("/api/settings/skins").status_code == 401
    assert client.put("/api/settings/skins", json=PAYLOAD).status_code == 401
