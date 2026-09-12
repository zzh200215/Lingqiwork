"""工作模块 HTTP layer。

现在只做一件事：把**已经生成出来的产出**列出来。产出没有登记表——`report.py` 的脊梁
只管写文件、进索引，不记账；`ArtifactFeedback` 只记点了赞的那些。所以真值是文件系统：
几个纯生成的目录，加上「成文」落在 `notes/` 里的日期前缀文件（它和用户自己的笔记同
目录——`compose.py` 是故意这么定的，产出因此能在笔记页里直接改）。

这个路由**只读**，不落库、不写盘。目录不存在就当没有（五个引擎都是拉取式，没过就跑
过一个，目录就是空的）。
"""
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.config import VAULT_DIR
from app.core import ingest

router = APIRouter(prefix="/api/work", tags=["work"])

# 会议闭环（§4-13）：一场会议 = `vault/meetings/<日期>-<名>/` 一个文件夹
_MEETING_DIR = "meetings"
_MEETING_INBOX = "inbox"

# (目录, kind, 标签)。顺序即界面上的分组顺序。
_GENERATED_DIRS: tuple[tuple[str, str, str], ...] = (
    ("research", "research", "研究"),
    ("decisions", "decide", "方案"),
    ("conflicts", "conflict", "对质"),
    ("recap", "recap", "复盘"),
    ("deliver", "deliver", "交付"),
    ("tasks", "task", "工作流"),  # 定时任务 `save_to_vault` 的产物；handoff/ 子目录不算
)
# 成文落 notes/，靠命名分辨（见 `report.save`：`{日期}-{slug}.md`）
_COMPOSE_DIR, _COMPOSE_KIND, _COMPOSE_LABEL = "notes", "compose", "成文"

_DATE_LEN = 10  # YYYY-MM-DD


def _looks_dated(name: str) -> bool:
    """`YYYY-MM-DD-…` —— 成文与四个引擎的命名都是这个形状。"""
    if len(name) <= _DATE_LEN or name[_DATE_LEN] != "-":
        return False
    d = name[:_DATE_LEN]
    return d[4] == "-" and d[7] == "-" and d.replace("-", "").isdigit()


def _title_of(p: Path) -> str:
    """第一个一级标题；没有就退回文件名（去掉日期前缀与后缀）。"""
    try:
        with p.open(encoding="utf-8", errors="ignore") as fh:
            for _ in range(40):  # 标题总在前面；读 40 行还不见就认了
                line = fh.readline()
                if not line:
                    break
                s = line.strip()
                if s.startswith("# "):
                    return s[2:].strip() or p.stem
    except OSError:
        pass
    stem = p.stem
    return stem[_DATE_LEN + 1 :] if _looks_dated(p.stem) else stem


def _row(p: Path, kind: str, label: str) -> dict:
    rel = p.relative_to(VAULT_DIR).as_posix()
    stem = p.stem
    date = stem[:_DATE_LEN] if _looks_dated(stem) else ""
    mtime = int(p.stat().st_mtime)
    if not date:  # 不是日期命名（手放的）——退回改动时间，别在界面上留个空
        date = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d")
    return {
        "kind": kind,
        "label": label,
        "path": rel,
        "title": _title_of(p),
        "date": date,
        "mtime": mtime,
    }


@router.get("/outputs")
async def list_outputs(limit: int = 200):
    """已生成的产出，新→旧。`limit` 封顶，避免一次列几千条。"""
    cap = max(1, min(int(limit or 200), 1000))
    rows: list[dict] = []

    for dirname, kind, label in _GENERATED_DIRS:
        d = VAULT_DIR / dirname
        if d.is_dir():
            rows.extend(_row(p, kind, label) for p in d.glob("*.md") if p.is_file())

    compose_dir = VAULT_DIR / _COMPOSE_DIR
    if compose_dir.is_dir():
        rows.extend(
            _row(p, _COMPOSE_KIND, _COMPOSE_LABEL)
            for p in compose_dir.glob("*.md")
            if p.is_file() and _looks_dated(p.stem)
        )

    rows.sort(key=lambda r: r["mtime"], reverse=True)
    return {"outputs": rows[:cap]}


def _meeting(d: Path) -> dict | None:
    """一个会议文件夹 → 一行。没有 md 产物就不是一场会议（inbox 的空壳、半成品都跳过）。"""
    try:
        entries = sorted(p for p in d.iterdir() if p.is_file())
    except OSError:
        return None
    files = [p for p in entries if p.suffix.lower() == ".md"]
    if not files:
        return None
    audio = next((p for p in entries if p.suffix.lower() in ingest.AUDIO_EXT), None)
    # 拿纪要做这一场的标题——它才是这场会议的"脸"
    head = next((p for p in files if "纪要" in p.stem), files[0])
    mtime = int(d.stat().st_mtime)
    date = d.name[:10] if _looks_dated(d.name) else datetime.fromtimestamp(mtime).strftime("%Y-%m-%d")
    return {
        "name": d.name,
        "path": d.relative_to(VAULT_DIR).as_posix(),
        "date": date,
        "title": _title_of(head),
        "mtime": mtime,
        "audio": audio.relative_to(VAULT_DIR).as_posix() if audio else "",
        "files": [
            {"path": p.relative_to(VAULT_DIR).as_posix(), "title": _title_of(p)} for p in files
        ],
    }


@router.get("/meetings")
async def list_meetings(limit: int = 100):
    """会议闭环的成品。**一场一行**——录音、转写、纪要、待办、短稿是同一件事的五个面，
    平铺成五行反而看不出它们是一起的。
    """
    cap = max(1, min(int(limit or 100), 500))
    root = VAULT_DIR / _MEETING_DIR
    rows: list[dict] = []
    if root.is_dir():
        for d in root.iterdir():
            if not d.is_dir() or d.name.startswith(".") or d.name == _MEETING_INBOX:
                continue
            row = _meeting(d)
            if row:
                rows.append(row)
    rows.sort(key=lambda m: m["mtime"], reverse=True)
    return {"meetings": rows[:cap]}


@router.get("/audio")
async def get_audio(path: str):
    """原声回放（§4-13）。`<audio src>` 带不了请求头，走的是 cookie——和图片同一条路。

    只认 vault 内、且后缀是音频的文件：这个端点不该变成「读任意文件」的入口。
    """
    rel = (path or "").strip()
    if not rel:
        raise HTTPException(400, "path is required")
    try:
        p = (VAULT_DIR / rel).resolve()
        p.relative_to(VAULT_DIR.resolve())
    except ValueError:
        raise HTTPException(400, "path escapes the vault") from None
    if p.suffix.lower() not in ingest.AUDIO_EXT:
        raise HTTPException(400, "不是音频文件")
    if not p.is_file():
        raise HTTPException(404, "音频不存在")
    return FileResponse(p)
