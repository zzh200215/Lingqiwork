"""提示词模块的三条 AI 能力（生成 / 调优 / 提取变量）。

**这一层一条模型调用都不发**：花钱的部分只有 `_ask`，而它是唯一被设计成注入缝的地方。
被判的是「模型乱说的时候，这里会不会把半截当成品」——那是会**悄悄**错的地方：
一个空标题、一段被代码围栏包住的 JSON、模型把括号一起写进变量名，都能让界面上
出现一条看起来正常、其实没法用的提示词。

另有两条对着「提取变量」这个动作本身：它必须和对话页 `/` 唤起**实际会问到的变量**
对得上（`prompt_ai.vars_in` 与 `App.tsx::applyPrompt` 是同一条正则）。
"""
import pytest

from app.core import prompt_ai
from app.routers.prompts import VarsIn, ai_vars


# ---------- 读模型的话 ----------


def test_parse_generate_reads_through_code_fences():
    """模型爱把 JSON 包在 ```json 里，`clean_json` 就是为这一步存在的。"""
    raw = '```json\n{"title": "周报模板", "content": "写给{读者}的周报"}\n```'
    assert prompt_ai.parse_generate(raw) == {"title": "周报模板", "content": "写给{读者}的周报"}


def test_parse_generate_uses_the_first_line_when_the_model_forgets_a_title():
    """标题缺了不该报废整条——正文才是他要的东西。"""
    got = prompt_ai.parse_generate('{"content": "第一行就是标题\\n后面是正文"}')
    assert got["title"] == "第一行就是标题"
    assert got["content"].startswith("第一行就是标题")


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "抱歉，我不能帮你做这个。",  # 客套话，不是 JSON
        '{"title": "有标题但正文是空的", "content": "   "}',  # 空正文
        '{"content": ""}',
    ],
)
def test_parse_generate_refuses_to_hand_back_something_unusable(raw):
    """读不出来就抛——**别把半截当成品**塞进库里。"""
    with pytest.raises(ValueError):
        prompt_ai.parse_generate(raw)


def test_parse_refine_only_wants_the_content():
    assert prompt_ai.parse_refine('{"content": "改完的全文"}') == {"content": "改完的全文"}
    with pytest.raises(ValueError):
        prompt_ai.parse_refine('{"content": ""}')


def test_parse_vars_strips_braces_and_dedupes():
    """模型有时会把花括号一起写进变量名（`{主题}`）——带进去用户就永远填不上。"""
    got = prompt_ai.parse_vars('{"vars": ["{主题}", "读者", " 主题 ", "", "读者"]}')
    assert got == ["主题", "读者"]


def test_parse_vars_on_a_non_list_is_an_empty_list_not_a_crash():
    assert prompt_ai.parse_vars('{"vars": "主题"}') == []
    assert prompt_ai.parse_vars("不是 JSON") == []


# ---------- 本地那条正则：必须和 `/` 唤起问的对得上 ----------


def test_vars_in_matches_what_the_slash_menu_would_ask():
    """`App.tsx::applyPrompt` 用的就是 `\\{([^{}\\n]{1,30})\\}`，两边必须一致。

    不一致的症状很难查：模型提了一批变量，可发出去时一个都不会被问到。
    """
    assert prompt_ai.vars_in("写给{读者}的{周数}周报") == ["读者", "周数"]
    assert prompt_ai.vars_in("没有变量") == []
    assert prompt_ai.vars_in("{重复}{重复}") == ["重复"]
    # 超过 30 字的不算变量（同一条正则的上界），空的不算
    assert prompt_ai.vars_in("{" + "长" * 31 + "}") == []
    assert prompt_ai.vars_in("{}") == []


# ---------- 退回本地，但要如实说 ----------


async def test_ai_vars_says_when_it_fell_back_to_the_local_scan(monkeypatch):
    """退回本地是好事，**悄悄退回**不是——那等于谎报来源。"""

    async def boom(_content: str) -> list[str]:
        raise RuntimeError("还没有启用的模型")

    monkeypatch.setattr(prompt_ai, "extract_vars", boom)
    got = await ai_vars(VarsIn(content="写给{读者}的周报"))

    assert got == {"vars": ["读者"], "via": "local"}


async def test_ai_vars_reports_the_model_when_the_model_worked(monkeypatch):
    async def ok(_content: str) -> list[str]:
        return ["主题"]

    monkeypatch.setattr(prompt_ai, "extract_vars", ok)
    got = await ai_vars(VarsIn(content="随便什么"))

    assert got == {"vars": ["主题"], "via": "model"}
