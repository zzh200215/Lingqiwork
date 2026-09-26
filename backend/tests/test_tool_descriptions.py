"""工具描述：**瘦身不许丢事实**（A3 第一步，2026-09-22）。

背景：A3 从"数工具 >20"改成症状驱动之后，**成本**是今天唯一有读数的那个症状——12 个工具的
定义在**每一轮**都重发一遍（瘦身前 4206 字，而同一次普通回合的 system 只有 402 字）。
第一步做的是**瘦身**：砍掉与 `chat._OUTPUT_RULE` 重复的话术、压缩铺陈，**不是**改能力。

这一层钉三件事：

1. **工具 API 没动**——名字、参数名、必填项一个都没改（动它们就是改 API，得走另一套流程：
   金标、白名单、`READONLY_TOOLS`、注入段点名的工具名全都跟着动）；
2. **每条描述点名的"事实"逐条还在**——少了哪一条，就是把能力悄悄说没了；
3. **总字数有个预算**——注意它是**预算不是阈值**：是我们给这一栏定的目标，不是量出来的界线
   （A3 刚因为"拿估计值当线"改过一回，别在同一个坑里再踩一次）。
"""
import json
import sys

sys.path.insert(0, ".")

from app.core import mcp  # noqa: E402

# 工具表本身（名字 + 每个工具的参数名 + 必填项）。**瘦身不该动这里一个字符。**
API = {
    "vault_read_file": (["path"], ["path"]),
    "vault_list_files": (["path"], []),
    "vault_write_file": (["path", "content"], ["path", "content"]),
    "save_artifact": (["kind", "title", "content", "length_budget"], ["title", "content"]),
    "fetch_url": (["url"], ["url"]),
    "web_search": (["query"], ["query"]),
    "kb_search": (["query", "top_k"], ["query"]),
    "image_gen": (["prompt", "size"], ["prompt"]),
    "memory_save": (["content"], ["content"]),
    "memory_list": ([], []),
    "memory_delete": (["id", "content"], []),
    "skill_load": (["name"], ["name"]),
    "delegate": (["task", "agent_name", "model_id", "tools"], ["task"]),
}

# 每条描述里**必须留着的事实**（挑的是"少了它模型就会做错事"的那些，不是措辞）。
FACTS = {
    "save_artifact": ["产出区", "产出清单", "content", "已存入产出", "两次", "覆盖", "字数", "额度"],
    "delegate": ["子代理", "task", "只读", "tools", "3 轮", "不能", "别委托"],
    "vault_write_file": ["覆盖", "索引"],
    "kb_search": ["知识库", "来源"],
    "web_search": ["链接", "fetch_url"],
    "image_gen": ["markdown", "30-90", "别重复"],
    "skill_load": ["完整指令", "系统提示"],
    "memory_save": ["长期记忆", "别记普通聊天"],
    "memory_delete": ["删除", "memory_list"],
    "vault_read_file": ["vault"],
    "vault_list_files": ["vault"],
    "fetch_url": ["网页"],
    "memory_list": ["长期记忆"],
}

# **预算**（我们定的，不是量出来的线）：瘦身前 4206 字。
# 留一点余量是为了下次加工具时不必为了过测试而硬砍事实。
BUDGET_CHARS = 3950
BUDGET_PER_DESC = 180


def _by_name() -> dict:
    return {b["name"]: b for b in mcp.BUILTIN_TOOLS}


def test_the_tool_api_did_not_change():
    """瘦身只动描述。名字/参数/必填项漂了 = 改的是 API，不是话术。"""
    got = _by_name()
    assert set(got) == set(API), "工具表本身变了"
    for name, (props, required) in API.items():
        spec = got[name]
        assert sorted(spec["parameters"]["properties"]) == sorted(props), name
        assert sorted(spec["parameters"].get("required", [])) == sorted(required), name


def test_every_fact_survived():
    """逐条点名的事实：**一条都不许少**（少了就是把能力说没了，而测试是唯一会发现的地方）。"""
    got = _by_name()
    for name, words in FACTS.items():
        text = got[name]["description"]
        missing = [w for w in words if w not in text]
        assert not missing, f"{name} 的描述里少了 {missing}"


def test_the_genre_mapping_is_still_spelled_out():
    """`kind` 是英文枚举，中文体裁名写在它的描述里——**那是模型唯一能把「周报」映射到
    `deliver` 的地方**，瘦身时最容易顺手删掉。"""
    kind = _by_name()["save_artifact"]["parameters"]["properties"]["kind"]
    assert set(kind["enum"]) == set(mcp._ARTIFACT_KINDS)  # noqa: SLF001
    for genre in mcp._ARTIFACT_KINDS:  # noqa: SLF001
        assert genre in kind["description"], genre


def test_the_budget_holds():
    """预算：总字数与单条描述。**它是预算不是阈值**——超了就是该瘦身了，不是"到线了要动手"。"""
    inv = mcp.mcp_manager.inventory(include_memory=True, include_delegate=True)
    assert inv["chars"] <= BUDGET_CHARS, f"工具定义 {inv['chars']} 字，超了预算 {BUDGET_CHARS}"
    for b in mcp.BUILTIN_TOOLS:
        assert len(b["description"]) <= BUDGET_PER_DESC, b["name"]


def test_the_shrink_actually_shrank():
    """**改完要看得出来改了**：瘦身前那份是 4206 字（`Agent升级.md` §2 A3 记着这个数）。

    这一条不是"钉住一个数字"，而是防止"以后有人把话术加回来、预算悄悄被顶到上限"——
    真加回来了，这里会先红。
    """
    inv = mcp.mcp_manager.inventory(include_memory=True, include_delegate=True)
    assert inv["chars"] < 4206, "没瘦下来？先看看描述是不是又被写长了"
    biggest = inv["biggest"][0]
    assert biggest["chars"] < 700, biggest


def test_the_biggest_two_are_no_longer_the_old_bloat():
    """瘦身的靶子就是这两个（原来 save_artifact 827 / delegate 746 字）。

    量法与 `inventory()` 一致：**序列化交给模型的那份 spec**（`{"type","function",...}` 外壳
    也算钱）——`BUILTIN_TOOLS` 那份带 `handler`，不能直接 dumps。
    """
    specs = mcp.mcp_manager.tool_specs(include_memory=True, include_delegate=True)
    sizes = {
        s["function"]["name"]: len(json.dumps(s, ensure_ascii=False, separators=(",", ":")))
        for s in specs
    }
    assert sizes["save_artifact"] < 700, sizes["save_artifact"]
    assert sizes["delegate"] < 700, sizes["delegate"]
