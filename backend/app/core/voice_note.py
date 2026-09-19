"""语音备忘：一段录音 → 一份 `vault/voice/` 里的 md（然后录音就删掉）。

**为什么不是 `journal`。** `journal.py` 那条路是**浏览器麦克风**口述的语音日记：
一天一个文件，条目按 `## HH:MM` 追加，是「今天我说了什么」的流水。
这里那条路是**一段录音文件**（手机录的、会议片段、随手按的）：
一次一份文件，原文照存，是「这段录音讲了什么」的原料。
两者的**输入形状、落盘形状、用途都不同**，所以落两个目录、归两个模块——
把录音文件塞进按天追加的日记里，会让 `## HH:MM` 那套分块失去意义。

**文件名与标题都不许走模型**（PLAN5 §4-10 确定性优先 + §3 R2 的验收「一分钟内看到文本」）：
`voice/YYYY-MM-DD-HHMM.md` 是**算出来**的，H1 是**拼出来**的。让模型起标题意味着
转写之外再多一次生成——那既拖过验收线，也让「同名」变成一件不可预测的事。
文件名 + H1 都不带模型，检索靠这两个（indexer 抓正文与标题）就够找到它。

**录音在转写成功后被删掉**（2026-09-18 决策）：原音频是几十上百倍大的原料，
留着只会让 vault 里堆一堆没人再听的文件。所以这里**只留文本**——
失败则一个字节都不动，录音留在原地等人处置（与 `tasks._transcribe` 的失败语义一致）。

纯文件层：不碰 LLM、不碰数据库（`journal.py` 同一个姿势），所以可以同步测试。
"""
import logging
from datetime import datetime
from pathlib import Path

from app.config import VAULT_DIR

log = logging.getLogger(__name__)

VOICE_DIR = VAULT_DIR / "voice"
# vault 相对的那一层目录名。**只写一处**：文件名、回执里的路径、那一问的判据
# 全都由它推出来——三处各写一遍"voice"的那天，改目录名就会漏掉一处。
VOICE_REL = "voice"

# 同一分钟里的第二条（同一段录音被触发两次、或一次触发里有多份）靠这个后缀区分。
# 不覆盖已有文件：**盖掉就等于丢了一份已经转写好的原文**，而那是这里唯一的值钱东西。
_MAX_SUFFIX = 99


def _title(now: datetime) -> str:
    return f"语音备忘 {now:%Y-%m-%d %H:%M}"


def _pick_path(now: datetime) -> Path:
    """`voice/YYYY-MM-DD-HHMM.md`；同一分钟已有文件就退到 `-2`、`-3`…。

    文件名**算出来**的，不含模型、不含原音频名：原音频名可能是「IMG_2043.m4a」
    这种毫无信息的东西，拿它当文件名等于把检索的钥匙交给一个随机串。
    原音频名进正文（下面那一行），保留「这份是从哪来的」这条线索。
    """
    base = VOICE_DIR
    stem = f"{now:%Y-%m-%d-%H%M}"
    path = base / f"{stem}.md"
    if not path.exists():
        return path
    for i in range(2, _MAX_SUFFIX + 1):
        alt = base / f"{stem}-{i}.md"
        if not alt.exists():
            return alt
    raise ValueError(f"这一分钟（{stem}）里已经有 {_MAX_SUFFIX} 份语音备忘了")


def write_note(text: str, source: str = "", now: datetime | None = None) -> dict:
    """把一段转写文本写进 `vault/voice/`。

    `source` 是原音频的 vault 相对路径，写进正文当作「这份从哪来」的线索——
    录音本身马上要删，这行是唯一留下的出处。

    Returns `{path, name, title, chars}`（`path` 是 vault 相对 posix 路径，直接可给回执）。
    """
    now = now or datetime.now()
    body = str(text or "").strip()
    if not body:
        raise ValueError("转写文本是空的")
    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    path = _pick_path(now)
    title = _title(now)
    lines = [f"# {title}", ""]
    if source:
        lines.append(f"> 来源：`{source}`（转写完成后原录音已删除）")
        lines.append("")
    lines.append(body)
    path.write_text("\n".join(lines).rstrip("\n") + "\n", encoding="utf-8")
    return {
        # **vault 相对路径由 `VOICE_DIR` 推出来**（这个模块对外只有这一个可替换的名字）。
        # 早期版本拿 `config.VAULT_DIR` 去 `relative_to()`，在「把 vault 指到别处」的
        # 调用里直接 `ValueError: ... is not in the subpath of ...`——同一次运行里
        # `tasks` 是按自己的 `VAULT_DIR` 找文件的，两个名字一旦分叉就在这里炸。
        "path": f"{VOICE_REL}/{path.name}",
        "name": path.name,
        "title": title,
        "chars": len(body),
    }


# ---------- 那一问：这份语音备忘归到哪儿（R2 · PLAN5 §3）----------
#
# **拉取式**：这一格只在你打开它的时候回答「哪几份还没回答过那一问」，不催、不计数、
# 不进零柒的提醒来源（nudge 那五来源一个都不加）。
#
# **判据是两条既有路上的痕，不新增状态列、不新增表**：
#   - 当材料 → `digest_points.source` 里有没有它（拆点那条路留下的痕）；
#   - 工作留痕 → `thread_items.ref` 里有没有引用它的挂接（挂事那条路留下的痕）。
# 两边都没有 = 还没回答。**不猜、不自动归类**（S2 的先例：自动判断会产出凑数草稿）。
#
# **读不到就说读不到**（§4-8）：那两处查不动时 `readable=false`——不然「读不出来」
# 会被界面渲染成「都归类完了」，而那是这一格最不该说错的一句话。
PENDING_RULES = {
    "pull": "拉取式：只在你打开它的时候回答，不催、不计数、不进零柒的提醒来源",
    "material": "「当材料」= 交给既有的拆点（`POST /api/tutor/digest`），点进学习页的建议日志；"
    "**要不要出卡仍然由你在学页点**——不自动建卡",
    "thread": "「工作留痕」= 挂到某件「事」上（`thread_items` 只存引用，不搬内容）",
    "state": "「还没回答」的判据是两条既有路上的痕（`digest_points.source` / `thread_items.ref`），"
    "不新增状态列",
}


def _on_disk() -> list[dict]:
    """`vault/voice/` 里的每一份，**文件名倒序**（文件名里就带着时间）。只读磁盘，不碰库。"""
    if not VOICE_DIR.is_dir():
        return []
    out: list[dict] = []
    for p in sorted(VOICE_DIR.glob("*.md"), key=lambda x: x.name, reverse=True):
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
            mtime = int(p.stat().st_mtime)
        except OSError:  # 读不动就跳过它，不让一份坏文件挡住整张单子
            continue
        title = ""
        for line in text.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
        out.append(
            {
                "path": f"{VOICE_REL}/{p.name}",
                "name": p.name,
                "title": title or p.stem,
                "chars": len(text),
                "mtime": mtime,
            }
        )
    return out


async def _answered() -> tuple[set[str], set[str]]:
    """`(拆过点的 source, 挂过事的 ref)`——两条既有路上的痕。**只读**，抛出去。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import DigestPoint, ThreadItem

    like = f"{VOICE_REL}/%"
    async with SessionLocal() as db:
        material = set(
            (await db.execute(select(DigestPoint.source).where(DigestPoint.source.like(like)))).scalars()
        )
        threads = set(
            (await db.execute(select(ThreadItem.ref).where(ThreadItem.ref.like(like)))).scalars()
        )
    return material, threads


async def pending() -> dict:
    """还没回答那一问的那几份 + 三个计数（`readable=false` = 读不到，不是「都归类完了」）。"""
    out: dict = {
        "readable": False,
        "error": "",
        "open": [],
        "counts": {"total": 0, "material": 0, "thread": 0, "open": 0},
        "rules": PENDING_RULES,
    }
    try:
        items = _on_disk()
        material, threads = await _answered()
    except Exception as e:  # noqa: BLE001 - 派生视图，坏了照实说，不假装「都归类完了」
        log.warning("voice note pending failed", exc_info=True)
        out["error"] = f"{type(e).__name__}: {e}"
        return out

    open_items = [i for i in items if i["path"] not in material and i["path"] not in threads]
    out.update(
        readable=True,
        error="",
        open=open_items,
        counts={
            "total": len(items),
            "material": sum(1 for i in items if i["path"] in material),
            "thread": sum(1 for i in items if i["path"] in threads),
            "open": len(open_items),
        },
    )
    return out
