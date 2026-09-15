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


def compose(kind: str, name: str = "", detail: str = "", count: int = 0) -> str:
    """Template line for an event. 零柒's voice: terse, a little dry."""
    now = datetime.now()
    if kind == "task_done":
        tail = f" {detail.strip()[:60]}" if detail.strip() else ""
        return f"「{name}」跑完了。{tail.strip()}"
    if kind == "task_failed":
        return f"「{name}」没跑成。{detail.strip()[:80]}"
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
        return f"今天 {count} 张过完了{tail}。"
    if kind == "cards_remedy":
        return f"你老错的那几个点我补了一段讲解（{count} 篇），在 notes 里。"
    if kind == "habits_due":
        # cards all cleared, only the habit grid left — `name` carries the names
        tail = f"：{name}" if name else ""
        return f"卡都清完了。还剩 {count} 个习惯没打勾{tail}。"
    if kind == "mastered":
        # 费曼模式说通的那一下，主语不是「你搞懂了」而是「你把它讲明白了」——
        # 同一个概念、两条不同的路，值得说不同的话。
        if detail == "taught":
            return f"你把「{name}」给我讲明白了。我记住了。"
        # 不是 f-string：这里没有占位符，pyflakes 会报「f-string is missing
        # placeholders」，CI 的 lint 那一步就红在这一行上。
        tail = "，这次是连着第二次说通" if detail == "twice" else ""
        return f"你把「{name}」搞懂了{tail}。"
    if kind == "greeting":
        part = "早上" if now.hour < 11 else ("下午" if now.hour < 18 else "晚上")
        return f"{part}好。今天的事我盯着，有进展我叫你。"
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
        # 隐私闸门（B3）：无论台词是模板拼的还是模型现写的，都在这里过一遍——
        # 路径、密钥、agent 的 prompt 片段都不许念出来。
        line = sanitize((text or compose(kind, name=name, detail=detail, count=count)).strip())
        if not line:
            return None
        import sqlite3

        conn = sqlite3.connect(settings.db_path)
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS pet_events ("
                "id INTEGER PRIMARY KEY, created_at TEXT, kind TEXT, text TEXT, detail TEXT)"
            )
            cur = conn.execute(
                "INSERT INTO pet_events (created_at, kind, text, detail) VALUES (?,?,?,?)",
                (
                    datetime.now().astimezone().isoformat(timespec="seconds"),
                    kind[:20],
                    line,
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
        rows = conn.execute(
            "SELECT id, kind, text, detail, created_at FROM pet_events "
            "WHERE id > ? ORDER BY id DESC LIMIT ?",
            (int(since_id), limit),
        ).fetchall()
    finally:
        conn.close()
    return [
        {"id": r[0], "kind": r[1], "text": r[2], "detail": r[3], "created_at": r[4]}
        for r in rows
    ]


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


@usage_ledger.traced("pet")
async def greeting(mode: str = "morning") -> str:
    """One LLM-composed line in 零柒's voice; template fallback if no provider."""
    st = status()
    gr = growth()
    mode_label = {"morning": "早间", "evening": "晚间"}.get(mode, "")
    fallback = compose("greeting")
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
        user = (
            f"现在是{when}。他的成长：等级 Lv.{gr['level']}「{gr['title']}」，累计 EXP {gr['exp']}，"
            f"已经搞懂 {gr['counts']['mastered']} 个概念、把 {gr['counts']['outputs']} "
            f"份东西交出去了。系统侧：今日任务完成 {st['tasks_done']} 失败 {st['tasks_failed']}。"
            f"以零柒的身份说一句{mode_label}的话（一两句以内），可说成长也可提一句系统状况，"
            f"直接输出那句话本身。"
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
