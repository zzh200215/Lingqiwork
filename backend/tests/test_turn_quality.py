"""W2a 的两条底线判据（`core/turn_quality.py`）—— 逐条钉住，并把「不该触发」也钉住。

这一层要守的不是「函数能不能跑」，是**它什么时候不许说话**：

- 「长正文 + 没落盘」在用户**没要求落盘**时不许触发补跑。实测里模型对「写一份周报」
  这种自然说法常常只当一次回答（两批 1/18 会存），但**判断「这算不算一份成品」不是
  W2a 的活**（那是 W3 的路由），在这里猜错的代价是把闲聊变成产出。
- 「编造路径」不许重试：模型已经存对了东西，只是正文里多写了个不存在的路径 ——
  再问一遍既救不了那句话，又白花一次调用。
- 正确拒绝（「没有素材，我不想凭空编」）不许被当成失守来逼它编 —— 补跑那句话里
  必须留着「不该存就说明理由」这条退路。
"""
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

from app.core import turn_quality as tq  # noqa: E402

LONG = "这周的工作可以分成三段来讲。" + "每段都写得很细，" * 50  # > 400 字


@pytest.fixture
def scratch():
    """临时目录。**不用 `tmp_path`**：这台机器上 pytest 的 basetemp
    （`C:\\Users\\TX\\AppData\\Local\\Temp\\pytest-of-TX`）建不出来，`PermissionError`。"""
    p = Path(tempfile.mkdtemp(prefix="wb-quality-"))
    try:
        yield p
    finally:
        shutil.rmtree(p, ignore_errors=True)


# ---------- 长正文 + 没落盘 ----------


def test_a_long_body_with_no_receipt_is_a_finding():
    bad = tq.findings(LONG, [])
    assert [f["code"] for f in bad] == ["long_body_without_a_receipt"]
    assert tq.long_body_without_a_receipt(LONG, [])


def test_a_receipt_clears_it_even_if_the_body_is_long():
    """有回执就不算 —— 正文长短不是判据，**有没有落盘**才是。"""
    assert not tq.long_body_without_a_receipt(LONG, [{"path": "deliver/x.md"}])
    assert tq.findings(LONG, [{"path": "deliver/x.md"}]) == []


def test_a_short_answer_is_not_a_finding():
    """问一个问题得到三句话，不是「该存没存」。阈值 400 字与账本的筛子同一个数。"""
    assert not tq.long_body_without_a_receipt("索引让查询变快，因为它把全表扫描换成了树查找。", [])
    assert tq.LONG_BODY_CHARS == 400


def test_the_threshold_is_inclusive():
    assert tq.long_body_without_a_receipt("好" * 399, []) is False
    assert tq.long_body_without_a_receipt("好" * 400, []) is True


# ---------- 编造路径 ----------


def test_a_path_that_is_not_in_this_turns_receipts_is_reported():
    bad = tq.findings("已经存好了：recap/2026-09-14-本周周报-精简版.md", [])
    assert [f["code"] for f in bad] == ["invented_path"]
    assert "recap/2026-09-14-本周周报-精简版.md" in bad[0]["detail"]


def test_a_path_that_matches_a_receipt_is_fine():
    arts = [{"path": "deliver/2026-09-15-周报.md"}]
    assert tq.invented_path_in_reply("已存入产出：deliver/2026-09-15-周报.md", arts) == ""
    assert tq.findings("已存入产出：deliver/2026-09-15-周报.md", arts) == []


def test_case_and_leading_dot_slash_do_not_create_a_false_alarm():
    """同一份东西写成 `./Deliver/X.MD` 不是编造 —— 归一化后再比。"""
    arts = [{"path": "deliver/X.md"}]
    assert tq.invented_path_in_reply("存到了 ./Deliver/X.MD", arts) == ""


def test_only_the_first_invented_path_is_reported():
    """一条就够触发拦截；全列出来只会把日志和界面淹掉。"""
    out = tq.invented_path_in_reply("见 recap/a.md 和 notes/b.md", [])
    assert out == "recap/a.md"


def test_a_chinese_slash_is_not_a_path():
    """「注意 / 这一点」这种写法很常见，不许被当成路径。"""
    assert tq.invented_path_in_reply("注意 / 这一点：本周的重点是检索阈值。", []) == ""


def test_a_bare_filename_is_not_a_path():
    """只有一个文件名、没有目录分隔，误报风险太高（正文里到处是「周报.md」这种提法）。"""
    assert tq.invented_path_in_reply("文件叫 周报.md，已经存好了。", []) == ""


def test_a_non_markdown_path_is_not_a_path():
    """只管 vault 里真的会有的那几种后缀 —— 别的路径说法多半是在讲代码。"""
    assert tq.invented_path_in_reply("看 src/app/core/llm.py 里的实现。", []) == ""


# ---------- 该不该补跑（三个「不」） ----------


def test_a_long_body_the_user_asked_to_save_is_worth_one_retry():
    bad = tq.findings(LONG, [])
    assert tq.should_retry(bad, "把这周的进展整理成一份周报，存进产出。") is True
    assert tq.retry_instruction(bad, "存进产出")


def test_a_long_body_nobody_asked_to_save_is_not_retried():
    """**这一条最重要**：猜「这算不算成品」是 W3 的事，W2a 不许在这里下手。"""
    bad = tq.findings(LONG, [])
    assert tq.should_retry(bad, "讲讲数据库索引为什么能让查询变快。") is False
    assert tq.retry_instruction(bad, "讲讲数据库索引为什么能让查询变快。") == ""


def test_a_long_body_with_a_save_claim_is_retried_even_without_an_explicit_ask():
    """**实测那 2/22 轮的形状**：正文摊在对话里，开头写着「已存入产出」（自然说法，用户没
    说「存进产出」）。它自己都认定这是一次交付了，补跑不涉及「把闲聊变成产出」那个风险。"""
    bad = tq.findings("已存入产出（约 100 字）。\n" + LONG, [])
    assert {f["code"] for f in bad} == {"claims_a_save_without_one", "long_body_without_a_receipt"}
    assert tq.should_retry(bad, "帮我写一份本周周报，300 字左右。") is True


def test_a_plain_long_explanation_without_a_claim_is_not_retried():
    """又长、又没落盘、也**没说是交付** —— 那可能就是在详细解释一件事（或者是一次
    「没有素材，我不想凭空编」的正确拒绝）。一次都不补。"""
    for bad in (tq.findings(LONG, []), tq.findings("我不想凭空编一份周报。\n" + LONG, [])):
        assert bad and bad[0]["code"] == "long_body_without_a_receipt"
        assert tq.should_retry(bad, "讲讲数据库索引为什么能让查询变快。") is False


def test_a_delivery_verdict_from_the_router_is_enough_to_retry():
    """W3 接上之后补上的那条：自然说法「帮我写一份本周周报」不带「存」字，
    以前根本不会补跑（W2a 的边界），现在由路由判定「这是交付型」来触发。"""
    bad = tq.findings(LONG, [])
    assert tq.should_retry(bad, "帮我写一份本周周报，300 字左右。", delivery=False) is False
    assert tq.should_retry(bad, "帮我写一份本周周报，300 字左右。", delivery=True) is True
    assert tq.retry_instruction(bad, "帮我写一份本周周报，300 字左右。", delivery=True)


def test_a_chat_verdict_still_never_retries():
    """路由说闲聊，就一次都不补 —— 误判的代价是把闲聊变成产出。"""
    bad = tq.findings(LONG, [])
    assert tq.should_retry(bad, "讲讲 asyncio 是怎么工作的。", delivery=False) is False


def test_an_invented_path_is_never_retried():
    """救不了那句话（它已经说出去了），重跑只是白花一次调用。"""
    bad = tq.findings("产出在 recap/x.md 里。", [])
    assert [f["code"] for f in bad] == ["invented_path"]
    assert tq.should_retry(bad, "存进产出") is False


def test_an_invented_path_plus_a_long_body_still_does_not_retry_without_a_save_ask():
    bad = tq.findings(LONG + "\n见 recap/x.md", [])
    assert {f["code"] for f in bad} == {"long_body_without_a_receipt", "invented_path"}
    assert tq.should_retry(bad, "写一份周报") is False


def test_a_claim_without_a_receipt_and_no_long_body_is_not_retried():
    """「已存入产出」+ 一句短话：正文不是成品，重跑一轮的收益抵不上一次调用。"""
    bad = tq.findings("已存入产出：周报（约 300 字）。", [])
    assert "claims_a_save_without_one" in [f["code"] for f in bad]
    assert tq.should_retry(bad, "存进产出") is False


def test_nothing_wrong_means_no_retry():
    assert tq.should_retry([], "存进产出") is False


def test_the_retry_instruction_keeps_a_way_out():
    """留退路：模型上一轮可能是在**正确地拒绝**（空 vault 下「我不想凭空编」）。"""
    text = tq.retry_instruction(tq.findings(LONG, []), "存进产出")
    assert "save_artifact" in text
    assert "不要为了落盘而编内容" in text


def test_the_retry_instruction_says_what_was_missing():
    text = tq.retry_instruction(tq.findings(LONG, []), "存进产出")
    assert "上一轮" in text and "回执" in text


# ---------- 回执白名单（带文件系统检查） ----------


def test_a_receipt_outside_the_vault_is_refused(scratch):
    assert tq.receipt_problem({"path": "../../secrets.md"}, scratch)
    assert tq.receipt_problem({"path": "/etc/passwd.md"}, scratch)
    assert tq.receipt_problem({"path": "C:/x/y.md"}, scratch)
    assert tq.receipt_problem({"path": ""}, scratch)
    assert tq.receipt_problem("不是对象", scratch)


def test_a_receipt_pointing_at_nothing_is_refused(scratch):
    why = tq.receipt_problem({"path": "deliver/没有这份.md"}, scratch)
    assert why and "盘上" in why


def test_a_real_file_passes(scratch):
    p = scratch / "deliver"
    p.mkdir()
    (p / "周报.md").write_text("# 周报\n", encoding="utf-8")
    assert tq.receipt_problem({"path": "deliver/周报.md"}, scratch) == ""


def test_drop_broken_receipts_keeps_the_good_ones_and_says_why(scratch):
    good = {"path": "deliver/好的.md"}
    (scratch / "deliver").mkdir()
    (scratch / "deliver" / "好的.md").write_text("x", encoding="utf-8")
    kept, dropped = tq.drop_broken_receipts([good, {"path": "recap/编的.md"}], scratch)
    assert kept == [good]
    assert len(dropped) == 1 and dropped[0]["path"] == "recap/编的.md" and dropped[0]["why"]


def test_the_default_vault_is_the_one_mcp_actually_writes_to(monkeypatch, scratch):
    """**读 `mcp.VAULT_DIR`，不是 `app.config.VAULT_DIR`** —— 落盘走的是前者，
    而评测会把前者临时换成 scratch 目录。跟着 config 走就会去校验另一个地方。"""
    from app.core import mcp

    (scratch / "deliver").mkdir()
    (scratch / "deliver" / "a.md").write_text("x", encoding="utf-8")
    monkeypatch.setattr(mcp, "VAULT_DIR", scratch)
    assert tq.receipt_problem({"path": "deliver/a.md"}) == ""
