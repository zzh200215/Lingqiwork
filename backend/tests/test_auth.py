"""The /api/* and /mcp token guard (PLAN §10.1 #6).

The middleware lives on `app.main`, so these use a real TestClient. The client is
deliberately NOT entered as a context manager: entering it would run the app's
lifespan (model warmup, watchers, scheduler) which none of this needs. Requests
still route through the middleware either way.
"""
import pytest
from fastapi.testclient import TestClient

from app.core import auth

TOKEN = "test-token-123"


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("WB_API_TOKEN", TOKEN)
    monkeypatch.setattr(auth, "_cached", None)
    from app.main import app

    return TestClient(app)


def test_api_requires_token(client):
    assert client.get("/api/settings/prefs").status_code == 401


def test_header_token_ok(client):
    r = client.get("/api/settings/prefs", headers={auth.HEADER: TOKEN})
    assert r.status_code == 200


def test_cookie_token_ok(client):
    client.cookies.set(auth.COOKIE, TOKEN)
    r = client.get("/api/settings/prefs")
    assert r.status_code == 200


def test_wrong_token_rejected(client):
    assert client.get("/api/settings/prefs", headers={auth.HEADER: "nope"}).status_code == 401


def test_health_is_exempt(client):
    # desktop.py probes this before it decides a server is already running
    assert client.get("/api/health").status_code == 200


def test_mcp_requires_token(client):
    assert client.post("/mcp", json={}).status_code == 401


def test_cookie_is_issued_on_first_response(client):
    r = client.get("/api/health")
    assert r.cookies.get(auth.COOKIE) == TOKEN


def test_protected_paths():
    assert auth.is_protected("/api/kb/upload")
    assert auth.is_protected("/mcp")
    assert auth.is_protected("/mcp/messages")
    assert not auth.is_protected("/api/health")
    assert not auth.is_protected("/")
    assert not auth.is_protected("/tutor.html")
