"""语音日记：转写文本按天落盘 vault/journal/YYYY-MM-DD.md。

纯文件层——不碰 LLM、不碰数据库。一天一个文件，条目以 `## HH:MM`
分块追加，方便人直接在 Obsidian 里翻，也让 recent() 可以无状态解析。
automemory 提取在路由层做（见 routers/journal.py），这里保持可同步测试。
"""
from datetime import datetime
from pathlib import Path

from app.config import VAULT_DIR

JOURNAL_DIR = VAULT_DIR / "journal"
EXCERPT_CHARS = 80


def _day_file(now: datetime) -> Path:
    return JOURNAL_DIR / f"{now:%Y-%m-%d}.md"


def append(text: str, now: datetime | None = None) -> dict:
    """追加一条语音日记；首次写入生成 `# 语音日记 YYYY-MM-DD` 标题。

    Returns {path, date, time, count} — count 是今天已有的条数。
    """
    now = now or datetime.now()
    body = " ".join(text.split()).strip()
    if not body:
        raise ValueError("日记内容为空")
    JOURNAL_DIR.mkdir(parents=True, exist_ok=True)
    path = _day_file(now)
    header = f"# 语音日记 {now:%Y-%m-%d}\n"
    entry = f"\n## {now:%H:%M}\n\n{body}\n"
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if not existing:
        existing = header
    path.write_text(existing.rstrip("\n") + "\n" + entry, encoding="utf-8")
    return {
        "path": str(path),
        "date": f"{now:%Y-%m-%d}",
        "time": f"{now:%H:%M}",
        "count": len(_parse(existing + entry)),
    }


def _parse(content: str) -> list[dict]:
    """一个日记文件 → [{time, text}]，按文件内出现顺序。"""
    out: list[dict] = []
    blocks = content.split("\n## ")[1:]
    for block in blocks:
        lines = block.split("\n")
        stamp = lines[0].strip()[:5]
        text = "\n".join(lines[1:]).strip()
        if stamp and text:
            out.append({"time": stamp, "text": text})
    return out


def recent(limit: int = 7, now: datetime | None = None) -> list[dict]:
    """最近的条目，跨文件新→旧；每条 {date, time, text, excerpt}。"""
    now = now or datetime.now()
    if not JOURNAL_DIR.exists():
        return []
    files = sorted(JOURNAL_DIR.glob("*.md"), reverse=True)
    out: list[dict] = []
    for path in files:
        date = path.stem
        if len(out) >= limit:
            break
        try:
            entries = _parse(path.read_text(encoding="utf-8"))
        except OSError:
            continue
        # 文件里时间升序（追加式），倒着读即新→旧
        for entry in reversed(entries):
            out.append(
                {
                    "date": date,
                    "time": entry["time"],
                    "text": entry["text"],
                    "excerpt": entry["text"][:EXCERPT_CHARS],
                }
            )
            if len(out) >= limit:
                break
    return out


def today_count(now: datetime | None = None) -> int:
    now = now or datetime.now()
    path = _day_file(now)
    if not path.exists():
        return 0
    try:
        return len(_parse(path.read_text(encoding="utf-8")))
    except OSError:
        return 0
