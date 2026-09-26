"""P3「会干活」：插件能力 → 模型工具。

零柒真的能做事的那一半——工具声明从哪来、白名单怎么过滤、模型调它走的是不是和
你在面板里点一下**同一条路**。不需要模型：`call_tool` 是纯后端行为。
"""
import sys

sys.path.insert(0, ".")

from app.core import pet_plugins as pp  # noqa: E402
from app.core.mcp import mcp_manager, take_tool_meta  # noqa: E402
from app.routers.pet import PET_TOOL_DEFAULT, _allowed_tools, _pet_tools  # noqa: E402


async def _tables() -> None:
    from app.db import engine
    from app.models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


def names(specs: list[dict]) -> set[str]:
    return {s["function"]["name"] for s in specs}


# ---------- 声明的一致性：工具是插件的，不是另写一份 ----------


def test_every_declared_tool_points_at_a_real_command():
    """工具名必须指向一个真存在的 (插件, 命令)。

    工具是**插件自己声明的**，所以这条一致性不该靠人记——它随时可能被改坏。
    """
    for tool, (plugin, cmd) in pp.TOOL_INDEX.items():
        assert plugin in pp.BUILTINS, f"{tool} 指向不存在的插件 {plugin}"
        spec = pp.BUILTINS[plugin]
        assert cmd in spec["commands"], f"{tool} → {plugin}/{cmd} 不在 commands 里"
        assert spec["tools"][cmd]["name"] == tool


def test_pet_tools_all_carry_the_prefix_the_dispatcher_needs():
    """`mcp.call_tool` 按名字前缀分派；不带 `pet_` 就会掉进 MCP 分支报「未连接」。"""
    for tool in pp.TOOL_INDEX:
        assert tool.startswith("pet_"), tool


def test_mood_clear_is_not_exposed_as_a_tool():
    """`mood/clear` 有命令但没有工具：没有理由让模型替你抹掉今天的心情。"""
    assert "mood" in pp.BUILTINS
    assert "clear" in pp.BUILTINS["mood"]["commands"]
    assert "clear" not in (pp.BUILTINS["mood"].get("tools") or {})


# ---------- tool_specs：装好且开着的插件才提供工具 ----------


async def test_tool_specs_are_openai_shaped():
    await _tables()
    specs = await pp.tool_specs()
    assert specs, "装好三个内置插件后就该有工具"
    for s in specs:
        assert s["type"] == "function"
        f = s["function"]
        assert f["name"] and f["description"]
        assert f["parameters"]["type"] == "object"


async def test_a_disabled_plugin_takes_its_tools_with_it():
    """关掉一个插件，它的工具就该消失——否则模型会去调一个已经不存在的能力
    （同 `chat.py`：工具关掉时不能注入工具规矩）。"""
    await _tables()
    assert "pet_focus_start" in names(await pp.tool_specs())
    await pp.set_enabled("focus", False)
    try:
        assert "pet_focus_start" not in names(await pp.tool_specs())
        assert "pet_water_drink" in names(await pp.tool_specs())  # 别的插件不受影响
    finally:
        await pp.set_enabled("focus", True)
    assert "pet_focus_start" in names(await pp.tool_specs())


async def test_whitelist_filters_the_plugin_tools():
    await _tables()
    assert names(await pp.tool_specs(allow={"pet_focus_start"})) == {"pet_focus_start"}
    assert await pp.tool_specs(allow=set()) == []


# ---------- call_tool：与面板按钮同一条路 ----------


async def test_call_tool_starts_focus_and_reports_a_panel():
    await _tables()
    text, meta = await pp.call_tool("pet_focus_start", {"minutes": 25})
    assert "开始" in text and "25" in text
    assert meta is not None
    assert meta["pet"]["plugin"] == "focus"
    assert meta["pet"]["command"] == "start"
    assert meta["pet"]["panel"]["running"] is True


async def test_call_tool_is_the_same_path_as_the_panel_button():
    """模型调一次工具，面板就真的跟着变——因为它走的就是 `command()`。

    这是 P3 的核心承诺：**模型能做的和你在面板里点一下能做的完全等价**。
    两套语义迟早分叉，所以只能有一套。
    """
    await _tables()
    await pp.call_tool("pet_focus_stop", {})
    await pp.call_tool("pet_focus_start", {"minutes": 10})
    rows = {r["name"]: r for r in await pp.list_plugins()}
    assert rows["focus"]["panel"]["running"] is True
    assert rows["focus"]["panel"]["minutes"] == 10


async def test_call_tool_stops_focus():
    await _tables()
    await pp.call_tool("pet_focus_start", {"minutes": 30})
    text, meta = await pp.call_tool("pet_focus_stop", {})
    assert "结束" in text
    assert meta["pet"]["panel"]["running"] is False


async def test_call_tool_water_and_mood():
    await _tables()
    text, meta = await pp.call_tool("pet_water_drink", {})
    assert "杯" in text
    assert meta["pet"]["panel"]["kind"] == "counter"

    text, meta = await pp.call_tool("pet_mood_set", {"value": 4})
    assert "4" in text
    assert meta["pet"]["panel"]["kind"] == "mood"


async def test_an_unknown_tool_is_an_error_string_not_an_exception():
    """工具失败该由模型读到、然后用自己的话告诉用户，而不是打断整轮对话。"""
    await _tables()
    text, meta = await pp.call_tool("pet_nope", {})
    assert "tool error" in text
    assert meta is None


async def test_a_bad_argument_is_an_error_string_too():
    await _tables()
    text, meta = await pp.call_tool("pet_mood_set", {"value": 99})
    assert "tool error" in text and meta is None


# ---------- 分派：mcp.call_tool 必须接住 pet_* ----------


async def test_the_mcp_dispatcher_routes_pet_tools():
    """不加那一段分派，`pet_focus_start` 会掉进 MCP 分支，报
    「server 'pet_focus_start' 未连接」——看起来像工具不存在，其实只是没接线。"""
    await _tables()
    out = await mcp_manager.call_tool("pet_focus_start", {"minutes": 15})
    assert "未连接" not in out
    assert "开始" in out and "15" in out


async def test_the_dispatcher_hands_the_panel_back_to_the_ui():
    """界面要的是**可核对的事实**（面板此刻的样子），所以副产物得从分派层传出来。"""
    await _tables()
    await mcp_manager.call_tool("pet_focus_start", {"minutes": 5})
    meta = take_tool_meta()
    assert meta is not None
    assert meta["pet"]["panel"]["running"] is True
    assert meta["pet"]["panel"]["minutes"] == 5


# ---------- 白名单 ----------


def test_allowed_tools_default_when_unset():
    assert _allowed_tools({}) == set(PET_TOOL_DEFAULT)


def test_allowed_tools_empty_string_means_none_at_all():
    """空串 = 一个都不给。必须能和「没配」区分开，否则关不掉工具。"""
    assert _allowed_tools({"pet_tools": ""}) == set()


def test_allowed_tools_accepts_a_comma_string_and_a_list():
    assert _allowed_tools({"pet_tools": "a, b ,,c"}) == {"a", "b", "c"}
    assert _allowed_tools({"pet_tools": ["a", " b "]}) == {"a", "b"}


def test_allowed_tools_junk_falls_back_to_the_default():
    assert _allowed_tools({"pet_tools": 42}) == set(PET_TOOL_DEFAULT)


async def test_pet_tools_respects_the_whitelist():
    await _tables()
    specs = await _pet_tools({"pet_tools": ["pet_focus_start"]})
    assert names(specs) == {"pet_focus_start"}


async def test_pet_tools_can_be_turned_off_entirely():
    await _tables()
    assert await _pet_tools({"pet_tools": ""}) == []


async def test_the_default_set_leaves_out_writes_and_slow_ones():
    """角落里的一个陪伴面板：不该让它悄悄改你的笔记，也不该让一次图片生成
    把对话卡住一分钟。"""
    await _tables()
    got = names(await _pet_tools({}))
    assert {"pet_focus_start", "pet_water_drink", "pet_mood_set"} <= got
    for unwelcome in ("vault_write_file", "memory_delete", "image_gen", "web_search", "fetch_url"):
        assert unwelcome not in got, unwelcome


async def test_the_whitelist_also_filters_the_builtin_tools():
    """内置工具不走插件运行时。**只过滤一边，白名单就是摆设。**"""
    await _tables()
    specs = await _pet_tools({"pet_tools": ["kb_search", "pet_water_drink"]})
    assert names(specs) == {"kb_search", "pet_water_drink"}


# ---------- 破坏性工具：零柒与 chat 用**同一条**口头授权规则（§4.1 ①，2026-09-22） ----------


async def test_zero_seven_only_gets_the_delete_tool_when_you_ask():
    """默认那套白名单里本来就没有 `memory_delete`，但白名单是**用户可以自己改的**——
    所以"能不能删"不能只靠默认值说话：明说了才给，没明说就算白名单里有也不给。

    这条与 `test_destructive_gate.py` 里 chat 那条是**同一个判据的两条路**：分叉的那天，
    两条路的行为会不一样而没人发现。
    """
    await _tables()
    prefs = {"pet_tools": ["memory_list", "memory_delete"]}

    plain = names(await _pet_tools(prefs, ask="今天心情不错"))
    assert "memory_delete" not in plain, "没让我删，零柒手里不该有那只手"
    assert "memory_list" in plain, "只拦破坏性的那一个"

    asked = names(await _pet_tools(prefs, ask="忘掉那条关于早睡的偏好"))
    assert "memory_delete" in asked, "明说了要忘掉，工具得给"
