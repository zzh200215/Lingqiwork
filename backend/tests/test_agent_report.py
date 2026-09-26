"""A0 基线进计量局那一格的测试（`app/core/agent_report.py` + 那条路由）。

两个重点，都不是"字段对不对"那类：
  1. **读不到与读坏了要说不同的话**（还没有报告 / 报告坏了 / 不是一个对象）——界面照实说，
     不给一排 0 充数（北极星那几张卡同一条口径）；
  2. **红线**：这个模块只读**跑分落下来的报告**，不 import 尺子、不碰金标。
"""
import json
import sys

sys.path.insert(0, ".")

from app.core import agent_report as ar  # noqa: E402

_REPORT = {
    "at": "2026-09-20 23:10:00",
    "seconds": 1035.7,
    "model_id": "sensenova/sensenova-6.8-flash-lite",
    "tasks": 19,
    "tasks_sha": "7432ac9669fd",
    "prompt_sha": "d583da7e7f2f",
    "done": 19,
    "done_rate": 1.0,
    "clean": 12,
    "clean_rate": 0.6316,
    "floor_failures": 0,
    "tool_not_allowed": 1,
    "tool_not_used": 0,
    "over_budget": 3,
    "errors": 0,
    "trace_missing": 0,
    "rounds": {"median": 3, "p90": 5, "max": 7, "mean": 3.68},
    "counts": {"over_budget": 3, "not_delegated": 3},
    "by_tag": {"deliver": {"tasks": 10, "done": 10}},
    "delegated_turns": 0,
    "delegate_calls": 0,
    "delegate_rounds": 0,
    "delegate_expected": 3,
    "delegate_missed": 3,
    # 报告里真正大的那一段：**不该**进载荷（逐条回复，几百 KB）
    "detail": [{"id": "x", "reply": "…" * 5000}],
}


def _write(tmp_path, payload) -> str:
    p = tmp_path / "agent_baseline.json"
    if isinstance(payload, str):
        p.write_text(payload, encoding="utf-8")
    else:
        p.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return str(p)


def test_a_report_is_projected_without_the_detail_blob(tmp_path):
    out = ar.view(_write(tmp_path, _REPORT))
    assert out["readable"] is True
    assert out["done"] == 19 and out["done_rate"] == 1.0
    assert out["delegate_missed"] == 3  # A1/A2 那两笔也要上墙
    assert out["tasks_sha"] == "7432ac9669fd"
    assert "detail" not in out, "逐条回复几百 KB，计量局那一格不该端它"
    # 口径是**逐行原文**（`MetricCard` 的纪律：界面不自己编一句说法）
    assert isinstance(out["rules"], dict) and out["rules"]["when"]
    assert "跑分当时" in out["rules"]["when"]


def test_no_report_yet_is_not_the_same_as_a_broken_one(tmp_path):
    """「还没跑过」与「读不出来」各说各的话——两张不同的脸，不给一排 0。"""
    missing = ar.view(tmp_path / "nope.json")
    assert missing["readable"] is False and "还没有跑过" in missing["error"]

    broken = ar.view(_write(tmp_path, "{ 这不是 json"))
    assert broken["readable"] is False and "读不出来" in broken["error"]

    not_object = ar.view(_write(tmp_path, "[1, 2, 3]"))
    assert not_object["readable"] is False and "不是一个对象" in not_object["error"]


def test_a_report_without_a_fingerprint_says_so(tmp_path):
    """指纹缺了不等于读不出来，但**要比不了**这件事得让读的人知道（`--compare` 就靠它）。"""
    payload = {k: v for k, v in _REPORT.items() if k != "tasks_sha"}
    out = ar.view(_write(tmp_path, payload))
    assert out["readable"] is True and out["sha_missing"] is True


def test_the_module_reads_the_report_and_never_the_gold_set():
    """红线：投影层不 import 尺子、不读金标目录（`Agent升级.md` §0 红线 #3）。

    这条与 `test_agent_eval.py` 那条运行期扫描是同一条纪律，只是这里把范围收到这一个模块上
    ——它离"顺手 import 一下尺子算个指纹"只有一步之遥，所以就近钉一颗钉子。
    """
    import ast
    from pathlib import Path

    src = Path(ar.__file__).read_text(encoding="utf-8")
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert not any("agent_eval" in a.name for a in node.names), "投影层 import 了尺子"
        elif isinstance(node, ast.ImportFrom):
            assert "agent_eval" not in (node.module or ""), "投影层 import 了尺子"
    assert "evals/agent" not in src and "evals\\agent" not in src, "投影层读了金标目录"
    assert ar.REPORT_NAME == "agent_baseline.json"


def test_the_route_serves_the_same_projection(monkeypatch, tmp_path):
    """路由只转手：它报的数与 `view()` 是同一个（界面不自己再算一份）。"""
    from fastapi.testclient import TestClient

    from app.core import auth

    monkeypatch.setattr(ar, "report_path", lambda: tmp_path / "agent_baseline.json")
    (tmp_path / "agent_baseline.json").write_text(
        json.dumps(_REPORT, ensure_ascii=False), encoding="utf-8"
    )
    monkeypatch.setenv("WB_API_TOKEN", "test-token-123")
    monkeypatch.setattr(auth, "_cached", None)
    from app.main import app

    client = TestClient(app)
    r = client.get("/api/dashboard/agent-eval", headers={auth.HEADER: "test-token-123"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["readable"] is True and body["done"] == 19
    assert body["rules"] == ar.RULES