"""Provider CRUD + user preferences + MCP server management.

api_key values are masked in responses. MCP servers live in config.json
(next to prefs) and are applied live via mcp_manager.reload().
"""
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.mcp import mcp_manager
from app.core.prefs import load_config, save_config
from app.core.secrets import SECRET_KEYS
from app.db import get_db
from app.models import ProviderConfig, iso_utc

router = APIRouter(prefix="/api/settings", tags=["settings"])


# ---------- preferences ----------

MASK = "••••••••"


@router.get("/prefs")
async def get_prefs():
    cfg = load_config()
    for secret in SECRET_KEYS:
        if cfg.get(secret):
            cfg = {**cfg, secret: MASK}  # never ship real secrets to the browser
    return cfg


class PrefsIn(BaseModel):
    system_prompt: str | None = None
    rag_top_k: int | None = None
    temperature: float | None = None
    hybrid_search: bool | None = None
    rerank_enabled: bool | None = None
    full_context: bool | None = None
    full_context_max_chars: int | None = None
    digest_enabled: bool | None = None
    # 夜间评测回归（eval_regression，2026-09-26）：**默认关**——它每天烧一次
    # 真金白银的模型调用。开关打开那一刻，钱花在哪就该写在明面上。
    eval_regression_enabled: bool | None = None
    eval_regression_cron: str | None = None
    digest_time: str | None = None
    memory_enabled: bool | None = None
    thread_context_enabled: bool | None = None
    automemory_enabled: bool | None = None
    memory_tidy_enabled: bool | None = None
    memory_tidy_time: str | None = None
    asr_model: str | None = None
    asr_language: str | None = None
    tts_voice: str | None = None
    tts_engine: str | None = None
    tts_auto: bool | None = None
    podcast_host_voice: str | None = None
    podcast_guest_voice: str | None = None
    podcast_daily_enabled: bool | None = None
    artifacts_enabled: bool | None = None
    artifacts_timeout: int | None = None
    kg_uri: str | None = None
    kg_user: str | None = None
    kg_password: str | None = None
    kg_enabled: bool | None = None
    desktop_notify: bool | None = None
    backup_enabled: bool | None = None
    backup_time: str | None = None
    backup_keep: int | None = None
    backup_dir: str | None = None
    image_enabled: bool | None = None
    image_api: str | None = None
    image_provider: str | None = None
    image_model: str | None = None
    image_size: str | None = None
    feeds_enabled: bool | None = None
    feeds_time: str | None = None
    smtp_host: str | None = None
    smtp_port: int | None = None
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_from: str | None = None
    smtp_to: str | None = None
    smtp_tls: bool | None = None
    email_on_digest: bool | None = None
    email_on_feeds: bool | None = None
    # 零柒 (these were in _DEFAULTS but missing here, so they were unsettable)
    pet_enabled: bool | None = None
    pet_notify: bool | None = None
    pet_greet_enabled: bool | None = None
    pet_morning_time: str | None = None
    pet_evening_time: str | None = None
    # P2：语气微调（按喂养分布改用词，不夸不评）
    pet_tone: bool | None = None
    # Z4：称号旁那一行风味小注（同一份喂养分布，摆成一句事实）
    pet_flavor: bool | None = None
    # 复习卡片
    cards_new_per_day: int | None = None
    cards_review_per_day: int | None = None
    cards_remind_enabled: bool | None = None
    cards_remind_time: str | None = None
    cards_remedy_enabled: bool | None = None

    @field_validator("pet_morning_time", "pet_evening_time", "cards_remind_time")
    @classmethod
    def check_hhmm(cls, v: str | None) -> str | None:
        if v is not None and not re.fullmatch(r"\d{1,2}:\d{2}", v.strip()):
            raise ValueError("时间格式应为 HH:MM")
        return v

    @field_validator("cards_new_per_day", "cards_review_per_day")
    @classmethod
    def check_card_caps(cls, v: int | None) -> int | None:
        if v is not None and not (0 <= v <= 500):
            raise ValueError("每日上限应在 0-500 之间")
        return v

    @field_validator("image_api")
    @classmethod
    def check_image_api(cls, v: str | None) -> str | None:
        if v is not None and v not in ("dashscope", "openai"):
            raise ValueError("image_api 只能是 dashscope 或 openai")
        return v

    @field_validator("asr_model")
    @classmethod
    def check_asr_model(cls, v: str | None) -> str | None:
        from app.core.asr import AVAILABLE_MODELS

        if v is not None and v not in AVAILABLE_MODELS:
            raise ValueError(f"asr_model 只能是 {'/'.join(AVAILABLE_MODELS)}")
        return v

    @field_validator("asr_language")
    @classmethod
    def check_asr_language(cls, v: str | None) -> str | None:
        from app.core.asr import LANGUAGES

        if v is not None and v not in LANGUAGES:
            raise ValueError(f"asr_language 只能是 {'/'.join(LANGUAGES)}")
        return v

    @field_validator("tts_voice")
    @classmethod
    def check_tts_voice(cls, v: str | None) -> str | None:
        from app.core.tts import VOICES

        if v is not None and v not in VOICES:
            raise ValueError("tts_voice 不在可用音色列表中")
        return v

    @field_validator("artifacts_timeout")
    @classmethod
    def check_artifacts_timeout(cls, v: int | None) -> int | None:
        from app.core.artifacts import MAX_TIMEOUT

        if v is not None and not (1 <= v <= MAX_TIMEOUT):
            raise ValueError(f"artifacts_timeout 需在 1~{MAX_TIMEOUT} 秒之间")
        return v

    @field_validator("podcast_host_voice", "podcast_guest_voice")
    @classmethod
    def check_podcast_voice(cls, v: str | None) -> str | None:
        from app.core.tts import VOICES

        if v is not None and v not in VOICES:
            raise ValueError("播客音色不在可用列表中")
        return v

    @field_validator("eval_regression_cron")
    @classmethod
    def _eval_cron_ok(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return v
        from app.core.tasks import validate_cron

        return validate_cron(v.strip())

    @field_validator("tts_engine")
    @classmethod
    def check_tts_engine(cls, v: str | None) -> str | None:
        from app.core.tts import ENGINES

        if v is not None and v not in ENGINES:
            raise ValueError(f"tts_engine 只能是 {'/'.join(ENGINES)}")
        return v


@router.put("/prefs")
async def update_prefs(body: PrefsIn):
    update = {k: v for k, v in body.model_dump().items() if v is not None}
    # the browser echoes the masked value back; treat any all-mask string as
    # "unchanged" (some clients mangle the bullet chars into ?/*) and keep the
    # stored secret instead of overwriting it with placeholder glyphs
    for secret in SECRET_KEYS:
        v = update.get(secret)
        if isinstance(v, str) and v.strip() and set(v.strip()) <= set("•*?●"):
            del update[secret]
    result = save_config(update)
    from app.core import scheduler as jobs

    jobs.reschedule_all()
    for secret in SECRET_KEYS:
        if result.get(secret):
            result = {**result, secret: MASK}
    return result


# ---------- persistent memory ----------

@router.get("/memories")
async def get_memories():
    from app.core import memory

    rows = await memory.list_memories()
    return [
        {
            "id": m.id,
            "content": m.content,
            "source": m.source or "manual",
            "kind": m.kind if m.kind in memory.AUTO_KINDS else "fact",
            # naive datetime 裸 str() 会让浏览器把 UTC 当本地读（本时区差 8 小时）；走 iso_utc。
            "created_at": iso_utc(m.created_at) or "",
            # 证据链：洞察/合并行带着它们的原句依据，页面可展开看「从哪来的」
            "evidence": memory.parse_evidence(m.evidence_json),
        }
        for m in rows
    ]


class MemoryIn(BaseModel):
    content: str


@router.post("/memories")
async def add_memory(body: MemoryIn):
    from app.core import memory

    result = await memory.add_memory(body.content)
    if result.startswith("[错误]"):
        raise HTTPException(400, result)
    return {"ok": True, "message": result}


@router.put("/memories/{memory_id}")
async def edit_memory(memory_id: int, body: MemoryIn):
    from app.core import memory

    result = await memory.update_memory(memory_id, body.content)
    if result.startswith("[错误]"):
        raise HTTPException(400, result)
    if result.startswith("[未找到]"):
        raise HTTPException(404, result)
    return {"ok": True, "message": result}


@router.delete("/memories/{memory_id}")
async def delete_memory(memory_id: int):
    from app.core import memory

    result = await memory.remove_memory(memory_id=memory_id)
    if result.startswith("[未找到]"):
        raise HTTPException(404, result)
    return {"ok": True, "message": result}


@router.delete("/memories")
async def clear_memories():
    from app.core import memory

    n = await memory.clear_all()
    return {"ok": True, "deleted": n}


# ---------- memory tidy (sleep-time consolidation) ----------


@router.get("/memories/tidy")
async def tidy_status():
    from app.core import memory_tidy, scheduler as sched

    cfg = load_config()
    return {
        "enabled": bool(cfg.get("memory_tidy_enabled")),
        "time": cfg.get("memory_tidy_time") or "03:30",
        "next_run": sched.next_run("memory_tidy"),
        "report": memory_tidy.last_report(),
    }


@router.post("/memories/tidy")
async def tidy_now():
    """Run one consolidation pass immediately (works even when the job is off)."""
    from app.core import memory_tidy

    return await memory_tidy.run_tidy()


# ---------- MCP servers ----------


class McpServerIn(BaseModel):
    name: str
    type: str = "stdio"  # stdio | sse
    command: str = ""
    args: list[str] = []
    url: str = ""
    enabled: bool = True


class McpServersIn(BaseModel):
    servers: list[McpServerIn] = []


def _mcp_view() -> dict:
    return {
        "servers": load_config().get("mcp_servers", []),
        "status": mcp_manager.status,
        "active_tools": mcp_manager.active_tools(),
        # A3 的触发条件读数（工具总数 + 那条 >20 的线）：设置页那一栏显示的是**它**，
        # 不是 `active_tools` 的长度——后者只是已连接的 MCP 工具，本机是 0，会把人读糊涂。
        "tools": mcp_manager.inventory(
            include_memory=bool(load_config().get("memory_enabled", True))
        ),
    }


@router.get("/mcp")
async def get_mcp():
    return _mcp_view()


@router.put("/mcp")
async def save_mcp(body: McpServersIn):
    save_config({"mcp_servers": [s.model_dump() for s in body.servers]})
    await mcp_manager.reload()
    return _mcp_view()


@router.post("/mcp/test")
async def test_mcp(body: McpServerIn):
    """Connect a throwaway client to one server config and list its tools."""
    return await mcp_manager.probe(body.model_dump())


@router.get("/mcp/expose")
async def expose_mcp():
    """How to register the workbench's own memory MCP server in other clients."""
    import json as _json
    import shutil
    import sys

    from app.config import BASE_DIR

    backend_dir = str(BASE_DIR / "backend")
    uv = shutil.which("uv") or "uv"
    snippet = {
        "command": uv,
        "args": ["--directory", backend_dir, "run", "python", "-m", "app.mcp_server"],
    }
    return {
        "uv": uv,
        "python": sys.executable,
        "backend_dir": backend_dir,
        "snippet": snippet,
        "snippet_json": _json.dumps(
            {"mcpServers": {"workbench-memory": snippet}}, ensure_ascii=False, indent=2
        ),
    }


# ---------- providers ----------


class ProviderIn(BaseModel):
    name: str
    kind: str = "openai"  # openai | anthropic
    base_url: str = ""
    api_key: str = ""
    models: list[str] = []
    enabled: bool = True

    @field_validator("kind")
    @classmethod
    def check_kind(cls, v: str) -> str:
        if v not in ("openai", "anthropic"):
            raise ValueError("kind must be openai or anthropic")
        return v


class ProviderOut(ProviderIn):
    id: int

    model_config = {"from_attributes": True}


def _mask(p: ProviderConfig) -> dict:
    data = ProviderOut.model_validate(p).model_dump()
    key = p.api_key or ""
    data["api_key_set"] = bool(key)
    data["api_key"] = (key[:6] + "..." + key[-4:]) if len(key) > 12 else ("***" if key else "")
    return data


@router.get("/providers")
async def list_providers(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(ProviderConfig).order_by(ProviderConfig.id))).scalars().all()
    return [_mask(r) for r in rows]


@router.post("/providers")
async def create_provider(body: ProviderIn, db: AsyncSession = Depends(get_db)):
    row = ProviderConfig(**body.model_dump())
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _mask(row)


@router.put("/providers/{provider_id}")
async def update_provider(
    provider_id: int, body: ProviderIn, db: AsyncSession = Depends(get_db)
):
    row = await db.get(ProviderConfig, provider_id)
    if not row:
        raise HTTPException(404, "provider not found")
    data = body.model_dump()
    new_key = data.get("api_key") or ""
    # empty or masked (from a GET round-trip) key = keep the stored one
    if not new_key or ("..." in new_key and len(new_key) < 20):
        data.pop("api_key", None)
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    return _mask(row)


@router.post("/providers/{provider_id}/probe")
async def probe_provider(provider_id: int, db: AsyncSession = Depends(get_db)):
    """Fire one minimal request per configured model and cache the outcome.

    This is the button that would have saved an hour on 2026-09-04: the account's
    free quota was gone for `qwen3.7-plus` only, and because that model sat first in
    the list every background feature used it while a working `qwen-turbo` waited
    second. `default_model` in the response is what the automated features will
    reach after this probe.
    """
    from app.core import providers as prov

    row = await db.get(ProviderConfig, provider_id)
    if not row:
        raise HTTPException(404, "provider not found")
    if not row.models:
        raise HTTPException(400, "这个 provider 还没配置任何模型")
    if not row.api_key:
        raise HTTPException(400, "这个 provider 还没填 api_key")

    results = {
        f"{row.name}/{m}": await prov.probe_model(row.kind, row.base_url, row.api_key, m)
        for m in row.models
    }
    prov.record_health(results)
    return {
        "provider": row.name,
        "results": [{"model_id": k, **v} for k, v in results.items()],
        "default_model": prov.default_model_id(),
    }


@router.delete("/providers/{provider_id}")
async def delete_provider(provider_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(ProviderConfig, provider_id)
    if not row:
        raise HTTPException(404, "provider not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True}
