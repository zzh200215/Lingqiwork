"""话题 × 技能 的确定性匹配（PLAN3 S1）：纯函数层 + 读盘那一层 + 红线。

不打模型、不碰真库、**也不碰真的 `skills/`**：那个目录由 fixture 指到 tmp
（`SKILLS_DIR` 是个模块全局，指到哪读到哪）。
"""
import ast
import atexit
import shutil
import tempfile
from pathlib import Path

import pytest

from app.core import skill_match, skills

# 临时目录开在仓库里（与 `test_skills.py` 同一个办法）：系统 temp 在有些环境里不可写。
_TMP = Path(tempfile.mkdtemp(prefix="wb-skillmatch-", dir=Path(".").resolve()))
atexit.register(lambda: shutil.rmtree(_TMP, ignore_errors=True))

# 一份与 `POSITIVE` 里的「给领导汇报这次项目的结论」对得上的技能（形状照 `candidates.draft`
# 落出来的那种：名字 + 一行「何时使用」）。
SKILL_NAME = "给领导写汇报要结论先行"
SKILL_DESC = "要把工作结果汇报给领导、需要一页纸讲清结论时用"
SKILL_BODY = "第一步：第一个小节就叫「结论」，一句话说清判断。"


@pytest.fixture(autouse=True)
def skill_dir(monkeypatch) -> Path:
    """技能目录指到临时目录（每个用例都是空的）——真 `skills/` 一个字节都不许动。"""
    d = _TMP / "skills"
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(skills, "SKILLS_DIR", d)
    return d


def _add_skill(root: Path, name: str = SKILL_NAME, description: str = SKILL_DESC,
               body: str = SKILL_BODY) -> None:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n", encoding="utf-8"
    )


def _listing(name: str = SKILL_NAME, description: str = SKILL_DESC) -> list[dict]:
    """`skills.list_skills()` 的形状。"""
    return [{"name": name, "description": description, "model": "", "tools": "", "files": [], "chars": 1}]


# ---------- 纯函数 ----------


def test_bigrams_are_two_char_shingles():
    assert skill_match.bigrams("汇报") == {"汇报"}
    assert skill_match.bigrams("结论先行") == {"结论", "论先", "先行"}
    # 单字话题仍是一个「gram」（不然一个字的话题永远匹配不上）
    assert skill_match.bigrams("报") == {"报"}
    assert skill_match.bigrams("  ") == set()


def test_cover_is_the_share_of_topic_bigrams_present():
    text = "要把工作结果汇报给领导、需要一页纸讲清结论时用"
    assert skill_match.cover("汇报", text) == 1.0
    assert skill_match.cover("唐诗里的意象怎么读", text) == 0.0
    # 部分对上：分母是话题自己的 gram 数（「汇报和诗」三个 gram 里只中一个）
    assert skill_match.cover("汇报和诗", text) == pytest.approx(1 / 3)


def test_hits_is_deterministic_and_ranked():
    """同输入同输出；分数降序；同分按名字排（不确定性会让留痕没法回放）。"""
    listing = _listing()
    first = skill_match.hits("给领导汇报这次项目的结论", listing)
    assert first == skill_match.hits("给领导汇报这次项目的结论", listing)
    assert first and first[0]["name"] == SKILL_NAME

    # 同分时按名字排：两份技能文本一样，名次不该随入参顺序变
    same = [
        {"name": "b 技能", "description": "同一段说明文字用来看名次"},
        {"name": "a 技能", "description": "同一段说明文字用来看名次"},
    ]
    assert [h["name"] for h in skill_match.hits("同一段说明文字", same)] == ["a 技能", "b 技能"]


def test_an_unrelated_topic_hits_nothing():
    """验收第 1 条：**无关话题 → 空集**（不是「总有个最近的」）。"""
    assert skill_match.hits("唐诗里的意象怎么读", _listing()) == []
    assert skill_match.hits("把这张图裁剪成正方形", _listing()) == []


def test_hits_caps_at_two():
    """验收第 1 条：命中数 ≤2（近重复会让好几份一起过线）。"""
    listing = [
        {"name": f"技能{i}", "description": "做竞品调研、需要按统一维度横向对比时用"}
        for i in range(5)
    ]
    assert len(skill_match.hits("把竞品的功能做个横向对比", listing)) == skill_match.MAX_INJECT == 2


def test_the_measured_numbers_are_written_down():
    """阈值不是拍的（PLAN3 §9.3 决策3）：天花板、被否的那一档、量它的那一页都在案上。"""
    src = Path("app/core/skill_match.py").read_text(encoding="utf-8")
    assert skill_match.RULER in src
    assert "0.273" in src  # 确定性那一档的实测天花板
    assert "0.592" in src  # 余弦那一档的天花板（离出厂阈值只剩 0.028，所以被否）
    assert skill_match.FLOOR_CEILING < skill_match.SKILL_FLOOR


def test_without_a_block_the_prompt_is_untouched():
    """验收第 2 条的反面：不命中 → **一个字都不多**（逐字节相同，不是「差不多」）。"""
    base = "你是产出引擎。"
    assert skill_match.with_skills(base, {"block": ""}) == base
    assert skill_match.with_skills(base, {}) == base
    assert skill_match.with_skills(base, {"names": ["x"], "block": "按这套工序做：\n\nX"}) == (
        f"{base}\n\n按这套工序做：\n\nX"
    )


def test_multiple_skills_keep_each_header():
    inj = {"names": ["甲", "乙"], "block": "按这套工序做：\n\n甲正文\n\n---\n\n按这套工序做：\n\n乙正文"}
    out = skill_match.with_skills("S", inj)
    assert out.count("按这套工序做：") == 2 and out.startswith("S\n\n")


# ---------- 读盘那一层 ----------


def test_injection_reads_the_skill_and_keeps_the_writer_form(skill_dir):
    """验收第 2 条：与 `skill_eval` 的「有它」侧**逐字一致**（`skill_eval.py` 那一行）。"""
    _add_skill(skill_dir)
    inj = skill_match.injection("给领导汇报这次项目的结论")
    assert inj["names"] == [SKILL_NAME]
    assert inj["picked"][0]["score"] >= skill_match.SKILL_FLOOR
    body = skills.load_skill(SKILL_NAME)
    assert inj["block"] == f"按这套工序做：\n\n{body}"


def test_injection_is_empty_without_a_topic(skill_dir):
    """`recap` 没有话题（`run(*, days=…)`）——这一层不猜，拿到空集。"""
    _add_skill(skill_dir)
    assert skill_match.injection("") == {"names": [], "picked": [], "block": ""}
    assert skill_match.injection("   ")["names"] == []


def test_injection_is_empty_when_nothing_matches(skill_dir):
    _add_skill(skill_dir)
    assert skill_match.injection("唐诗里的意象怎么读")["names"] == []


def test_injection_skips_a_skill_deleted_between_listing_and_loading(skill_dir, monkeypatch):
    """清单里有、正文已经没了：跳过——**绝不能**把「[未找到] 技能…」那句注进 system。"""
    monkeypatch.setattr(skills, "list_skills", lambda: _listing("已经删掉的技能"))
    inj = skill_match.injection("给领导汇报这次项目的结论")
    assert inj["names"] == [] and inj["block"] == ""


def test_injection_never_raises(skill_dir, monkeypatch):
    """读挂了不能把一次引擎运行变成失败（与 `_score_run` 同一条纪律）。"""

    def boom() -> list[dict]:
        raise RuntimeError("盘挂了")

    monkeypatch.setattr(skills, "list_skills", boom)
    assert skill_match.injection("给领导汇报这次项目的结论")["names"] == []


def test_the_engine_event_and_the_run_log_carry_the_same_names(skill_dir):
    """两条路都看得出「本次注入了什么」：SSE 事件给手动那条路，日志给无人值守那条。"""
    _add_skill(skill_dir)
    inj = skill_match.injection("给领导汇报这次项目的结论")
    assert skill_match.event_data(inj)["skills"] == [SKILL_NAME]
    entry = skill_match.log_entry(skill_match.event_data(inj))  # 事件的载荷也吃得下
    assert entry["tool"] == "skill_inject"
    assert entry["args"]["skills"] == [SKILL_NAME]
    assert entry["ok"] is True and SKILL_NAME in entry["result"] and "本次注入" in entry["result"]


# ---------- 红线 ----------


def test_the_matcher_never_speaks():
    """匹配只出事实：源码里一行 `pet.*` 都没有（与 `cross.py` 同一条红线）。"""
    src = Path("app/core/skill_match.py").read_text(encoding="utf-8")
    # 扫语法树，不扫字面——注释里正当地写着「台词」这类词
    tree = ast.parse(src)
    used = sorted(
        {
            n.attr
            for n in ast.walk(tree)
            if isinstance(n, ast.Attribute) and getattr(n.value, "id", "") == "pet"
        }
    )
    assert used == []
    assert "pet_events" not in src


def test_injection_stays_out_of_the_ruler_and_out_of_recap():
    """结构红线（PLAN3 §8 第 8 条 + §9.3 决策5）：

    - 注入**不许**做进 `report.synthesize*`——`engine_eval._synthesize_collect` 贴的就是那条路
      （它的注释原话），注进去等于让标尺量错对象；
    - 六个引擎里五个接了，`recap` 刻意不接（它没有话题）。
    """
    assert "skill_match" not in Path("app/core/report.py").read_text(encoding="utf-8")
    for engine in ("compose", "deliver", "research", "decide", "conflict", "threads"):
        assert "skill_match" in Path(f"app/core/{engine}.py").read_text(encoding="utf-8"), engine
    assert "skill_match" not in Path("app/core/recap.py").read_text(encoding="utf-8")
    # 无人值守那条路：注入清单进了运行日志（S3 试用期唯一的真值来源）
    assert "skill_match" in Path("app/core/tasks.py").read_text(encoding="utf-8")
