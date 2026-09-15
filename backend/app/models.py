"""ORM models: conversations, messages, providers, memories, agents, tasks, evals, cards."""
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.core.secrets import seal, unseal


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
    # 这一轮落盘的产出（`save_artifact` 的副产物），JSON 数组。
    # 存它是因为回执是这一轮**唯一有信息量**的东西：正文可能在 vault 文件里、
    # 回复正文那头是空的，只把正文落库等于把有价值的丢掉、把空壳留下。
    artifacts_json: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    # Ciphertext at rest (core/secrets.py). Read/write via the `api_key` property
    # below; the column keeps its original name so existing rows need no migration.
    api_key_enc: Mapped[str] = mapped_column("api_key", String(1000), default="")
    models: Mapped[list] = mapped_column(JSON, default=list)  # ["deepseek-chat", ...]
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    @property
    def api_key(self) -> str:
        """Plaintext key. Every reader (llm, cards, _mask, …) keeps using this."""
        return unseal(self.api_key_enc)

    @api_key.setter
    def api_key(self, value: str) -> None:
        self.api_key_enc = seal(value or "")


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
    # 记忆证据链（DeepTutor 参考项：可检视的三层记忆）：洞察（reflect 合成）与
    # 合并行（tidy merge 吸收）各自记录它们由哪些原句而来，[{"id","text"}] 文本
    # 快照——被合并掉的原行会删除，只存 id 引用会变成死链。普通抽取/手写行是空。
    evidence_json: Mapped[str] = mapped_column(Text, default="[]")
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
    # 人工卡点（§4-12）：这一步跑完停在 `awaiting_approval`，等人点头才触发下游。
    # 从 `decide` 借来的模式——「先摆出来给人看，再往下走」。
    require_approval: Mapped[bool] = mapped_column(Boolean, default=False)
    # 这一步做什么（§4-13）：prompt = 跑提示词（默认，现状）；transcribe = 把触发它的
    # 那段录音交给本地 ASR 转写——不走模型，产出就是转写文本。
    action: Mapped[str] = mapped_column(String(12), default="prompt")
    # 产物落哪个 vault 子目录（空 = tasks/）。沿 chain 继承，因此一条流水线的各步
    # 写进同一个文件夹——「同一个会议」就是这么来的；录音触发时还会再套一层
    # `<日期>-<录音名>/`。
    landing_dir: Mapped[str] = mapped_column(String(300), default="")


class TaskRun(Base):
    """One execution of a ScheduledTask, with the full tool-call log for replay."""

    __tablename__ = "task_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_id: Mapped[int] = mapped_column(Integer, index=True)
    trigger: Mapped[str] = mapped_column(String(10), default="cron")  # cron | manual | chain | watch
    upstream_task_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="running")  # running | ok | error | awaiting_approval | rejected
    mode: Mapped[str] = mapped_column(String(10), default="simple")
    model_id: Mapped[str] = mapped_column(String(100), default="")
    rounds: Mapped[int] = mapped_column(Integer, default=0)  # model rounds in agent mode
    tool_calls: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(Text, default="")
    answer: Mapped[str] = mapped_column(Text, default="")
    log_json: Mapped[str] = mapped_column(Text, default="[]")  # [{tool, args, ok, result}]
    tokens_in: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tokens_out: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 尺子（§4-10）：这次产出对该任务检索到的材料的接地分 0-5（`core/engine_eval` 的
    # LLM 判分）。NULL = 没打分——没开检索 / 没命中材料 / 判分没跑成。它是工作流在
    # **无人值守**时唯一会说话的东西：静默劣化不进 last_status，但分数掉得下来。
    grounded: Mapped[int | None] = mapped_column(Integer, nullable=True)
    judge_reason: Mapped[str] = mapped_column(Text, default="")
    # 这次运行落进的目录（vault 相对，空 = vault/tasks/）。记在 run 上是因为链条
    # 可能在人工卡点上停一轮再续跑——那时得知道当初落的是哪个文件夹（§4-13）。
    run_dir: Mapped[str] = mapped_column(String(300), default="")


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
    # 领域（Q3 形态）：这条题属于哪个领域。**空 = 还没归类**，不是「无领域」。
    # 为什么是手写的一个词而不是从 vault 目录推：目录是笔记的组织方式，不是领域的
    # 声明（实测那个库的顶层目录是 notes/sub/clippings，推出来的「领域」是文件系统，
    # 不是他关心的东西）。同一个规矩见 `DecisionLog.topic`——那里也是手写一个词，
    # 读的时候分组，样本不够就不给率。
    domain: Mapped[str] = mapped_column(String(30), default="")
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


class PetPlugin(Base):
    """零柒的一个能力插件（B2，openpets 范式）。

    openpets 的办法是把「能力」外置成插件——**权限 / 配额 / 存储 / 计划 / 事件 /
    命令 / 面板**由运行时提供，宠物本体不动就能长出能力。零柒照搬这个范式：内置两个
    先跑通（喝水提醒 · 专注计时），接口留着，往后加插件不必碰宠物本体。

    **一行 = 一个装好的插件**，`name` 唯一。三块 JSON 各管一摊：
    `spec_json`  插件声明的能力（权限 / 配额 / 计划 / 面板 / 命令）；
    `storage_json` 插件自己的小仓库（今天的杯数、计时器的起点）；
    `quota_json` 事件按天计数（`{"2026-09-13": 2}`），用于配额封顶。
    """

    __tablename__ = "pet_plugins"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(20), unique=True)
    label: Mapped[str] = mapped_column(String(60), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    spec_json: Mapped[str] = mapped_column(Text, default="{}")
    storage_json: Mapped[str] = mapped_column(Text, default="{}")
    quota_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


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
    """One day the user actually opened a page — the "打开次数" baseline.

    At most one row per (page, day), enforced by the unique index, so a reload
    never inflates the count. `day` is a LOCAL calendar date string for the same
    reason as `HabitLog.day`: the only question it answers is "did I open it that
    day", and every timezone-aware comparison in this codebase has been a bug.
    The table exists because a 7-day usage baseline was wanted and nothing else
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

    Deliberately NOT a Conversation row. The tutor is the one thing that
    must be removable in one piece if its failure signals fire, and a `kind`
    column on `conversations` would instead leak into every existing chat query.

    `concept` / `verdict` / `stuck` / `aliases` are filled when the session ends,
    so they default to "" rather than being nullable: a session with no verdict is
    a real state (you closed the tab), not a broken row.

    The 「理解状态」 is this table grouped by concept — not a
    second table. A separate one would mean keeping two copies of the same fact
    in sync, and every write already passes through here.
    """

    __tablename__ = "tutor_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    topic: Mapped[str] = mapped_column(String(200))  # the user's own words
    concept: Mapped[str] = mapped_column(String(120), default="")  # normalized at end
    # 领域（Q3 形态）：和 concept 一起从会话里提取，`_EXTRACT_PROMPT` 本来就要求
    # concept 带领域限定词（「asyncio 事件循环」），这里只是把那个限定词**单独要一份
    # 可机读的**——从 concept 里切词去猜（「Python 的 GIL」切成什么？）就是在生产逻辑
    # 里猜文本，那是这个仓库明令不做的事。同领域必须同一个词，理由也一样：分组靠它。
    domain: Mapped[str] = mapped_column(String(30), default="")
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
    # feature: recall gets cut if it never triggers, and that call
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
    # 这条卡点解了没有。NULL = 待解。**主要的出口不是手动关，是自动回写**：同一概念
    # 后一场自评「搞懂了」时 `end()` 把此前的卡点一并关掉。手动关闭只兜「我不打算再
    # 管这个了」——不然清单只增不减。`stuck` 本身不动：卡点留着当记录，状态是另一轴。
    stuck_resolved_at: Mapped[datetime | None] = mapped_column(
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


class DigestPoint(Base):
    """`digest()` 拆出的一个「要搞懂的点」——**只是建议日志，不是学习状态**。

    学习状态的真值仍然只有 `tutor_sessions`（见 TutorSession 的注释）；这张表存在的
    唯一理由，是让学习地图「未触及」那一档拿得到「拆出来但还没开教的点」。开了教就
    回填 `taught_session_id`，于是「未触及」= 这张表里 `taught_session_id IS NULL` 的行。

    去重按 `(source, point)`：同一份材料重拆一遍不该堆出第二行，否则这张日志会自己
    长出噪声。
    """

    __tablename__ = "digest_points"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source: Mapped[str] = mapped_column(String(300), default="")  # 材料路径 / 标签
    point: Mapped[str] = mapped_column(String(400))  # 一句话的点，就是开场话题
    why: Mapped[str] = mapped_column(Text, default="")  # 为什么容易卡
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # 非空 = 这个点已经开成过一场教学，不再是「未触及」
    taught_session_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ArtifactFeedback(Base):
    """One 👍/👎 on a generated document — the quality flywheel's raw material.

    research / compose / recap 都通过 `core/report.py` 的脊梁成文，产物形状一致，也都
    是「模型写给你看的东西」；此前只有聊天消息有 feedback、教学有自评，这三条链路
    **没有任何地方记录过"这次我满意吗"**。没有它，每个模块只能靠"看起来对不对"判断。

    关键的是 (kind, prompt_sha, model_id) 这三个字段——攒够之后才回答得了"哪版提示词
    更好"和"哪个 provider 在本产品上更强"。`prompt_sha` 就是 `core/prompts.py` 里那份
    指纹的同一个算法（sha256 前 12 位），所以提示词一改，反馈自然按版本分开统计。
    """

    __tablename__ = "artifact_feedback"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), index=True)  # research | compose | recap
    prompt_sha: Mapped[str] = mapped_column(String(12), default="")
    model_id: Mapped[str] = mapped_column(String(120), default="")
    verdict: Mapped[str] = mapped_column(String(8))  # good | bad
    reason: Mapped[str] = mapped_column(Text, default="")
    ref: Mapped[str] = mapped_column(String(200), default="")  # vault 相对路径（若已落盘）
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EngineEvalRun(Base):
    """某个成文引擎跑一遍 golden set 的自动得分。

    `core/engine_eval.py` 的落库形态：**结构判分**（确定性：小节齐/序、引用不越界、
    复盘不得出现被禁的话）与**接地判分**（LLM 0-5：有没有编造）各一个聚合分。

    `prompt_sha` 与 `ArtifactFeedback` **同一个算法**——这是这张表存在的理由：自动分
    和人点出来的满意率落在同一把 key 上，才回答得了「这版提示词是真变好了，还是只是
    我手滑点了赞」。
    """

    __tablename__ = "engine_eval_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    engine: Mapped[str] = mapped_column(String(20), index=True)  # research | compose | recap | decide
    prompt_sha: Mapped[str] = mapped_column(String(12), index=True)
    model_id: Mapped[str] = mapped_column(String(120), default="")  # "" = 只跑了结构判分
    total: Mapped[int] = mapped_column(Integer, default=0)
    structural: Mapped[float] = mapped_column(Float, default=0.0)  # 无 finding 的用例占比
    grounded: Mapped[float | None] = mapped_column(Float, nullable=True)  # 0-5 均值
    seconds: Mapped[float] = mapped_column(Float, default=0.0)
    detail_json: Mapped[str] = mapped_column(Text, default="[]")  # 逐用例的 findings / 分数 / 理由


class PromptEvalRun(Base):
    """一条提示词跑一遍 golden set 的对照成绩（Q1）。

    `core/prompt_eval.py` 的落库形态：按 `backend/evals/prompts/*.json` 重放 n 条用例，
    每条跑一组**声明式断言**（断言与它对应的提示词原句都在 `prompt_eval.CHECKS` 里）。

    `variant_sha` 空 = 这一跑的是**已登记的内容**（基准/回归）；非空 = 拿一段候选内容比了比。
    候选内容**只存在于 `detail_json` 里当证据**：没有任何代码会把它读回来当配置——
    提示词的单一事实来源仍然是源码常量（`core/prompts.py` 的护栏）。

    `prompt_sha` 与 `ArtifactFeedback` / `EngineEvalRun` **同一个算法**（content 的
    sha256 前 12 位），所以「自动对照分」和「人点出来的满意率」落得到一起。
    """

    __tablename__ = "prompt_eval_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    key: Mapped[str] = mapped_column(String(80), index=True)  # 登记表里的属性名
    prompt_sha: Mapped[str] = mapped_column(String(12), index=True)
    variant_sha: Mapped[str] = mapped_column(String(12), default="", index=True)
    variant_label: Mapped[str] = mapped_column(String(60), default="")
    model_id: Mapped[str] = mapped_column(String(120), default="")
    cases: Mapped[int] = mapped_column(Integer, default=0)
    passed: Mapped[int] = mapped_column(Integer, default=0)
    rate: Mapped[float] = mapped_column(Float, default=0.0)
    ci_low: Mapped[float] = mapped_column(Float, default=0.0)
    ci_high: Mapped[float] = mapped_column(Float, default=1.0)
    seconds: Mapped[float] = mapped_column(Float, default=0.0)
    detail_json: Mapped[str] = mapped_column(Text, default="[]")  # 逐用例：断言、回复、耗时


class TurnTrace(Base):
    """一次聊天回合的**记录**（W5）：为什么慢、为什么贵、为什么没落盘。

    **为什么要有它。** 缺口二：界面上看得到调了哪些工具，但**什么都不落盘**。本轮
    （upgrade-plan）的每一个结论都是临时脚本量出来的，量完就散 —— 光是为了量一件事就临时
    搭了 `measure.py` + 一个 Playwright 脚本，这本身就是证据。这张表把那些数留下来。

    **它是什么、不是什么。** 这是**诊断**账本，不是考核仪表：不设目标、不催、不做排行榜
    （沿用 `quality.py` 的红线）。所以列里只有事实：跑了几轮、调了什么工具、各花多久、
    多少 token、声称存了有没有真存、有没有重试。

    `tool_calls_json` 只记**名称 / 参数与结果的字节数 / 毫秒 / 成功与否**，不记正文 ——
    正文该在 vault 里，抄一份进库是同一篇东西存两处。

    `claim_checked` 与 `claim_truthful` 分开：前者=这一轮的话被校验过，后者=校验的结论。
    没校验和校验通过是两件事，合成一列就会把「没查」读成「查了且没问题」。
    """

    __tablename__ = "turn_traces"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    conversation_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    message_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    model_id: Mapped[str] = mapped_column(String(120), default="")
    # 这一轮用的是哪一版输出规矩（与 `ArtifactFeedback` 同一个 sha 算法）——
    # 于是「回合行为」和「人点的满意率」落在同一把 key 上（upgrade-plan §2.1 的缝一）。
    prompt_sha: Mapped[str] = mapped_column(String(12), default="")
    # 确定性路由（W3）落在这里：没接路由时 level=""、kind=""（= 还没分过）
    route_level: Mapped[str] = mapped_column(String(20), default="")
    route_kind: Mapped[str] = mapped_column(String(30), default="")
    rounds: Mapped[int] = mapped_column(Integer, default=0)
    tool_calls_json: Mapped[str] = mapped_column(Text, default="[]")
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    artifacts_json: Mapped[str] = mapped_column(Text, default="[]")
    # 这一轮回复正文的长度。**只记数字，不记正文**：正文自己活在 `messages` 里，
    # 而「长正文却没落盘」（W2a 的那条判据）只需要长度这一个数。
    answer_chars: Mapped[int] = mapped_column(Integer, default=0)
    claim_checked: Mapped[bool] = mapped_column(Boolean, default=False)
    claim_truthful: Mapped[bool] = mapped_column(Boolean, default=True)
    retried: Mapped[int] = mapped_column(Integer, default=0)
    seconds: Mapped[float] = mapped_column(Float, default=0.0)
    error: Mapped[str] = mapped_column(Text, default="")


class SchemaMigration(Base):
    """已应用的迁移（W6）。一行一版，**只增不删**。

    没有它的时候，`main.py` 靠一张写死的列表每次启动全表重放：能用、幂等，但没人知道
    这个库是哪一版、下一步该跑什么、能不能先看看再跑。这张表就是那份记录 ——
    `core/migrations.py` 只跑 `version` 不在里面的那些。
    """

    __tablename__ = "schema_migrations"

    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DecisionLog(Base):
    """一条「判断 + 依据 + 信心」，以及事后回看的应验结果（校准分）。

    **为什么要写「信心」。** 判断做出的时候人心里是有个把握程度的，但过几个月回头，只会
    记得蒙对的那几次。把信心在**当时**钉下来，才谈得上校准——「你当时说七成把握的那类事，
    实际应验了几成」。这是这张表存在的唯一理由。

    **回看是拉取式**：没有到期时间、没有队列、没有提醒。`outcome` 空着就是
    还没回看；没有任何东西会催它。`outcome` ∈ "" | hit | miss | unclear。
    """

    __tablename__ = "decision_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    text: Mapped[str] = mapped_column(Text)  # 判断本身，一句话
    basis: Mapped[str] = mapped_column(Text, default="")  # 当时凭什么这么判断
    topic: Mapped[str] = mapped_column(String(30), default="")  # 领域标签，校准时分组用
    confidence: Mapped[int] = mapped_column(Integer, default=70)  # 0-100
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    outcome: Mapped[str] = mapped_column(String(10), default="")  # "" | hit | miss | unclear
    note: Mapped[str] = mapped_column(Text, default="")  # 回看时记一句为什么算应验


class ModelUsage(Base):
    """一次**操作**的模型用量（按模型汇总成一行）。

    **为什么要有它。** `messages`（聊天）与 `task_runs`（定时任务）各记一条，但**其余
    路径全都不记**——研究 / 产出 / 复盘 / 方案 / 对质 / 教学 / 圆桌 / 播客 / 卡片 /
    记忆整理烧的 token，在「这个月钱花在哪」里一个字都看不到。研究刚从 1 次调用变成
    ≥2 次、又多了一个引擎、取材还要多一次改写，账目反而更该看得清。

    一行 = 一个操作 × 一个模型（一个研究跑 3 轮 + 成文，可能是一行，也可能是两行）。
    `kind` 是操作名（research / conflict / tutor…），`ref` 是那次的线索（话题 / 文件）。
    """

    __tablename__ = "model_usage"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    kind: Mapped[str] = mapped_column(String(20), index=True)
    ref: Mapped[str] = mapped_column(String(120), default="")
    model_id: Mapped[str] = mapped_column(String(120), default="")
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    calls: Mapped[int] = mapped_column(Integer, default=0)
    # 这笔钱算在哪件事头上（§4-16）。NULL = 不属于任何一件事——**大多数调用都是这样**，
    # 别为了填满它去猜：只有「就这件事做的那次」才记。
    # 不加索引：这张表很小，而且**迁移列建不了索引**（`create_all` 会跳过已存在的表，
    # 老库靠 `_migrate` 补列），带了 `index=True` 只会让新库和老库长得不一样。
    thread_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


class Thread(Base):
    """「一件事」——地基（§4-15）。

    材料 / 笔记 / 卡片 / 卡点 / 成品 / 决策都能挂上来，答的是「这件事我到哪了」和
    「我这个月干了什么」。**vault 不搬家**：这里只有名字，挂接在 `ThreadItem` 里存引用。
    """

    __tablename__ = "threads"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    note: Mapped[str] = mapped_column(Text, default="")
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ThreadItem(Base):
    """挂在一件事上的一条东西。**只存引用**，不复制内容。

    `kind` ∈ material | note | card | tutor | output | task | decision；`ref` 是卡片/会话/
    决策/任务的 id（字符串），或 vault 相对路径。同一条挂两次是幂等的——由唯一索引兜底，
    不是靠调用方自觉。
    """

    __tablename__ = "thread_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    thread_id: Mapped[int] = mapped_column(Integer, index=True)
    kind: Mapped[str] = mapped_column(String(12))
    ref: Mapped[str] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# The uniqueness is load-bearing, not decoration: it is what makes a double tick
# idempotent (the router upserts on it). Expressed as a unique Index rather than a
# UniqueConstraint because a bare UniqueConstraint() at module level attaches to no
# table and would silently do nothing.
Index("ix_habit_logs_day", HabitLog.habit_id, HabitLog.day, unique=True)
Index("ix_job_runs_recent", JobRun.job_id, JobRun.id)
Index("ix_usage_page_day", UsageVisit.page, UsageVisit.day, unique=True)
Index("ix_tutor_turns_session", TutorTurn.session_id, TutorTurn.id)
Index("ix_feedback_group", ArtifactFeedback.kind, ArtifactFeedback.prompt_sha, ArtifactFeedback.model_id)
Index("ix_engine_eval_group", EngineEvalRun.engine, EngineEvalRun.prompt_sha, EngineEvalRun.model_id)
Index("ix_model_usage_recent", ModelUsage.kind, ModelUsage.id)
Index(
    "ix_thread_items_unique",
    ThreadItem.thread_id,
    ThreadItem.kind,
    ThreadItem.ref,
    unique=True,
)
