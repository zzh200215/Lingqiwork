"""dist 新鲜度闸（core/dist_stamp.py）：落后要说得出，新鲜要闭得上嘴。

这条闸是「只提示、不拦截」的，所以测试钉的是**消息本身的分寸**：
该喊的三种（没章 / 章读不出 / commit 不一致）都有话说，比不了的一种安静。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, ".")

from app.core.dist_stamp import current_head, stale_reason  # noqa: E402

HEAD = "a" * 40
OTHER = "b" * 40


def _stamp(tmp_path: Path, commit: str = HEAD) -> Path:
    p = tmp_path / ".wb-build.json"
    p.write_text(json.dumps({"commit": commit, "at": "2026-10-01T12:00:00"}), encoding="utf-8")
    return p


def test_fresh_dist_is_quiet(tmp_path):
    assert stale_reason(_stamp(tmp_path), HEAD) is None


def test_stale_commit_gets_a_reason_with_both_commits(tmp_path):
    reason = stale_reason(_stamp(tmp_path, OTHER), HEAD)
    assert reason is not None
    assert OTHER[:10] in reason and HEAD[:10] in reason


def test_missing_stamp_gets_a_reason(tmp_path):
    assert "npm run build" in (stale_reason(tmp_path / ".wb-build.json", HEAD) or "")


def test_unreadable_stamp_gets_a_reason(tmp_path):
    p = tmp_path / ".wb-build.json"
    p.write_text("{broken", encoding="utf-8")
    assert "npm run build" in (stale_reason(p, HEAD) or "")


def test_uncomparable_sides_stay_quiet(tmp_path):
    """没有 commit 的一边（zip 下载的包 / 不在 git 里）→ 比不了就不猜。"""
    p = _stamp(tmp_path)
    assert stale_reason(p, None) is None
    no_commit = tmp_path / "s2.json"
    no_commit.write_text(json.dumps({"at": "2026-10-01T12:00:00"}), encoding="utf-8")
    assert stale_reason(no_commit, HEAD) is None


def test_current_head_returns_none_outside_a_repo(tmp_path):
    assert current_head(tmp_path) is None
