"""零柒 — the workbench's resident companion (ROADMAP V14).

零柒 is the personification of the proactive layer: it speaks first, without
being asked, about what the system already did (tasks, digest, backup, feeds).

Three rules baked into the design:
- proactive, not reactive — it emits on events, never waits to be asked;
- honest mood — its "status" is computed from real data, never faked;
- frugal — it stays quiet unless it has something with substance, and only
  toasts for failures and greetings (never per-event spam).

Deliberately all-sync: emit() fires from scheduler threads and task coroutines
alike, so it uses plain sqlite3 (same pattern as digest._resolve_model) and
never awaits. A failed emit must never break the triggering job.
"""
import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone

from app.config import VAULT_DIR, settings
from app.core import notify
from app.core.prefs import load_config
from app.core import usage_ledger

log = logging.getLogger(__name__)

KINDS = {
    "task_done",
    "task_failed",
    "gate_ok",
    "gate_rejected",
    "digest",
    "backup",
    "feeds",
    "greeting",
    "say",
    "cards_due",
    "cards_done",
    "cards_remedy",
    "habits_due",
    "mastered",
    "repeated",
    "output",
    "retell",
    "digested",
    "cards_made",
    "skill_draft",
    "plugin",
}

# ---------- 隐私边界（B3）----------
#
# openpets 那条规矩：插件 / agent 驱动零柒时，**不让 prompt、文件路径、代码、日志、
# 密钥进台词**。零柒原本会把任务名、报错原文直接说出来，报错里常常带绝对路径和 key。
# 这里是一道**纯函数**闸门，`emit()` 每句台词都过——包括 LLM 现场写的那句（greeting）。
#
# 只求「不漏」，不求「好看」：路径与密钥一律换成中性占位符。宁可少说一句，也不把用户
# 的目录结构或密钥念到屏幕上（桌宠台词会弹通知、会留存在 pet_events 里）。
_SECRET_MASK = "[已隐藏]"
_PATH_MASK = "[路径]"
_SECRET_RE = re.compile(
    r"(?i)"
    r"\b(?:sk|pk|ghp|gho|ghs|xox[baprs]|AKIA|ASIA)[-_A-Za-z0-9]{12,}\b"
    r"|\bBearer\s+[A-Za-z0-9._\-]{12,}"
    r"|\b[A-Fa-f0-9]{32,}\b"
    r"|\b[A-Za-z0-9+/]{40,}={0,2}\b"
    r"|\b(?:api[_-]?key|access[_-]?token|secret|password|passwd)\b\s*[=:]\s*\S+"
)
_HOME_PATH_RE = re.compile(r"~[/\\][^\s]+")
_WIN_PATH_RE = re.compile(r"[A-Za-z]:\\[^\s，。；：、）】\"']+")
_UNC_PATH_RE = re.compile(r"\\\\[^\s]+")
# 绝对路径：`/a/b` 起头，至少两段。前导不能是 / : . -（否则会啃掉 URL 与相对路径）。
_UNIX_PATH_RE = re.compile(r"(?<![\w./:\\-])/(?:[\w.@+-]+/)+[\w.@+-]+")


def sanitize(text: str) -> str:
    """台词隐私闸门：剥掉密钥与文件路径。纯函数，坏输入原样返回。"""
    if not text:
        return text
    out = _SECRET_RE.sub(_SECRET_MASK, text)
    out = _HOME_PATH_RE.sub(_PATH_MASK, out)
    out = _WIN_PATH_RE.sub(_PATH_MASK, out)
    out = _UNC_PATH_RE.sub(_PATH_MASK, out)
    return _UNIX_PATH_RE.sub(_PATH_MASK, out)

CHAT_SYSTEM = (
    "你是「零柒」，一台本地优先的个人工作台里的常驻小助手。"
    "性格：极简、克制、靠谱，偶尔一句冷幽默；不寒暄、不卖萌、不刷存在感。"
    "回答尽量短——能一句说完就不说两句，用户要细节时再展开。"
    "你了解这台工作台的能力（多模型对话/RAG 知识库/定时任务/笔记/备份/语音），"
    "适合交给定时任务的事就主动建议交给定时任务。用中文回答。"
)


def _conn():
    import sqlite3

    return sqlite3.connect(settings.db_path)


def _pet_enabled() -> bool:
    try:
        return bool(load_config().get("pet_enabled", True))
    except Exception:  # noqa: BLE001
        return True


def _default_model_id() -> str | None:
    """First enabled provider's first *working* model.

    Kept as a thin delegate so its six call sites did not have to change when the
    rule moved into `core/providers.py`; that move is what made "skip a model whose
    last probe failed" possible in one place instead of three.
    """
    from app.core.providers import default_model_id

    return default_model_id()


def _part_of_day(now: datetime | None = None) -> str:
    """「早上 / 下午 / 晚上」——问候语的时段。**只有这一份**（`compose` 与开工/收工那两句共用）。"""
    hour = (now or datetime.now()).hour
    return "早上" if hour < 11 else ("下午" if hour < 18 else "晚上")


# ---------- 台词池（Z3 · PLAN4）：同一件事，几句话轮着说 ----------
#
# 只给**高频**的那几种备说法（一天可能说好几遍的那种）。每条池的第一句就是**原话**
# ——`compose(..., n=0)` 拿到的还是从前那一句，所以不传 `n` 的调用方一个字节都没变。
#
# 两条界线（计划里写死的）：
# 1. **里程碑句不轮换**：`mastered` 的「taught / twice」、`output` 的「第一份 / 第 N 份」
#    是**事件语义**（你教它 / 连着第二次 / 头一份），不是措辞；
# 2. **只换说法，不换事实**：占位符（名字、数字、缺口、连着几天）每一句里都得照样拼对，
#    有一条测试逐句验这件事。
POOLS: dict[str, tuple[str, ...]] = {
    "task_done": (
        "「{name}」跑完了。{tail}",
        "「{name}」这一轮成了。{tail}",
        "「{name}」收了。{tail}",
    ),
    "task_failed": (
        "「{name}」没跑成。{tail}",
        "「{name}」倒在半路。{tail}",
        "「{name}」这一轮没过去。{tail}",
    ),
    "cards_done": (
        "今天 {count} 张过完了{tail}。",
        "今天 {count} 张卡清了{tail}。",
        "今天这 {count} 张，过了{tail}。",
    ),
    "output": (
        "「{name}」交出去了。{tail}",
        "「{name}」落地了。{tail}",
        "「{name}」我收进架子了。{tail}",
    ),
    "mastered": (
        "你把「{name}」搞懂了{tail}。",
        "「{name}」这下通了{tail}。",
        "「{name}」算是真懂了{tail}。",
    ),
}


def _pick(pool: tuple[str, ...], n: int) -> str:
    """从池子里挑第 `n` 句。**确定性**：同一个 `n` 永远同一句，没有随机数。

    读不出来 / 负数当 0（负数取模会绕到池子最后一句话，那是「越界的下标看起来像有意的」）——
    挑不出来就说原话，绝不抛：`compose` 是 `emit` 的主路径，它一抛，那条台词就整条没了。
    """
    try:
        i = int(n)
    except (TypeError, ValueError):
        return pool[0]
    if i <= 0:
        return pool[0]
    return pool[i % len(pool)]


def compose(kind: str, name: str = "", detail: str = "", count: int = 0, n: int = 0) -> str:
    """Template line for an event. 零柒's voice: terse, a little dry.

    `n` 是**轮换位置**（Z3 · PLAN4）：同一个 kind 之前说过几次。高频那几种各备几句，
    `n % len(pool)` 取一句——**确定性**，不用随机数（随机 = 复现不了的 bug）。
    默认 0 = 这个 kind 的原话，所以不传 `n` 的调用方（测试、`cards.py` 那处直接
    `compose("cards_due")`）拿到的还是老那句。
    """
    now = datetime.now()
    if kind == "task_done":
        tail = detail.strip()[:60]
        return _pick(POOLS["task_done"], n).format(name=name, tail=tail)
    if kind == "task_failed":
        return _pick(POOLS["task_failed"], n).format(name=name, tail=detail.strip()[:80])
    if kind == "gate_ok":
        # Z2（PLAN4）：停在卡点上的那一步，**你点了头**。
        # 在那之前是「等你有声、抵达无声」：等你点头那条 nudge 是气泡第一优先级，
        # 可你点完之后链继续往下跑，它一个字都没有。这一句只说你做了什么，不夸、不催。
        return f"「{name}」你点了头，我继续。"
    if kind == "gate_rejected":
        # 驳回那句必须**中性**：不打趣、不「哼」、不劝你再想想。驳回一步是正常操作，
        # 不是犯错——这里多带一个字的情绪，都会变成一笔「你否决了它」的账。
        return f"「{name}」那步驳回了。"
    if kind == "digest":
        return f"今日摘要好了，覆盖 {count} 个文件的变更，已放进 digests。"
    if kind == "backup":
        return f"备份打好了（{detail}）。"
    if kind == "feeds":
        return f"订阅抓完了，{count} 条新内容已入库。"
    if kind == "cards_due":
        tail = f"，已经连着 {detail} 天了" if detail and detail not in ("0", "") else ""
        return f"今天有 {count} 张卡到期{tail}。十分钟的事。"
    if kind == "cards_done":
        tail = f"，连着 {detail} 天" if detail and detail not in ("0", "") else ""
        return _pick(POOLS["cards_done"], n).format(count=count, tail=tail)
    if kind == "cards_remedy":
        return f"你老错的那几个点我补了一段讲解（{count} 篇），在 notes 里。"
    if kind == "habits_due":
        # cards all cleared, only the habit grid left — `name` carries the names
        tail = f"：{name}" if name else ""
        return f"卡都清完了。还剩 {count} 个习惯没打勾{tail}。"
    if kind == "mastered":
        # 费曼模式说通的那一下，主语不是「你搞懂了」而是「你把它讲明白了」——
        # 同一个概念、两条不同的路，值得说不同的话。
        # **轮换只换主句**：`taught` 那一句整句就是那件事的语义（你教它），一个字都不动；
        # 「连着第二次」那半句在每一句变体里逐字保留。里程碑不是措辞，轮不得。
        if detail == "taught":
            return f"你把「{name}」给我讲明白了。我记住了。"
        # 不是 f-string：这里没有占位符，pyflakes 会报「f-string is missing
        # placeholders」，CI 的 lint 那一步就红在这一行上。
        tail = "，这次是连着第二次说通" if detail == "twice" else ""
        return _pick(POOLS["mastered"], n).format(name=name, tail=tail)
    if kind == "repeated":
        # 「同一个概念又卡住」——判据是「我接住过你卡在哪儿，你带着它回来还是没过」
        # （`tutor.is_recurring_mistake`）。这句话只**陈述**，不催、不劝、不记账：
        # 主语是「你又」，因为这是陪伴该有的样子，不是提醒事项。
        where = f"。上次卡在：{detail.strip()}" if detail.strip() else "。"
        return f"「{name}」这是第 {count} 次了，还是没走通{where}"
    if kind == "output":
        # 环二的表达层：一份成品**交出去了**。主语是「你」（B1），不是「系统生成了」。
        # 数字是**读出来的累计量**（`_count_outputs`：架子上真正有几份），不是宠物记的账、
        # 更不是它发的奖——「算出来的不是发的奖」这条从 `pet_room` 开篇一直管到这里。
        # 数不出来（0）就只留前半句：宁可少说一句，也不编一个数。
        # 「第一份」/「第 N 份」那半句**不轮换**（里程碑是事件语义），轮换的只是主句。
        if count == 1:
            tail = "第一份。"
        elif count > 1:
            tail = f"这是第 {count} 份。"
        else:
            tail = ""
        return _pick(POOLS["output"], n).format(name=name, tail=tail)
    if kind == "retell":
        # M1：你**讲**了一遍，它刚判完。这一句是**判词**，不是评分表——主语是「你」，
        # 说得出的缺口就说（`detail` 是 missed_points 的第一条），说不出就只说结果。
        # ⚠️ 这个 kind 的 `count` 是**档位**（1 重来 | 2 困难 | 3 良好 | 4 简单），不是次数。
        gap = detail.strip()
        if count >= 3:
            return f"「{name}」你讲清楚了。"
        if count == 2:
            return f"「{name}」大概对，就差在「{gap}」。" if gap else f"「{name}」大概对，还差一点。"
        return f"「{name}」这次没讲通。"
    if kind == "digested":
        # M2（PLAN §3 G2）：一份材料消化完了。**数是这次真写进去的点数**，
        # 不是模型草稿里提了几个——「写盘的人说话」这条从 `note_output` 一路管到这里。
        tail = f"拆出 {count} 个要搞懂的点。" if count > 0 else "没拆出什么。"
        return f"「{name}」我嚼完了。{tail}"
    if kind == "cards_made":
        # 出卡完成（`POST /api/cards/batch` 那条路）。去重之后**真加进去的张数**。
        return f"「{name}」出好了 {count} 张卡。" if count > 0 else f"「{name}」这回没出成新卡。"
    if kind == "skill_draft":
        # 环一的落盘话：**顺便把纪律念出来**——草稿不算数，量过才算（§4 第四条）。
        return f"「{name}」这份工序我记下了。还没量过，不算数。"
    if kind == "greeting":
        return f"{_part_of_day(now)}好。今天的事我盯着，有进展我叫你。"
    return detail or "在。"


def emit(
    kind: str,
    name: str = "",
    detail: str = "",
    count: int = 0,
    text: str | None = None,
) -> int | None:
    """Record one spoken line; toast only for failures and greetings.

    Best-effort by contract: any failure is logged and swallowed so the
    triggering job (task/digest/backup/feeds) is never broken by the pet.
    """
    try:
        if not _pet_enabled():
            return None
        import sqlite3

        conn = sqlite3.connect(settings.db_path)
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS pet_events ("
                "id INTEGER PRIMARY KEY, created_at TEXT, kind TEXT, text TEXT, detail TEXT)"
            )
            # `name` 是后加的列（M2）：`detail` 当初兼着「这件事叫什么」与「补充一句」
            # 两个角色，于是「同一个概念说过没有」查不出来（`repeated` 的冷却撞上过）。
            # 这张表历史上不走迁移，所以这里自己补列——与 `models.PetEvent` 那段说明同源。
            cols = {r[1] for r in conn.execute("PRAGMA table_info(pet_events)")}
            if "name" not in cols:
                conn.execute("ALTER TABLE pet_events ADD COLUMN name TEXT DEFAULT ''")
            # Z3（PLAN4）的**轮换键**：这个 kind 之前说过几次。选它而不是 `event_id`：
            # ① `compose` 不必知道 id（插入才产生 id，那会要求先插后拼、顺序全乱）；
            # ② 一句话的说法只跟**它自己这一类**说过几次有关，不被中间冒出来的问候带偏；
            # ③ 表还没建过 / 查不出来 → 0（= 原话），绝不因为读不到就抛。
            try:
                said_before = int(
                    conn.execute(
                        "SELECT COUNT(*) FROM pet_events WHERE kind = ?", (kind[:20],)
                    ).fetchone()[0]
                )
            except Exception:  # noqa: BLE001 - 轮换是打磨，坏了大不了永远说第一句
                said_before = 0
            # 隐私闸门（B3）：无论台词是模板拼的还是模型现写的，都在这里过一遍——
            # 路径、密钥、agent 的 prompt 片段都不许念出来。
            line = sanitize(
                (
                    text
                    or compose(kind, name=name, detail=detail, count=count, n=said_before)
                ).strip()
            )
            if not line:
                return None
            cur = conn.execute(
                "INSERT INTO pet_events (created_at, kind, text, name, detail) VALUES (?,?,?,?,?)",
                (
                    datetime.now().astimezone().isoformat(timespec="seconds"),
                    kind[:20],
                    line,
                    sanitize(name)[:500],
                    sanitize(detail)[:500],
                ),
            )
            conn.commit()
            event_id = int(cur.lastrowid or 0)
        finally:
            conn.close()
        # frugal: toast only for things that are useless unseen — failures,
        # greetings, and the daily review/habit nudge (a bubble in a page you
        # never opened is worth nothing). At most one such toast per day.
        if kind in ("task_failed", "greeting", "cards_due", "habits_due") and load_config().get(
            "pet_notify", True
        ):
            try:
                notify.desktop("零柒", line[:180])
            except Exception:  # noqa: BLE001
                pass
        log.info("pet emit [%s]: %s", kind, line[:80])
        return event_id
    except Exception:  # noqa: BLE001 - never break the caller
        log.debug("pet emit failed", exc_info=True)
        return None


def feed(limit: int = 30, since_id: int = 0) -> list[dict]:
    """Recent spoken lines, newest first."""
    limit = max(1, min(int(limit), 100))
    import sqlite3

    conn = sqlite3.connect(settings.db_path)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(pet_events)")}
        if not cols:
            # 表还没建过 = 一句话都还没说过（新库、被删过的库）。**这不是异常**：
            # `status()` / `growth()` 一直是这么处理的，`feed` 原先会直接
            # `no such table` 抛出去——`/api/pet/stream` 那条常驻的流一开就死在这儿。
            return []
        name_col = "name" if "name" in cols else "''"
        rows = conn.execute(
            f"SELECT id, kind, text, detail, created_at, {name_col} FROM pet_events "
            "WHERE id > ? ORDER BY id DESC LIMIT ?",
            (int(since_id), limit),
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": r[0],
            "kind": r[1],
            "text": r[2],
            "detail": r[3],
            "created_at": r[4],
            "name": r[5] or "",
        }
        for r in rows
    ]


# ---------- 聊天落库（P5 · 加深脑子）---------------------------------------------
#
# 聊天设计上曾是 ephemeral：随请求来、随请求走。代价是刷新页面它就「忘了上一句」，
# 隔天回来更是从头开始——「它记得你」靠前端内存那 6 轮兜不住。落到本地库里，
# 后端补历史、前端回放才有真值可读。
#
# 与 `pet_events` 同一套规矩：**这张表不走迁移**，读写时自己 `CREATE TABLE IF NOT
# EXISTS`（models.PetChat 是同一张表的声明，新库由 create_all 建、老库由这里建）；
# 读不出来（表没建过 / 库坏了）就当没有——记忆是增强项，聊天绝不因此 500。
#
# 时间戳与 pet_events 同一口径（本地带偏移的 ISO）。`pet_state._away`（久别重逢）
# 会读它当「最后一次来过」的证据，两边口径一致才比得了。


def save_chat_turn(user_text: str, pet_text: str, tools: list | None = None) -> None:
    """落一轮问答。**真的回了话才算一轮**：报错、中断、只问没答的那次不落——
    残句进了记忆，往后每一场对话都要背着它。best-effort，绝不抛。"""
    u = (user_text or "").strip()
    a = (pet_text or "").strip()
    if not u or not a:
        return
    try:
        import json as _json

        conn = _conn()
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS pet_chats ("
                "id INTEGER PRIMARY KEY, created_at TEXT, role TEXT, text TEXT, "
                "tools TEXT DEFAULT '[]')"
            )
            ts = datetime.now().astimezone().isoformat(timespec="seconds")
            conn.execute(
                "INSERT INTO pet_chats (created_at, role, text, tools) VALUES (?,?,?,?)",
                (ts, "user", u[:20000], "[]"),
            )
            conn.execute(
                "INSERT INTO pet_chats (created_at, role, text, tools) VALUES (?,?,?,?)",
                (ts, "pet", a[:20000], _json.dumps(tools or [], ensure_ascii=False)),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - 记不住这一轮，也比聊天挂掉强
        log.debug("pet save_chat_turn failed", exc_info=True)


def recent_chats(limit: int = 30) -> list[dict]:
    """最近几轮问答，**旧 → 新**。给前端回放、给后端在客户端没带历史时补上下文。

    `role` 直接给 `'user' / 'pet'`（`pet_context.history` 认的就是这两个字面量，
    `pet` 由它折成 assistant——折的那一处不改）。读不出来就空表。
    """
    try:
        import json as _json

        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT id, created_at, role, text, tools FROM pet_chats "
                "ORDER BY id DESC LIMIT ?",
                (max(1, min(int(limit), 100)),),
            ).fetchall()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        log.debug("pet recent_chats failed", exc_info=True)
        return []
    out = []
    for r in reversed(rows):
        try:
            tools = _json.loads(r[4] or "[]")
        except (TypeError, ValueError):
            tools = []
        out.append(
            {
                "id": int(r[0]),
                "created_at": str(r[1] or ""),
                "role": str(r[2]),
                "text": str(r[3] or ""),
                "tools": tools if isinstance(tools, list) else [],
            }
        )
    return out


# ---------- 本地日 → UTC 区间 ----------
#
# `models.utcnow()` 往 `task_runs.started_at` / `messages.created_at` 这些列里写的是
# **UTC**（`models.iso_utc` 那段注释就是为这 8 小时差立的），而「今天」永远是**本地**的
# 概念。两者不能拿同一个日期串去比。
#
# 这里就是那个换算的唯一出处：`pet.status()` 与 `pet_state` 都用它。**别再写
# `LIKE '<本地日期>%'`** —— 在 UTC+8 下那等于把本地 00:00–08:00 的活动算到前一天，
# 再把第二天 00:00–08:00 的算进今天，整体错位一个时区偏移。


def local_day_utc_bounds(now: datetime | None = None) -> tuple[str, str]:
    """本地「今天」对应的 UTC 区间，格式与 SQLAlchemy 写进 SQLite 的一致。

    返回 `[今天 00:00 本地, 明天 00:00 本地)` 两端换算成 **naive UTC** 的 ISO 字符串
    （`YYYY-MM-DD HH:MM:SS.ffffff`）。这种定长格式的**字典序就是时间序**，所以直接
    拿去和 `CAST(col AS TEXT)` 做 `>= ? AND < ?` 即可——不用 `datetime()` 包一层，
    也就不必赌存储格式。

    `now` 传 aware 的 datetime 就按它自己的时区算（测试用这个把语义钉死）；传 naive
    或不传，按系统本地时区解释（与 `datetime.now()` 一致）。

    注意：`astimezone()` 给出的是**当下这一刻的固定偏移**，不含夏令时表。对中国这种
    没有夏令时的时区是精确的；有夏令时的时区在切换那天会差一小时——真到那天再换成
    `zoneinfo`，这里先不为一个用不上的复杂度埋单。
    """
    now = now or datetime.now()
    if now.tzinfo is None:
        now = now.astimezone()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)

    def _fmt(d: datetime) -> str:
        return d.astimezone(timezone.utc).replace(tzinfo=None).isoformat(sep=" ", timespec="microseconds")

    return _fmt(midnight), _fmt(midnight + timedelta(days=1))


def status() -> dict:
    """Honest mood: computed from real data, never faked. All best-effort."""
    out: dict = {
        "tasks_done": 0,
        "tasks_failed": 0,
        "notes_today": 0,
        "tokens_today": 0,
        "time_of_day": "morning" if datetime.now().hour < 11 else ("afternoon" if datetime.now().hour < 18 else "evening"),
        "pet_enabled": _pet_enabled(),
    }
    # 本地「今天」不是本地日期串，而是一段 UTC 区间——见 local_day_utc_bounds 的注释。
    day_start, day_end = local_day_utc_bounds()
    try:
        import sqlite3

        conn = sqlite3.connect(settings.db_path)
        try:
            for st, n in conn.execute(
                "SELECT status, COUNT(*) FROM task_runs "
                "WHERE CAST(started_at AS TEXT) >= ? AND CAST(started_at AS TEXT) < ? "
                "GROUP BY status",
                (day_start, day_end),
            ):
                if st == "ok":
                    out["tasks_done"] = int(n)
                elif st == "error":
                    out["tasks_failed"] = int(n)
            row = conn.execute(
                "SELECT COALESCE(SUM(tokens_in),0)+COALESCE(SUM(tokens_out),0) "
                "FROM messages "
                "WHERE CAST(created_at AS TEXT) >= ? AND CAST(created_at AS TEXT) < ?",
                (day_start, day_end),
            ).fetchone()
            out["tokens_today"] = int(row[0] or 0)
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - stats are best-effort
        log.debug("pet status db query failed", exc_info=True)
    try:
        cutoff = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        out["notes_today"] = sum(
            1
            for p in VAULT_DIR.rglob("*")
            if p.is_file()
            and p.suffix == ".md"
            and p.stat().st_mtime >= cutoff
            and not {"digests", "feeds", "tasks"} & set(p.relative_to(VAULT_DIR).parts[:-1])
        )
    except Exception:  # noqa: BLE001
        pass
    return out


# ---------- 成长模型（B1）：诚实、只增不减、只正面呈现 ----------
#
# 三条不破的规矩，前两条沿用 status() 的立场，第三条是你为这一线拍板的：
# 1. **来自真实数据** —— 算出来的，不是编的；
# 2. **只增不减** —— 每一项都是**累计计数**（跑成的任务、学会的概念、打过的卡……），
#    没有任何一处会因为「今天没做」而回落。没有扣分、没有掉级、没有还欠。
# 3. **只正面呈现** —— 界面上只有等级 / 称号 / 累计 EXP / 各来源明细。
#
# 来源五条线：学习（A3 的掌握事件）、**教零柒（费曼模式说通了）**、工作（跑成的
# 工作流 + 交付的成品）、习惯（打卡天数）、复习（答题次数）。
#
# `LEVEL_STEPS` **不动**：新来源让 EXP 涨得更快，等级只会往上走；反过来若把门槛
# 调高，已经到过的等级就会回落——那违反「只增不减」。
LEVEL_STEPS = (0, 120, 320, 640, 1100, 1700, 2500, 3500, 4800, 6400)
LEVEL_TITLES = ("初识", "同行", "顺手", "老练", "笃定", "通透", "自在", "成形", "长明", "归一")

# 每单位成长值多少 EXP。数字本身不重要，重要的是**每一项背后的计数都是真的**。
EXP_MASTERED = 30  # 一个概念「学会了」
EXP_SESSION = 5  # 一场教学
EXP_RUN_OK = 12  # 一次跑成的工作流
EXP_OUTPUT = 20  # 一份交出去的成品
EXP_HABIT_DAY = 4  # 一个习惯打卡日
EXP_REVIEW = 1  # 一次复习
# 「把零柒教会」是这套系统里最重的单次动作：讲明白比听明白难，所以它给得比
# `EXP_MASTERED` 还多。半懂也给，只是少一档——讲了一半也是真干了的活，不该归零。
EXP_TAUGHT_PET = 40
EXP_TAUGHT_HALF = 12
_OUTPUT_DIRS = ("research", "decisions", "conflicts", "recap", "deliver")

# 「已掌握」的 SQL 版：与 `tutor.is_mastered` 同一条规则——最近一次自评说通了、且不止一场。
_MASTERED_SQL = (
    "SELECT COUNT(*) FROM ("
    " SELECT concept, COUNT(*) AS n,"
    "  (SELECT verdict FROM tutor_sessions t2 WHERE t2.concept = t.concept"
    "     AND t2.verdict IN ('got','half') ORDER BY t2.id DESC LIMIT 1) AS last_verdict"
    " FROM tutor_sessions t WHERE t.concept != '' AND t.verdict IN ('got','half')"
    " GROUP BY t.concept) WHERE n >= 2 AND last_verdict = 'got'"
)

# 「把零柒教会」= 费曼模式（你讲、它追问）。**判据就是 `mode` 本身**，不新增列：
# 费曼模式的语义本来就是「你当老师，它当那个没搞懂的学生」，而那个学生就是零柒。
# `end()` 里你按的那一下自评，就是对你讲解质量的评估——它已经是真值，再存一个
# 「教宠物专用」的字段就是同一件事存两份，迟早不同步。
#
# 代价是：`/tutor` 页里开的费曼会话同样算数（它们本来就是同一件事，只是入口不同）。
# 真要区分「教零柒」和「教一个无名学生」，那时再加列也不迟。
#
# 谓词单独拎出来当常量：P4 的「小屋」要数**什么时候**教会的（`pet_room` 拿它去查
# `ended_at`），数次数与数时刻必须是同一条规则——两份 SQL 迟早各改一半。
TAUGHT_MODE = "mode = 'feynman'"
TAUGHT_GOT = f"{TAUGHT_MODE} AND verdict = 'got'"
TAUGHT_HALF = f"{TAUGHT_MODE} AND verdict = 'half'"
_TAUGHT_SQL = f"SELECT COUNT(*) FROM tutor_sessions WHERE {TAUGHT_GOT}"
_TAUGHT_HALF_SQL = f"SELECT COUNT(*) FROM tutor_sessions WHERE {TAUGHT_HALF}"


def _count(conn, sql: str) -> int:
    """A missing table counts as zero — growth must never break on a fresh DB."""
    try:
        row = conn.execute(sql).fetchone()
        return int(row[0] or 0)
    except Exception:  # noqa: BLE001
        return 0


def _count_outputs() -> int:
    try:
        return sum(
            sum(1 for f in (VAULT_DIR / d).glob("*.md") if f.is_file())
            for d in _OUTPUT_DIRS
            if (VAULT_DIR / d).is_dir()
        )
    except Exception:  # noqa: BLE001
        return 0


def is_output_path(rel: str) -> bool:
    """一个 vault 相对路径算不算一份**成品**——这里唯一出处。

    定义就是 `_OUTPUT_DIRS`（四个引擎 + 交付）。它同时被成长值、「今天喂了它什么」、
    小屋的架子用着。**别在别处再写一份**：P4 的验收里就撞上过一次——`work.list_outputs`
    比这个宽（它连 `tasks/` 的工作流产物与 `notes/` 的成文都列），拿它当屋里的架子，
    会出现「架上 4 份、成长说交出 2 份」这种自相矛盾。工作页答的是另一个问题
    （「系统生成了哪些文件」），两个口径不必相同，但**同一句话里只能有一个**。
    """
    return rel.split("/", 1)[0] in _OUTPUT_DIRS


def note_output(name: str, rel: str) -> int | None:
    """一份成品落盘了 —— 零柒说一句（环二的表达层，`docs/loops.md` §2）。

    **谁说**：写盘的那个地方说。会往产出目录里落东西的只有三处——五个成文引擎的
    `report.save`、定时任务的 `tasks._write_vault`、会话与手工出口的 `mcp._save_artifact`。
    「刚刚多了一份什么」只有写的人知道；放在这里是因为**判据**必须是同一句
    `is_output_path`：「算不算成品」在这个仓库里只有一个答案（成长值、小屋架子、
    工作页清单、挂接都用它），这里不另立一条。

    代价是 `tasks.run_task` 得**让位**：落了成品的那一路它不再补一句「跑完了」——
    一件事只说一句。反过来（落点不是成品，比如 `tasks/` 的留痕、`notes/` 的成文）
    这里一个字都不说，那句「跑完了」照旧。

    best-effort：说一句话不该影响落盘，任何失败都咽掉。
    """
    try:
        if not is_output_path((rel or "").replace("\\", "/")):
            return None
        return emit("output", name=(name or "").strip(), count=_count_outputs())
    except Exception:  # noqa: BLE001 - 台词绝不拖累写盘
        log.debug("pet note_output failed", exc_info=True)
        return None


def growth() -> dict:
    """零柒的成长：**从「你走到哪了」算**，不是「系统今天干了什么」。

    这是 B1 要改掉的核心——旧 status() 数的是今天的任务/笔记/token，那是**系统**的
    一天；这里数的是**你**的积累：学会的概念、跑成的事、交出去的成品、坚持的天数。
    全部是累计量，所以只增不减；`parts` 只列非零的来源，界面上也就没有空档可「还欠」。
    """
    counts = {
        "mastered": 0,
        "sessions": 0,
        "taught": 0,
        "taught_half": 0,
        "runs_ok": 0,
        "habit_days": 0,
        "reviews": 0,
    }
    try:
        import sqlite3

        conn = sqlite3.connect(settings.db_path)
        try:
            counts["mastered"] = _count(conn, _MASTERED_SQL)
            counts["sessions"] = _count(conn, "SELECT COUNT(*) FROM tutor_sessions")
            counts["taught"] = _count(conn, _TAUGHT_SQL)
            counts["taught_half"] = _count(conn, _TAUGHT_HALF_SQL)
            counts["runs_ok"] = _count(conn, "SELECT COUNT(*) FROM task_runs WHERE status='ok'")
            counts["habit_days"] = _count(conn, "SELECT COUNT(*) FROM habit_logs")
            counts["reviews"] = _count(conn, "SELECT COUNT(*) FROM card_reviews")
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - growth is best-effort; the pet still sits there
        log.debug("pet growth db query failed", exc_info=True)
    # 产出数不走 SQL（它是 vault 里的文件），所以单独补进 counts——界面要拿它显示
    # 「交出 N 份」，exp 也要用它。漏了这一行，exp 对、明细却写 0。
    counts["outputs"] = _count_outputs()

    parts = [
        {
            "key": "learning",
            "label": "把东西搞懂",
            "exp": counts["mastered"] * EXP_MASTERED + counts["sessions"] * EXP_SESSION,
        },
        {
            # 「你搞懂了」和「你把它讲明白了」是两件事，所以分成两个来源。
            # 一场费曼说通会同时进 learning（算一场教学，+5）和这里（+40）——
            # 那不是重复计数，是两件事都真的发生了。
            "key": "teach",
            "label": "把零柒教会",
            "exp": counts["taught"] * EXP_TAUGHT_PET + counts["taught_half"] * EXP_TAUGHT_HALF,
        },
        {
            "key": "work",
            "label": "把东西做出来",
            "exp": counts["runs_ok"] * EXP_RUN_OK + counts["outputs"] * EXP_OUTPUT,
        },
        {"key": "habits", "label": "坚持", "exp": counts["habit_days"] * EXP_HABIT_DAY},
        {"key": "review", "label": "复习", "exp": counts["reviews"] * EXP_REVIEW},
    ]
    exp = sum(p["exp"] for p in parts)
    level = 1
    for i, step in enumerate(LEVEL_STEPS):
        if exp >= step:
            level = i + 1
    floor = LEVEL_STEPS[level - 1]
    has_next = level < len(LEVEL_STEPS)
    nxt = LEVEL_STEPS[level] if has_next else None
    return {
        "level": level,
        "title": LEVEL_TITLES[min(level - 1, len(LEVEL_TITLES) - 1)],
        "exp": exp,
        # 只给「正在靠近」的名字与一条进度条，**不给「还差 N」**——那是欠债口吻。
        "next_title": LEVEL_TITLES[level] if has_next and level < len(LEVEL_TITLES) else "",
        "progress": 1.0 if nxt is None else round((exp - floor) / max(1, nxt - floor), 3),
        "parts": [p for p in parts if p["exp"] > 0],
        "counts": counts,
    }


def _day_said(f: dict) -> str:
    """收工那句的**陈述部分**（M2 · PLAN §3 G2）：今天真发生了什么。

    **只说已经发生的事**，一件都没有就返回空串（不加一句「今天什么也没干」）。
    刻意没有「还欠」「还剩」这种句子——那是这个仓库封存过的机制（`cards.reschedule`）。
    """
    bits: list[str] = []
    if int(f.get("digested") or 0) > 0:
        bits.append(f"消化了 {int(f['digested'])} 个点")
    if int(f.get("cards_made") or 0) > 0:
        bits.append(f"出了 {int(f['cards_made'])} 张卡")
    if int(f.get("got") or 0) > 0:
        bits.append(f"说通了 {int(f['got'])} 个概念")
    if int(f.get("outputs") or 0) > 0:
        bits.append(f"交出 {int(f['outputs'])} 份成品")
    if int(f.get("reviews") or 0) > 0:
        bits.append(f"过了 {int(f['reviews'])} 张卡")
    return f"今天{'、'.join(bits)}。" if bits else ""


def day_statement(now: datetime | None = None) -> str:
    """今天**已经发生的事**说成一句话（收工那句与陪伴页注入**共用这一处**）。

    一句话只有一个出处：Z1（PLAN4）把它注入陪伴页的 system 时，用的就是这一句——
    两处各写一遍，迟早一处说「消化了 2 个点」、另一处说「出了 3 张卡」。

    一件都没发生就是**空串**（调用方据此「什么都不加」，绝不写「今天你什么都没干」）；
    读不出来也当没有——事实读不到就不说，不编。
    """
    try:
        from app.core import pet_state as state

        return _day_said(state.day_facts(now))
    except Exception:  # noqa: BLE001 - 陈述读不出来就当今天没事实
        log.debug("pet day statement failed", exc_info=True)
        return ""


@usage_ledger.traced("pet")
async def greeting(mode: str = "morning", now: datetime | None = None) -> str:
    """One LLM-composed line in 零柒's voice; template fallback if no provider.

    三件仪式都挂在**这一句**上（不新增 cron）：
    - 开工（08:30）：昨日拆出来的那一个点 → 问一句（答不答都行、不追问、不计数）；
    - 收工（21:00）：今天的**事实陈述**（`pet_state.day_facts`）；
    - **周日**收工：同一句位置改说**这一周**（`weekly.sunday_report`，M4 · PLAN §3 G4）
      ——`sched.set_daily` 只支持「每天一条」，为周报单开 cron 会让周日 21:00 冒两句。

    读不到数据就什么都不加——**普通问候**，不硬凑（周报也一样：那一周没数据就没有）。

    `now` 只给测试用：把「今天是周几」钉死。生产路径不传，走系统时钟。
    """
    # 这些读数是同步 sqlite3 / 目录扫描；greeting 在事件循环上（定时任务与 /say 都走它），
    # 放线程里跑，别让整圈循环等一次 COUNT。
    st = await asyncio.to_thread(status)
    gr = growth()
    mode_label = {"morning": "早间", "evening": "晚间"}.get(mode, "")
    fallback = compose("greeting")

    ask: dict | None = None
    said = ""
    weekly_rep: dict | None = None
    try:
        from app.core import pet_state as state

        if mode == "morning":
            ask = await asyncio.to_thread(state.last_digest_point, now)
        elif mode == "evening":
            from app.core import weekly

            weekly_rep = await weekly.sunday_report(now)
            # 周报优先：它就是周日那句。日陈述是它的子集，两句都说等于同一件事说两遍。
            said = weekly_rep["text"] if weekly_rep else await asyncio.to_thread(day_statement, now)
    except Exception:  # noqa: BLE001 - 仪式读不出来就让位给普通问候
        log.debug("pet greeting ritual facts failed", exc_info=True)
        weekly_rep, said = None, ""

    # 模板兜底也要把仪式带上：没有 provider 时那句问候同样该问、同样该说今天
    # （周报同理——**没有 provider 的机器上这份周报照样成立**，它全是读出来的事实）。
    # **两句封顶**——有仪式时不留那句「今天的事我盯着」（零柒的话能一句说完就不说两句）。
    if ask:
        fallback = f"{_part_of_day(now)}好。昨天那个「{ask['title']}」，你现在讲得清吗？"
    if said:
        fallback = f"{_part_of_day(now)}好。{said}"

    model_id = _default_model_id()
    if not model_id:
        return fallback
    try:
        from app.core.llm import ProviderInfo, stream_chat
        from app.routers.chat import resolve_model

        resolved = await resolve_model(model_id)
        p = resolved.provider
        info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)
        when = {"morning": "早上", "evening": "晚上"}.get(mode, "现在")
        # B1：主语从「系统今天」改成「你走到哪了」——零柒该说的是你的积累，不是今天的计数。
        ritual = ""
        if ask:
            ritual = (
                f"另外，可以问他一句：昨天拆出来的「{ask['title']}」现在还讲得清吗"
                f"（**答不答都行，不要追问、不要计数**）。"
            )
        elif weekly_rep:
            # 周报这一支把**事实原文**喂进去：模型只换说法，不决定说什么（说错了就是编）。
            ritual = (
                f"另外，用第一人称把这一周陈述一遍，事实就用这些：{weekly_rep['text']}"
                f"（**是这一周、不是今天**；不许说「还欠」「还没做」这类话）。"
            )
        elif said:
            ritual = f"另外，把今天的事实陈述一句：{said}（**不许说「还欠」「还没做」这类话**）。"
        user = (
            f"现在是{when}。他的成长：等级 Lv.{gr['level']}「{gr['title']}」，累计 EXP {gr['exp']}，"
            f"已经搞懂 {gr['counts']['mastered']} 个概念、把 {gr['counts']['outputs']} "
            f"份东西交出去了。系统侧：今日任务完成 {st['tasks_done']} 失败 {st['tasks_failed']}。"
            f"{ritual}"
            f"以零柒的身份说一句{mode_label}的话（两三句以内），直接输出那句话本身。"
        )
        parts: list[str] = []
        async for delta in stream_chat(
            info,
            resolved.model,
            [
                {"role": "system", "content": CHAT_SYSTEM},
                {"role": "user", "content": user},
            ],
        ):
            parts.append(delta)
        line = "".join(parts).strip()
        return line[:200] if line else fallback
    except Exception:  # noqa: BLE001 - template fallback, never raise
        log.debug("pet greeting LLM failed", exc_info=True)
        return fallback


def reschedule() -> None:
    """(Re)register the daily morning/evening greetings from config.

    This is the pet's "circadian rhythm" — the one thing that makes it
    speak FIRST on a schedule, instead of only reacting to job events.
    """
    from app.core import scheduler as sched

    cfg = load_config()
    enabled = bool(cfg.get("pet_greet_enabled", True)) and _pet_enabled()
    sched.set_daily(
        "pet_morning",
        _greet_morning,
        enabled,
        cfg.get("pet_morning_time") or "08:30",
    )
    sched.set_daily(
        "pet_evening",
        _greet_evening,
        enabled,
        cfg.get("pet_evening_time") or "21:00",
    )


async def _greet_morning() -> None:
    """Scheduled: 零柒 greets first thing; best-effort, never breaks the scheduler."""
    try:
        line = await greeting("morning")
        emit("greeting", text=line)
        log.info("pet morning greeting: %s", line[:80])
    except Exception:  # noqa: BLE001
        log.exception("pet morning greeting failed")


async def _greet_evening() -> None:
    """Scheduled: 零柒 recaps the day from real data; best-effort."""
    try:
        line = await greeting("evening")
        emit("greeting", text=line)
        log.info("pet evening greeting: %s", line[:80])
    except Exception:  # noqa: BLE001
        log.exception("pet evening greeting failed")
