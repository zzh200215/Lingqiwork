"""Artifacts light-execution endpoints (opt-in, see app.core.artifacts)."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from app.core import artifacts

router = APIRouter(prefix="/api/artifacts", tags=["artifacts"])


class RunIn(BaseModel):
    code: str
    language: str = "python"
    timeout: int | None = None

    @field_validator("language")
    @classmethod
    def _known_language(cls, v: str) -> str:
        v = (v or "").lower()
        if v not in artifacts.LANGUAGES and v not in ("js", "node"):
            raise ValueError(f"language 只能是 {'/'.join(artifacts.LANGUAGES)}")
        return v


@router.get("/status")
async def get_status():
    return artifacts.status()


@router.post("/run")
async def run(body: RunIn):
    try:
        return artifacts.run(body.code, body.language, body.timeout)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001 - runner failures surface to the UI
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e
