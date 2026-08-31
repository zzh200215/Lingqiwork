"""Knowledge-graph RAG endpoints: connection to the user's local Neo4j,
LLM extraction over the vault, retrieval debugging."""
import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core import kg
from app.core.prefs import load_config, save_config

router = APIRouter(prefix="/api/kg", tags=["kg"])


class KgConfigIn(BaseModel):
    uri: str = "bolt://localhost:7687"
    user: str = "neo4j"
    password: str = ""
    enabled: bool = False


class KgBuildIn(BaseModel):
    max_files: int = Field(default=8, ge=1, le=30)


class KgQueryIn(BaseModel):
    q: str
    top_k: int = Field(default=6, ge=1, le=20)


@router.get("/status")
async def status():
    cfg = load_config()
    st: dict = {
        "enabled": bool(cfg.get("kg_enabled")),
        "uri": cfg.get("kg_uri") or "bolt://localhost:7687",
        "user": cfg.get("kg_user") or "neo4j",
        "password_set": bool(cfg.get("kg_password")),
    }
    st.update(kg.verify())  # {"ok": bool, "files"/"entities"/"relations" | "error"}
    return st


@router.put("/config")
async def save_config_and_test(body: KgConfigIn):
    update: dict = {
        "kg_uri": body.uri.strip() or "bolt://localhost:7687",
        "kg_user": body.user.strip() or "neo4j",
        "kg_enabled": body.enabled,
    }
    pw = body.password.strip()
    # the browser echoes the masked value back; treat any all-mask string as "unchanged"
    if pw and set(pw) <= set("•*?●"):
        pw = ""
    if pw:
        update["kg_password"] = pw
    save_config(update)
    kg.close()
    st = kg.verify()
    if not st.get("ok"):
        raise HTTPException(502, f"Neo4j 连接失败：{st.get('error', '')}")
    return {"ok": True, **st}


@router.post("/build")
async def build(body: KgBuildIn | None = None):
    if not load_config().get("kg_enabled"):
        raise HTTPException(400, "知识图谱功能未开启（先在配置里启用并保存）")
    max_files = body.max_files if body else 8
    try:
        return await kg.build(max_files)
    except Exception as e:  # noqa: BLE001 - graph/provider failures
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e


@router.post("/query")
async def query(body: KgQueryIn):
    if not body.q.strip():
        raise HTTPException(400, "问题为空")
    try:
        return await asyncio.to_thread(kg.retrieve, body.q.strip(), body.top_k)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e


@router.post("/clear")
async def clear():
    try:
        n = await asyncio.to_thread(kg.clear)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e
    return {"ok": True, "deleted_entities": n}
