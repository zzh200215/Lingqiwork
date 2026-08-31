"""RSS subscription + e-mail endpoints (ROADMAP V5.2)."""
import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core import feeds, mailer, scheduler as sched

router = APIRouter(prefix="/api/feeds", tags=["feeds"])


class FeedIn(BaseModel):
    url: str
    name: str | None = None


class EnabledIn(BaseModel):
    enabled: bool


class MailIn(BaseModel):
    subject: str | None = None
    body: str | None = None
    to: str | None = None


@router.get("")
async def list_feeds():
    return {
        "feeds": feeds.list_feeds(),
        "dir": str(feeds.FEEDS_DIR),
        "next_run": sched.next_run("feeds_sync"),
    }


@router.post("")
async def add_feed(body: FeedIn):
    try:
        return await asyncio.to_thread(feeds.add, body.url, body.name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001 - network/parse failures
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e


@router.post("/sync")
async def sync_all():
    return await asyncio.to_thread(feeds.sync_all)


@router.post("/{name}/sync")
async def sync_one(name: str):
    try:
        return await asyncio.to_thread(feeds.sync, name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e


@router.put("/{name}")
async def toggle_feed(name: str, body: EnabledIn):
    try:
        return feeds.set_enabled(name, body.enabled)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/{name}")
async def delete_feed(name: str):
    return feeds.remove(name)


mail_router = APIRouter(prefix="/api/mail", tags=["mail"])


@mail_router.get("")
async def mail_config():
    c = mailer.config()
    return {**c, "password": "***" if c["password"] else "", "configured": bool(c["host"] and c["to"])}


@mail_router.post("/test")
async def send_test(body: MailIn):
    try:
        return await asyncio.to_thread(
            mailer.send,
            body.subject or "AI 工作台测试邮件",
            body.body or "这是一封来自本地 AI 工作台的测试邮件。收到即表示 SMTP 配置可用。",
            body.to,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001 - smtp errors
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e
