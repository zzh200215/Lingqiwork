"""零柒桌面小窗（desktop_pet.py）的纯函数测试。

表单/GDI+ 的部分只能在真机上验（真机验收记录在模块 docstring）；这里钉的是
台词断行、动作选择、久别重逢「只说一遍」的判定——它们错了，窗口上就是
错的内容。
"""
import sys
from pathlib import Path

sys.path.insert(0, ".")

from desktop_pet import pick_action, should_say, wrap_line  # noqa: E402


def test_wrap_line_breaks_cjk_by_width():
    lines = wrap_line("任务清零，概念未动，但三十个数。系统静默，你也睡吧。", width=12, max_lines=4)
    assert len(lines) == 3
    assert all(len(ln) <= 12 for ln in lines)
    assert "".join(lines) == "任务清零，概念未动，但三十个数。系统静默，你也睡吧。"


def test_wrap_line_empty_is_no_bubble():
    assert wrap_line("") == []
    assert wrap_line("   ") == []


def test_wrap_line_caps_at_max_lines_with_ellipsis():
    lines = wrap_line("一" * 50, width=10, max_lines=4)
    assert len(lines) == 4
    assert lines[-1].endswith("…")


def test_pick_action_flash_beats_state_until_it_expires():
    assert pick_action(100, ("jumping", 200), "running") == "jumping"
    assert pick_action(300, ("jumping", 200), "running-left") == "running-left"


def test_pick_action_unknown_falls_back_to_idle():
    assert pick_action(0, None, "moonwalk") == "idle"
    assert pick_action(0, ("moonwalk", 999), "idle") == "idle"


def test_returning_line_says_once():
    assert should_say("5 天没见。", "returning", said=False) is True
    assert should_say("5 天没见。", "returning", said=True) is False


def test_silent_modes_never_bubble():
    assert should_say("", "idle", False) is False
    # 普通状态台词只进面板，不冒泡（气泡是事件与重逢的）
    assert should_say("专注中，我不吵你。", "focusing", False) is False
