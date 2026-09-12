"""学习小组圆桌：三个 persona 笔谈一个卡点（Smallville 多智能体思路的裁剪版）。

三个固定人设按固定顺序各说 1-3 句、共两轮——苏格拉底老师负责把问题问深，
费曼同侪负责换大白话和类比，唱反调的考官负责挑反例和边界。与 arena 的区别：
arena 是同一段 prompt **并行**赛马（比谁答得好）；圆桌是**串行**的（每个人
看得到前面说了什么，要接话）。与播客的区别：播客是两个声音讨论既定材料，
圆桌的产出先是一份文字纪要，想听再做播客（复用 generate_from_blocks）。

纪要按天落 vault/roundtable/，人在 Obsidian 里照常可翻——和语音日记同一个
「vault 是正文真相源」的规矩。
"""
import asyncio
import logging
import re
from datetime import datetime
from pathlib import Path

from app.config import VAULT_DIR
from app.core import usage_ledger

log = logging.getLogger(__name__)

ROUND_DIR = VAULT_DIR / "roundtable"
ROUNDS = 2
TURN_CHARS = 400  # 单个 persona 一轮的上限——圆桌是接话，不是演讲

# (key, 显示名, 人设)。key 进纪要和播客块，显示名进 md 粗体行。
PERSONAS: tuple[tuple[str, str, str], ...] = (
    (
        "mentor",
        "苏格拉底老师",
        "你是圆桌里的苏格拉底老师。你的发言只做一件事：把问题再往深里问一层——"
        "点出大家都在绕开的那个前提、那个没定义的词。不给答案，不给总结。",
    ),
    (
        "peer",
        "费曼同侪",
        "你是圆桌里刚搞懂这个问题的同侪（费曼风格）。你的发言只做一件事：把前面"
        "的说法翻译成大白话和一个具体例子，哪里翻译不过去，就直说「这里我其实还没懂」。",
    ),
    (
        "skeptic",
        "唱反调的考官",
        "你是圆桌里的考官，专门唱反调。你的发言只做一件事：找一个反例、一个边界"
        "条件、一个「这个说法在什么情况下会翻车」。不为反对而反对——翻车点要具体。",
    ),
)

_NAMES = {key: name for key, name, _ in PERSONAS}


def _transcript_text(turns: list[dict]) -> str:
    """已产生的发言 → 给下一个人看的上下文（纯文本，截断防膨胀）。"""
    if not turns:
        return "（你是第一个发言的）"
    return "\n".join(f"{t['name']}：{t['text']}" for t in turns)


def _prompt(topic: str, context: str, turns: list[dict]) -> str:
    head = f"圆桌话题：{topic}"
    if context:
        head += f"\n背景材料：{context[:600]}"
    return (
        f"{head}\n\n目前的讨论：\n{_transcript_text(turns)}\n\n"
        "现在轮到你发言。只说 1-3 句，直接接话，不要复述别人、不要开场白、不要客套。"
    )


@usage_ledger.traced("roundtable")
async def run(topic: str, context: str = "", rounds: int = ROUNDS) -> dict:
    """开一场圆桌：串行两轮 × 三个 persona，纪要落盘。模型部分走降级链。

    Raises RuntimeError（没有可用 provider）——由路由翻译成 503。
    """
    topic = (topic or "").strip()
    if not topic:
        raise ValueError("topic 为空")
    rounds = max(1, min(rounds, 3))

    from app.core.llm import stream_chat_fallback
    from app.core.tasks import _candidates

    candidates = await _candidates("")
    turns: list[dict] = []
    for _ in range(rounds):
        for key, name, brief in PERSONAS:
            messages = [
                {"role": "system", "content": brief},
                {"role": "user", "content": _prompt(topic, context, turns)},
            ]
            try:
                text = (
                    await asyncio.wait_for(
                        _collect(stream_chat_fallback(candidates, messages)), timeout=120
                    )
                ).strip()[:TURN_CHARS]
            except Exception:  # noqa: BLE001 - 一个人掉线，圆桌继续
                log.warning("roundtable turn failed for %s", key, exc_info=True)
                text = ""
            if text:
                turns.append({"persona": key, "name": name, "text": text})
    if not turns:
        raise RuntimeError("圆桌没能产生任何发言——检查默认模型是否可用")

    file = _save(topic, turns)
    return {"topic": topic, "turns": turns, "file": str(file), "at": f"{datetime.now():%Y-%m-%d %H:%M}"}


async def _collect(gen) -> str:
    parts: list[str] = []
    async for c in gen:
        parts.append(c)
    return "".join(parts)


def _slug(topic: str) -> str:
    s = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", topic)[:24].strip("-")
    return s or "untitled"


def _save(topic: str, turns: list[dict]) -> Path:
    """纪要按天落盘；同一天同话题追加「## 场次」而不是覆盖。"""
    ROUND_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now()
    path = ROUND_DIR / f"{now:%Y-%m-%d}-{_slug(topic)}.md"
    body = [f"# 学习小组圆桌：{topic}", "", f"{now:%Y-%m-%d %H:%M} · {' · '.join(_names_in(turns))}", ""]
    round_no = 0
    for i, t in enumerate(turns):
        if i % len(PERSONAS) == 0:
            round_no += 1
            body.append(f"## 第 {round_no} 轮")
            body.append("")
        body.append(f"**{t['name']}**：{t['text']}")
        body.append("")
    path.write_text("\n".join(body), encoding="utf-8")
    return path


def _names_in(turns: list[dict]) -> list[str]:
    seen: list[str] = []
    for t in turns:
        if t["name"] not in seen:
            seen.append(t["name"])
    return seen


def parse_file(path: Path) -> tuple[str, list[dict]]:
    """纪要 md → (topic, turns)。自己写的格式自己读，播客端点用。"""
    text = path.read_text(encoding="utf-8")
    topic = ""
    m = re.search(r"^# 学习小组圆桌：(.+)$", text, re.M)
    if m:
        topic = m.group(1).strip()
    turns: list[dict] = []
    for line in text.splitlines():
        m = re.match(r"^\*\*(.+?)\*\*：(.*)$", line)
        if m and m.group(1) in set(_NAMES.values()):
            name = m.group(1)
            key = next(k for k, n, _ in PERSONAS if n == name)
            turns.append({"persona": key, "name": name, "text": m.group(2).strip()})
    return topic, turns


def recent(limit: int = 7) -> list[dict]:
    """最近的圆桌纪要，新→旧：{file, topic, at}。"""
    if not ROUND_DIR.exists():
        return []
    out: list[dict] = []
    for path in sorted(ROUND_DIR.glob("*.md"), reverse=True):
        try:
            topic, turns = parse_file(path)
        except OSError:
            continue
        out.append({"file": str(path), "topic": topic or path.stem, "turns": len(turns)})
        if len(out) >= limit:
            break
    return out
