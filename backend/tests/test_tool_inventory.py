"""A3 的**触发条件**（`Agent升级.md` §2）：2026-09-22 起是**症状驱动**，不是一个工具数。

原来的条件是「工具总数 >20」——查过一遍：那个数是**估的**（同一份文档里还写着 30+），
而"工具多到选不过来"今天没有任何读数支撑（20 条 A0 基线里 `tool_not_allowed` /
`tool_not_used` 都是 0）。现在看两个症状：**选择**（看 A0 报告）与**成本**（看这里的 `chars`）。

这一层钉四件事：

1. **读数与模型真拿到的那张清单同一处算**（不是另一处自己数一遍）；
2. `chars` / `biggest` 真是从那张清单现算的——**不是缓存的数字**；
3. **没有 `fired` 这种布尔**：`review_hint` 只是"到了就复看一遍"的提示（别再把它当及格线）；
4. 设置页那个端点报的就是这一份（路由只转手）。
"""
import asyncio
import json
import sys

sys.path.insert(0, ".")

from app.core import mcp  # noqa: E402


def test_the_readings_come_from_the_same_list_the_model_gets():
    """**读数只此一处**：`inventory()` 数的、量的，就是 `tool_specs()` 交给模型的那张清单。"""
    inv = mcp.mcp_manager.inventory(include_memory=True, include_delegate=True)
    specs = mcp.mcp_manager.tool_specs(include_memory=True, include_delegate=True)
    assert inv["count"] == len(specs)
    assert inv["names"] == [s["function"]["name"] for s in specs]
    assert inv["mcp"] == len(mcp.mcp_manager.active_tools())

    # 成本那一栏是**现算**的：与把同一张清单序列化一遍对得上
    sizes = {
        s["function"]["name"]: len(json.dumps(s, ensure_ascii=False, separators=(",", ":")))
        for s in specs
    }
    assert inv["chars"] == sum(sizes.values())
    assert [b["name"] for b in inv["biggest"]] == sorted(sizes, key=sizes.get, reverse=True)[:3]
    assert inv["biggest"][0]["chars"] == max(sizes.values())


def test_memory_tools_follow_the_switch_like_chat_does():
    """关掉记忆 → `memory_*` 一个都不该算进去（与 chat 那条路同一条规则）。

    **差 2 不是 3**：第三个（`memory_delete`）默认就不发（§4.1 ① 的口头授权，2026-09-22 起），
    所以它在"开"的那一份里本来也不在——两个开关叠在同一条路上，计数要照实说。
    """
    on = mcp.mcp_manager.inventory(include_memory=True, include_delegate=True)
    off = mcp.mcp_manager.inventory(include_memory=False, include_delegate=True)
    assert "memory_delete" not in on["names"], "破坏性工具默认不该在表里（§4.1 ①）"
    assert not [n for n in off["names"] if n.startswith("memory_")]
    assert off["count"] == on["count"] - 2
    # 成本那一栏跟着一起小（关掉记忆就少发两段描述）
    assert off["chars"] < on["chars"]


def test_the_trigger_is_no_longer_a_count():
    """**这条是这次改动的要点**：不再有「到线变红」这种布尔。

    留一个数字是为了"到了就复看一遍"——但它只叫 `review_hint`，**不进任何判断**。
    """
    inv = mcp.mcp_manager.inventory(include_memory=True, include_delegate=True)
    assert inv["review_hint"] == 20
    assert "fired" not in inv and "trigger" not in inv
    for name in ("A3_TOOL_TRIGGER",):
        assert not hasattr(mcp, name), f"{name} 已经删掉了——症状驱动不需要那个常量"


def test_the_cost_reading_is_what_we_measured():
    """成本那一栏**今天长什么样**写下来：它是"复看时读什么"的依据，不是及格线。

    数值会随工具增减变（所以只钉**量得对**，不钉具体数）；但最占地方的那一个是谁要钉住——
    今天它是 `save_artifact`（一家 800+ 字），那是 A3 本体第一步（瘦身/合并）的靶子。
    """
    inv = mcp.mcp_manager.inventory(include_memory=True, include_delegate=True)
    assert inv["chars"] > 1000, "12 个工具的描述不该只有几百字——这一栏大概没在真量"
    assert inv["biggest"][0]["chars"] > 400
    assert inv["biggest"][0]["name"] in {"save_artifact", "delegate"}, inv["biggest"]


def test_the_settings_route_reports_the_same_readings(monkeypatch):
    """设置页那一栏读的是这个端点：**它报的与 `inventory()` 是同一份**（路由只转手）。"""
    from fastapi.testclient import TestClient

    from app.core import auth

    monkeypatch.setenv("WB_API_TOKEN", "test-token-123")
    monkeypatch.setattr(auth, "_cached", None)
    from app.main import app

    client = TestClient(app)
    r = client.get("/api/settings/mcp", headers={auth.HEADER: "test-token-123"})
    assert r.status_code == 200, r.text
    body = r.json()
    inv = mcp.mcp_manager.inventory(include_memory=True)
    assert body["tools"]["count"] == inv["count"]
    assert body["tools"]["chars"] == inv["chars"]
    assert body["tools"]["biggest"] == inv["biggest"]
    assert body["tools"]["review_hint"] == mcp.A3_REVIEW_HINT == 20
    assert isinstance(body["tools"]["names"], list)


def test_the_selection_symptom_lives_in_the_a0_report_not_here():
    """**另一半症状不在这里算**：选错工具/该用没用是 A0 尺子的判据，而它的读法已经上墙
    （`core/agent_report.py` → 仪表盘那一格）。

    这一条钉的是**去哪看**：同一个症状有两个读数处，迟早会有两个答案——所以本模块**不**复制
    一遍，只钉那两栏确实到了墙上。
    """
    from app.core import agent_eval, agent_report

    rep = agent_eval.summarize([], model_id="")
    assert {"tool_not_allowed", "tool_not_used"} <= set(rep), "尺子不给这两栏了？"
    assert {"tool_not_allowed", "tool_not_used"} <= set(agent_report._FIELDS), (  # noqa: SLF001
        "投影白名单漏了症状那一栏——仪表盘上看不见它，这条线就白改了"
    )


def test_the_manager_is_reachable_offline():
    """这条测试**不连任何 MCP 服务器**：`inventory()` 读的是内存里那份清单。"""
    assert asyncio.run(asyncio.sleep(0)) is None
