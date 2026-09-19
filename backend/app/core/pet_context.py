"""零柒的「今天」（Z1 · PLAN4）：让陪伴页里的它知道**你在过什么日子**。

**它解决什么。** 陪伴页的零柒有长期记忆（`memory`）、有性格微调（`pet_tone`）、有工具，
但它不知道**今天**：收工那句陈述说得出「今天消化了 2 个点、过了 3 张卡」，聊天里的它
一个字都说不出——镜子照得见长期，照不见当天。这一格把当天补上：三样东西追加进 system。

1. **今天的事实**：`pet.day_statement()` 那一句（与收工那句**同源**，不另写文案）；
2. **它最近说过的话**：`pet_events` 最近 `RECENT_LINES` 条（本身已过 `sanitize`，
   不二次泄密），让同一句话不至于说两遍；
3. **最近几轮对话**（`history()`，Z1 定稿时用户点的方向）：后端每一轮都是新的
   `messages`，不发历史它就**不记得你上一句**——「那第 2 条呢」这种追问答不上来。
   历史优先来自前端内存；P5 聊天落库之后，客户端一份都没带（刚刷新、隔天回来）
   时由 `routers/pet.pet_chat` 从 `pet_chats` 补——「它记得你」是跨会话的。

## 三条纪律（与 `pet_tone` 同一套）

- **只追加、绝不替换**：`CHAT_SYSTEM` 是登记过的一等提示词（带 sha），改它等于把整条
  人设换了版本。这里只往后面接。
- **空数据不注入**：一天还没动静 → 两段都不加，也**绝不写「今天你什么都没干」**
  （那是欠账口吻，PLAN4 §8.7）。读不出来同理——事实读不到就不说。
- **上限在这一处**：历史条数、单条字数、总字数都在 `history()` 里夹。**不信任客户端**带
  多少来（那是陪伴聊天，一段历史不该把上下文撑爆）；前端那份同样的上限只是省一次往返。

## 真机 drill 改过两处（2026-09-17）

拿真模型问一遍「我今天干了啥」跑出来的，不是想出来的：

1. `LINES_HEAD` 补了「**不一定都是今天**」：那些台词是 `pet_events` 最近五条，跨天；
   不写清，模型会把三天前那句当今天的事一起汇报。
2. 多了 `HISTORY_NOTE`：同一份 messages 里明明带着上一轮，flash 级模型会答
   「我手上只看得见这一轮的对话」——**那是对用户说假话**。历史在场时把「你们正在连着聊」
   说明白（只在真有历史时加，见 `context()`）。
"""

import logging
from datetime import datetime

log = logging.getLogger(__name__)

__all__ = [
    "FACTS_HEAD",
    "HISTORY_CHARS",
    "HISTORY_MESSAGES",
    "HISTORY_NOTE",
    "LINES_HEAD",
    "LINE_CHARS",
    "RECENT_LINES",
    "TURN_CHARS",
    "apply",
    "context",
    "facts_block",
    "history",
    "lines_block",
    "recent_lines",
]

RECENT_LINES = 5  # 它最近说过的话：五句够看出「刚才在说什么」，再多就成了流水账
LINE_CHARS = 120  # 台词本来是一行；长引用（判断原文那种）截断，别把 system 撑起来
HISTORY_MESSAGES = 6  # 最近 6 条 = 三个来回。前端 `petChat.PET_HISTORY_MESSAGES` 与它对齐
TURN_CHARS = 600  # 单条历史的上限：一次问答里那句长回答不该整段重发
HISTORY_CHARS = 3000  # 历史总量预算：超了从**最旧**那头丢（最近的话最要紧）

FACTS_HEAD = (
    "今天**已经发生**的事（他问「我今天干了啥」这类问题时，就用这些数回答；"
    "没写在这儿的不要编）："
)
LINES_HEAD = (
    "你最近说过的话（从早到晚，**不一定都是今天**；这些已经说过了，"
    "**别重复**，可以当事实引用）："
)
# 真机 drill 撞出来的那一句（2026-09-17）：同一份 messages 里明明带着上一轮，
# flash 级的模型会回一句「我手上只看得见这一轮的对话」——那是**对用户说假话**。
# 所以历史在场时把「你们正在连续对话」这件事说明白（只在真有历史时加）。
HISTORY_NOTE = (
    "你们正在连着聊：用户这一句**前面**的那几条就是你们刚才说的话，可以直接接着说；"
    "不要说「我看不见之前的对话」。"
)


def _stamp(raw: object) -> str:
    """`pet_events.created_at`（**本地 aware** 的 ISO）→ `09-17 21:00`；读不出来给空串。"""
    s = str(raw or "").strip()
    if not s:
        return ""
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return ""
    return f"{dt:%m-%d %H:%M}"


def facts_block(said: str) -> str:
    """今天那句事实 → 一段注入文本。**空串进、空串出**（一件都没发生就什么都不加）。"""
    s = (said or "").strip()
    if not s:
        return ""
    return f"{FACTS_HEAD}\n{s}"


def lines_block(rows: object) -> str:
    """它最近说过的几句 → 一段注入文本。`rows` 是 `pet.feed()` 的产出（新 → 旧）。

    摆成**从早到晚**：越靠后越接近他正在问的这一句。时间读不出来的那行不摆时间，
    但话照摆——一句话的价值在内容，不在它几点说的。
    """
    if not isinstance(rows, list):
        return ""
    picked = [
        r
        for r in rows[:RECENT_LINES]
        if isinstance(r, dict) and str(r.get("text") or "").strip()
    ]
    if not picked:
        return ""
    out: list[str] = []
    for r in reversed(picked):
        text = str(r["text"]).strip()[:LINE_CHARS]
        when = _stamp(r.get("created_at"))
        out.append(f"- {when}「{text}」" if when else f"- 「{text}」")
    return f"{LINES_HEAD}\n" + "\n".join(out)


def history(turns: object) -> list[dict]:
    """客户端带来的最近几轮对话 → OpenAI 形状的 messages。**纯函数，坏输入不抛。**

    只认 `user` / `pet` 两个角色（`pet` → `assistant`，与前端 `petChat.ts` 那两个字面量
    对齐）；别的角色丢掉、空白丢掉、单条截断、总量超预算时从最旧那头丢。
    `history` 这个键名两边一致，改一处就得改另一处。
    """
    if not isinstance(turns, list):
        return []
    out: list[dict] = []
    for t in turns:
        if not isinstance(t, dict):
            continue
        role = {"user": "user", "pet": "assistant"}.get(str(t.get("role") or "").strip())
        if role is None:
            continue
        text = str(t.get("text") or "").strip()
        if not text:
            continue
        out.append({"role": role, "content": text[:TURN_CHARS]})
    out = out[-HISTORY_MESSAGES:]
    while len(out) > 1 and sum(len(m["content"]) for m in out) > HISTORY_CHARS:
        out.pop(0)
    return out


def recent_lines(limit: int = RECENT_LINES) -> list[dict]:
    """它最近说过的几句（`pet.feed` 的增量读）。**读不出来就空表**——聊天不该被它挡住。"""
    try:
        from app.core import pet

        return pet.feed(limit=limit)
    except Exception:  # noqa: BLE001 - 增强项，坏了就当没说过
        log.debug("pet recent lines failed", exc_info=True)
        return []


def context(said: str = "", lines: object = None, *, has_history: bool = False) -> str:
    """该追加的那几段（今天的事实 + 它说过的话 + 有历史时那句说明）。都没有就是**空串**。"""
    parts = [facts_block(said), lines_block(lines)]
    if has_history:
        parts.append(HISTORY_NOTE)
    return "\n\n".join(p for p in parts if p)


def apply(
    system: str, *, said: str = "", lines: object = None, has_history: bool = False
) -> str:
    """把那几段追加到 system 后面。**只追加，绝不替换**：没数据时原样返回同一个字符串。

    调用方（`routers/pet.pet_chat`）拿到的可能是追加过的版本，也可能就是原样——
    人设常量本身在任何情况下都不会被改写（同 `pet_tone.apply`）。
    `has_history` 由调用方按**归一化之后**的历史条数给（脏数据不算数）。
    """
    extra = context(said, lines, has_history=has_history)
    return f"{system}\n\n{extra}" if extra else system
