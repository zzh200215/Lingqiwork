"""FastAPI entry point. Creates tables on startup, serves API + built frontend."""
import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import BASE_DIR, DATA_DIR, settings
from app.core import auth, mcp_server  # mount 在模块级跑，必须先于 lifespan 导入
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
    conflict,
    conversations,
    cost,
    dashboard,
    decide,
    decisions,
    deliver,
    dirs,
    dispatch,
    evals,
    feeds,
    form,
    habits,
    health as health_router,
    images,
    interview,
    journal,
    kb,
    kg,
    notes,
    outputs,
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
    threads,
    tts,
    today,
    tutor,
    turns,
    usage,
    work,
)

# surface app/core logs (watcher, indexer, embedder) — uvicorn sets root to WARNING
logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")

# 文件日志（CTO review #9）：无人值守任务（cron / 夜间回归 / watcher）出事时，
# stdout 早就没了——桌面壳与后台进程把控制台吞掉之后，这个文件是唯一的事后证据。
# 2MB × 3 份轮转，写入失败不能挡启动（数据目录不可写时降级为只有控制台）。
try:
    from logging.handlers import RotatingFileHandler

    _log_dir = DATA_DIR / "logs"
    _log_dir.mkdir(exist_ok=True)
    _file_handler = RotatingFileHandler(
        _log_dir / "workbench.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8"
    )
    _file_handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s:%(name)s:%(message)s")
    )
    logging.getLogger().addHandler(_file_handler)
except OSError:  # noqa: BLE001 - 日志文件开不出来照样跑
    pass

STATIC_DIR = BASE_DIR / "frontend" / "dist"

log = logging.getLogger(__name__)


async def _migrate() -> None:
    """结构迁移（W6）：**有版本、可 dry-run、迁移前自动备份**。

    真正的活都在 `core/bootstrap.py` 与 `core/migrations.py` —— 这里只留一个名字给
    `lifespan` 用，好让「启动时做了什么」在这份文件里仍然读得出来。
    """
    from app.core import bootstrap

    await bootstrap.ensure_schema()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 建表 + 迁移走同一个入口（`core/bootstrap.py`）——CLI 与 drill 也走它，
    # 于是「库没初始化过」不会再以一个语焉不详的 SQLite 错出现在别处。
    await _migrate()
    # One-time, idempotent: seal any secret still sitting in plaintext (config.json
    # and provider api_key rows) so existing installs inherit the encryption.
    from app.core import secrets as secretbox
    from app.db import SessionLocal

    secretbox.migrate_config()
    async with SessionLocal() as _db:
        await secretbox.migrate_providers(_db)

    from app.core import indexer, retriever
    from app.core import mcp_server
    from app.core.mcp import mcp_manager
    from app.core.watcher import watcher

    indexer._on_index_change = retriever.invalidate
    from app.core import ingest

    await asyncio.to_thread(ingest.warm_ocr)  # must load before the watcher needs it
    # 启动清理（BUG-012）：把上一进程遗留的 running 行落成 error，解开并发守卫的死锁。
    # 必须在**任何触发源起来之前**——watcher / triggers / 调度器都可能起 run_task，
    # 而守卫认 running 行，遗留行不清就把对应任务永久锁死。
    from app.core import tasks as _tasks

    await _tasks.reset_orphan_runs()
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


async def _auth_guard(request: Request, call_next):
    """Require the API token on /api/* and /mcp, and hand the page its cookie.

    Registered *before* CORSMiddleware so CORS stays the outermost layer: a 401
    from here still carries the CORS headers the cross-origin dev page needs in
    order to read it. The cookie carries the token for same-origin loads that
    cannot set a header (`<img>`/`<audio>` sources, the backup download link).
    """
    if auth.is_protected(request.url.path) and not auth.request_ok(
        request.headers.get(auth.HEADER), request.cookies.get(auth.COOKIE)
    ):
        return JSONResponse({"detail": "unauthorized"}, status_code=401)

    response = await call_next(request)
    if request.cookies.get(auth.COOKIE) != auth.token():
        response.set_cookie(auth.COOKIE, auth.token(), path="/", httponly=True, samesite="strict")
    return response


app.add_middleware(BaseHTTPMiddleware, dispatch=_auth_guard)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # vite dev server
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(settings_router.router)
app.include_router(dispatch.router)
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
app.include_router(deliver.router)
app.include_router(recap.router)
app.include_router(decide.router)
app.include_router(conflict.router)
app.include_router(decisions.router)
app.include_router(quality.router)
app.include_router(arena.router)
app.include_router(backup.router)
app.include_router(tasks.router)
app.include_router(evals.router)
app.include_router(form.router)
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
app.include_router(interview.router)
app.include_router(turns.router)
app.include_router(usage.router)
app.include_router(work.router)
app.include_router(outputs.router)
app.include_router(threads.router)

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

    Also the SPA fallback: the frontend is now one shell with client-side routes
    (`/kb`, `/tutor`…), so any unknown path that *looks like a route* gets
    `index.html` back and the router decides what to render. Without this every
    deep link 404s in the packaged form (dev never hits it — vite serves there).
    """

    async def get_response(self, path: str, scope):
        # normalize Windows backslashes from os.path.join in StaticFiles.get_path
        rel = (path or "").lstrip("/\\").replace("\\", "/")
        try:
            response = await super().get_response(path, scope)
        except HTTPException as e:
            if e.status_code != 404 or not self._is_spa_route(rel, scope):
                raise
            response = await super().get_response("index.html", scope)
            response.headers["Cache-Control"] = "no-cache"
            return response
        if rel.endswith(".html") or rel in ("", "index.html"):
            response.headers["Cache-Control"] = "no-cache"
        elif rel.startswith("assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response

    @staticmethod
    def _is_spa_route(rel: str, scope) -> bool:
        """这个 404 该不该用 SPA 外壳兜住。

        - 只认 GET/HEAD。走到这里时其实已经是 GET/HEAD 了（`StaticFiles.get_response`
          对别的方法先抛 405），留这一条是让这个判断独立成立，而不是依赖父类的行为。
        - `api/` `mcp/` 不归这里管（它们有自己的路由，且受 token 保护）；
        - **缺的静态资源不兜**——否则 `assets/typo.js` 会拿到一份 HTML，浏览器报
          的是 MIME 错误而不是干净的 404，排查起来南辕北辙。
          但 `.html` 要兜：`/kb.html` 已经不是真实文件了（前端收成单个外壳），
          而**存量书签小工具打的正是这个地址**——不兜就等于把它们全废掉。
        """
        if scope.get("method") not in ("GET", "HEAD"):
            return False
        # 裸 `mcp` / `api` 也要盖住：MCP 的端点正好是 `/mcp`，不是 `/mcp/...`
        if rel in ("api", "mcp") or rel.startswith(("api/", "mcp/")):
            return False
        name = Path(rel).name
        ext = name.rsplit(".", 1)[1].lower() if "." in name else ""
        return ext in ("", "html")


if STATIC_DIR.exists():
    app.mount("/", NoCacheStaticFiles(directory=STATIC_DIR, html=True), name="static")
