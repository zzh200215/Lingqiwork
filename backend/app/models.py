"""ORM models: conversations, messages, providers, memories, agents, tasks, evals, cards."""
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


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
