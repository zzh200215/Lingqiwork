"""Agent skills endpoints (ROADMAP V6.1)."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core import skills

router = APIRouter(prefix="/api/skills", tags=["skills"])


@router.get("")
async def list_skills():
    return {"dir": str(skills.SKILLS_DIR), "skills": skills.list_skills()}


@router.get("/content")
async def skill_content(name: str):
    try:
        return {"name": name, "content": skills.load_skill(name), "raw": skills.read_raw(name)}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class SkillInstall(BaseModel):
    url: str
    name: str = ""
    overwrite: bool = False


@router.post("/install")
async def install_skill(body: SkillInstall):
    try:
        return await skills.install_from_url(body.url, body.name, body.overwrite)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001 - network errors
        raise HTTPException(502, f"下载失败：{type(e).__name__}: {e}") from e


@router.delete("/{name}")
async def remove_skill(name: str):
    try:
        return skills.remove(name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class SkillUpdate(BaseModel):
    content: str


@router.put("/{name}")
async def update_skill(name: str, body: SkillUpdate):
    try:
        return skills.update(name, body.content)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


# ---------- 能力候选（环一：一份材料 → 一个能力包）----------
#
# 落在同一个路由下，因为产物就是一份 SKILL.md。区别在**从哪来**：
# `/api/skills/install` 是从网上装一份现成的，这里是**从你自己的材料里读出来**。
# 两者都不代表「已验证」——有没有基线由 `/api/skills/candidates` 如实回答。


class CandidateIn(BaseModel):
    """一份材料。`source_path` 与 `text` **二选一**（vault 路径 / `repo:` / `dir:` / 粘贴）。"""

    source_path: str = ""
    text: str = ""
    model_id: str = ""
    overwrite: bool = False


@router.post("/candidate")
async def make_candidate(body: CandidateIn):
    """读一份材料，判断有没有一套值得反复用的工序，有就落一份 SKILL.md 草稿。

    **不抛 5xx**：读不出来（路径越界 / 太短）与出不了候选（模型没配 / 没有工序）
    都是**正常结论**，用 `ok=False` + 一句理由回答。真要出问题的是「悄悄写了一份没人要的
    技能」，所以这里连同名覆盖都要显式要 `overwrite`。
    """
    from app.core import candidates

    return await candidates.draft(
        source_path=body.source_path,
        text=body.text,
        model_id=body.model_id,
        overwrite=body.overwrite,
    )


@router.get("/candidates")
async def list_candidates():
    """现有技能 + **有没有基线** —— 「没基线不许当能力展示」的唯一出处。"""
    from app.core import skill_eval

    return await skill_eval.report()


class DraftFromRunIn(BaseModel):
    """一次运行 → 一份能力草稿（S2）。"""

    run_id: int
    model_id: str = ""
    overwrite: bool = False


@router.post("/draft-from-run")
async def draft_from_run(body: DraftFromRunIn):
    """读**一次运行**（连带它那条链的最近几步），判断这段工作里有没有一套值得反复做的工序。

    与 `/candidate` 同一套纪律、同一个落盘出口、同样四条硬规矩；差异只在**输入**：
    这里给的是**你自己干过的活**（题目 + 产出），不是一份材料。合集按
    `task_runs.thread_id` 归堆——「处理一项工作」的三步天然同堆（PLAN3 §9.2 决策2）。

    **不抛 5xx**（同 `/candidate`）：读不到那次运行、没有 provider、判不出工序，
    都是 `ok=False` / `usable=false` + 一句理由。
    """
    from app.core import candidates

    return await candidates.draft_from_run(
        body.run_id, model_id=body.model_id, overwrite=body.overwrite
    )


class CasesIn(BaseModel):
    """一份技能的用例（尺子）。`ask` 是它会收到什么；`intent` 是「它当时应该怎样」。"""

    cases: list[dict]
    model_id: str = ""


@router.get("/{name}/cases")
async def get_skill_cases(name: str):
    """这份技能的用例 + 断言清单（编辑界面读它，**不自己拼默认值**）。"""
    from app.core import skill_eval

    return skill_eval.cases_payload(name)


@router.post("/{name}/cases")
async def save_skill_cases(name: str, body: CasesIn):
    """把用例写进 `backend/evals/skills/<技能名>.json`（进 git、可审、可回滚）。

    **不自动生成用例**：模型自己出题自己考，考的是它会不会出题。用例得由真实需求来。
    """
    from app.core import skill_eval

    try:
        return skill_eval.save_cases(name, body.cases, body.model_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class RunIn(BaseModel):
    model_id: str = ""


@router.post("/{name}/run")
async def run_skill_eval(name: str, body: RunIn):
    """量一遍：每条用例问两次（没它 / 有它），逐条比对 + `k/n` + Wilson 区间。

    **会花钱**：用例数 × 2 次生成 + 有它那一侧每条一次判分，报告里写着 `calls`。
    """
    from app.core import skill_eval

    try:
        return await skill_eval.run(name, model_id=body.model_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/{name}/eval")
async def skill_eval_history(name: str):
    """这份技能最近一次跑分（这一版内容的）。没跑过就直说 `baseline: null`。"""
    from app.core import skill_eval

    return {"skill": name, "baseline": await skill_eval.latest(name)}


@router.get("/{name}/trials")
async def skill_trials(name: str):
    """这份草稿**在真实工作里被用过几次**（S3 试用期）。

    派生自运行日志里那条 `skill_inject`（S1 留的痕）——**零新表，也不落第二份真值**。
    每次试用自带题目、产出预览与接地分，人据此挑哪几次值得当用例。

    **`window` 一定要显示出来**：每个任务只留最近 `window` 条运行（`tasks._RUNS_KEEP`），
    所以这个数是窗口内的、会缩水；写成「共 N 次」就是撒谎。
    """
    from app.core import skill_trials as trials

    return await trials.for_skill(name)
