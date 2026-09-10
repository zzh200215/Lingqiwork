"""Agent Skills (ROADMAP V6.1) — SKILL.md instruction packs, industry-standard.

A skill is a folder under `skills/` containing a SKILL.md (optional YAML-ish
frontmatter: name/description/model/tools) plus any supporting files. Every
chat turn injects a compact index ("when to use" descriptions); the model
loads the full instructions via the `skill_load` tool when relevant. Skills
can be installed straight from a GitHub SKILL.md URL.

Deliberately outside `vault/`: skills are instructions, not knowledge — they
should not pollute RAG retrieval.
"""
import asyncio
import logging
import re
import shutil
from html import unescape
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from app.config import BASE_DIR

log = logging.getLogger(__name__)

SKILLS_DIR = BASE_DIR / "skills"
SKILLS_DIR.mkdir(parents=True, exist_ok=True)

_NAME_RE = re.compile(r"^[^\\/:*?\"<>|\s]{1,60}$")
_URL_TIMEOUT = 20
_MAX_BODY = 60_000  # chars — a loaded skill must not eat the whole context
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.S)


def _parse_skill_text(text: str) -> dict:
    """Split SKILL.md into (name, description, model, tools, body).

    Frontmatter is deliberately minimal: `key: value` lines, no YAML dep.
    """
    meta: dict[str, str] = {}
    body = text
    m = _FRONTMATTER_RE.match(text)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                meta[k.strip().lower()] = v.strip().strip("\"'")
        body = text[m.end():]
    return {
        "name": (meta.get("name") or "").strip(),
        "description": (meta.get("description") or "").strip(),
        "model": (meta.get("model") or "").strip(),
        "tools": (meta.get("tools") or "").strip(),
        "body": body.strip()[:_MAX_BODY],
    }


def _skill_dir(name: str) -> Path:
    if not _NAME_RE.match(name or ""):
        raise ValueError(f"非法技能名: {name!r}")
    return SKILLS_DIR / name


def list_skills() -> list[dict]:
    out = []
    for d in sorted(SKILLS_DIR.iterdir()):
        skill_md = d / "SKILL.md"
        if not d.is_dir() or not skill_md.exists():
            continue
        try:
            parsed = _parse_skill_text(skill_md.read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            continue
        files = [p.relative_to(SKILLS_DIR).as_posix() for p in d.rglob("*") if p.is_file()]
        description = parsed["description"]
        if not description and parsed["body"]:
            description = parsed["body"].splitlines()[0][:120]
        out.append(
            {
                "name": d.name,
                "description": description,
                "model": parsed["model"],
                "tools": parsed["tools"],
                "files": files,
                "chars": len(parsed["body"]),
            }
        )
    return out


def index_block() -> str:
    """Compact skill list for the chat system prompt ('' when none)."""
    skills = [s for s in list_skills() if s["description"]]
    if not skills:
        return ""
    lines = "\n".join(f"- {s['name']}：{s['description']}" for s in skills)
    return (
        "你可以使用以下技能（instruction packs）。当任务与某技能相关时，"
        "先调用 skill_load 工具加载其完整内容，然后遵循其中的指导执行：\n"
        f"{lines}"
    )


def _resolve_skill_dir(name: str) -> Path | None:
    """Find a skill folder by folder name first, then by frontmatter name.

    The frontmatter fallback matters because installed SKILL.md files may
    carry a different `name:` than the folder they land in — the model should
    be able to use either.
    """
    try:
        d = _skill_dir(name)
        if (d / "SKILL.md").exists():
            return d
    except ValueError:
        return None
    for s in list_skills():
        d = SKILLS_DIR / s["name"]
        try:
            fm = _parse_skill_text((d / "SKILL.md").read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            continue
        if fm["name"] == name:
            return d
    return None


def load_skill(name: str) -> str:
    """Full skill body for the model ('[未找到…]' on miss — tool-safe)."""
    d = _resolve_skill_dir((name or "").strip())
    if d is None:
        return f"[未找到] 技能 '{name}' 不存在"
    parsed = _parse_skill_text((d / "SKILL.md").read_text(encoding="utf-8", errors="ignore"))
    extra = [p for p in d.rglob("*") if p.is_file() and p.name != "SKILL.md"]
    note = (
        f"\n\n[附随文件：{', '.join(p.name for p in extra)}]" if extra else ""
    )
    return f"# 技能：{d.name}\n\n{parsed['body']}{note}"


async def load_skill_tool(args: dict) -> str:
    """Built-in tool handler for skill_load."""
    return load_skill((args.get("name") or "").strip())


def read_raw(name: str) -> str:
    """Raw SKILL.md text (frontmatter + body) — for editing in the UI."""
    d = _resolve_skill_dir((name or "").strip())
    if d is None:
        raise ValueError(f"技能 '{name}' 不存在")
    return (d / "SKILL.md").read_text(encoding="utf-8", errors="ignore")


def _install_text(name: str, text: str, overwrite: bool = False) -> dict:
    """Write a SKILL.md as a new skill folder (shared by URL install + tests)."""
    parsed = _parse_skill_text(text)
    if not parsed["body"]:
        raise ValueError("SKILL.md 内容为空")
    if not parsed["description"]:
        raise ValueError("SKILL.md 缺少 description（frontmatter 里需要一行 description: 何时使用）")
    name = (name or parsed["name"]).strip()
    d = _skill_dir(name)
    if d.exists() and not overwrite:
        raise ValueError(f"技能 '{name}' 已存在（可勾选覆盖）")
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(text.strip() + "\n", encoding="utf-8")
    log.info("skill installed: %s", d.name)
    return {"name": d.name, "description": parsed["description"], "chars": len(parsed["body"])}


def update(name: str, content: str) -> dict:
    """Replace an existing skill's SKILL.md; rename the folder when the
    frontmatter `name:` changes (conflict-checked)."""
    current = _resolve_skill_dir((name or "").strip())
    if current is None:
        raise ValueError(f"技能 '{name}' 不存在")
    parsed = _parse_skill_text(content)
    if not parsed["body"]:
        raise ValueError("SKILL.md 内容为空")
    if not parsed["description"]:
        raise ValueError("SKILL.md 缺少 description（frontmatter 里需要一行 description: 何时使用）")
    new_name = (parsed["name"] or "").strip() or current.name
    target = _skill_dir(new_name)  # validates the name
    if target != current and target.exists():
        raise ValueError(f"技能 '{new_name}' 已存在")
    if target != current:
        current.rename(target)
    (target / "SKILL.md").write_text(content.strip() + "\n", encoding="utf-8")
    log.info("skill updated: %s", target.name)
    return {"name": target.name, "description": parsed["description"], "chars": len(parsed["body"])}


def _to_raw_github(url: str) -> str:
    """github.com blob URL -> raw.githubusercontent.com (other URLs pass through)."""
    m = re.match(
        r"https?://github\.com/([^/]+)/([^/]+)/blob/(.+)$", url.strip()
    )
    if m:
        return f"https://raw.githubusercontent.com/{m.group(1)}/{m.group(2)}/{m.group(3)}"
    return url


def _fetch_url_text(url: str) -> str:
    url = _to_raw_github(url.strip())
    if urlparse(url).scheme not in ("http", "https"):
        raise ValueError("URL 必须以 http(s) 开头")
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (AI-Workbench) curl/8"})
    with urlopen(req, timeout=_URL_TIMEOUT) as resp:
        return resp.read(500_000).decode("utf-8", "ignore")


async def install_from_url(url: str, name: str = "", overwrite: bool = False) -> dict:
    text = await asyncio.to_thread(_fetch_url_text, url)
    text = unescape(text)
    return _install_text(name, text, overwrite)


def remove(name: str) -> dict:
    d = _skill_dir(name)
    if not d.exists():
        raise ValueError(f"技能 '{name}' 不存在")
    shutil.rmtree(d)
    return {"ok": True, "name": name}
