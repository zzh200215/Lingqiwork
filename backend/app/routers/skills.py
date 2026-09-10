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
