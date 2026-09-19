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

   ⚠️ **P2（2026-09-16）在这里让开了一格，理由写在原地**：`night_owl`（连着三个晚上
   过十点）是**唯一**一个往回看几天的输入。它仍然不是账本——不落库、不算欠、不发通知、
   不进问候，每次都是现从 `messages` 的时间戳推出来的，把那些行删掉它就没了。
   为什么要它：作息是**模式**，不是「此刻」，用一个小时的能量值描述不了它；而「它陪你
   熬了三天所以蔫了」比「你坐太久了」更接近一只宠物的样子。代价也写清楚：它只看
   `messages` 一个来源（一个模块里「活跃」只有一个意思，那个意思已经定在
   `_activity_span` 里），所以**深夜只复习不打字的人，这个信号不会亮**。

纯函数（`energy` / `mode` / `compute`）与 DB 分开，照 `pet_plugins` 里 `roll_day` /
`water_due` / `focus_due` 的先例：规则能被单测完整覆盖，不用起服务、不用碰库。
"""
import json
import logging
from datetime import datetime, timedelta, timezone

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
    "gated": "waiting",  # 有一步跑完了，停在你点头那儿
    "busy": "running-right",  # 有活正在跑，它去盯着
    "returning": "waving",  # 好几天没见（P5）：回来这一趟值得挥个手——和问候是一家
    "idling": "waiting",  # 你摸了一会儿鱼
    "pupil": "waiting",  # 你正在讲给它听——同一个「在等你」，两个原因
    "resting": "running-left",  # 你走开很久，它也去眯一会儿
    "tired": "failed",  # 今天坐太久了
    "sleepy": "idle",  # 深夜
    "night_owl": "failed",  # 连着几个晚上熬到很晚（P2）：同一个「蔫」的姿势，两个原因
}

# ---------- 阈值（都是「此刻」的量，不是账本）----------

IDLE_MIN = 5  # 几分钟不动算「摸鱼」（只有前端给了 idle_sec 才判定）
REST_MIN = 30  # 多久算「走开很久」
AWAY_DAYS = 2  # 好几天没有任何活动才算「回来一趟」（久别重逢，P5）——半天不算，那叫摸鱼
CELEBRATE_MIN = 10  # 产出落地 / 刚说通一个概念后的庆祝窗口（分钟）
PUPIL_WINDOW_MIN = 120  # 费曼会话「还活着」的窗口：超过这么久没发言就当它已经散了
LATE_HOUR = 23  # 23:00 之后算深夜
EARLY_HOUR = 6  # 06:00 之前也算深夜
LOW_ENERGY = 40  # 低于这个就蔫了
# 「夜猫子」（P2）：连着几个晚上过十点还在，它就蔫。**只看已结束的日子**——
# 今天 22:00 之后这件事，在今天还没到 22:00 时根本不存在；拿今天当一格，这个信号
# 在白天永远是假的，而它恰恰该在白天被看见（你昨晚又熬了）。代价是它最多晚一天知道，
# 而「作息」本来就不是一个当天可判的东西。
NIGHT_HOUR = 22
NIGHT_OWL_DAYS = 3

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


def is_late_night(stamp: datetime | None, hour: int = NIGHT_HOUR) -> bool:
    """那一天算不算「晚睡」：**那天最后一条活动的本地时刻**在 `hour` 点之后。Pure。

    `stamp` 是库里那种 naive UTC（`messages.created_at`）。`None` = 那天一条活动都没有
    → **不算**：没开过工作台的那天，凭什么说人家熬夜。

    口径就是 PLAN 那句话的字面意思（「22 点后仍活跃」），只看那天**最后**一条：
    连着 22:00–01:00 那样干的人，那一天的 22–24 点这一段照样命中，所以不会漏。
    """
    if stamp is None:
        return False
    return stamp.replace(tzinfo=timezone.utc).astimezone().hour >= hour


def is_night_owl(late: list[bool], need: int = NIGHT_OWL_DAYS) -> bool:
    """`late`（旧→新，一个已结束的本地日一格）里**最近 `need` 天是不是天天晚睡**。Pure。

    只数最后 `need` 格：往前多喂几天不影响结论（信号只关心最近的作息）。
    不够 `need` 格（新装的库、或者根本没有那些天的记录）→ False。
    """
    return len(late) >= need and all(late[-need:])


def mode(signals: dict, now: datetime, e: int) -> str:
    """此刻该是什么模式。**顺序即优先级**，第一条命中就返回。

    优先级是照着「什么更值得说」排的：正在专注 > 刚交出东西 > 有活**停着等你** >
    有活在跑 > 好几天没见（重逢是一趟到访的问候）> 你人不在 > 你正在讲给它听 >
    深夜 > 连着晚睡 > 累了 > 你在哪个页面。

    「你人不在」排在「你在讲」之前是刻意的：讲解中走开 20 分钟，零柒该显示无聊，
    而不是一直假装还在听。走回来它自然回到 `pupil`。

    `gated` 排在 `busy` 之前也是刻意的：两件事可以同时为真，而**需要你的那件更值得说**。

    `returning`（P5）也排在「你人不在」那两档之前：隔了几天回来这一趟，重逢那句
    就是这次到访的问候——哪怕你回来只看了一眼又走开，「N 天没见」依然是真的，
    而「走开挺久了」只是这一小时的近况。

    `night_owl`（P2）排在 `sleepy` 之后、`tired` 之前：此刻是深夜就说深夜（那是眼前
    最要紧的一件），而**连着三天的那个模式比「今天坐太久了」更值得先开口**——前者是
    三天的证据，后者是一下午的疲劳。两者都命中时只说一句，说更早发生的那件。
    """
    if signals.get("focus_running"):
        return "focusing"
    if _celebration(signals):
        return "celebrating"
    if signals.get("gated"):
        return "gated"
    if signals.get("busy"):
        return "busy"
    if signals.get("away_days"):
        return "returning"
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
    if signals.get("night_owl"):
        return "night_owl"
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
        # 引擎名能拿到就说清在跑什么（「它在翻工具箱」的诚实版：说的是真在跑的那件事）；
        # 定时任务那一跳没有名字（`task_runs` 只知道有一行在跑），所以退回一句泛的。
        what = str(signals.get("busy_with") or "").strip()
        return f"{what}正在跑，我去盯着。" if what else "活正在跑，我去盯着。"
    if m == "gated":
        # P4 补的那一格：有一步**跑完了、停着等人点头**（`task_runs.status='awaiting_approval'`）。
        # 这不是催办，是系统的事实——仓库本来就会为它弹一条桌面通知（`tasks._notify_gate`），
        # 这句只是把同一件事摆到它脸上。**不报件数**：一报就成了「你还欠 N 件」的口吻。
        return "有一步停着，等你点头。"
    if m == "returning":
        # 久别重逢（P5）：只说事实——几天没见；走之前在拆什么（拆点就发生在离开前后
        # 那阵子才提，见 `_away` 的守卫）。不问「为什么这么久没来」，不算「你欠了几天」
        # ——重逢是陈述，不是考勤。
        days = int(signals.get("away_days") or 0)
        what = str(signals.get("away_topic") or "").strip()
        if what:
            return f"{days} 天没见。走的时候你在拆「{what}」。"
        return f"{days} 天没见。"
    if m == "tired":
        return "你坐太久了。我蔫了，你也差不多。"
    if m == "night_owl":
        # P2：主语是**它自己**（「我有点蔫」），事实是无主语的陈述。**不劝、不评、不算账**——
        # 没有「你该早睡了」，也没有「连续三天」这种像在记账的计数，只说「三个晚上」这个事实。
        return "连着三个晚上都过了十点。我有点蔫。"
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
        # 「在跑什么」与「几件停着等你」是**事实**，界面可以直接显示；
        # 它们不参与判定之外的任何事，也不是第二份真值（都从 `signals` 派生）。
        "busy_with": str(signals.get("busy_with") or ""),
        "gated": int(signals.get("gated") or 0),
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


def output_files() -> list[tuple[str, float]]:
    """`vault/` 下几类成品：`(vault 相对路径, mtime)`。与 `pet._OUTPUT_DIRS` 同一份
    目录清单——刻意引用它而不是抄一遍，改了那边这里不会走偏（也就是
    `pet.is_output_path` 那一条判据：算不算成品在这个仓库里只有一个答案）。

    周报（`core/weekly.py`）与「今天」都从这里取：**同一批文件，只是窗口不同**。
    两处各写一遍 glob 的话，「这周交出 3 份」与「今天交出 1 份」迟早对不上账。
    """
    out: list[tuple[str, float]] = []
    for d in pet._OUTPUT_DIRS:  # noqa: SLF001 - 同包内共用一份真值
        p = VAULT_DIR / d
        if not p.is_dir():
            continue
        for f in p.glob("*.md"):
            try:
                out.append((f"{d}/{f.name}", f.stat().st_mtime))
            except OSError:
                continue
    return out


def _output_mtimes() -> list[float]:
    return [m for _rel, m in output_files()]


def _today_counts(conn, now: datetime) -> dict:
    """今天的那几个计数。区间用 UTC 边界，见 `_utc_day_bounds`。"""
    # 卡点的那个状态串**只有 `tasks` 有一份**（`_GATE_STATUS`）——这里引它而不是抄一遍：
    # 抄一份的话，哪天那边改名，这边会安静地永远不显示「停着等你」。
    from app.core.tasks import _GATE_STATUS  # noqa: PLC0415 - tasks 也引 pet，只能在这里进

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
        elif st == _GATE_STATUS:
            out["gated"] = int(n or 0)
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


def _away(conn, now: datetime) -> dict:
    """「回来一趟」的信号（P5 · 久别重逢）：好几天没有任何活动。

    「活动」看两个来源：`messages`（与 `_activity_span` 同一列——作息那条 P2 的
    口径「说话」就是它）和 `pet_chats`（跟零柒自己聊天**也算来过**——聊天落库之后，
    只聊天不记笔记的人不该被说「没见」）。两张表的时间口径不同（naive UTC 对
    本地带偏移），分别解析成 aware 再比，**不拿字符串比**（字符串序在两种格式
    之间没有意义）。都没有 → 空库/新装，谈不上「重逢」。

    「走的时候在拆什么」：最新一个拆点，**只有它就发生在离开前后那阵子**才提
    （离开的时长 + 一天的宽限）——拆点是好几个月前的事、人上周还在，那就不是
    「走的时候」，说出来就是编。
    """
    now_aware = now.astimezone()
    last: datetime | None = None
    r = _rows(conn, "SELECT MAX(CAST(created_at AS TEXT)) FROM messages")
    if r and r[0][0]:
        d = _iso(str(r[0][0]))
        if d is not None:
            d = d.replace(tzinfo=timezone.utc)  # messages 是 naive UTC
            last = d
    r = _rows(conn, "SELECT MAX(CAST(created_at AS TEXT)) FROM pet_chats")
    if r and r[0][0]:
        d = _iso(str(r[0][0]))
        if d is not None:
            if d.tzinfo is None:  # 老行兜底：按本地补上
                d = d.astimezone()
            if last is None or d > last:
                last = d
    if last is None:
        return {}
    gap_min = (now_aware - last).total_seconds() / 60.0
    days = gap_min / 1440.0
    if days < AWAY_DAYS:
        return {}
    out = {"away_days": int(days)}
    r = _rows(conn, "SELECT point, created_at FROM digest_points ORDER BY id DESC LIMIT 1")
    if r and r[0][0]:
        d = _iso(str(r[0][1] or ""))
        if d is not None:
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            age_min = (now_aware - d).total_seconds() / 60.0
            if 0 <= age_min <= gap_min + 1440:
                out["away_topic"] = str(r[0][0])[:80]
    return out


def _late_nights(conn, now: datetime, days: int = NIGHT_OWL_DAYS) -> list[bool]:
    """最近 `days` 个**已结束的**本地日，每天是不是晚睡（旧 → 新）。

    `messages` 一个来源，与 `_activity_span` 同一条：**一个模块里「活跃」只能有一个
    意思**，那个意思已经定在那儿了（你要把复习、教学也算活跃，改那一处，别在这儿另立）。
    一天一条 `MAX(created_at)`，三天三条小查询。

    为什么从**昨天**开始数：见 `NIGHT_HOUR` 那段注释。
    """
    out: list[bool] = []
    for i in range(max(1, int(days)), 0, -1):
        start, end = _utc_day_bounds(now - timedelta(days=i))
        r = _rows(
            conn,
            "SELECT MAX(CAST(created_at AS TEXT)) FROM messages "
            "WHERE CAST(created_at AS TEXT) >= ? AND CAST(created_at AS TEXT) < ?",
            (start, end),
        )
        stamp = _iso(r[0][0]) if (r and r[0] and r[0][0]) else None
        out.append(is_late_night(stamp))
    return out


def running_engines() -> list[str]:
    """**进程内**正在跑的那些引擎（`inflight` 的 key），比如 `recap` / `decide`。

    这是 `task_runs` 看不到的那一半：页面点出来的六个成文引擎不写 `task_runs`，
    但它们正是「有活正在跑」最真实的证据——用户盯着转圈的正是那几秒。
    进程内状态，重启即空，**不落库**（`inflight` 自己就是这么设计的）。
    """
    try:
        from app.core import inflight

        return sorted(inflight.running())
    except Exception:  # noqa: BLE001 - 拿不到就当没有在跑的
        return []


def engine_label(key: str) -> str:
    """引擎名 → 一个中文词。**不另抄一份表**：`mcp._ARTIFACT_KINDS` 已经是
    「这六个东西叫什么」的唯一出处（落点目录与标签都从它来）。认不出来就用原名。"""
    try:
        from app.core import mcp

        return mcp._ARTIFACT_KINDS.get(key, ("", ""))[1] or key  # noqa: SLF001 - 同包内共用一份真值
    except Exception:  # noqa: BLE001
        return key


def work_fingerprint(now: datetime | None = None) -> str:
    """「此刻有什么在跑」的指纹：**变了就说明界面该重算一次状态**。

    只读两样便宜的东西：进程内正在跑的引擎、今天的在跑/卡点任务数。刻意**不**搬
    `_signals()`——它要扫五个产出目录、算活跃跨度，给两秒一次的流用太贵。

    它只回答「有没有变化」，**不含任何给用户看的数**；状态依然只有 `snapshot()`
    一个出处，指纹不构成第二份真值。查询挂了返回空串（= 一次多余的刷新，无害）。
    """
    now = now or datetime.now()
    counts: dict = {}
    try:
        import sqlite3

        conn = sqlite3.connect(settings.db_path)
        try:
            counts = _today_counts(conn, now)
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        log.debug("pet state fingerprint failed", exc_info=True)
    return "|".join(
        [
            "engines:" + ",".join(running_engines()),
            "running:1" if counts.get("busy") else "running:0",
            f"gated:{int(counts.get('gated') or 0)}",
        ]
    )


def day_facts(now: datetime | None = None) -> dict:
    """今天**已经发生的事**：拆了几个点、出了几张卡、说通了几个概念、过了几张卡、交出几份成品。

    收工那句陈述读它（M2 · PLAN §3 G2 第 3 条）。与「今日概览五档」（`core/today`）
    分工不同：那是**待办**（未消化 / 到期卡 / 卡点），这里只说已经做完的事——
    两者都真实，但一个是清单、一个是陈述，**混起来就变成「你还欠」**。

    全部按**本地日**算（`_utc_day_bounds`：那张换算只能有一份）。坏了返回全零，
    绝不抛——一句问候不值得让调度器红。
    """
    now = now or datetime.now()
    out = {"digested": 0, "cards_made": 0, "got": 0, "reviews": 0, "outputs": 0}
    start, end = _utc_day_bounds(now)
    try:
        import sqlite3

        conn = sqlite3.connect(settings.db_path)
        try:
            for key, col, table in (
                ("digested", "created_at", "digest_points"),
                ("cards_made", "created_at", "cards"),
                ("reviews", "reviewed_at", "card_reviews"),
            ):
                r = _rows(
                    conn,
                    f"SELECT COUNT(*) FROM {table} "
                    f"WHERE CAST({col} AS TEXT) >= ? AND CAST({col} AS TEXT) < ?",
                    (start, end),
                )
                out[key] = int(r[0][0] or 0) if r else 0
            r = _rows(
                conn,
                "SELECT COUNT(*) FROM tutor_sessions "
                "WHERE verdict = 'got' AND CAST(COALESCE(ended_at, created_at) AS TEXT) >= ? "
                "AND CAST(COALESCE(ended_at, created_at) AS TEXT) < ?",
                (start, end),
            )
            out["got"] = int(r[0][0] or 0) if r else 0
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - 陈述读不出来就少说一句，不是错误
        log.debug("pet state day facts failed", exc_info=True)
    try:
        mtimes = _output_mtimes()
        today = now.strftime("%Y-%m-%d")
        out["outputs"] = sum(
            1 for m in mtimes if datetime.fromtimestamp(m).strftime("%Y-%m-%d") == today
        )
    except Exception:  # noqa: BLE001
        log.debug("pet state day facts output scan failed", exc_info=True)
    return out


def last_digest_point(now: datetime | None = None) -> dict | None:
    """**昨天**（本地日）拆出来的最新一个点——开工那句问的就是它（M2 · PLAN §3 G2）。

    为什么是昨天、不是最近七天：仪式要的是「昨天喂进去的东西，今天还记得吗」。
    更早的属于记录，不是此刻该问的一句（与 `tutor.is_recurring_mistake` 的窗口同一条纪律）。
    没有就返回 None——**那就普通问候**，不硬凑一个问题出来。
    """
    now = now or datetime.now()
    try:
        import sqlite3

        start, end = pet.local_day_utc_bounds(now - timedelta(days=1))
        conn = sqlite3.connect(settings.db_path)
        try:
            r = _rows(
                conn,
                "SELECT point, why FROM digest_points "
                "WHERE CAST(created_at AS TEXT) >= ? AND CAST(created_at AS TEXT) < ? "
                "ORDER BY id DESC LIMIT 1",
                (start, end),
            )
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        log.debug("pet state last digest point failed", exc_info=True)
        return None
    if not r or not r[0][0]:
        return None
    return {"title": str(r[0][0])[:200], "why": str(r[0][1] or "")[:300]}


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
            s.update(_focus_running(conn, now))
            s.update(_pupil_waiting(conn, now))
            s.update(_fresh_mastery(conn, now))
            # P5：好几天没来 → 久别重逢那句。**只在真为真时才写进信号**（缺键就是没有），
            # 与其余几项一致：没有那件事，就不必让 `mode()` 多看一眼。
            s.update(_away(conn, now))
            # P2：连着三个晚上过十点 → 蔫。**只在真为真时才写进信号**（缺键就是没有），
            # 与其余几项一致：没有那件事，就不必让 `mode()` 多看一眼。
            if is_night_owl(_late_nights(conn, now)):
                s["night_owl"] = True
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - 状态算不出来，零柒就安静待着
        log.debug("pet state signals failed", exc_info=True)

    # 进程内正在跑的引擎（`task_runs` 里没有它们）。**放在 DB 那块之后**：引擎在跑时
    # 它就是「此刻在跑什么」最准的答案，所以允许它盖掉上面那个泛泛的 `busy`。
    engines = running_engines()
    if engines:
        s["busy"] = True
        s["busy_with"] = engine_label(engines[0])

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
