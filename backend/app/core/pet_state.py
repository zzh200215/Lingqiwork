"""零柒的状态：**此刻**它在陪你做什么（P1 · 维度一）。

与另外两个模块的分工，一句话分清楚：

- `pet.status()`  数的是**系统**今天干了什么（任务、笔记、token）；
- `pet.growth()`  数的是**你**累积走到哪了（学会的概念、交出的成品）——只增不减；
- **本模块说的是「此刻」** ——你在工作还是摸鱼、零柒该摆什么姿势、它还剩多少精神。

三条不破的规矩，前两条沿用宠物本体，第三条是这一线拍板的：

1. **诚实** —— 每个状态都从真实数据算出来，不是编的（同 `status()` / `growth()`）；
2. **克制** —— 默认安静：`idle` 一个字都不说，不刷存在感；
3. **此刻不记账** —— 精力只描述**当下**：跨天自然归零、不进历史、不出现「你还欠 N」。
   等级与 EXP 永不回落（那是 `growth()` 的立场），**精力不是账本**。
   零柒说的是「我有点蔫」，不是「你欠了 3 小时专注」。

纯函数（`energy` / `mode` / `compute`）与 DB 分开，照 `pet_plugins` 里 `roll_day` /
`water_due` / `focus_due` 的先例：规则能被单测完整覆盖，不用起服务、不用碰库。
"""
import json
import logging
from datetime import datetime, timezone

from app.config import VAULT_DIR, settings
from app.core import pet

log = logging.getLogger(__name__)

# ---------- 九个动画：一个不少 ----------
#
# 素材是 Codex pet atlas 那九个 webp（`frontend/public/pet/*.webp`）。P1 之前
# 代码里只用过四个（idle / waving / failed / review），其余五个是**已发货但闲置**的
# 资产。这里的映射把它们全部用掉——`waving` 不在此表，它归 feed 事件与主动提醒
# （「系统出事了」和「你欠账了」该盖过日常状态）。
ACTIONS = (
    "idle",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "running",
    "running-right",
    "running-left",
    "review",
)

# 模式 → 摆哪个姿势。**同一个动作可以服务多个模式**（工作与专注都是 `running`），
# 但每个模式都有自己的一句台词，界面靠台词区分。
MODE_ACTION = {
    "idle": "idle",
    "focusing": "running",  # 专注计时中
    "working": "running",  # 在 /work
    "learning": "review",  # 在 /tutor
    "reviewing": "review",  # 在 /review
    "celebrating": "jumping",  # 刚交出一份成品
    "busy": "running-right",  # 有活正在跑，它去盯着
    "idling": "waiting",  # 你摸了一会儿鱼
    "pupil": "waiting",  # 你正在讲给它听——同一个「在等你」，两个原因
    "resting": "running-left",  # 你走开很久，它也去眯一会儿
    "tired": "failed",  # 今天坐太久了
    "sleepy": "idle",  # 深夜
}

# ---------- 阈值（都是「此刻」的量，不是账本）----------

IDLE_MIN = 5  # 几分钟不动算「摸鱼」（只有前端给了 idle_sec 才判定）
REST_MIN = 30  # 多久算「走开很久」
CELEBRATE_MIN = 10  # 产出落地 / 刚说通一个概念后的庆祝窗口（分钟）
PUPIL_WINDOW_MIN = 120  # 费曼会话「还活着」的窗口：超过这么久没发言就当它已经散了
LATE_HOUR = 23  # 23:00 之后算深夜
EARLY_HOUR = 6  # 06:00 之前也算深夜
LOW_ENERGY = 40  # 低于这个就蔫了

FATIGUE_PER_MIN = 0.12  # 今天活跃跨度每 1 分钟扣多少
# 疲劳封顶：再久也不会归零，因为它是状态不是惩罚。
# 但**不能低于 `100 - LOW_ENERGY`**，否则白天永远跌不破 LOW_ENERGY，
# `tired` 就成了一个永远命中不了的模式（夜里先被 `sleepy` 截走）。
# 65 → 白天最多扣到 35，`tired` 可达；`test_tired_is_reachable` 锁住这个下界。
FATIGUE_CAP = 65.0
RECOVER_PER_MIN = 0.4  # 空闲每 1 分钟回多少
RECOVER_CAP = 25.0  # 休息回得上限


def _late_penalty(hour: int) -> int:
    """深夜的扣分。分段是为了让「一点还在干」明显比「十一点还在干」更蔫。"""
    if hour == LATE_HOUR:
        return 8
    if hour in (0, 1):
        return 18
    if 2 <= hour < EARLY_HOUR:
        return 25
    return 0


def _mins_from_sec(value) -> float | None:
    """把「多少秒」换算成分钟。**坏值返回 None = 不知道**，而不是 0 = 没空闲。

    这个区别要紧：0 会让零柒以为你正坐在电脑前（于是不判摸鱼），
    None 会让它闭嘴不判。**不知道的时候，宁可什么都不说。**
    """
    if value is None:
        return None
    try:
        return max(0.0, float(value)) / 60.0
    except (TypeError, ValueError):
        return None


def _mins(value) -> float | None:
    """已经是「分钟」的值：只做校验与下界，**不再除 60**。

    单独一个函数是因为踩过：`active_span_min` / `fresh_output_min` 本来就是分钟，
    早先误用了秒→分钟的换算，于是所有疲劳被除了 60，`tired` 永远命中不了。
    """
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return None


def _idle_minutes(signals: dict) -> float | None:
    """你多久没动了。

    **优先用前端给的 `idle_sec`**（浏览器本地算的键鼠/可见性，不落库）；
    没有就退回服务端的「距上次消息多久」。两边都没有 = 不知道，那就别判。
    """
    if signals.get("idle_sec") is not None:
        return _mins_from_sec(signals.get("idle_sec"))
    return _mins_from_sec(signals.get("last_activity_sec"))


def energy(signals: dict, now: datetime) -> int:
    """此刻剩多少精神，0–100。

    **纯「当下」量：不写库、不跨天累积、不看历史。** 今天的活跃跨度是唯一输入，
    空闲会把它补回来，所以「干了一上午 + 午休」自然高于「连着干一上午」。
    """
    e = 100.0
    span = _mins(signals.get("active_span_min"))
    if span is not None:
        e -= min(FATIGUE_CAP, span * FATIGUE_PER_MIN)
    e -= _late_penalty(now.hour)
    idle_min = _idle_minutes(signals)
    if idle_min is not None:
        e += min(RECOVER_CAP, idle_min * RECOVER_PER_MIN)
    return int(max(0, min(100, round(e))))


def _celebration(signals: dict) -> str:
    """值得跳一下的**原因**，没有就返回空串。

    **两件都算**，但理由不同、台词也该不同：刚交出一份成品（`output`），和刚把一个
    概念说通（`mastered`）。后者是 P2 接进来的。

    产出优先：它是"到手的成果"，比"想通了"更值得先喊一声。
    """
    out = _mins(signals.get("fresh_output_min"))
    if out is not None and out <= CELEBRATE_MIN:
        return "output"
    taught = _mins(signals.get("mastered_ago_min"))
    if taught is not None and taught <= CELEBRATE_MIN:
        return "mastered"
    return ""


def mode(signals: dict, now: datetime, e: int) -> str:
    """此刻该是什么模式。**顺序即优先级**，第一条命中就返回。

    优先级是照着「什么更值得说」排的：正在专注 > 刚交出东西 > 有活在跑 >
    你人不在 > 你正在讲给它听 > 深夜 > 累了 > 你在哪个页面。

    「你人不在」排在「你在讲」之前是刻意的：讲解中走开 20 分钟，零柒该显示无聊，
    而不是一直假装还在听。走回来它自然回到 `pupil`。
    """
    if signals.get("focus_running"):
        return "focusing"
    if _celebration(signals):
        return "celebrating"
    if signals.get("busy"):
        return "busy"
    idle_min = _idle_minutes(signals)
    if idle_min is not None:
        if idle_min >= REST_MIN:
            return "resting"
        if idle_min >= IDLE_MIN:
            return "idling"
    if signals.get("pupil_waiting"):
        return "pupil"
    if now.hour >= LATE_HOUR or now.hour < EARLY_HOUR:
        return "sleepy"
    if e < LOW_ENERGY:
        return "tired"
    path = str(signals.get("path") or "")
    if path.startswith("/tutor"):
        return "learning"
    if path.startswith("/review"):
        return "reviewing"
    if path.startswith("/work"):
        return "working"
    return "idle"


def _line(m: str, signals: dict, e: int) -> str:
    """一句台词。语气照 `pet.CHAT_SYSTEM`：极简、克制、偶尔冷幽默，不卖萌。

    `idle` 故意返回空串——**安静是默认**，没话说就不说。
    """
    if m == "focusing":
        return "专注中，我不吵你。"
    if m == "working":
        return "你在干活，我陪着。"
    if m == "learning":
        return "在学东西。我在旁边看着。"
    if m == "reviewing":
        return "在过卡。"
    if m == "celebrating":
        # 台词要跟着**原因**走：交出一份成品，和想通一个概念，不是一件事。
        # 这条是 P2 视觉验收抓出来的——当时它对着"说通"也说"交出去一份。收着。"
        if _celebration(signals) == "mastered":
            return "你讲明白了。我记住了。" if signals.get("mastered_taught") else "你搞懂了。记一笔。"
        return "交出去一份。收着。"
    if m == "busy":
        return "活正在跑，我去盯着。"
    if m == "tired":
        return "你坐太久了。我蔫了，你也差不多。"
    if m == "sleepy":
        return "很晚了。"
    if m == "resting":
        return "你走开挺久了。我也眯一会儿。"
    if m == "pupil":
        return "我在听。你讲。"
    if m == "idling":
        return f"{int(_idle_minutes(signals) or 0)} 分钟没动了。要不要……算了。"
    return ""


def compute(signals: dict, now: datetime) -> dict:
    """`(信号, 现在) -> 状态`。纯函数：不碰库、不碰网络，测试可以随便喂。"""
    e = energy(signals, now)
    m = mode(signals, now, e)
    return {
        "mode": m,
        "action": MODE_ACTION[m],
        "energy": e,
        "line": _line(m, signals, e),
        "path": str(signals.get("path") or "")[:100],
    }


# ---------- 信号采集 ----------


def _rows(conn, sql: str, args=()) -> list:
    """一次查询。表还没建 / 列不存在 / 库是坏的 —— 一律当没有。

    状态是增强不是要求：新装的库、被删过的表，都不该让 `/api/pet/state` 500。
    """
    try:
        return conn.execute(sql, args).fetchall()
    except Exception:  # noqa: BLE001
        return []


def _utc_day_bounds(now: datetime) -> tuple[str, str]:
    """本地「今天」对应的 UTC 区间。

    实现搬去 `pet.local_day_utc_bounds` 了。**这个换算只能有一份**：`pet.status()`
    原来各写了一份，而且是错的那一份（见那里的注释）。新模块写对、老模块留着错，
    等于把这个坑留在原地等下一次踩。
    """
    return pet.local_day_utc_bounds(now)


def _iso(text) -> datetime | None:
    try:
        return datetime.fromisoformat(str(text))
    except (TypeError, ValueError):
        return None


def _naive(dt: datetime) -> datetime:
    """库里取出来的是 naive UTC，`datetime.now()` 是本地朴素时间——两边都去掉时区
    再相减，至少保证同一个来源内部自洽；跨来源的绝对差这里用不到。"""
    return dt.replace(tzinfo=None)


def _output_mtimes() -> list[float]:
    """`vault/` 下几类成品的改动时间。与 `pet._OUTPUT_DIRS` 同一份目录清单——
    刻意引用它而不是抄一遍，改了那边这里不会走偏。"""
    out: list[float] = []
    for d in pet._OUTPUT_DIRS:  # noqa: SLF001 - 同包内共用一份真值
        p = VAULT_DIR / d
        if not p.is_dir():
            continue
        for f in p.glob("*.md"):
            try:
                out.append(f.stat().st_mtime)
            except OSError:
                continue
    return out


def _today_counts(conn, now: datetime) -> dict:
    """今天的那几个计数。区间用 UTC 边界，见 `_utc_day_bounds`。"""
    start, end = _utc_day_bounds(now)
    out: dict = {}
    for st, n in _rows(
        conn,
        "SELECT status, COUNT(*) FROM task_runs "
        "WHERE CAST(started_at AS TEXT) >= ? AND CAST(started_at AS TEXT) < ? GROUP BY status",
        (start, end),
    ):
        if st == "ok":
            out["tasks_done"] = int(n or 0)
        elif st == "error":
            out["tasks_failed"] = int(n or 0)
        elif st == "running":
            out["busy"] = True
    r = _rows(
        conn,
        "SELECT COUNT(*) FROM tutor_sessions "
        "WHERE CAST(created_at AS TEXT) >= ? AND CAST(created_at AS TEXT) < ?",
        (start, end),
    )
    out["sessions_today"] = int(r[0][0] or 0) if r else 0
    r = _rows(
        conn,
        "SELECT COUNT(*) FROM card_reviews "
        "WHERE CAST(reviewed_at AS TEXT) >= ? AND CAST(reviewed_at AS TEXT) < ?",
        (start, end),
    )
    out["reviews_today"] = int(r[0][0] or 0) if r else 0
    return out


def _activity_span(conn, now: datetime) -> dict:
    """活跃跨度 = 今天最早一条消息 → 最晚一条。

    刻意**不是**「最早一条 → 现在」：那样停下来两小时反而更累。空闲靠 idle
    回血，两件事分开算。时区对不上就整块跳过（别把别的信号一起带走）。
    """
    start, end = _utc_day_bounds(now)
    r = _rows(
        conn,
        "SELECT MIN(CAST(created_at AS TEXT)), MAX(CAST(created_at AS TEXT)) "
        "FROM messages "
        "WHERE CAST(created_at AS TEXT) >= ? AND CAST(created_at AS TEXT) < ?",
        (start, end),
    )
    if not (r and r[0][0] and r[0][1]):
        return {}
    first, last = _iso(r[0][0]), _iso(r[0][1])
    if not (first and last):
        return {}
    try:
        # 两头都要在 **UTC** 里比：库里的 last 是 naive UTC，而 `now` 是本地朴素时间，
        # 直接相减在 UTC+8 下会凭空多出 8 小时——你刚说一句话，零柒却以为你走了半天。
        now_utc = now.astimezone(timezone.utc).replace(tzinfo=None)
        return {
            "active_span_min": max(0.0, (_naive(last) - _naive(first)).total_seconds() / 60.0),
            "last_activity_sec": max(0.0, (now_utc - _naive(last)).total_seconds()),
        }
    except (TypeError, ValueError, OverflowError):
        return {}


def _focus_running(conn, now: datetime) -> dict:
    """专注计时：真值在插件的 storage_json 里，规则复用它的纯函数。"""
    from app.core import pet_plugins

    r = _rows(conn, "SELECT storage_json FROM pet_plugins WHERE name = 'focus'")
    if not r:
        return {}
    try:
        state = json.loads(r[0][0] or "{}")
    except (TypeError, ValueError):
        return {}
    if not isinstance(state, dict):
        return {}
    rem = pet_plugins.focus_remaining(state, now)
    if rem is None or rem <= 0:
        return {}
    return {"focus_running": True, "focus_remaining_sec": int(rem)}


def _pupil_waiting(conn, now: datetime) -> dict:
    """零柒是不是正在等你把话讲完：有一场费曼会话开着，**而且最近还动过**。

    「还动过」这条是必需的：一场开着没关的旧会话（关了标签页就走了）不该让零柒
    永远摆出「我在听」。所以判据是**最后一次发言**的时间，不是会话创建时间。

    `tutor_turns.created_at` 是 ORM 写的 naive UTC，所以两头都在 UTC 里比——
    和 `_activity_span` 同一个道理。
    """
    r = _rows(
        conn,
        "SELECT MAX(t.created_at) FROM tutor_turns t "
        "JOIN tutor_sessions s ON s.id = t.session_id "
        "WHERE s.mode = 'feynman' AND s.ended_at IS NULL",
    )
    if not (r and r[0][0]):
        return {}
    last = _iso(str(r[0][0]))
    if last is None:
        return {}
    now_utc = now.astimezone(timezone.utc).replace(tzinfo=None)
    try:
        age = (now_utc - _naive(last)).total_seconds() / 60.0
    except (TypeError, ValueError, OverflowError):
        return {}
    return {"pupil_waiting": True} if 0 <= age <= PUPIL_WINDOW_MIN else {}


def _fresh_mastery(conn, now: datetime) -> dict:
    """最近一次「说通一个概念」距今多少分钟。

    ⚠️ **`pet_events.created_at` 是第三种时间口径**：`pet.emit` 写的是
    `datetime.now().astimezone()`，即**本地带偏移**的 ISO；而 ORM 那几张表是
    naive UTC。所以这里必须**按 aware 解析、和 aware 的 now 比**——把它当 naive
    用，就会差一个时区，正是 `pet.status()` 刚修过的那一类坑。
    """
    r = _rows(
        conn,
        "SELECT created_at, detail FROM pet_events WHERE kind = 'mastered' "
        "ORDER BY id DESC LIMIT 1",
    )
    if not (r and r[0][0]):
        return {}
    when = _iso(str(r[0][0]))
    if when is None:
        return {}
    local_now = now.astimezone()
    if when.tzinfo is None:  # 老行 / 手写的行：按本地补上，至少口径一致
        when = when.replace(tzinfo=local_now.tzinfo)
    try:
        age = (local_now - when).total_seconds() / 60.0
    except (TypeError, ValueError, OverflowError):
        return {}
    if age < 0:
        return {}
    # `detail == "taught"` 是 `tutor._note_first_mastery` 在费曼模式下打的标——
    # 台词据此区分「你搞懂了」和「你讲明白了」。老行没有这一列的值，当 socratic。
    return {"mastered_ago_min": age, "mastered_taught": str(r[0][1] or "") == "taught"}


def _signals(idle_sec: int | None = None, path: str = "", now: datetime | None = None) -> dict:
    """从真实数据采集信号。全 sync（同 `pet.status()` 的路子），全部 best-effort。

    `now` 只为测试注入——生产调用不传，用真实时间。
    """
    import sqlite3

    now = now or datetime.now()
    s: dict = {"path": path}
    if idle_sec is not None:
        try:
            s["idle_sec"] = max(0, int(idle_sec))
        except (TypeError, ValueError):
            pass

    try:
        conn = sqlite3.connect(settings.db_path)
        try:
            s.update(_today_counts(conn, now))
            s.update(_activity_span(conn, now))
            r = _rows(
                conn,
                "SELECT COUNT(*) FROM tutor_sessions WHERE stuck != '' AND stuck_resolved_at IS NULL",
            )
            s["stuck_open"] = int(r[0][0] or 0) if r else 0
            s.update(_focus_running(conn, now))
            s.update(_pupil_waiting(conn, now))
            s.update(_fresh_mastery(conn, now))
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - 状态算不出来，零柒就安静待着
        log.debug("pet state signals failed", exc_info=True)

    try:
        mtimes = _output_mtimes()
        if mtimes:
            newest = max(mtimes)
            s["fresh_output_min"] = max(0.0, (now.timestamp() - newest) / 60.0)
            s["outputs_today"] = sum(
                1 for m in mtimes if datetime.fromtimestamp(m).strftime("%Y-%m-%d") == now.strftime("%Y-%m-%d")
            )
    except Exception:  # noqa: BLE001
        log.debug("pet state output scan failed", exc_info=True)

    return s


def snapshot(idle_sec: int | None = None, path: str = "", now: datetime | None = None) -> dict:
    """采集 + 计算。任何一步坏了都降级成一个安静的状态，绝不抛。

    `idle_sec` / `path` 由前端传：**都是瞬时量，不落库、不写日志**。
    键鼠活动只在浏览器里算（`idle_sec`），服务端只知道「该显示无聊了」，
    不知道你在不在电脑前。

    `now` 只为测试注入——生产调用不传，用真实时间。
    """
    now = now or datetime.now()
    try:
        return compute(_signals(idle_sec=idle_sec, path=path, now=now), now)
    except Exception:  # noqa: BLE001
        log.debug("pet state snapshot failed", exc_info=True)
        return compute({"path": path}, now)
