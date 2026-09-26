"""Agent presets CRUD + deterministic multi-agent collaboration runs."""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import collab
from app.core.prefs import load_config
from app.db import SessionLocal, get_db
from app.models import Agent
from app.models import Conversation, Message

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agents", tags=["agents"])


class AgentIn(BaseModel):
    name: str
    avatar: str = "🤖"
    system_prompt: str = ""
    model_id: str = ""
    use_rag: bool = False
    # A2：从布尔升成白名单。空 = 不限制；`none` = 一个都不给；
    # 其余按 fnmatch（`vault_*`、`kb_search`、`server__*`，逗号或空格分隔）。
    tool_whitelist: str = ""
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name 不能为空")
        return v[:50]

    @field_validator("avatar")
    @classmethod
    def avatar_short(cls, v: str) -> str:
        return (v or "🤖")[:8]

    @field_validator("tool_whitelist")
    @classmethod
    def whitelist_shape(cls, v: str) -> str:
        # 只做「长度 + 记号合法性」的体检，**不校验工具名认不认识**：外部 MCP 没连上时
        # 名字本来就查不到，把配置拦在门外会让用户没法先把配置写好。
        return (v or "").strip()[:500]


class AgentPatch(BaseModel):
    """Partial update — all fields optional."""

    name: str | None = None
    avatar: str | None = None
    system_prompt: str | None = None
    model_id: str | None = None
    use_rag: bool | None = None
    tool_whitelist: str | None = None
    enabled: bool | None = None


def _out(a: Agent) -> dict:
    return {
        "id": a.id,
        "name": a.name,
        "avatar": a.avatar,
        "system_prompt": a.system_prompt,
        "model_id": a.model_id,
        "use_rag": a.use_rag,
        "tool_whitelist": a.tool_whitelist or "",
        "enabled": a.enabled,
    }


@router.get("")
async def list_agents(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Agent).order_by(Agent.id))).scalars().all()
    return [_out(r) for r in rows]


@router.post("")
async def create_agent(body: AgentIn, db: AsyncSession = Depends(get_db)):
    dup = (
        await db.execute(select(Agent).where(Agent.name == body.name))
    ).scalar_one_or_none()
    if dup:
        raise HTTPException(409, f"同名智能体已存在：{body.name}")
    row = Agent(**body.model_dump())
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _out(row)


@router.put("/{agent_id}")
async def update_agent(
    agent_id: int, body: AgentPatch, db: AsyncSession = Depends(get_db)
):
    row = await db.get(Agent, agent_id)
    if not row:
        raise HTTPException(404, "agent not found")
    data = body.model_dump(exclude_none=True)
    if "name" in data and data["name"] != row.name:
        dup = (
            await db.execute(select(Agent).where(Agent.name == data["name"]))
        ).scalar_one_or_none()
        if dup:
            raise HTTPException(409, f"同名智能体已存在：{data['name']}")
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    return _out(row)


@router.delete("/{agent_id}")
async def delete_agent(agent_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(Agent, agent_id)
    if not row:
        raise HTTPException(404, "agent not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


# ---------- multi-agent collaboration (deterministic patterns) ----------


class CollabIn(BaseModel):
    conversation_id: int
    goal: str
    agent_ids: list[int]
    pattern: str = "pipeline"
    use_rag: bool = False
    # 材料清单的**第二个来源**（2026-09-22 拍板）：你钉的这一轮要读哪几份。形状沿用交付那
    # 条路（`DeliverIn.pinned`）：vault 相对路径 / `repo:` / `dir:`——后两种在协作里会被
    # 跳过，理由是读步手里只有 `vault_read_file`（见 `thread_context.pinned_materials`）。
    pinned: list[str] = Field(default_factory=list)

    @field_validator("pattern")
    @classmethod
    def known_pattern(cls, v: str) -> str:
        if v not in collab.PATTERNS:
            raise ValueError(f"pattern 只能是 {'/'.join(collab.PATTERNS)}")
        return v

    @field_validator("goal")
    @classmethod
    def goal_not_blank(cls, v: str) -> str:
        if not (v or "").strip():
            raise ValueError("goal 不能为空")
        return v[: collab.MAX_GOAL_CHARS]

    @field_validator("pinned")
    @classmethod
    def pinned_shape(cls, v: list) -> list:
        # 与 `AgentIn.tool_whitelist` 同款：只做「条数 + 长度」的体检，**不在这里查文件在不在**
        # ——那是 `pinned_materials` 的活，它才知道"读得动"是什么意思（在不在 vault、是不是文件）。
        return [str(s).strip()[:300] for s in (v or []) if str(s or "").strip()][:20]


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/collab")
async def run_collab(body: CollabIn):
    """Run agents in a fixed pattern, streaming the transcript as one message."""
    if not (collab.MIN_AGENTS <= len(body.agent_ids) <= collab.MAX_AGENTS):
        raise HTTPException(400, f"协作需要 {collab.MIN_AGENTS}~{collab.MAX_AGENTS} 个智能体")
    if len(set(body.agent_ids)) != len(body.agent_ids):
        raise HTTPException(400, "智能体不能重复选择")

    async with SessionLocal() as db:
        conv = await db.get(Conversation, body.conversation_id)
        if not conv:
            raise HTTPException(404, "conversation not found")
        rows = []
        for aid in body.agent_ids:
            a = await db.get(Agent, aid)
            if not a or not a.enabled:
                raise HTTPException(400, f"智能体不可用: id={aid}")
            rows.append(a)
        default_model_id = conv.model_id
        user_msg = Message(conversation_id=conv.id, role="user", content=body.goal.strip())
        db.add(user_msg)
        if conv.title == "New chat":
            conv.title = body.goal.strip().replace("\n", " ")[:50] or "New chat"
        agent_dicts = [
            {
                "id": a.id,
                "name": a.name,
                "avatar": a.avatar,
                "system_prompt": a.system_prompt,
                # A2：把会话默认模型**提前定下来**。空字符串会让每一步各自去猜默认模型，
                # 而「这一步用的哪个模型」是要记账的（A2 的账里就有它）。
                "model_id": a.model_id or default_model_id,
            }
            for a in rows
        ]
        conv_id = conv.id
        await db.commit()

    from app.routers.chat import _save_assistant_message, indexer_retrieve, resolve_model

    async def resolve(model_id: str):
        return await resolve_model(model_id or default_model_id)

    async def retrieve(query: str, top_k: int):
        return await indexer_retrieve(query, top_k)

    retrieve_fn = retrieve if body.use_rag else None

    # **A2 挂账②那条边界的落地**：把「这一轮读哪几份」交给编排器，而不是让每一步各自
    # `vault_list_files` 去猜。来源是**确定性的一处**——你说「继续推进那件事」时，就是那件事
    # 挂着的那几份（A4 的同一份真值、同一个开关：关掉「手头那件事」的人不该在协作里被它影响）。
    # 不是「产品里多了一条猜材料的规则」，而是把已有的那一条接上。
    from app.core import thread_context

    materials: list[str] = []
    if load_config().get("thread_context_enabled", True):
        materials = await thread_context.materials_for(body.goal)
        if materials:
            log.info("collab 这一轮读这几份（%d）：%s", len(materials), "、".join(materials))

    # **第二个来源（2026-09-22）**：你钉的那几份。人指的不用猜，所以它不过 `refers_to_thread`
    # 那道启发式、也不受「手头那件事」那个开关管。**排在最前**——与交付那条「钉进来的材料
    # 排在取材结果最前」（§4-14）是同一个先后：人指定的一定优先于推断出来的。
    pinned = thread_context.pinned_materials(body.pinned)
    if pinned:
        log.info("collab 钉进来的材料（%d）：%s", len(pinned), "、".join(pinned))
        if body.pattern != "fanout":
            # 说了不做要讲清楚：材料清单只有 fanout 吃（另外两种模式的每一步本来就不分材料）。
            # 不写这一行，钉了没反应的人会以为是坏了。
            log.info("collab 这一轮的钉材料不生效：%s 不分材料（只有 fanout 吃）", body.pattern)
    materials = pinned + [m for m in materials if m not in pinned]

    async def gen():
        transcript = ""
        facts: list[dict] = []
        try:
            async for event, data in collab.run(
                body.goal,
                agent_dicts,
                body.pattern,
                resolve,
                retrieve_fn,
                # 空表 = 不分工（老行为）：既没指涉「手头那件事」、也没人钉材料时**不去猜**该读什么
                materials=materials or None,
            ):
                if event == "delta":
                    transcript += data["text"]
                elif event == "done":
                    facts = data.get("facts") or []
                yield _sse(event, data)
        except Exception as e:  # noqa: BLE001 - surface setup failures in-stream
            yield _sse("error", {"message": f"{type(e).__name__}: {e}"})
        if facts:
            # 每一步的账落一行日志：协作是额度最大的那类操作，出问题时第一个要看的
            # 就是「哪一步贵」。判定不读它（那是 A2 那把尺子的事）。
            log.info(
                "collab facts（%s）：%s | 并行 %.1fs · 串行 %.1fs",
                body.pattern,
                collab.facts_summary(facts),
                sum(float(f.get("seconds") or 0) for f in facts if f.get("parallel")),
                sum(float(f.get("seconds") or 0) for f in facts if not f.get("parallel")),
            )
        if transcript.strip():
            # 逐步账跟正文一起落（A2，2026-09-23）：它以前**只走流式事件**——刷新一下那条消息
            # 就只剩纪要正文，「哪一步贵、哪一步烧光」全没了。`facts` 是后端自己发出去的那份
            # 事实（界面照抄的也是它），落库就是把它原样留下，不另算一份。
            await _save_assistant_message(
                conv_id, transcript, default_model_id or "collab", steps=facts or None
            )

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
