"""迁移版本化（W6）：把那张写死的 ALTER 列表变成有序、有记录、能 dry-run 的迁移。

**为什么。** 原来 `main.py` 里是一张写死的 `(表, 列, DDL)` 列表，每次启动全表重放。它其实
能用，而且靠 `PRAGMA table_info` 自检所以幂等 —— 但它**没有任何记录**：没有任何地方知道
这个库现在是哪一版、下一步该跑什么、能不能先看看再跑。这一轮它连着咬了两次：给
`eval_items` / `tutor_sessions` 加 `domain` 时，副本库因为没走应用启动而缺列
（`create_all` 只建新表、**不给老表加列**），脚本当场 SQL 报错。

**不重写历史。** 第一个迁移就是**基线**：把改动之前那张列表原样收进来，记成 v1。
- 老库：跑完 v1 就和改动前一样（缺哪列补哪列），并记下 v1；
- 新库：`create_all` 已经建全了列，v1 是空操作，同样记下 v1。

以后每加一列/改一次结构 = 追一个 v2、v3…，**只跑没跑过的那些**。

**能退回去。** 有待跑的迁移时，先自动备份一次（`core/backup.py` 现成的能力）：
迁移动的是真库，出错没有备份就没得退。没有待跑的就**不备份**——不然每次启动都多一份。
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

log = logging.getLogger(__name__)


# 改动之前那张写死的列表，原样搬过来当基线。**不要在这里加新东西** ——
# 新的结构改动请追一个 MIGRATIONS 条目，这样它才有版本、才有记录、才只跑一次。
LEGACY_COLUMNS: list[tuple[str, str, str]] = [
    ("conversations", "pinned", "ALTER TABLE conversations ADD COLUMN pinned BOOLEAN DEFAULT 0"),
    ("conversations", "folder", "ALTER TABLE conversations ADD COLUMN folder VARCHAR(100) DEFAULT ''"),
    ("messages", "feedback", "ALTER TABLE messages ADD COLUMN feedback VARCHAR(4)"),
    # V2.3 agent orchestration columns (tasks table)
    ("tasks", "mode", "ALTER TABLE tasks ADD COLUMN mode VARCHAR(10) DEFAULT 'simple'"),
    ("tasks", "tool_whitelist", "ALTER TABLE tasks ADD COLUMN tool_whitelist TEXT DEFAULT ''"),
    ("tasks", "max_rounds", "ALTER TABLE tasks ADD COLUMN max_rounds INTEGER DEFAULT 12"),
    ("tasks", "retry", "ALTER TABLE tasks ADD COLUMN retry INTEGER DEFAULT 1"),
    ("tasks", "notify_on_error", "ALTER TABLE tasks ADD COLUMN notify_on_error BOOLEAN DEFAULT 0"),
    ("tasks", "trigger_kind", "ALTER TABLE tasks ADD COLUMN trigger_kind VARCHAR(10) DEFAULT 'cron'"),
    ("tasks", "watch_path", "ALTER TABLE tasks ADD COLUMN watch_path VARCHAR(500) DEFAULT ''"),
    ("tasks", "chain_next_id", "ALTER TABLE tasks ADD COLUMN chain_next_id INTEGER"),
    # 人工卡点（§4-12）：这一步等人点头才触发下游
    ("tasks", "require_approval", "ALTER TABLE tasks ADD COLUMN require_approval BOOLEAN DEFAULT 0"),
    # 会议闭环（§4-13）：转写步骤 + 共享落点目录
    ("tasks", "action", "ALTER TABLE tasks ADD COLUMN action VARCHAR(12) DEFAULT 'prompt'"),
    ("tasks", "landing_dir", "ALTER TABLE tasks ADD COLUMN landing_dir VARCHAR(300) DEFAULT ''"),
    # V1.4 memory upgrade
    ("memories", "source", "ALTER TABLE memories ADD COLUMN source VARCHAR(10) DEFAULT 'manual'"),
    ("memories", "kind", "ALTER TABLE memories ADD COLUMN kind VARCHAR(10) DEFAULT 'fact'"),
    # 记忆证据链（DeepTutor 参考项：可检视记忆）
    ("memories", "evidence_json", "ALTER TABLE memories ADD COLUMN evidence_json TEXT DEFAULT '[]'"),
    # V6.2 observability: per-message / per-run token usage
    ("messages", "tokens_in", "ALTER TABLE messages ADD COLUMN tokens_in INTEGER"),
    ("messages", "tokens_out", "ALTER TABLE messages ADD COLUMN tokens_out INTEGER"),
    # 产出回执落库（P1）：正文可能空着，回执不能丢
    ("messages", "artifacts_json", "ALTER TABLE messages ADD COLUMN artifacts_json TEXT"),
    ("task_runs", "tokens_in", "ALTER TABLE task_runs ADD COLUMN tokens_in INTEGER"),
    ("task_runs", "tokens_out", "ALTER TABLE task_runs ADD COLUMN tokens_out INTEGER"),
    # 工作流运行的尺子（§4-10）：接地分 0-5 + 一句话理由
    ("task_runs", "grounded", "ALTER TABLE task_runs ADD COLUMN grounded INTEGER"),
    ("task_runs", "judge_reason", "ALTER TABLE task_runs ADD COLUMN judge_reason TEXT DEFAULT ''"),
    ("task_runs", "run_dir", "ALTER TABLE task_runs ADD COLUMN run_dir VARCHAR(300) DEFAULT ''"),
    # 用量按事记（§4-16）
    ("model_usage", "thread_id", "ALTER TABLE model_usage ADD COLUMN thread_id INTEGER"),
    # tutor history compression (maple-os 参考项：长会话中段压缩)
    ("tutor_sessions", "summary", "ALTER TABLE tutor_sessions ADD COLUMN summary TEXT DEFAULT ''"),
    ("tutor_sessions", "summary_upto", "ALTER TABLE tutor_sessions ADD COLUMN summary_upto INTEGER DEFAULT 0"),
    ("tutor_sessions", "repo", "ALTER TABLE tutor_sessions ADD COLUMN repo VARCHAR(100) DEFAULT ''"),
    ("tutor_sessions", "mode", "ALTER TABLE tutor_sessions ADD COLUMN mode VARCHAR(10) DEFAULT 'socratic'"),
    # 卡点清单：待解 / 已解（NULL = 待解）
    ("tutor_sessions", "stuck_resolved_at", "ALTER TABLE tutor_sessions ADD COLUMN stuck_resolved_at DATETIME"),
    # 领域（Q3 形态）：三样证据各自的领域标签。空的含义是「还没归类」，不是「无领域」。
    ("tutor_sessions", "domain", "ALTER TABLE tutor_sessions ADD COLUMN domain VARCHAR(30) DEFAULT ''"),
    ("eval_items", "domain", "ALTER TABLE eval_items ADD COLUMN domain VARCHAR(30) DEFAULT ''"),
]


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    apply: Callable[..., Awaitable[None]]


async def _m001_baseline(conn) -> None:
    """v1 基线：改动之前那张写死的列表，原样重放一遍。

    仍然靠 `PRAGMA table_info` 自检，所以在新库上（`create_all` 已建全列）是彻底的空操作，
    在老库上只补缺的那些。**不重写历史**：老库里已有的列一根手指都不碰。
    """
    from sqlalchemy import text

    for table, col, ddl in LEGACY_COLUMNS:
        cols = (await conn.execute(text(f"PRAGMA table_info({table})"))).mappings().all()
        if cols and not any(c["name"] == col for c in cols):
            await conn.execute(text(ddl))
            log.info("迁移 v1：%s 补上 %s", table, col)


async def _add_column(conn, table: str, col: str, ddl: str) -> bool:
    """补一列，已经有就跳过。返回是否真的动了结构。

    **每条给老表加列的迁移都要走这里**：新库是 `create_all` 先建的（列早就有了），
    老库才需要 ALTER —— 不先查一下就会在新库上撞一句 `duplicate column name`。
    """
    from sqlalchemy import text

    cols = (await conn.execute(text(f"PRAGMA table_info({table})"))).mappings().all()
    if not cols:
        return False  # 表都没有：那是 create_all 的事，迁移不负责建表
    if any(c["name"] == col for c in cols):
        return False
    await conn.execute(text(ddl))
    return True


async def _m002_turn_quality(conn) -> None:
    """v2：回合账本加 `quality_json`（W2a 的两条底线校验结论）。

    单独一版而不是塞进 v1：v1 是**历史基线**，它记的是「改动前那张列表」，
    往里加东西就等于把历史改写了一遍，以后没人分得清哪一版到底改了什么。
    """
    if await _add_column(
        conn, "turn_traces", "quality_json", "ALTER TABLE turn_traces ADD COLUMN quality_json TEXT DEFAULT '{}'"
    ):
        log.info("迁移 v2：turn_traces 补上 quality_json")


async def _m003_model_profiles(conn) -> None:
    """v3：模型画像两张表（W7）。

    新表用 `create` + `checkfirst=True`，所以老库会补上、新库（`create_all` 已经建过）是空操作 ——
    与 `_ensure_table` 同一招。**仍然要记一个版本号**：没有记录的话，没人知道这个库有没有这两张表。
    """
    from app.models import ModelProfile, ModelProfileChange

    for table in (ModelProfile.__table__, ModelProfileChange.__table__):
        await conn.run_sync(lambda sync_conn, t=table: t.create(sync_conn, checkfirst=True))
    log.info("迁移 v3：model_profiles / model_profile_changes 就位")


async def _m004_task_thread(conn) -> None:
    """v4：任务行记住「这件事」（M2）。

    工作链起链时按题目写进来，下游每一步靠它把产物挂到同一件事上。走 `_add_column`
    ——新库 `create_all` 已经建好这一列，老库才 ALTER。
    """
    if await _add_column(
        conn, "tasks", "thread_id", "ALTER TABLE tasks ADD COLUMN thread_id INTEGER"
    ):
        log.info("迁移 v4：tasks 补上 thread_id")


async def _m005_run_thread(conn) -> None:
    """v5：运行行也记住「这件事」（M2）。

    链条可能在人工卡点上停一轮再续跑，续跑时「是哪件事」只能从**那一轮运行**上读回来
    （任务行上是「最近一次在忙哪件事」的提示，不保证就是这一轮）。与 v4 同理走 `_add_column`。
    """
    if await _add_column(
        conn, "task_runs", "thread_id", "ALTER TABLE task_runs ADD COLUMN thread_id INTEGER"
    ):
        log.info("迁移 v5：task_runs 补上 thread_id")


async def _m006_skill_eval(conn) -> None:
    """v6：技能包的成绩表（环一的收口）。

    新表用 `create` + `checkfirst=True`（与 v3 同一招）：老库补上、新库（`create_all`
    已经建过）是空操作。**仍然要记一个版本号**——没有记录的话，没人知道这个库有没有这张表。
    """
    from app.models import SkillEvalRun

    await conn.run_sync(lambda sync_conn: SkillEvalRun.__table__.create(sync_conn, checkfirst=True))
    log.info("迁移 v6：skill_eval_runs 就位")


async def _m007_card_retell(conn) -> None:
    """v7：复习记录多一列「重讲原文」（M1 · PLAN §3 G1）。

    与自评写**同一条**行，只是多这一列。它是判分的输入，也是「这一天你真的重讲了」
    的唯一凭据（北星指标读它）。追加式加列，不开新表。
    """
    if await _add_column(
        conn, "card_reviews", "retell", "ALTER TABLE card_reviews ADD COLUMN retell TEXT DEFAULT ''"
    ):
        log.info("迁移 v7：card_reviews 补上 retell（重讲原文）")


async def _m008_decision_witness(conn) -> None:
    """v8：决策日志多一列「多久之后值得回头看一眼」（M4 · PLAN §3 G5）。

    这是「拉取式：没有队列、没有任何东西会催你」那条规矩**唯一一次让开**，理由写在
    两处（`core/decision_log.py` 开篇 / `models.DecisionLog`，说的是同一件事）：
    纯拉取式在 90 天这个尺度上会把这张表变成死数据。

    **不回填历史行**：到期时间是 `created_at + witness_days` **算出来**的，所以
    `DEFAULT 90` 一填，老行就都到点了——迁移只加一列，不搬数据，也不写第二份真值。
    要退回真·拉取式时，删掉这一列就够了（那正是它是一列而不是一张表的原因）。
    """
    if await _add_column(
        conn,
        "decision_log",
        "witness_days",
        "ALTER TABLE decision_log ADD COLUMN witness_days INTEGER DEFAULT 90",
    ):
        log.info("迁移 v8：decision_log 补上 witness_days（到期回看，默认 90 天）")


async def _m009_card_judged(conn) -> None:
    """v9：复习记录多一列「这一档是谁打的」（PLAN2 T2 · 校准曲线）。

    只有一条写入路径会把它置真：`retell.adjudicate()` 判分成功之后落账那一次。
    看卡自评、以及「判分挂了退回自评」，写的都是默认的假。

    **不回填历史行**，而且这次不回填是**语义上必须的**：上线之前那些行，`False` 在
    「自评还是判过」这件事上是**未知**——那时候还没有这一列，判过的行和自评的行长得
    一模一样。所以曲线只统计 v9 之后的行（`cards.calibration` 的 docstring 写着这条）；
    把历史行当成自评会让曲线开口就说一句假话。
    """
    if await _add_column(
        conn,
        "card_reviews",
        "judged",
        "ALTER TABLE card_reviews ADD COLUMN judged BOOLEAN DEFAULT 0",
    ):
        log.info("迁移 v9：card_reviews 补上 judged（这一档是不是判分器判的）")


async def _m010_card_judged_sha(conn) -> None:
    """v10：复习记录多一列「判它的那一版判分器是谁」（PLAN2 §9.4）。

    v9 只记了「是不是判分器判的」，于是判分器换版之后，两版的行在曲线上混在一起、还被
    标成同一版。这一列把版本记在行上，曲线于是可以**按 sha 分段**（`cards.calibration`
    的 `segments`）。

    **不回填**：v9–v10 之间那些判过的行，哪一版判的**本来就不知道**，回填一个当前的 sha
    等于给它们编一个版本。空字符串 = 「判过，但不知道哪一版」，`cards.calibration` 把它
    单列一格（`sha: ""`），界面上写「版本未知」。

    这一列是**用户定夺后才加的**（PLAN2 §3 原来写的是「全规划只有一列」）：当时真库里
    `card_reviews` 一行都没有，所以「历史行没法标版本」这个代价是零；再晚一点加，第一批
    判分行就永远只能是「未知」。
    """
    if await _add_column(
        conn,
        "card_reviews",
        "judged_sha",
        "ALTER TABLE card_reviews ADD COLUMN judged_sha VARCHAR(12) DEFAULT ''",
    ):
        log.info("迁移 v10：card_reviews 补上 judged_sha（判它的那一版提示词）")


async def _m011_session_judged_sha(conn) -> None:
    """v11：教学会话多一列「这个 verdict 是谁定的」（PLAN2 P2-3 · 会话侧校准）。

    非空 = 判分器判的（存判它的那一版 `SESSION_JUDGE_SYSTEM` 的指纹）；空 = 你自己标的。

    **只占一列**（卡片侧当时用了两列）：那里多出的那一列是为了表示「判过但不知道哪一版」
    这批历史行；会话侧没有这批行（真库 `tutor_sessions` 当时 **0 场**），所以「非空 = 判的」
    既不撒谎也不缺信息。**不回填**：v11 之前判过的会话在这一列上是空的，与自评看起来
    一样——这就是那段历史的代价，而它当时是零场。
    """
    if await _add_column(
        conn,
        "tutor_sessions",
        "judged_sha",
        "ALTER TABLE tutor_sessions ADD COLUMN judged_sha VARCHAR(12) DEFAULT ''",
    ):
        log.info("迁移 v11：tutor_sessions 补上 judged_sha（这个自评是谁定的）")


async def _m012_prereq_adoption(conn) -> None:
    """v12：让「回指采纳」可算（PLAN2 §6 第三条度量）——两列，零新表。

    那条度量问的是「搁置卡的前置候选有没有人看」：它是拉取式功能唯一的生死指标
    （没人看就撤，不留尸体）。可这件事在两个地方都没有痕迹：

    - **看过**：候选是当场算的、不落库，翻一眼就走了 —— `cards.prereq_seen_at`；
    - **采纳**：从候选点进去开的那场课，与其他任何一场课长得一模一样
      —— `tutor_sessions.prereq_card_id`。

    两列都是 nullable，**不回填**（旧行一律 NULL = 「没翻过 / 不是从候选开的」——
    这在那批行上是**真的**，不是未知：这个功能上线之前，一次都没有过）。

    为什么这次允许破 §3 那条「零新列零新表」：与 §9.4 同一个理由，而且更硬——
    **没有这两列，那条度量就只能靠猜**（从 `tutor_sessions` 里倒推「topic 恰好等于
    某个候选概念」），而猜出来的生死指标会把一个没人用的功能判成有人用。
    当时真库里 `cards` 与 `tutor_sessions` 都是 **0 行**，所以两列的代价是零。
    """
    if await _add_column(
        conn,
        "cards",
        "prereq_seen_at",
        "ALTER TABLE cards ADD COLUMN prereq_seen_at DATETIME",
    ):
        log.info("迁移 v12：cards 补上 prereq_seen_at（最后一次翻前置候选的时刻）")
    if await _add_column(
        conn,
        "tutor_sessions",
        "prereq_card_id",
        "ALTER TABLE tutor_sessions ADD COLUMN prereq_card_id INTEGER",
    ):
        log.info("迁移 v12：tutor_sessions 补上 prereq_card_id（这场课从哪张搁置卡的候选开的）")


async def _m013_feedback_injected(conn) -> None:
    """v13：给质量闭环补一列「这份产出吃着技能生成的没有」（PLAN3 §9.2 决策4）——一列，零新表。

    反馈的 join key 是 `(kind, prompt_sha, model_id)`，而 `prompt_sha` 取自**模块级常量**
    （`compose._SYNTH_PROMPT` 那类），所以 S1 注入一份技能**并不改变它**：注入了和没注入的
    运行，👍/👎 会汇进同一份成绩，「哪版提示词更好」被静默掺进两种工序。这一列让聚合能把
    「有注入」单独摆一行，而 key 一个不动（改 key 会断裂历史，等于改写 PLAN.md 的口径）。

    **三态、不是 bool**：`""` 不知道 / `"[]"` 没注入 / `"[技能名…]"` 有注入。为什么要有
    「不知道」——从产出清单**事后**点的 👍/👎，那一刻前端手里没有注入信息；把未知记成
    「没注入」，这一列就成了编出来的数（读不到就说读不到）。

    为什么不回填：这个功能上线之前，历史行确实**没有**「有没有注入」这个属性（那时候
    引擎根本不吃 skill）。留 `""`（不知道）比编一个 `"[]"` 诚实。当时真库
    `artifact_feedback` 是 **0 行**（2026-09-17 数过），所以这一列的代价是零。
    """
    if await _add_column(
        conn,
        "artifact_feedback",
        "injected",
        "ALTER TABLE artifact_feedback ADD COLUMN injected TEXT DEFAULT ''",
    ):
        log.info("迁移 v13：artifact_feedback 补上 injected（这次产出吃着技能生成的没有）")


async def _m014_thread_kind_session(conn) -> None:
    """v14：挂接的 `kind` 从 `"tutor"` 改叫 `"session"`（R3 · PLAN5 §3）。

    **为什么改**：`"tutor"` 这个名字说的是**功能**（教学），而这一列说的是**挂的是什么东西**
    （一场会话）。七个 kind 里其它六个（material / note / card / output / task / decision）
    都是「东西」，只有它是「功能」——所以 PLAN5 把它写成 `session` 是把它归回同一类。
    代码侧的改名是原子的（`threads.KINDS`），但**已经写进库的行不会自己变**，
    所以这里补一条数据迁移：不改的话，历史挂接会在改完的当天集体变成「引用不存在」——
    `_resolve()` 只认新 kind，`exists=False`，界面上那一条就灰了。

    **只改值，不动表结构**：`thread_items` 一行都不增删。真库数过（2026-09-18）
    `thread_items` 是 **0 行**，所以这条在这里是空操作——但它在别的库（或从备份恢复的库）
    上不是，而「因为我的库是空的所以不写迁移」正是那种一年后没人查得出来的错。
    """
    from sqlalchemy import text as _sql

    r = await conn.execute(
        _sql("UPDATE thread_items SET kind = 'session' WHERE kind = 'tutor'")
    )
    if r.rowcount:
        log.info("迁移 v14：thread_items 里有 %s 条挂接从 tutor 改名为 session", r.rowcount)


# 有序。**只增不改**：已经发出去的版本号不许改内容（谁跑过就永远跑过了）。
MIGRATIONS: list[Migration] = [
    Migration(1, "baseline：补齐历史列（改动前那张写死的列表）", _m001_baseline),
    Migration(2, "W2a：回合账本加 quality_json（两条底线校验的结论）", _m002_turn_quality),
    Migration(3, "W7：模型画像与它的基线（model_profiles / model_profile_changes）", _m003_model_profiles),
    Migration(4, "M2：任务行记住它处理的是哪件「事」（tasks.thread_id）", _m004_task_thread),
    Migration(5, "M2：运行行也记住它（task_runs.thread_id）——过卡点要靠它", _m005_run_thread),
    Migration(6, "环一：技能包的成绩表（skill_eval_runs）", _m006_skill_eval),
    Migration(7, "M1：复习记录加 retell（重讲原文，判分的输入）", _m007_card_retell),
    Migration(8, "M4：decision_log 加 witness_days（到点回看，默认 90 天）", _m008_decision_witness),
    Migration(9, "N1：card_reviews 加 judged（这一档是判分器判的还是自评的）", _m009_card_judged),
    Migration(10, "N1：card_reviews 加 judged_sha（判它的那一版提示词，曲线按它分段）", _m010_card_judged_sha),
    Migration(11, "P2-3：tutor_sessions 加 judged_sha（这个 verdict 是判分器定的还是你定的）", _m011_session_judged_sha),
    Migration(12, "§6：让「回指采纳」可算（cards.prereq_seen_at + tutor_sessions.prereq_card_id）", _m012_prereq_adoption),
    Migration(13, "S1：质量闭环加 injected（这份产出吃着技能生成的没有，三态）", _m013_feedback_injected),
    Migration(14, "R3：挂接的 kind 从 tutor 改名为 session（一场会话，不是一个功能）", _m014_thread_kind_session),
]


def _version_of(m: Migration) -> int:
    return int(m.version)


async def _ensure_table(conn) -> None:
    from app.models import SchemaMigration

    await conn.run_sync(lambda sync_conn: SchemaMigration.__table__.create(sync_conn, checkfirst=True))


async def applied() -> dict[int, str]:
    """已应用的版本 → 应用时刻（ISO）。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import SchemaMigration, iso_utc

    try:
        async with SessionLocal() as db:
            rows = (await db.execute(select(SchemaMigration).order_by(SchemaMigration.version))).scalars().all()
    except Exception:  # noqa: BLE001 - 还没有这张表 = 一版都没跑过
        return {}
    return {r.version: iso_utc(r.applied_at) or "" for r in rows}


async def pending() -> list[Migration]:
    """按版本号排好、还没跑过的那些。"""
    done = await applied()
    return sorted((m for m in MIGRATIONS if _version_of(m) not in done), key=_version_of)


async def run(dry_run: bool = False) -> dict:
    """跑没跑过的迁移。

    `dry_run=True` 只回答「会跑什么」，**一个字节都不写**（不建表、不备份、不改结构）。
    有待跑的迁移时先自动备份一次：迁移动的是真库，出错没有备份就没得退。
    """
    from app.db import engine

    todo = await pending()
    out = {
        "applied": [{"version": _version_of(m), "name": m.name} for m in todo],
        "backup": None,
        "dry_run": bool(dry_run),
    }
    if not todo or dry_run:
        return out

    from app.core import backup

    try:
        made = backup.create_backup("before-migrate")
        out["backup"] = made.get("name") if isinstance(made, dict) else None
        log.info("迁移前备份：%s", out["backup"])
    except Exception:  # noqa: BLE001 - 备份失败不该挡住启动，但要留痕
        log.warning("迁移前备份失败（继续迁移）", exc_info=True)

    from sqlalchemy import insert

    from app.models import SchemaMigration, utcnow

    async with engine.begin() as conn:
        await _ensure_table(conn)
        for m in todo:
            await m.apply(conn)
            await conn.execute(
                insert(SchemaMigration).values(
                    version=_version_of(m), name=m.name, applied_at=utcnow()
                )
            )
            log.info("迁移已应用：v%s %s", _version_of(m), m.name)
    return out


async def status() -> dict:
    """已应用 / 待应用，各带版本与名字。给 CLI 看，也给人看。"""
    done = await applied()
    return {
        "applied": [
            {"version": v, "name": next((m.name for m in MIGRATIONS if _version_of(m) == v), ""), "at": at}
            for v, at in sorted(done.items())
        ],
        "pending": [{"version": _version_of(m), "name": m.name} for m in await pending()],
        "current": max(done) if done else 0,
        "head": max((_version_of(m) for m in MIGRATIONS), default=0),
    }
