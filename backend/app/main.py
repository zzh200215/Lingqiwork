"""FastAPI entry point. Creates tables on startup, serves API + built frontend."""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import BASE_DIR, settings
from app.core import mcp_server  # mount 在模块级跑，必须先于 lifespan 导入
from app.db import engine
from app.models import Base
from app.routers import (
    agents,
    arena,
    ask,
    artifacts,
    asr,
    backup,
    beliefs,
    cards,
    chat,
    compose,
    conversations,
    cost,
    dashboard,
    decide,
    dirs,
    evals,
    feeds,
    habits,
    health as health_router,
    images,
    journal,
    kb,
    kg,
    notes,
    pet,
    podcast,
    prompts,
    quality,
    recap,
    repos,
    research,
    roundtable,
    search,
    settings as settings_router,
    skills,
    tasks,
    tts,
    today,
    tutor,
    usage,
)

# surface app/core logs (watcher, indexer, embedder) — uvicorn sets root to WARNING
logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")

STATIC_DIR = BASE_DIR / "frontend" / "dist"


async def _migrate() -> None:
    """Tiny idempotent column migrations for existing SQLite tables."""
    from sqlalchemy import text

    stmts = [
        ("conversations", "pinned", "ALTER TABLE conversations ADD COLUMN pinned BOOLEAN DEFAULT 0"),
        ("conversations", "folder", "ALTER TABLE conversations ADD COLUMN folder VARCHAR(100) DEFAULT ''"),
        ("messages", "feedback", "ALTER TABLE messages ADD COLUMN feedback VARCHAR(4)"),
        # V2.3 agent orchestration columns (tasks table)
        ("tasks", "mode", "ALTER TABLE tasks ADD COLUMN mode VARCHAR(10) DEFAULT 'simple'"),
        ("tasks", "tool_whitelist", "ALTER TABLE tasks ADD COLUMN tool_whitelist TEXT DEFAULT ''"),
        ("tasks", "max_rounds", "ALTER TABLE tasks ADD COLUMN max_rounds INTEGER DEFAULT 12"),
        ("tasks", "retry", "ALTER TABLE tasks ADD COLUMN retry INTEGER DEFAULT 1"),
        ("tasks", "notify_on_error", "ALTER TABLE tasks ADD COLUMN notify_on_error BOOLEAN DEFAULT 0"),
        ("tasks", "trigger_kind", "ALTER TABLE tasks ADD COLUMN trigger_kind VARCHAR(10) DEFAULT 'cron'"),
        ("tasks", "watch_path", "ALTER TABLE tasks ADD COLUMN watch_path VARCHAR(500) DEFAULT ''"),
        ("tasks", "chain_next_id", "ALTER TABLE tasks ADD COLUMN chain_next_id INTEGER"),
        # V1.4 memory upgrade
        ("memories", "source", "ALTER TABLE memories ADD COLUMN source VARCHAR(10) DEFAULT 'manual'"),
        ("memories", "kind", "ALTER TABLE memories ADD COLUMN kind VARCHAR(10) DEFAULT 'fact'"),
        # 记忆证据链（DeepTutor 参考项：可检视记忆）
        ("memories", "evidence_json", "ALTER TABLE memories ADD COLUMN evidence_json TEXT DEFAULT '[]'"),
        # V6.2 observability: per-message / per-run token usage
        ("messages", "tokens_in", "ALTER TABLE messages ADD COLUMN tokens_in INTEGER"),
        ("messages", "tokens_out", "ALTER TABLE messages ADD COLUMN tokens_out INTEGER"),
        ("task_runs", "tokens_in", "ALTER TABLE task_runs ADD COLUMN tokens_in INTEGER"),
        ("task_runs", "tokens_out", "ALTER TABLE task_runs ADD COLUMN tokens_out INTEGER"),
        # tutor history compression (maple-os 参考项：长会话中段压缩)
        ("tutor_sessions", "summary", "ALTER TABLE tutor_sessions ADD COLUMN summary TEXT DEFAULT ''"),
        ("tutor_sessions", "summary_upto", "ALTER TABLE tutor_sessions ADD COLUMN summary_upto INTEGER DEFAULT 0"),
        ("tutor_sessions", "repo", "ALTER TABLE tutor_sessions ADD COLUMN repo VARCHAR(100) DEFAULT ''"),
        ("tutor_sessions", "mode", "ALTER TABLE tutor_sessions ADD COLUMN mode VARCHAR(10) DEFAULT 'socratic'"),
    ]
    async with engine.begin() as conn:
        for table, col, ddl in stmts:
            cols = (await conn.execute(text(f"PRAGMA table_info({table})"))).mappings().all()
            if cols and not any(c["name"] == col for c in cols):
                await conn.execute(text(ddl))


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _migrate()
    from app.core import indexer, retriever
    from app.core import mcp_server
    from app.core.mcp import mcp_manager
    from app.core.watcher import watcher

    indexer._on_index_change = retriever.invalidate
    from app.core import ingest

    await asyncio.to_thread(ingest.warm_ocr)  # must load before the watcher needs it
    watcher.start()
    from app.core import triggers

    triggers.watcher.start()
    from app.core.dirs import watcher as dir_watcher

    dir_watcher.start()
    await mcp_manager.reload()
    from app.core import scheduler as jobs

    jobs.start()
    try:
        async with mcp_server.running():
            yield
    finally:
        jobs.shutdown()
        from app.core import triggers

        triggers.watcher.stop()
        from app.core.dirs import watcher as dir_watcher

        dir_watcher.stop()
        watcher.stop()
        await mcp_manager.close()


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # vite dev server
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(settings_router.router)
app.include_router(agents.router)
app.include_router(conversations.router)
app.include_router(chat.router)
app.include_router(cost.router)
app.include_router(kb.router)
app.include_router(notes.router)
app.include_router(dashboard.router)
app.include_router(prompts.router)
app.include_router(skills.router)
app.include_router(search.router)
app.include_router(beliefs.router)
app.include_router(roundtable.router)
app.include_router(research.router)
app.include_router(compose.router)
app.include_router(recap.router)
app.include_router(decide.router)
app.include_router(quality.router)
app.include_router(arena.router)
app.include_router(backup.router)
app.include_router(tasks.router)
app.include_router(evals.router)
app.include_router(images.router)
app.include_router(journal.router)
app.include_router(ask.router)
app.include_router(repos.router)
app.include_router(dirs.router)
app.include_router(asr.router)
app.include_router(artifacts.router)
app.include_router(tts.router)
app.include_router(podcast.router)
app.include_router(pet.router)
app.include_router(kg.router)
app.include_router(feeds.router)
app.include_router(feeds.mail_router)
app.include_router(cards.router)
app.include_router(habits.router)
app.include_router(health_router.router)
app.include_router(today.router)
app.include_router(tutor.router)
app.include_router(usage.router)

# MCP server（streamable HTTP，只读工具）挂在 /mcp；session manager 由 lifespan 启动。
# 必须在静态文件的 / 挂载之前装（见 mcp_server 模块 docstring 的坑位说明）。
for _r in mcp_server.routes():
    app.router.routes.append(_r)


@app.get("/api/health")
async def health():
    return {"ok": True}


class NoCacheStaticFiles(StaticFiles):
    """Serve the built frontend with a sane cache policy:

    - *.html / index are `no-cache` so a rebuild shows up on the next refresh
      (Vite hashes JS/CSS filenames, so fresh HTML always pulls fresh assets);
    - assets/*.js|css are content-hashed → long-lived immutable caching.
    """

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        # normalize Windows backslashes from os.path.join in StaticFiles.get_path
        rel = (path or "").lstrip("/\\").replace("\\", "/")
        if rel.endswith(".html") or rel in ("", "index.html"):
            response.headers["Cache-Control"] = "no-cache"
        elif rel.startswith("assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


if STATIC_DIR.exists():
    app.mount("/", NoCacheStaticFiles(directory=STATIC_DIR, html=True), name="static")
