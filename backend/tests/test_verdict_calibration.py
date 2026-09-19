"""会话侧校准（PLAN2 P2-3）的离线测试。

这一格钉四件事：

1. **分堆按「谁定的」**：`tutor_sessions.judged_sha` 非空 = 判分器判的（存判它的那一版），
   空 = 你自己标的——一个字段回答两个问题，因为会话侧**没有**「判过但不知道哪一版」那批
   历史行（真库当时 0 场），所以不需要卡片侧那样的两列；
2. **说通率的分子分母**：说通 /（说通 + 半懂），**「没用」不进分母**（教学没成，证明不了水平，
   与 `is_mastered` / `concepts()` 同一条规矩）；没标 verdict 的会话一条都不进；
3. **样本小是结论不是缺陷**：两个比率各带 95% Wilson 区间，区间不重叠才算 `decidable`
   ——会话比卡片少得多，这一条大部分时候会是 `false`，那就如实摆着；
4. **红线沿用**：这条数只进仪表盘，跑完一遍宠物一个字都没说。
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, ".")

from app.core import pet as pet_core  # noqa: E402
from app.core import retell as rt  # noqa: E402
from app.core import tutor  # noqa: E402
from app.db import SessionLocal, engine as _engine  # noqa: E402
from app.models import Base as _Base  # noqa: E402
from app.models import PetEvent, TutorSession  # noqa: E402

NOW = datetime.now().astimezone()


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


def _naive_utc(when: datetime) -> datetime:
    """库里那几列的口径：naive UTC。"""
    return when.astimezone(timezone.utc).replace(tzinfo=None)


@pytest.fixture(autouse=True)
def _clean():
    from sqlalchemy import delete

    async def _go() -> None:
        async with SessionLocal() as db:
            for model in (TutorSession, PetEvent):
                await db.execute(delete(model))
            await db.commit()

    asyncio.run(_go())
    yield


async def _session(
    verdict: str, *, sha: str = "", days_ago: float = 0.0, ended: bool = True
) -> int:
    """一场已结束的会话。`sha` 非空 = 这个 verdict 是判分器定的。"""
    when = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days_ago)
    async with SessionLocal() as db:
        row = TutorSession(
            topic="随便讲讲",
            concept="某个概念",
            verdict=verdict,
            judged_sha=sha,
            created_at=when,
            ended_at=when if ended else None,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


# ---------- 纯函数：两边的比率与「看得出来吗」 ----------


def test_a_rate_with_no_samples_is_none_not_zero():
    """一场都没有 → `rate=None`（不是 0）。0 是「全都说通了」，两回事。"""
    out = tutor.rate_ci(0, 0)
    assert out["rate"] is None and out["n"] == 0 and out["tell"] is False
    assert out["ci"] == [0.0, 1.0]  # 「什么都不知道」的区间


def test_verdict_rates_split_by_who_decided():
    """分堆**只**按 `judged_sha` 非空分；「没用」进分布但不进说通率的分母。"""
    out = tutor.verdict_rates(
        [
            ("got", ""),  # 自己标的
            ("half", ""),
            ("useless", ""),  # 不进分母
            ("got", "6c6b1852e876"),  # 让它判的
            ("got", "6c6b1852e876"),
            ("half", "6c6b1852e876"),
            ("useless", "6c6b1852e876"),
            ("", ""),  # 没标 verdict：两边都不进
        ]
    )
    assert out["self"]["dist"] == {"got": 1, "half": 1, "useless": 1}
    assert out["self"]["n"] == 2 and out["self"]["rate"] == 0.5
    assert out["judged"]["dist"] == {"got": 2, "half": 1, "useless": 1}
    assert out["judged"]["n"] == 3 and out["judged"]["rate"] == 0.667
    assert out["gap"] == round(0.5 - 0.667, 3)
    assert out["decidable"] is False  # n=2 vs 3：区间宽得重叠


def test_small_samples_are_not_decidable_and_big_ones_are():
    """样本小是**结论**不是缺陷：靠区间重不重叠说话，不靠一个好看的比例。"""
    small = tutor.verdict_rates([("got", "")] + [("half", f"sha{i}") for i in range(4)])
    assert small["decidable"] is False
    # 一边 40 场里 38 场说通、另一边 40 场里 8 场：区间不重叠 → 看得出来
    rows = [("got", "")] * 38 + [("half", "")] * 2 + [("got", "s")] * 8 + [("half", "s")] * 32
    big = tutor.verdict_rates(rows)
    assert big["self"]["rate"] == 0.95 and big["judged"]["rate"] == 0.2
    assert big["decidable"] is True and big["self"]["tell"] is True
    assert big["gap"] == 0.75


def test_one_side_missing_is_no_gap_at_all():
    """只有自评（还没用过「让它判」）→ `gap=None`，不是把一边当成 0。"""
    out = tutor.verdict_rates([("got", ""), ("half", "")])
    assert out["judged"]["n"] == 0 and out["judged"]["rate"] is None
    assert out["gap"] is None and out["decidable"] is False


# ---------- 真行：谁定的这一列 ----------


async def test_end_records_who_decided_and_a_later_mark_overwrites_it(monkeypatch):
    """`end()` 每次都**无条件重写**这一列：谁最后落定就记谁。

    不这么做的话，一场「先自己标、后来让它判」的会话会留着「自评」这个已经不再成立的
    说法——而这一列存在的全部意义就是说得准。
    """
    async def fake_extract(session_id, topic, model_id):  # noqa: ANN001, ARG001
        return "", "", "", "", ""

    monkeypatch.setattr(tutor, "_extract", fake_extract)
    sid = await _session("")

    await tutor.end(sid, "half")
    async with SessionLocal() as db:
        assert (await db.get(TutorSession, sid)).judged_sha == ""

    sha = rt.session_judge_sha()
    assert len(sha) == 12
    await tutor.end(sid, "got", judged_sha=sha)
    async with SessionLocal() as db:
        assert (await db.get(TutorSession, sid)).judged_sha == sha

    await tutor.end(sid, "half")  # 自己改回去 → 「谁定的」跟着回到自评
    async with SessionLocal() as db:
        assert (await db.get(TutorSession, sid)).judged_sha == ""


async def test_the_endpoint_reads_what_the_rows_say():
    """真行：窗口、verdict、谁定的三样都按账面算。"""
    sha = rt.session_judge_sha()
    await _session("got")
    await _session("half")
    await _session("useless")
    await _session("got", sha=sha)
    await _session("half", sha=sha)
    await _session("got", days_ago=400)  # 窗口外（默认 90 天）
    await _session("got", ended=False)  # 没结束的会话不进（`ended_at` 是 verdict 的同生共死那一边）
    await _session("", sha=sha)  # 没标 verdict

    out = await tutor.verdict_calibration()
    assert out["readable"] is True and out["error"] == ""
    assert out["days"] == tutor.CALIB_DAYS
    assert out["self"]["dist"] == {"got": 1, "half": 1, "useless": 1}
    assert out["judged"]["dist"] == {"got": 1, "half": 1, "useless": 0}
    assert (out["self"]["rate"], out["judged"]["rate"]) == (0.5, 0.5)
    assert out["gap"] == 0.0 and out["decidable"] is False
    assert out["judge_sha"] == sha and out["mixed"] is False
    # 口径随数一起给出来（界面照抄，不自己编一份说法）
    assert set(out["rules"]) >= {"rate", "window", "confound", "small"}
    assert "不是同一批会话" in out["rules"]["confound"]


async def test_a_second_judge_version_is_flagged():
    """换过判分提示词之后，「让它判的」那一边就不是一把尺子量的了——要说出来。"""
    await _session("got", sha=rt.session_judge_sha())
    await _session("half", sha="deadbeef0000")
    out = await tutor.verdict_calibration()
    assert out["mixed"] is True and "不止一版" in out["rules"].get("mixed", "")


async def test_reading_it_failing_is_not_a_zero_line(monkeypatch):
    """读不出来照实说，不给一个「两边都是 0」的形状。"""
    # 让那次查询自己炸：把 select 换成一个一调用就抛的（tutor 里是函数内 import 的
    # `from sqlalchemy import select`，所以换模块属性就够）。
    from app.core import pet

    def bad_bounds(_day):  # noqa: ANN001 - 窗口换算在查询之前，换掉它就等于库读不动
        raise RuntimeError("db down")

    monkeypatch.setattr(pet, "local_day_utc_bounds", bad_bounds)
    out = await tutor.verdict_calibration()
    assert out["readable"] is False and "db down" in out["error"]
    assert out["self"]["rate"] is None and out["judged"]["rate"] is None
    assert out["gap"] is None


async def test_the_judge_path_stamps_the_version(monkeypatch):
    """接线：`/sessions/{id}/judge` 那条路落下来的行必须带着**判分器**的标记。"""
    sid = await _session("")

    async def fake_judge(session_id, *, model_id="", stream_fn=None):  # noqa: ANN001, ARG001
        return {"ok": True, "verdict": "half", "missed_points": ["没说清归属"], "model_id": "p/m"}

    async def fake_extract(session_id, topic, model_id):  # noqa: ANN001, ARG001
        return "", "", "", "", ""

    monkeypatch.setattr(rt, "judge_session", fake_judge)
    monkeypatch.setattr(tutor, "_extract", fake_extract)

    from app.routers import tutor as tutor_router

    out = await tutor_router.judge_session(sid, tutor_router.JudgeIn())
    assert out["judged"] is True and out["verdict"] == "half"
    async with SessionLocal() as db:
        row = await db.get(TutorSession, sid)
    assert row.verdict == "half"
    assert row.judged_sha == rt.session_judge_sha(), "判分那条路必须把版本带上"


async def test_the_pet_says_nothing_about_it():
    """红线（与卡片侧那条同一条）：跑完这条数，宠物一个字都没说。"""
    await _session("got", sha=rt.session_judge_sha())
    await _session("half")
    await tutor.verdict_calibration()
    assert pet_core.feed(limit=50) == []


def test_http_endpoint(monkeypatch):
    monkeypatch.setenv("WB_API_TOKEN", "t")
    from fastapi.testclient import TestClient

    from app.core import auth
    from app.main import app

    monkeypatch.setattr(auth, "_cached", None)
    c = TestClient(app)
    h = {"X-WB-Token": "t"}
    assert c.get("/api/tutor/calibration").status_code == 401
    body = c.get("/api/tutor/calibration", headers=h).json()
    assert body["readable"] is True
    assert body["days"] == tutor.CALIB_DAYS
    assert "self" in body and "judged" in body and "rules" in body
