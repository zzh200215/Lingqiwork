"""ORM models: conversations, messages, providers, memories, agents, tasks, evals, cards."""
from datetime import date, datetime, timezone

from sqlalchemy import JSON, Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, String, Text
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
    # A2 的**逐步账**（协作跑完那十来步，每步一条 `fact`）：谁、几轮、几次工具、几秒、烧没烧光。
    # 存它是因为它以前**只走流式事件**——刷新一下就没了，用户回头再看那条消息只剩纪要正文，
    # 而「哪一步贵、哪一步烧光」恰恰是协作最该留下的那笔账（同 `artifacts_json` 的理由）。
    steps_json: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    # A2：这一栏从「用不用工具」升成「**能用哪些**工具」——fnmatch 通配（`vault_*`、
    # `kb_search`、`server__*`），空 = 不限制，保留字 `none` = 一个都不给。
    # 语义在 `mcp.filter_specs` 一处（与 `tasks.tool_whitelist` 同一套）。
    # 旧库那一列原样叫 `tools_enabled`：迁移时 `true → ''`、`false → 'none'`
    # （见 `migrations._m017_agent_tool_whitelist`）。
    #
    # `server_default` 是有意的：这一列非空、默认「不限制」，而 `create_all` 只带
    # Python 侧默认值时，**裸 SQL 的 INSERT 会在 NOT NULL 上炸**（A2 写迁移测试时撞的）。
    # 迁移重建表时也从模型取 DDL（`Table.to_metadata`），两边同源。
    tool_whitelist: Mapped[str] = mapped_column(Text, default="", server_default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Prompt(Base):
    """Reusable prompt template (Open WebUI-style prompt library).

    Content may contain {variable} placeholders the user fills in before send.

    「提示词」模块（`提示词模块方案.md`）把它从一张纯文本表扩成一个**库**：
    标签 / 分类 / 收藏 / 评分 / 出处 / 备注。参照 AI Gist，但**不引 Jinja**——
    现有的 `{变量}` 够用，少一个模板注入面。
    """

    __tablename__ = "prompts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(100))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    # 下面每一列都带 `server_default`：这些列非空，而 `create_all` 只带 Python 侧
    # 默认值时，**裸 SQL 的 INSERT 会在 NOT NULL 上炸**（同 `tool_whitelist` L144-147
    # 那条注释的来由）。文本列一律「空字符串 = 没填」，不用 NULL 表达两种含义。
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    tags: Mapped[str] = mapped_column(String(200), default="", server_default="")
    category: Mapped[str] = mapped_column(String(50), default="", server_default="")
    favorite: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    rating: Mapped[int] = mapped_column(Integer, default=0, server_default="0")  # 0 = 未评
    source: Mapped[str] = mapped_column(String(300), default="", server_default="")
    note: Mapped[str] = mapped_column(String(500), default="", server_default="")


class PromptVersion(Base):
    """提示词改一版就留一条（AI Gist 的「历史版本记录」）。

    **为什么值得单独一张表**：这个库的用处就是「持续变好」，而「变好」只有在能回头比
    的时候才成立。改前的原文不留下，改完就只剩一句「我记得以前那版更好」。
    只留最近 20 版——与 `core/tasks.py::_RUNS_KEEP` 同一条纪律：留痕不能无限长。
    """

    __tablename__ = "prompt_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    prompt_id: Mapped[int] = mapped_column(Integer, index=True)
    title: Mapped[str] = mapped_column(String(100), default="", server_default="")
    content: Mapped[str] = mapped_column(Text, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PromptUsage(Base):
    """一次「用了它」（复制走，或者填完变量发出去）。

    `content_sha` 让「改过之后效果不一样」可追溯；`vars_json` 让下次复用不必重填。
    **不存冗余计数**：列表要的「用过几次」由这里聚合出来，不养第二份真值。
    """

    __tablename__ = "prompt_usages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    prompt_id: Mapped[int] = mapped_column(Integer, index=True)
    used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    content_sha: Mapped[str] = mapped_column(String(12), default="", server_default="")
    vars_json: Mapped[str] = mapped_column(Text, default="{}", server_default="{}")


class PromptCategory(Base):
    """分类是**一等对象**（参照 AI Gist）：有名字、有颜色、有顺序。

    **为什么成员关系不在这一张表上。**「这条提示词属于哪个分类」只有一处真值：
    `prompts.category`（一个字符串）。这张表只管「这个分类**长什么样**」——颜色与排序。
    两处都存成员关系就会分叉，而分叉那天没人说得清哪一边是对的。

    于是三种状态都是**定义好的**，不是坏数据：
    - 有提示词、有这一行 → 正常；
    - 有提示词、没这一行 → 没挑过颜色，用默认色（不必先建分类才能归类）；
    - 这一行在、却没有提示词 → **空分类**（你建了它，还没往里放东西）。
    """

    __tablename__ = "prompt_categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(50), unique=True)
    # `#rrggbb`。空串 = 没挑过色，界面按名字派一个稳定的默认色。
    color: Mapped[str] = mapped_column(String(20), default="", server_default="")
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class DeliverTemplate(Base):
    """自定义体裁模板（方案 §8.1 行2）——把「你常写的那种东西」存成一种体裁。

    **它是体裁，不是别的东西。** 内置那五条（`core/deliver.py` 的 `GENRES`）与这里每一行
    是**同一个形状**：一个界面名 + 一段结构指令 + 一个「长稿吗」判据。`synth_prompt` 对
    两者一视同仁，所以界面上它们并排出现在同一排 chips 里——结构只能由一处决定，
    摆两个选择器（体裁一处、模板一处）就会互相打架。

    **`slug` 与 `label` 分开是有意的**：`prompt_sha` 按体裁 id 分版本（质量闭环靠它把
    「这一版写得好不好」分开统计），所以**改名不该让历史断裂**。`label` 随便改，`slug`
    建了就不动。同理 `slug` 带 `t-` 前缀：内置体裁的 id 因此**永远不可能被顶掉**。

    这张表只存模板本身。**没有「用了几次」这种列**——那是算得出来的（`artifact_feedback`
    按 prompt_sha 分组），存进来只会悄悄过期。
    """

    __tablename__ = "deliver_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(60), unique=True)
    label: Mapped[str] = mapped_column(String(40))
    # 结构指令——与 `GENRES[*]["prompt"]` 同一个位置、同一个作用。
    prompt: Mapped[str] = mapped_column(Text)
    # 长稿 = 结构值得先定下来再写（界面据此走「先出提纲」那一模）。新建默认长稿：
    # 你会想存成模板的，多半是那种值得先定结构的稿子。
    long: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ThreadIgnore(Base):
    """收件箱里**你按过「忽略」的**那一条（方案 §8.4 行175）。

    **为什么这张表非有不可。** 收件箱的目标是**清空**——§8.4 的注释原话是「常驻就变成
    『又一堆欠账』，而不是『待归类』」。而它的候选是**派生**出来的：所有没挂到任何事的条目。
    没有「忽略」这一档，你永远不想挂的那些就会一直躺在那里，收件箱永远清不空，
    于是它变成了它本该避免的那样东西。

    **只存 `(kind, ref)`，不存标题**：标题是派生的（`threads._catalog()` 现取），存一份
    就会在改名之后说谎。删掉这一行的唯一后果是那条**又出现在收件箱里**——东西一件都没动
    （`core/threads.py` 的两条护栏之一：删掉一件事只少一层索引）。
    """

    __tablename__ = "thread_ignores"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(12))
    ref: Mapped[str] = mapped_column(String(300))
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
    # 这条流程处理的是哪件「事」（M2）。**运行期列**，与 `conversation_id` 同类：起链时按
    # 你输入的题目写进来（同名复用、没有就建一条），下游每一步跟着它把成品挂到同一件事上。
    # 「这条流程在忙哪件事」是它的全部含义 —— 具体**哪一趟**处理的是哪件记在
    # `TaskRun.thread_id` 上（卡点续跑、手动重跑都读那一份）。
    thread_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 步级超时（秒，2026-09-26）：一次执行最多等多少秒。空 = 引擎默认（900）。
    # 本地任务最常见的死法不是报错而是**不返回**——一个挂死的请求把整条链冻在
    # 夜里，重试次数再多也救不了「根本没结束」的那一趟（Temporal 的口径：超时
    # 才是重试的总闸，次数只是兜底）。
    timeout_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 接地分门禁（required checks，2026-09-26）：配了数（0-5），这一步跑完先打分，
    # 分数低于它就停在人工卡点（等人处置），**不自动流向下游**。空 = 不设——
    # 打分照旧只记分、不挡道（「看板不是考核」的口径不变，门禁只挡自己配的线）。
    gate_min_grounded: Mapped[float | None] = mapped_column(Float, nullable=True)


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
    # 运行日志。**两种形状同一个数组**（顺序就是发生的顺序，这也正是步骤条要的东西）：
    #   · 工具调用：`{tool, args, ok, result, ms}`（`ms` = 这一次调用花了多久，§8.3）
    #   · 一步工序：`{step, ok, ms, note?, ref?}`（引擎跑的那几步，**没有 `tool` 键**）
    # 为什么不分成两个数组：两边都没有时间戳，插不回正确的位置。读的人按 `tool` / `step`
    # 各自过滤，互不干扰（`skill_trials` / `skill_metrics` 读的就是 `tool`）。
    log_json: Mapped[str] = mapped_column(Text, default="[]")
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
    # 这次运行在处理哪件「事」（M2）。与 `run_dir` 同一个理由：**停一轮再续跑也得知道**，
    # 而且链条上「是哪件」由上游定（`_fire_chain` 传下来）——所以真值在 run 上，不在任务行上
    # （任务行那个只是「这条流程最近一次在忙哪件事」的界面提示）。
    thread_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


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
    window polls these and speaks them. Not a chat log — the conversation log
    lives in `PetChat` (P5 之后它落库了，见那张表的说明).

    **`name` 与 `detail` 的分工**（M2 补记）：`name` 是**这件事叫什么**（概念 / 任务名 /
    文件名——过 `pet.compose` 拼句子用的那个），`detail` 是**这一句的补充**（卡在哪、
    连着几天、哪个插件）。历史行只有 `detail`（它当初兼着两个角色，于是「同一个概念
    说过没有」没法查——`repeated` 的冷却撞上过这个坑）。新写的都带上 `name`；
    `pet.emit()` 里与建表语句同一处补列，`create_all` 建新库、老库由它自己 ALTER。
    """

    __tablename__ = "pet_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    kind: Mapped[str] = mapped_column(String(20), default="say")
    text: Mapped[str] = mapped_column(Text)  # what 零柒 says
    name: Mapped[str] = mapped_column(Text, default="")  # 这件事叫什么（概念 / 任务 / 文件）
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


class PetChat(Base):
    """跟零柒说过的一轮问答（P5 · 加深脑子：聊天从「随请求走」到「记得住」）。

    设计上曾是 ephemeral（与选择助手同一立场：这是跟陪伴者的对话，不是又一个
    会话列表）。代价用了几天就露出来：刷新页面它就「忘了上一句」，隔天回来
    更是从头开始——「它记得你」这件事，靠前端内存里那 6 轮兜不住。落到本地库，
    跨会话的连续性才有真值可读（后端补历史、前端回放都读它）。

    **与 `PetEvent` 的分工**：那边是**它主动说的**（事件台词，一行一件事），
    这边是**你们一问一答的对话**。`tools` 存那一轮它真的做了什么（P3 的回执，
    JSON 数组）——回放时面板还能摆出那排小 chip，只存事实，不存解释。

    报错/中断的那一轮**不落**（`pet.save_chat_turn` 的规矩）：真的回了话才算
    一轮，残句不该进记忆。
    """

    __tablename__ = "pet_chats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    role: Mapped[str] = mapped_column(String(10))  # 'user' | 'pet'
    text: Mapped[str] = mapped_column(Text)
    tools: Mapped[str] = mapped_column(Text, default="[]")  # JSON：那一轮的工具回执


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
    # PLAN2 §6「回指采纳」（v12）：**最后一次翻这张卡的「可能缺前置」候选**的时刻。
    # 它只服务那一件度量：拉取式功能「有没有人看」是它唯一的生死指标，而「看过」这件事
    # 在别的表里没有任何痕迹（候选是当场算的、不落库）。NULL = 从没翻过。
    #
    # 写入口只有一个：`POST /api/cards/{id}/prereq/seen`（界面在真去取候选那一下调它）。
    # **不在 GET 里顺手写**：读路径带副作用，翻页/重试/预取都会把它记账，而「看过」是
    # 一个必须说得准的数（说不准就会把一个没人用的功能判成有人用）。
    prereq_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
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
    # M1（PLAN §3 G1）：这一答是**讲出来**的，这里是那次重讲的原文。
    # 它是判分的输入，也是「这一天你真的重讲了」的唯一凭据（北星指标读的就是这一列）。
    # 自评那一路照旧留空——两条路写的是同一张表、同一组间隔字段（双入口单账本）。
    retell: Mapped[str] = mapped_column(Text, default="")
    # PLAN2 T2：这一档**是谁打的**。`True` = 判分器判的（`retell.adjudicate` 那条路，
    # **唯一**的写入方）；`False` = 你自己定的档，包括「判分挂了、退回自评」的那种
    # ——判分没跑成 ≠ 差评，更 ≠ 判过分（`retell` 那一列照旧带原文，所以
    # 「这一天你真的重讲了」不受影响）。
    #
    # 它存在的唯一理由是校准曲线：`grade` 两边都写，不分成两列就问不出「我觉得我懂」
    # 与「实际讲得出来」差多少。**`False` 在 v9 之前的历史行上含义是「未知」**，
    # 不是「自评」——所以曲线只统计 v9 之后的行（见 `cards.calibration` 的 docstring）。
    judged: Mapped[bool] = mapped_column(Boolean, default=False)
    # PLAN2 §9.4（v10，2026-09-16 定夺）：**判它的那一版提示词的指纹**（`JUDGE_SYSTEM` 的
    # sha12）。判分器换版时，曲线必须知道每一行是哪把尺子量的——否则两版的行会混在一起
    # 被当成一把量（第一版就是这个毛病，页脚只能写「账本没存版本」）。
    #
    # 三种状态，`judged` 与它一起读：
    #   `judged=1, sha='a1b2c3d4e5f6'` → 判过，就是这一版；
    #   `judged=1, sha=''`             → 判过，但**不知道哪一版**（v9–v10 之间的行，
    #                                    那时候没有这一列；不可伪造，新行写不出这个状态）；
    #   `judged=0`                     → 自评（`sha` 恒空）。
    #
    # 为什么不是「一列搞定」：把布尔换成指纹（`judged = bool(sha)`）会让上面第二种状态
    # **不可表示**，而它真实存在——那批行的唯一诚实说法就是「不知道」。
    judged_sha: Mapped[str] = mapped_column(String(12), default="")


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
    # PLAN2 §6「回指采纳」（v12）：**这一场是从哪张搁置卡的前置候选开出来的**。
    # NULL = 不是（自己开的、从点/深链开的、陪读开的……绝大多数都是 NULL）。
    # 与 `origin_point_id`（`tutor.start` 那个「从材料拆出的点开场」）同一种做法，
    # 但那个字段还兼着「标记已教」的活，所以没有合并成一个 origin 字符串——
    # 一个字段一个用途，读的人才不用去解析格式。
    prereq_card_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
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
    # PLAN2 P2-3（v11，2026-09-16）：**这个 verdict 是谁定的**——判分器判的（这里存
    # 判它的那一版 `SESSION_JUDGE_SYSTEM` 的指纹），还是你自己标的（空串）。
    #
    # 与卡片侧的 `judged`/`judged_sha`（v9/v10）同一个形状，但只占**一列**：那里的两列
    # 是因为「判过但不知道哪一版」那批历史行必须能被表示出来；会话侧没有那批行
    # （真库 `tutor_sessions` 当时 **0 场**），所以「非空 = 判的、空 = 你标的」既不撒谎
    # 也不缺信息。指纹也**不另算一份**：`retell.session_judge_sha()` 从登记表取。
    #
    # 覆盖规则：`end()` 每次都按传进来的值**无条件重写**这一列——你先自己标了「懂了」，
    # 后来点了「让它判」判成「半懂」，那它就从自评变成判分；反过来手动改回去也一样。
    # 「谁定的」跟着最后一次落定走，不然这一列会在原地留着一个不再成立的说法。
    judged_sha: Mapped[str] = mapped_column(String(12), default="")


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
    # S1 的注入痕迹（PLAN3 §9.2 决策4）：这份产出是**吃着某份工序**生成的、还是没吃？
    # **三态文本，不是 bool**——「不知道」必须与「没注入」分开：从产出清单**事后**点的
    # 👍/👎，那时前端手里没有注入信息，记成「没注入」就是在编（读不到就说读不到）。
    #   "" = 不知道 ｜ "[]" = 没有注入 ｜ "[技能名…]" = 有注入
    # 它**不改**聚合的 join key `(kind, prompt_sha, model_id)`：注入并不改变 `prompt_sha`
    # （那是模块级常量的指纹），所以不加这一列，两种工序的 👍/👎 会混进同一份成绩里，
    # 「哪版提示词更好」就被悄悄掺了别的东西。
    injected: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class TurnEvalRun(Base):
    """一次「聊天回合行为」的回归跑（W1）。

    和 `EngineEvalRun` 同形，但量的是**另一条路**：成文引擎测的是「一次生成一份东西」，
    这一张测的是**聊天那条工具循环**——模型有没有真的把东西存下来、有没有说谎、一轮存了
    几份、正文有没有被回填进对话。upgrade-plan 的缺口一就是「这条路一层都没盖」，
    而且当轮所有结论都是临时脚本量出来、量完就散。

    `scenario_sha` 是那套用例的指纹（用例改了要能看出来），`prompt_sha` 与
    `ArtifactFeedback` 同一个算法（与 `_OUTPUT_RULE` 对齐）——自动分和人点的满意率
    落在同一把 key 上。

    `deterministic` 是「一个 finding 都没有」的用例占比（确定性判分，零模型成本）；
    `judged` 是 LLM 判分那半（回执是不是一行话）的均值，没跑就是 NULL。
    **报告必须带样本量与 Wilson 区间**：裸比例会让人把噪声当结论（upgrade-plan §8）。
    """

    __tablename__ = "turn_eval_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    scenario: Mapped[str] = mapped_column(String(40), index=True)
    scenario_sha: Mapped[str] = mapped_column(String(12), index=True)
    prompt_sha: Mapped[str] = mapped_column(String(12), index=True)
    model_id: Mapped[str] = mapped_column(String(120), default="")
    total: Mapped[int] = mapped_column(Integer, default=0)  # 跑了多少个回合（用例 × 重复）
    deterministic: Mapped[float] = mapped_column(Float, default=0.0)  # 无 finding 的占比
    judged: Mapped[float | None] = mapped_column(Float, nullable=True)  # LLM 判分均值 0-5
    seconds: Mapped[float] = mapped_column(Float, default=0.0)
    detail_json: Mapped[str] = mapped_column(Text, default="[]")  # 逐回合的 findings / 回复 / 回执


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


class SkillEvalRun(Base):
    """一份**技能包**跑一遍用例的成绩（环一的收口）。

    `core/skill_eval.py` 的落库形态：每条用例问两次（没它 / 有它），比对逐条过没过，
    再给 `k/n` + Wilson 区间。与 `PromptEvalRun` 的分工：那张表量**登记过的提示词**、
    比的是「改前 vs 改后」；这张表量**技能包**、比的是「没它 vs 有它」。

    `skill_sha` = sha256(技能名 + SKILL.md 正文) 前 12 位：内容改过之后旧成绩不作数
    （`stale`），**与 Q1 技能卡的 `stale` 同一个意思**。`skill` 是技能名，不是外键 ——
    技能活在 `skills/` 的目录里，删掉技能不该让历史成绩消失（记录本来就是"当时跑过"）。
    """

    __tablename__ = "skill_eval_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    skill: Mapped[str] = mapped_column(String(80), index=True)
    skill_sha: Mapped[str] = mapped_column(String(12), index=True)
    model_id: Mapped[str] = mapped_column(String(120), default="")
    cases: Mapped[int] = mapped_column(Integer, default=0)
    with_passed: Mapped[int] = mapped_column(Integer, default=0)  # 有它那一侧过了几条
    rate: Mapped[float] = mapped_column(Float, default=0.0)
    ci_low: Mapped[float] = mapped_column(Float, default=0.0)
    ci_high: Mapped[float] = mapped_column(Float, default=1.0)
    # 逐条差：有它比没它多过了几条 / 少过了几条。**这才是"有没有用"的直接答案**，
    # 单看 in 侧通过率会把"这条用例本来就简单"读成"技能有用"。
    helped: Mapped[int] = mapped_column(Integer, default=0)
    hurt: Mapped[int] = mapped_column(Integer, default=0)
    # 「跟着工序做」的 LLM 判分均值（0-5）。**-1 = 没判**（没有可判的产出 / 判分没跑成）——
    # NULL 与 0 分的区别必须留着，否则「没量」会被读成「量了，0 分」。
    follows_method: Mapped[float] = mapped_column(Float, default=-1.0)
    seconds: Mapped[float] = mapped_column(Float, default=0.0)
    detail_json: Mapped[str] = mapped_column(Text, default="[]")  # 逐用例：两次回复、断言、判分


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
    # P3：这一轮**注入了几条材料**、模型**真引用了几条**。两个计数开成正式列（不再借
    # `quality_json`）——它是线上唯一一条最便宜的检索质量反馈，要能被聚合读。
    #
    # **为什么不存一个「使用率」**：比率要分母，而这两个数在两种回合里含义完全不同
    # ——没检索的回合（闲聊跳过、RAG 关）注入就是 0，把它算进分母等于拿「没检索」当
    # 「检索了没人用」。所以存两个原始计数，聚合的人自己选分母（`summary()` 用的分母
    # 是「注入 > 0 的回合数」，理由写在那边）。
    sources_injected: Mapped[int] = mapped_column(Integer, default=0)
    sources_cited: Mapped[int] = mapped_column(Integer, default=0)
    # A1：这一轮委托出去的子代理（每个一条事实：谁、哪个模型、几轮、用了哪些工具、
    # 花了多少 token、多久、有没有出错）。**一列 JSON 而不是一张表**——它只在排查
    # 「这一轮为什么这么贵」时逐条读，不参与聚合（要聚合的那两个数已经开了正式列）。
    sub_traces_json: Mapped[str] = mapped_column(Text, default="[]")
    # W2a 的两条底线校验结论：`{"findings":[{"code","detail"}...], "repaired":bool,
    # "dropped_receipts":[...]}`。**存 findings 而不是存一个分数** —— 判据在
    # `core/turn_quality.py` 一处，界面照着显示，不自己再算一遍。
    quality_json: Mapped[str] = mapped_column(Text, default="{}")
    seconds: Mapped[float] = mapped_column(Float, default=0.0)
    error: Mapped[str] = mapped_column(Text, default="")


class ModelProfile(Base):
    """一个模型该被怎么用（W7）：per-model 的策略，**外加它被认可时的那条 W1 基线**。

    **为什么要有它。** 同一个提示词喂所有模型，而实测行为差异巨大：flash-lite 需要把规矩提到
    system 层且仍会谎报/循环；deepseek-v4-pro 限流且输出不完整；qwen 另配一套。以前这些差别
    只存在于我的记忆和临时脚本里 —— 换模型靠「看起来还行」。

    **核心纪律：没有基线的画像不生效。** `baseline_run_id` 为空 = 这份策略还没被 W1 量过，
    于是 `core/model_profiles.effective()` 会回落成默认值并在账本里写明原因。不这么做的话，
    「per-model 策略」会变成另一种手感。

    只有**声明**没有测量的字段（如 `supports_structure`）也在这一行里，如实标 False ——
    默认不能假设任何 provider 支持强制结构化（W2b 要按 provider 灰度）。
    """

    __tablename__ = "model_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    model_id: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    temperature: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_rounds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tool_choice: Mapped[str] = mapped_column(String(20), default="")
    # 想不想走强制结构化（W2b），以及**量过没有**这个能力。两者分开：想 ≠ 能。
    force_structure: Mapped[bool] = mapped_column(Boolean, default=False)
    supports_structure: Mapped[bool] = mapped_column(Boolean, default=False)
    length_policy: Mapped[str] = mapped_column(String(20), default="")  # "" | revise | truncate
    give_output_rule: Mapped[bool] = mapped_column(Boolean, default=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    # —— 基线：三项记录 = 分数（k/n + 区间）、成本（输出 token）、延迟（秒）——
    baseline_run_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    baseline_pass: Mapped[int | None] = mapped_column(Integer, nullable=True)
    baseline_total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    baseline_ci_low: Mapped[float | None] = mapped_column(Float, nullable=True)
    baseline_ci_high: Mapped[float | None] = mapped_column(Float, nullable=True)
    baseline_judged: Mapped[float | None] = mapped_column(Float, nullable=True)
    baseline_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    baseline_tokens_out: Mapped[float | None] = mapped_column(Float, nullable=True)
    baseline_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ModelProfileChange(Base):
    """画像的每一次改动（W7）：改了什么、改成什么、当时挂的是哪条基线。**append-only。**

    「改画像有前后对照」这句验收要的就是这张表：改之前那一版的数值不会因为改动而消失。
    """

    __tablename__ = "model_profile_changes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    model_id: Mapped[str] = mapped_column(String(120), index=True)
    changed_json: Mapped[str] = mapped_column(Text, default="{}")  # {字段: [旧, 新]}
    profile_json: Mapped[str] = mapped_column(Text, default="{}")  # 改完之后的整份快照
    baseline_run_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")


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

    **回看是拉取式**：没有队列、没有任何东西会催你——`outcome` 空着就是还没回看，
    你什么时候想翻就什么时候翻。

    ⚠️ **M4（2026-09-16）在这里让开了一步，理由写在原地**：`witness_days` 是这条规矩
    唯一的例外。「纯拉取式」的下场在三个月这个尺度上是可预见的——**那条日志会变成死数据**
    （`outcome` 永远空着，校准分永远算不出来，整张表只剩自我表扬）。所以到点之后由
    **现有 nudge 管线**念一句：一天一条、只陈述当时的事实、可关（`pet_enabled`），
    台词里没有「你该回看了」。这不是把旧规矩删掉，是写明它在什么条件下被让开——
    与 `cards.reschedule` 给复习留死线同一个做法。要退回真·拉取式：
    删掉这一列 + `decision_log.witness()` + 前端那一支，成本很小（那正是它被设计成
    一列而不是一张表的原因）。
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
    # 多久之后值得回头看一眼（天）。90 天：短于这个数，多半还看不出应验与否；
    # 长于它，人会先把当时为什么那么想忘掉。见上面那段「让开一步」的说明。
    witness_days: Mapped[int] = mapped_column(Integer, default=90)


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
    # 状态机（方案 §8.4）：`open`（进行中）/ `done`（完成）。
    #
    # **「停滞」不在这里**：它是**算出来的**——「N 天没动静」是事实，不是你要维护的字段。
    # 存进来的话，它会在没人碰的某一天悄悄过期（库里写着 open、其实早停了），
    # 而界面上还得靠第二次判断去纠正。算的话永远和 `updated_at` 一致。
    status: Mapped[str] = mapped_column(String(12), default="open")
    # 截止日（`YYYY-MM-DD`）。NULL = 没设——**不编一个默认期限出来**。
    deadline: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ThreadItem(Base):
    """挂在一件事上的一条东西。**只存引用**，不复制内容。

    `kind` ∈ material | note | card | session | output | task | decision（R3 起：`tutor`
    改叫 `session`——这一列说的是「挂的是什么东西」，不是「哪个功能」）；`ref` 是卡片/会话/
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
# 「忽略过」也是幂等的，靠唯一索引兜底而不是靠调用方自觉（与 `ix_thread_items_unique`
# 同一条理由）：连点两次不该长出两行，否则「撤销忽略」就得删两遍。
Index("ix_thread_ignores_unique", ThreadIgnore.kind, ThreadIgnore.ref, unique=True)
