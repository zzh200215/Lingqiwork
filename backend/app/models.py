"""ORM models: conversations, messages, providers, memories, agents, tasks, evals, cards."""
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(dt: datetime | None) -> str | None:
    """ISO string a browser will read as UTC.

    SQLite has no timezone type, so a `DateTime(timezone=True)` column round-trips
    to a NAIVE datetime. Serialising that bare makes `new Date(...)` in the page
    treat 09:41 UTC as 09:41 local — eight hours off in this timezone, which is why
    the review page used to say a card was due at 11:57 when it was really 19:57.
    Every value in these columns is written by `utcnow()`, so stamping the offset
    back on is safe and is the fix.
    """
    if dt is None:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).isoformat()


class Base(DeclarativeBase):
    pass


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(255), default="New chat")
    model_id: Mapped[str] = mapped_column(String(100), default="")
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    folder: Mapped[str] = mapped_column(String(100), default="")  # "" = no folder
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="Message.id",
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE")
    )
    role: Mapped[str] = mapped_column(String(20))  # user / assistant / system
    content: Mapped[str] = mapped_column(Text, default="")
    sources_json: Mapped[str | None] = mapped_column(Text, nullable=True)  # RAG refs, JSON
    model_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    feedback: Mapped[str | None] = mapped_column(String(4), nullable=True)  # 'up' | 'down'
    tokens_in: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tokens_out: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    conversation: Mapped[Conversation] = relationship(back_populates="messages")


Index("ix_messages_conversation", Message.conversation_id)


class ProviderConfig(Base):
    """One row per provider entry (e.g. deepseek, moonshot, ollama...)."""

    __tablename__ = "provider_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(50), unique=True)  # display key
    kind: Mapped[str] = mapped_column(String(20), default="openai")  # openai | anthropic
    base_url: Mapped[str] = mapped_column(String(500), default="")
    api_key: Mapped[str] = mapped_column(String(500), default="")
    models: Mapped[list] = mapped_column(JSON, default=list)  # ["deepseek-chat", ...]
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class Memory(Base):
    """One persistent fact about the user (Open WebUI-style memory)."""

    __tablename__ = "memories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    content: Mapped[str] = mapped_column(Text)  # single fact sentence
    source: Mapped[str] = mapped_column(String(10), default="manual")  # manual | auto
    # 偏好 / 事实 / 习惯 三类（preference | fact | habit），automemory 抽取时分类，
    # 注入提示词时带上标签，模型才知道「这是他的稳定偏好」还是「这是长期项目背景」。
    # 刻意没有「状态」类：时效性信息会变成流水账，_AUTO_SYSTEM 里明确拒收。
    kind: Mapped[str] = mapped_column(String(10), default="fact")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Agent(Base):
    """Named preset: persona prompt + model + chat defaults (Khoj-style agent)."""

    __tablename__ = "agents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(50), unique=True)
    avatar: Mapped[str] = mapped_column(String(8), default="🤖")
    system_prompt: Mapped[str] = mapped_column(Text, default="")
    model_id: Mapped[str] = mapped_column(String(100), default="")  # "" = conversation default
    use_rag: Mapped[bool] = mapped_column(Boolean, default=False)
    tools_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Prompt(Base):
    """Reusable prompt template (Open WebUI-style prompt library).

    Content may contain {variable} placeholders the user fills in before send.
    """

    __tablename__ = "prompts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(100))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ScheduledTask(Base):
    """Cron-scheduled prompt run (Khoj Automations / OWU Automations style).

    Results land in a dedicated conversation and, optionally, in the vault.
    V2.3: `mode="agent"` turns the run into a multi-step autonomous tool loop;
    `trigger_kind="watch"` fires on vault file changes instead of cron; a
    `chain_next_id` links the task into a linear pipeline whose handoff
    travels through `vault/tasks/handoff/`.
    """

    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    prompt: Mapped[str] = mapped_column(Text)
    cron: Mapped[str] = mapped_column(String(60), default="0 9 * * *")  # 5-field crontab
    model_id: Mapped[str] = mapped_column(String(100), default="")  # "" = first enabled
    use_rag: Mapped[bool] = mapped_column(Boolean, default=False)
    tools_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    save_to_vault: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    conversation_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_run: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_status: Mapped[str] = mapped_column(String(20), default="")  # ok | error
    last_result: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # --- V2.3 agent orchestration ---
    mode: Mapped[str] = mapped_column(String(10), default="simple")  # simple | agent
    tool_whitelist: Mapped[str] = mapped_column(Text, default="")  # "" = all; fnmatch patterns
    max_rounds: Mapped[int] = mapped_column(Integer, default=12)  # agent-mode tool loop budget
    retry: Mapped[int] = mapped_column(Integer, default=1)  # extra attempts on auto-run failure
    notify_on_error: Mapped[bool] = mapped_column(Boolean, default=False)  # SMTP mail on failure
    trigger_kind: Mapped[str] = mapped_column(String(10), default="cron")  # cron | watch
    watch_path: Mapped[str] = mapped_column(String(500), default="")  # vault-relative dir/file
    chain_next_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # downstream task


class TaskRun(Base):
    """One execution of a ScheduledTask, with the full tool-call log for replay."""

    __tablename__ = "task_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_id: Mapped[int] = mapped_column(Integer, index=True)
    trigger: Mapped[str] = mapped_column(String(10), default="cron")  # cron | manual | chain | watch
    upstream_task_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(10), default="running")  # running | ok | error
    mode: Mapped[str] = mapped_column(String(10), default="simple")
    model_id: Mapped[str] = mapped_column(String(100), default="")
    rounds: Mapped[int] = mapped_column(Integer, default=0)  # model rounds in agent mode
    tool_calls: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(Text, default="")
    answer: Mapped[str] = mapped_column(Text, default="")
    log_json: Mapped[str] = mapped_column(Text, default="[]")  # [{tool, args, ok, result}]
    tokens_in: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tokens_out: Mapped[int | None] = mapped_column(Integer, nullable=True)


class EvalItem(Base):
    """One retrieval test case: a question + the vault file that should be found.

    Simplified RAGAS thinking — retrieval is scored objectively against the
    expected source, answer quality by an LLM judge.
    """

    __tablename__ = "eval_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    question: Mapped[str] = mapped_column(Text)
    expected_source: Mapped[str] = mapped_column(String(500), default="")  # vault-relative path
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EvalRun(Base):
    """Aggregated scores of one batch evaluation, kept for before/after compare."""

    __tablename__ = "eval_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # retrieval config snapshot
    top_k: Mapped[int] = mapped_column(Integer, default=5)
    hybrid: Mapped[bool] = mapped_column(Boolean, default=True)
    rerank: Mapped[bool] = mapped_column(Boolean, default=True)
    full_context: Mapped[bool] = mapped_column(Boolean, default=True)
    judge_model: Mapped[str] = mapped_column(String(100), default="")  # "" = no LLM judging
    # scores
    total: Mapped[int] = mapped_column(Integer, default=0)
    hit1: Mapped[float] = mapped_column(Float, default=0.0)
    hit3: Mapped[float] = mapped_column(Float, default=0.0)
    hitk: Mapped[float] = mapped_column(Float, default=0.0)
    mrr: Mapped[float] = mapped_column(Float, default=0.0)
    faithfulness: Mapped[float | None] = mapped_column(Float, nullable=True)  # 0-5 avg
    seconds: Mapped[float] = mapped_column(Float, default=0.0)
    detail_json: Mapped[str] = mapped_column(Text, default="[]")  # per-question results


class PetEvent(Base):
    """One spoken line from 零柒, the resident companion (ROADMAP V14).

    Emitted best-effort by task/digest/backup/feeds completion hooks; the pet
    window polls these and speaks them. Not a chat log — pet chat is ephemeral.
    """

    __tablename__ = "pet_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    kind: Mapped[str] = mapped_column(String(20), default="say")
    text: Mapped[str] = mapped_column(Text)  # what 零柒 says
    detail: Mapped[str] = mapped_column(Text, default="")  # optional longer context


class Card(Base):
    """One spaced-repetition card, with its SM-2 scheduling state in place.

    Cards are DERIVED state: generated from a vault note or pasted text, then
    mutated on every answer. They live in SQLite rather than as vault/*.md
    because (a) the vault contract is "anything in here gets indexed for RAG",
    and a few hundred Q/A fragments would compete with real notes in retrieval,
    and (b) due/interval/ease change on every review, which would make the
    watcher re-index constantly. `source` points back at the vault file so the
    review page can deep-link to the original via /notes.html?path=.

    Kinds are tuned for programming skills — scenario/debug carry the weight,
    because "can you do it" matters more than "can you recite it".
    """

    __tablename__ = "cards"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(10), default="concept")  # concept|cloze|scenario|debug
    front: Mapped[str] = mapped_column(Text)  # 题面（cloze 用 ____ 挖空）
    back: Mapped[str] = mapped_column(Text)  # 答案 + 为什么
    hint: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(500), default="")  # vault rel path; "" = pasted
    source_label: Mapped[str] = mapped_column(String(200), default="")  # display name
    source_excerpt: Mapped[str] = mapped_column(Text, default="")  # what the card was drawn from
    topic: Mapped[str] = mapped_column(String(100), default="")
    deck: Mapped[str] = mapped_column(String(100), default="default")
    origin: Mapped[str] = mapped_column(String(10), default="ai")  # ai | manual
    model_id: Mapped[str] = mapped_column(String(100), default="")  # which model wrote it
    suspended: Mapped[bool] = mapped_column(Boolean, default=False)  # leech or shelved by hand
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # --- SM-2 state (updated in place) ---
    due: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    interval_days: Mapped[float] = mapped_column(Float, default=0.0)
    ease: Mapped[float] = mapped_column(Float, default=2.5)
    reps: Mapped[int] = mapped_column(Integer, default=0)
    lapses: Mapped[int] = mapped_column(Integer, default=0)
    last_grade: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_review: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class CardReview(Base):
    """One graded answer to one Card — the revlog.

    Every field needed to (a) undo the answer exactly and (b) later fit an
    FSRS-style model from history is captured here. This is the part that is
    expensive to add retroactively, so it is complete from day one.
    """

    __tablename__ = "card_reviews"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    card_id: Mapped[int] = mapped_column(Integer, index=True)
    reviewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    grade: Mapped[int] = mapped_column(Integer)  # 1 重来 | 2 困难 | 3 良好 | 4 简单
    seconds: Mapped[float] = mapped_column(Float, default=0.0)  # think time
    interval_before: Mapped[float] = mapped_column(Float, default=0.0)
    interval_after: Mapped[float] = mapped_column(Float, default=0.0)
    ease_before: Mapped[float] = mapped_column(Float, default=2.5)
    ease_after: Mapped[float] = mapped_column(Float, default=2.5)
    reps_before: Mapped[int] = mapped_column(Integer, default=0)
    due_before: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


# the hot query is "not suspended and due <= now", ordered by due
Index("ix_cards_queue", Card.suspended, Card.due)
Index("ix_cards_source", Card.source)


class Habit(Base):
    """One thing you intend to do on a schedule — the definition, not the result.

    Same shape as a review card at the day level ("due today, tick, streak"),
    which is why both live on the 今日 page. `auto_source` is the interesting
    field: a habit with `auto_source="cards"` is never ticked by hand, its daily
    value is derived from `card_reviews`. That makes the habit grid non-empty on
    day one without the user entering anything — the empty-list cold start is
    what killed every other opt-in feature in this project.
    """

    __tablename__ = "habits"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    icon: Mapped[str] = mapped_column(String(8), default="")
    kind: Mapped[str] = mapped_column(String(10), default="check")  # check | count
    target: Mapped[float] = mapped_column(Float, default=1.0)  # count 型的每日目标
    unit: Mapped[str] = mapped_column(String(20), default="")  # 杯 / 步 / 分钟
    weekdays: Mapped[str] = mapped_column(String(7), default="1111111")  # 周一→周日
    auto_source: Mapped[str] = mapped_column(String(20), default="")  # "" | cards
    sort: Mapped[int] = mapped_column(Integer, default=0)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class HabitLog(Base):
    """One habit's result on one day. At most one row per (habit, day).

    `day` is a LOCAL calendar date string, not a datetime, on purpose: the only
    question a habit answers is "did I do it that day", and every timezone-aware
    comparison in this codebase has been a bug source. A date string also makes
    the streak input a plain set[str].
    """

    __tablename__ = "habit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    habit_id: Mapped[int] = mapped_column(Integer, index=True)
    day: Mapped[str] = mapped_column(String(10))  # "2026-09-04"
    value: Mapped[float] = mapped_column(Float, default=1.0)
    note: Mapped[str] = mapped_column(String(200), default="")
    logged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class UsageVisit(Base):
    """One day the user actually opened a page — the "打开次数" baseline (PLAN 第0周).

    At most one row per (page, day), enforced by the unique index, so a reload
    never inflates the count. `day` is a LOCAL calendar date string for the same
    reason as `HabitLog.day`: the only question it answers is "did I open it that
    day", and every timezone-aware comparison in this codebase has been a bug.
    The table exists because PLAN needs a 7-day usage baseline and nothing else
    recorded "did the user open the app today" before.
    """

    __tablename__ = "usage_visits"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    page: Mapped[str] = mapped_column(String(30), default="")  # review | chat | notes | ...
    day: Mapped[str] = mapped_column(String(10))  # "2026-09-04"
    visited_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class JobRun(Base):
    """One execution of a scheduled background job.

    Exists because of a concrete incident: on 2026-09-04 the default model's free
    quota ran out, and since all eight background jobs swallow their exceptions by
    design (a failing digest must not kill the scheduler), every automated feature
    failed silently for days with nothing visible anywhere in the UI. For a system
    whose whole claim is that it grows itself, the growth machinery breaking
    invisibly is the fatal failure mode.

    Rows are written by a wrapper in `core/scheduler.py`, so the existing jobs did
    not have to change. Retention is `KEEP_RUNS` per job_id, matching the per-task
    run log in `core/tasks.py`.
    """

    __tablename__ = "job_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[str] = mapped_column(String(60), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    seconds: Mapped[float] = mapped_column(Float, default=0.0)
    ok: Mapped[bool] = mapped_column(Boolean, default=True)
    message: Mapped[str] = mapped_column(Text, default="")  # error, or a short result line


class TutorSession(Base):
    """One 教学会话: you name something to understand, and it asks until you get it.

    Deliberately NOT a Conversation row. The tutor is the one thing PLAN.md says
    must be removable in one piece if its failure signals fire, and a `kind`
    column on `conversations` would instead leak into every existing chat query.

    `concept` / `verdict` / `stuck` / `aliases` are filled when the session ends,
    so they default to "" rather than being nullable: a session with no verdict is
    a real state (you closed the tab), not a broken row.

    The 「理解状态」PLAN.md asks for is this table grouped by concept — not a
    second table. A separate one would mean keeping two copies of the same fact
    in sync, and every write already passes through here.
    """

    __tablename__ = "tutor_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    topic: Mapped[str] = mapped_column(String(200))  # the user's own words
    concept: Mapped[str] = mapped_column(String(120), default="")  # normalized at end
    verdict: Mapped[str] = mapped_column(String(10), default="")  # got | half | useless
    stuck: Mapped[str] = mapped_column(Text, default="")  # one line: where it broke down
    # 同一个概念的其他说法，结束时和 concept 一起提取。存在的唯一理由是召回：
    # bge-small-zh 接不住同义改写（「协程什么时候切换」对「asyncio 事件循环」实测
    # 0.44-0.49），而几个月后重逢时用的词往往正好不是上次那个词。`tutor.ALIAS_SEP`
    # （" | "）分隔的一行而不是 JSON —— 它只有一个消费者（`tutor.recall_hits`，把每
    # 个别名各算一条向量），存成结构化数据就得多一层解析而换不到任何东西。分隔符
    # 不能是空格：别名自己会带空格（「event loop 调度」），切碎了就成噪声。
    aliases: Mapped[str] = mapped_column(Text, default="")
    # Whether 「你上次卡过」 actually fired here. This is instrumentation, not a
    # feature: PLAN.md 第 5 节 kills recall if it never triggers, and that call
    # should not depend on remembering to hand-count it in LOG.md.
    recalled: Mapped[bool] = mapped_column(Boolean, default=False)
    # 历史压缩缓存（maple-os 参考项）：超出 HISTORY_LIMIT 的中段不是丢掉，而是
    # 压成 `summary` 注入；`summary_upto` 记录已覆盖到 dropped 列表的第几轮，攒够
    # 一批才重新压缩。原文永远在 tutor_turns 里，压缩的只是 prompt。
    summary: Mapped[str] = mapped_column(Text, default="")
    summary_upto: Mapped[int] = mapped_column(Integer, default=0)
    # 代码库陪读（全局唤起脑暴清单）：非空 = 这场会话的取材只在 repos/<repo>/ 里找
    repo: Mapped[str] = mapped_column(String(100), default="")
    # socratic（默认：老师问你答）| feynman（反转：你讲它追问，检验你是不是真懂）
    mode: Mapped[str] = mapped_column(String(10), default="socratic")
    model_id: Mapped[str] = mapped_column(String(100), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class TutorTurn(Base):
    """One message inside a 教学会话.

    Separate from `messages` for the same reason TutorSession is separate from
    `conversations`: dropping two tables must be enough to remove the feature.
    No sources/tokens/feedback columns — the tutor does no RAG and no tools in
    this step, and a column added "for later" is a column nobody fills.
    """

    __tablename__ = "tutor_turns"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("tutor_sessions.id", ondelete="CASCADE")
    )
    role: Mapped[str] = mapped_column(String(20))  # user | assistant
    content: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# The uniqueness is load-bearing, not decoration: it is what makes a double tick
# idempotent (the router upserts on it). Expressed as a unique Index rather than a
# UniqueConstraint because a bare UniqueConstraint() at module level attaches to no
# table and would silently do nothing.
Index("ix_habit_logs_day", HabitLog.habit_id, HabitLog.day, unique=True)
Index("ix_job_runs_recent", JobRun.job_id, JobRun.id)
Index("ix_usage_page_day", UsageVisit.page, UsageVisit.day, unique=True)
Index("ix_tutor_turns_session", TutorTurn.session_id, TutorTurn.id)
