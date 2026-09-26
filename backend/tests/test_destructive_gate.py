"""§4.1 ① 的落地：**破坏性工具要口头授权**（2026-09-22）。

那条挂账写死的条件是「引入删除类工具（删除类 / 对外发送类 / 覆盖 vault 之外的路径）时，
**确认是前置条件不是可选项**」。今天确实有这样一个工具（`memory_delete` 默认在模型手里），
所以条件触发了；而选的形态不是弹确认框（那会打断流，正是它当初被挂起来的原因），是
**不给它那只手**——只有你这一轮明说要忘掉/删掉记忆，那个工具才进工具表。

这一层钉四件事，**每一件都在不同的路上**（这正是要害：名单散在四处迟早漏一处）：

1. 网关默认不发（`tool_specs` 的默认值就是那条判据的落点）；
2. **交互那两条路**（chat / 零柒）按「你这一轮说的话」授权；
3. **无人值守那两条路**（定时任务、子代理）**永远拿默认值**——那里没有"这一轮"，也就没人可问；
4. 声明本身不许写错名字（`DESTRUCTIVE_TOOLS` 必须都是真工具）。
"""
import asyncio
import sys

sys.path.insert(0, ".")

from app.core import delegate, mcp  # noqa: E402
from app.core import turn_quality as tq  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import Conversation, ProviderConfig  # noqa: E402


def _names(specs: list[dict]) -> set[str]:
    return {(s.get("function") or {}).get("name", "") for s in specs}


# ---------- 1. 网关：默认不发 ----------


def test_the_gateway_withholds_destructive_tools_by_default():
    """默认那张表里**没有**删除类工具；要拿到它，调用方得明写 `allow_destructive=True`。"""
    assert mcp.DESTRUCTIVE_TOOLS, "声明是空的——那条条件就成了摆设"
    default = _names(mcp.mcp_manager.tool_specs(include_memory=True, include_delegate=True))
    allowed = _names(
        mcp.mcp_manager.tool_specs(
            include_memory=True, include_delegate=True, allow_destructive=True
        )
    )
    for name in mcp.DESTRUCTIVE_TOOLS:
        assert name not in default, f"{name} 不该出现在默认表里"
        assert name in allowed, f"{name} 连显式放行都拿不到——那工具名大概写错了"


def test_every_destructive_name_is_a_real_tool():
    """写错一个名字 = 那条工具**静默地**继续发出去（名单只在过滤处生效，没人会报错）。"""
    real = {b["name"] for b in mcp.BUILTIN_TOOLS}
    assert set(mcp.DESTRUCTIVE_TOOLS) <= real, set(mcp.DESTRUCTIVE_TOOLS) - real


# ---------- 3. 无人值守：永远拿默认值 ----------


def test_a_delegated_subagent_cannot_be_handed_it():
    """子代理是**没有"这一轮"可问**的那条路：主循环点名也没用（与纪律 5 同一条思路）。"""
    assert delegate._specs(["memory_delete"]) == []
    # 别的写工具照旧给得出去——这一层只拦声明过的破坏性工具
    assert "save_artifact" in _names(delegate._specs(["save_artifact"]))


def test_the_shipped_declaration_still_matches_what_we_think_is_dangerous():
    """今天只有「删记忆」这一个：写下来是为了**下次加工具时有人要回答两个问题**——
    它丢了什么、能不能补回来；哪条路有资格拿到它。"""
    assert set(mcp.DESTRUCTIVE_TOOLS) == {"memory_delete"}


def test_the_tasks_tool_catalogue_does_not_offer_it():
    """`GET /api/tasks/tools` 是建任务时那个白名单选择器，也是无人值守那条路的工具目录——
    它走默认参数，所以删除类工具**连选都选不到**（要自动清理记忆，得走一条不是工具的路）。"""
    import asyncio as _a

    from app.routers.tasks import list_tools

    rows = _a.run(list_tools())
    offered = {r["name"] for r in rows}
    assert not (offered & set(mcp.DESTRUCTIVE_TOOLS)), offered & set(mcp.DESTRUCTIVE_TOOLS)
    assert offered, "目录是空的——这条测试就没在量东西"


# ---------- 2. 交互那条路：按你这一轮说的话授权 ----------


def _seed_provider_and_conv() -> None:
    async def go() -> None:
        async with SessionLocal() as db:
            db.add(
                ProviderConfig(
                    name="stub",
                    kind="openai",
                    base_url="https://stub",
                    api_key="k",
                    models=["stub-m"],
                    enabled=True,
                )
            )
            db.add(Conversation(id=9301, title="t", model_id="stub/stub-m"))
            await db.commit()

    asyncio.run(go())


def _tools_this_turn(monkeypatch, text: str) -> set[str]:
    """走**真的** `/api/chat` 组装路径，只在最外面把 `run_agentic_chat` 换成记账替身。

    与 `test_thread_context` 里那条同款——尺子那条路（工具表怎么拼出来）才是最可能
    静默坏掉的地方，所以不直接调 `tool_specs()` 了事。
    """
    from app.routers import chat

    conf = {
        "memory_enabled": True,  # 这一轮要看的正是"记忆开着时给不给那把删除工具"
        "automemory_enabled": False,
        "thread_context_enabled": False,
    }
    monkeypatch.setattr(chat, "load_config", lambda: conf)

    seen: dict = {}

    async def fake(info, model, messages, tools, run_tool, emit_text, emit_tool, **kw):  # noqa: ARG001
        seen["tools"] = _names(tools or [])
        emit_text("在。")
        return "在。"

    async def _no_followups(*_a, **_k):
        return []

    monkeypatch.setattr(chat, "run_agentic_chat", fake)
    monkeypatch.setattr(chat, "_generate_followups", _no_followups)

    async def go() -> None:
        async for _frame in chat._generate(
            chat.ChatRequest(conversation_id=9301, content=text, use_rag=False)
        ):
            pass

    asyncio.run(go())
    return seen["tools"]


def test_the_chat_hands_the_delete_tool_only_when_you_ask(monkeypatch):
    """**这一条是那次挂账的正面证据**：同一句话以外什么都不改，只换你说的内容。"""
    _seed_provider_and_conv()

    plain = _tools_this_turn(monkeypatch, "帮我总结一下这周的进展。")
    assert "memory_delete" not in plain, "没让我删，它手里不该有那只手"
    assert "memory_list" in plain, "只拦破坏性的那一个，读记忆照旧"

    asked = _tools_this_turn(monkeypatch, "把那条关于 Python 的记忆删掉。")
    assert "memory_delete" in asked, "明说了要删，工具得给（否则这句请求永远做不到）"
