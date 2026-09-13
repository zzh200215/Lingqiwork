// API types + fetch helpers

export interface ProviderConfig {
  id: number
  name: string
  kind: 'openai' | 'anthropic'
  base_url: string
  api_key: string
  api_key_set: boolean
  models: string[]
  enabled: boolean
}

export interface McpServer {
  name: string
  type: 'stdio' | 'sse'
  command: string
  args: string[]
  url: string
  enabled: boolean
}

export interface McpServerStatus {
  ok: boolean
  tools: number
  error: string | null
}

export interface McpActiveTool {
  server: string
  name: string
  description: string
}

export interface McpView {
  servers: McpServer[]
  status: Record<string, McpServerStatus>
  active_tools: McpActiveTool[]
}

export interface McpProbe {
  name: string
  ok: boolean
  tools: string[]
  error: string | null
}

export interface Conversation {
  id: number
  title: string
  model_id: string
  pinned?: boolean
  folder?: string
  created_at: string
  updated_at: string
  messages?: Message[]
}

export interface MemoryItem {
  id: number
  content: string
  source?: 'manual' | 'auto'
  /** 偏好 / 事实 / 习惯 / 洞察——automemory 抽取分类；洞察是夜间反思合成的 */
  kind?: 'preference' | 'fact' | 'habit' | 'insight'
  created_at: string
  /** 证据链：洞察/合并行的原句依据（[{id,text}]），普通抽取/手写行为空数组 */
  evidence?: { id: number; text: string }[]
}

export interface MemoryExpose {
  uv: string
  python: string
  backend_dir: string
  snippet: { command: string; args: string[] }
  snippet_json: string
}

export interface MemoryTidyReport {
  ok: boolean
  ran_at?: string
  before?: number
  after?: number
  clusters?: number
  merged?: number
  skipped?: number
  message?: string
  error?: string
  details?: { ids: number[]; from: string[]; into: string }[]
}

export interface MemoryTidyStatus {
  enabled: boolean
  time: string
  next_run: string | null
  report: MemoryTidyReport | null
}

export interface AsrStatus {
  model: string
  language: string
  loaded: boolean
  models: string[]
}

export interface AsrResult {
  text: string
  language: string
  duration: number
}

/** 语音日记：vault/journal 按天落盘的一条（POST 响应） */
export interface JournalSaved {
  path: string
  date: string
  time: string
  count: number
}

export interface JournalRecent {
  entries: { date: string; time: string; text: string; excerpt: string }[]
  today: number
}

/** 学习小组圆桌：一次笔谈纪要（mentor / peer / skeptic 串行两轮） */
export interface RoundtableResult {
  topic: string
  turns: { persona: 'mentor' | 'peer' | 'skeptic'; name: string; text: string }[]
  file: string
  at: string
}

export interface TtsResult {
  url: string
  cached: boolean
  engine: 'edge' | 'sapi'
}

export interface PodcastTurn {
  speaker: 'host' | 'guest'
  text: string
}

export interface PodcastEntry {
  id: string
  title: string
  sources: string[]
  turns: number
  duration_sec: number
  file: string
  script: PodcastTurn[]
  created_at: string
  ok?: boolean
}

export interface ArtifactsStatus {
  enabled: boolean
  timeout: number
  python: string
  node: string | null
  languages: string[]
}

export interface ArtifactsResult {
  ok: boolean
  exit_code: number
  timeout: boolean
  stdout: string
  stderr: string
  elapsed_ms: number
  run_dir?: string
}

export interface KgStatus {
  enabled: boolean
  uri: string
  user: string
  password_set: boolean
  ok?: boolean
  files?: number
  entities?: number
  relations?: number
  error?: string
}

export interface KgRetrieval {
  entities: { name: string; description: string; score: number }[]
  relations: { src: string; type: string; dst: string; description: string }[]
}

export interface AgentPreset {
  id: number
  name: string
  avatar: string
  system_prompt: string
  model_id: string
  use_rag: boolean
  tools_enabled: boolean
  enabled: boolean
}

export interface Message {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  sources?: unknown
  model_id?: string | null
  feedback?: 'up' | 'down' | null
  created_at: string
}

export interface PromptItem {
  id: number
  title: string
  content: string
  created_at: string
}

export interface DashboardNarrative {
  today_messages: number
  yesterday_messages: number
  this_week_messages: number
  prev_week_messages: number
  today_tokens: number
  today_vault_files: number
  week_start: string
}

export interface DashboardBriefing {
  text: string
  cached: boolean
  facts: {
    conversations: number
    memories: number
    vault_files: number
    today_messages: number
    yesterday_messages: number
    this_week_messages: number
    prev_week_messages: number
    today_tokens: number
    today_vault_files: number
    task_runs_30d: number
    task_ok_30d: number
    task_err_30d: number
    recent_titles: string[]
  }
}

export interface DashboardStats {
  conversations: number
  messages: number
  memories: number
  vault_files: number
  tokens_total: number
  daily_tokens: { date: string; tokens: number }[]
  task_stats: {
    runs_30d: number
    ok: number
    error: number
    rate: number | null
  }
  tasks: {
    id: number
    name: string
    cron: string
    mode?: string
    trigger_kind?: string
    watch_path?: string
    next_run: string | null
    last_run: string | null
    last_status: string
  }[]
  tasks_total: number
  recent_conversations: { id: number; title: string; model_id: string; updated_at: string }[]
  daily_messages: { date: string; count: number }[]
  top_models: { model_id: string; count: number }[]
  narrative: DashboardNarrative
}

export interface SearchHit {
  source: 'chat' | 'tutor'
  id: number
  // chat 命中 → conversation_id；tutor 命中 → session_id（教学页深链用）
  ref_id: number
  title: string
  role: string
  excerpt: string
  at: string | null
}

/** 信念演化时间线：automemory 事实聚成的一条「信念线」 */
export interface BeliefThread {
  label: string
  first_at: string | null
  last_at: string | null
  items: { id: number; content: string; kind: string }[]
}

// ---------- 决策日志 + 校准分 ----------

export type DecisionOutcome = '' | 'hit' | 'miss' | 'unclear'

export interface DecisionEntry {
  id: number
  text: string
  basis: string
  /** 领域标签，校准时分组用；空 = 不进榜 */
  topic: string
  /** 0-100：**判断当时**自己说的把握。这一栏是整件事的关键 */
  confidence: number
  created_at: string | null
  reviewed_at: string | null
  /** '' = 还没回看（没有任何东西会催它） */
  outcome: DecisionOutcome
  note: string
}

export interface CalibrationBucket {
  bucket: string
  hits: number
  misses: number
  sample: number
  /** null = 样本不够，不给分 */
  rate: number | null
}

export interface Calibration {
  total: number
  reviewed: number
  /** 回看了但「还看不出」的，单独计数、不进命中率分母 */
  unclear: number
  pending: number
  overall: { hits: number; misses: number; rate: number | null; min_sample: number }
  by_topic: { topic: string; hits: number; misses: number; rate: number }[]
  by_confidence: CalibrationBucket[]
}

export interface DecisionLogView {
  entries: DecisionEntry[]
  calibration: Calibration
}

// ---------- 用量与成本 ----------

export interface CostKindRow {
  in: number
  out: number
  calls: number
}

export interface CostSummary {
  days: number
  total_tokens_in: number
  total_tokens_out: number
  total_tokens: number
  /** 聊天消息条数（自己有一列，不走账本） */
  chat_calls: number
  /** 定时任务次数（同上） */
  task_runs: number
  /** 账本收下的调用次数：聊天与定时任务之外的**全部**路径 */
  ledger_calls: number
  by_model: Record<string, { in: number; out: number; total: number; calls: number }>
  /** 按操作——「钱花在哪」的正答 */
  by_kind: Record<string, CostKindRow>
  by_day: [string, number][]
  /** 填了模型价格才有；形状由后端 estimate_cost 决定 */
  cost?: Record<string, unknown> | null
}

export interface NoteSearchHit {
  path: string
  count: number
  excerpt: string
}

export interface BackupItem {
  name: string
  size: number
  created_at: string
}

export interface BackupList {
  dir: string
  keep: number
  next_run: string | null
  backups: BackupItem[]
  restore_hint: string
}

export interface ScheduledTask {
  id: number
  name: string
  prompt: string
  cron: string
  model_id: string
  use_rag: boolean
  tools_enabled: boolean
  save_to_vault: boolean
  enabled: boolean
  mode: 'simple' | 'agent'
  tool_whitelist: string
  max_rounds: number
  retry: number
  notify_on_error: boolean
  trigger_kind: 'cron' | 'watch' | 'chain'
  watch_path: string
  chain_next_id: number | null
  /** 人工卡点：这一步跑完停下等人点头，才触发下游 */
  require_approval: boolean
  /** 这一步做什么：prompt = 跑提示词；transcribe = 本地 ASR 转写录音 */
  action: 'prompt' | 'transcribe'
  /** 产物落哪个 vault 子目录（空 = tasks/）。沿链条继承，所以一条流水线的各步同目录。 */
  landing_dir: string
  /** 停在人工卡点上的那次运行；null/缺省 = 没有待审的。放行/驳回用它。 */
  awaiting_run_id?: number | null
  conversation_id: number | null
  last_run: string | null
  last_status: string
  last_result: string
  next_run: string | null
  running?: boolean
}

export interface SkillItem {
  name: string
  description: string
  model?: string
  tools?: string
  files: string[]
  chars: number
}

export interface TaskTool {
  name: string
  description: string
}

export interface TaskRunLogEntry {
  tool: string
  args: Record<string, unknown>
  ok: boolean
  result: string
}

export interface TaskRunItem {
  id: number
  task_id: number
  trigger: 'cron' | 'manual' | 'chain' | 'watch'
  upstream_task_id: number | null
  started_at: string | null
  finished_at: string | null
  status: string
  mode: string
  model_id: string
  rounds: number
  tool_calls: number
  error: string
  answer: string
  /** 接地分 0-5（LLM 判分：这次的答案 vs 本次检索到的材料）。null = 没打分（没材料 / 判分没跑成）。 */
  grounded: number | null
  /** 判分给的一句话理由 */
  judge_reason: string
  /** 这次运行的落点目录（vault 相对；空 = tasks/） */
  run_dir: string
  log: TaskRunLogEntry[]
}

export interface TaskRunResult {
  status: string
  error: string
  answer: string
  model_id: string
  conversation_id: number | null
  vault_file: string | null
  sources: number
  run_id: number
  rounds: number
  tool_calls: number
  log: TaskRunLogEntry[]
}

export interface EvalItem {
  id: number
  question: string
  expected_source: string
  note: string
}

export interface EvalCaseResult {
  id: number
  question: string
  expected_source: string
  rank: number | null
  hits: (string | null)[]
  answer: string
  score: number | null
  reason: string
  error: string
}

export interface EvalRun {
  id: number
  created_at: string | null
  top_k: number
  hybrid: boolean
  rerank: boolean
  full_context: boolean
  judge_model: string
  total: number
  hit1: number
  hit3: number
  hitk: number
  mrr: number
  faithfulness: number | null
  seconds: number
  labelled?: number
  detail?: EvalCaseResult[]
}

export interface ImageConfig {
  enabled: boolean
  api: string
  provider: string
  model: string
  size: string
}

export interface ImageItem {
  name: string
  url: string
  bytes: number
  created?: string
}

export interface ImageGenResult {
  prompt: string
  model: string
  size: string
  api: string
  provider: string
  seconds: number
  images: ImageItem[]
}

export interface RepoItem {
  name: string
  url: string
  files?: number
  chunks?: number
  pruned?: number
  truncated?: boolean
  errors?: string[]
  last_synced?: string
  seconds?: number
  cloned?: boolean
}

export interface RepoList {
  repos: RepoItem[]
  dir: string
  max_files: number
  max_file_bytes: number
}

export interface DirItem {
  name: string
  path: string
  enabled: boolean
  exists: boolean
  files?: number
  chunks?: number
  errors?: string[]
  pruned?: number
  truncated?: boolean
  last_synced?: string
  seconds?: number
}

export interface DirList {
  dirs: DirItem[]
  max_files: number
  max_file_bytes: number
  watcher: string
}

export interface FeedItem {
  name: string
  url: string
  title?: string
  enabled?: boolean
  new?: number
  total?: number
  written_to?: string | null
  last_synced?: string
}

export interface FeedList {
  feeds: FeedItem[]
  dir: string
  next_run: string | null
}

// ---------- 复习卡片 ----------

export type CardKind = 'concept' | 'cloze' | 'scenario' | 'debug'
export type CardGrade = 1 | 2 | 3 | 4

/** A candidate, not yet in the deck — AI-generated or hand-written. */
export interface CardDraft {
  kind: CardKind
  front: string
  back: string
  hint: string
  topic: string
  excerpt: string
  origin?: 'ai' | 'manual'
  duplicate_of?: number | null // -1 = duplicate of another card in this same batch
  similarity?: number | null
}

/** Everything that can be carded. Externals are prefixed `repo:` / `dir:`. */
export interface CardSources {
  vault: string[]
  repos: string[]
  dirs: string[]
  /** match counts before `limit` was applied, so the UI can say "showing 200 of 812" */
  totals: { vault: number; repos: number; dirs: number }
  /** source -> cards already made from it; "" holds the pasted-text cards */
  card_counts: Record<string, number>
}

/** One retrieval hit, already carrying the spec the material endpoints accept. */
export interface MaterialHit {
  source: string
  /** "" when the hit is a namespace entry rather than a file */
  spec: string
  title: string
  chunk: number | null
  score: number | null
  text: string
  cards: number
}

export interface CardItem {
  id: number
  kind: CardKind
  front: string
  back: string
  hint: string
  topic: string
  source: string
  source_label: string
  source_excerpt: string
  origin: string
  suspended: boolean
  due: string | null
  interval_days: number
  ease: number
  reps: number
  lapses: number
  last_grade: number | null
  last_review: string | null
  created_at: string | null
}

export interface CardQueue {
  due: CardItem[]
  /** new cards; named `fresh` to dodge the reserved word */
  fresh: CardItem[]
  due_total: number
  caps: { new_per_day: number; review_per_day: number }
  today: { reviewed: number; new_done: number }
}

export interface CardReviewResult extends CardItem {
  ok: boolean
  due_seconds: number
  /** true when the card comes due soon enough to re-show it this session */
  requeue: boolean
}

export interface CardStats {
  total: number
  new: number
  learning: number
  mature: number
  suspended: number
  due_now: number
  today_reviewed: number
  today_new: number
  remaining_today: number
  accuracy_7d: number | null
  daily: { date: string; count: number }[]
  streak: number
  next_due: string | null
}

export interface CardSourceStat {
  source: string
  source_label: string
  cards: number
  lapses: number
  reviews: number
  avg_grade: number | null
  again_rate: number | null
  weak: boolean
}

// ---------- 习惯打卡 ----------

export type HabitKind = 'check' | 'count'

/** One habit as the 今日 page sees it: definition + today's value + streak. */
export interface Habit {
  id: number
  name: string
  icon: string
  kind: HabitKind
  target: number
  unit: string
  /** 7 chars of 0/1, Monday first */
  weekdays: string
  /** "" = ticked by hand; "cards" = derived from card_reviews, not tickable */
  auto: string
  sort: number
  value: number
  done: boolean
  scheduled: boolean
  streak: number
  /** local date strings that count as done — the heatmap input */
  history: string[]
}

export interface HabitToday {
  day: string
  habits: Habit[]
  done: number
  total: number
  pending: string[]
  heatmap_days: number
}

/** Shape returned by create/update — the definition only, no daily state. */
export interface HabitDef {
  id: number
  name: string
  icon: string
  kind: HabitKind
  target: number
  unit: string
  weekdays: string
  auto: string
  sort: number
  archived: boolean
}

// ---------- 后台自检 ----------

/** One model's probe outcome. `code` is like "403 AllocationQuota.FreeTierOnly". */
export interface ModelProbe {
  model_id: string
  ok: boolean
  code: string
  message: string
  ms: number
}

export interface JobHealth {
  job_id: string
  registered: boolean
  /** the prefs flag that turns this job on ("" for task_<id> jobs) */
  enabled_by: string
  /** you turned it off — not a fault */
  disabled: boolean
  next_run: string | null
  runs: number
  consecutive_failures: number
  last: { at: string | null; ok: boolean; seconds: number; message: string } | null
}

export interface SelfCheck {
  jobs_total: number
  jobs_live: number
  /** switched off in settings */
  jobs_off: string[]
  /** should be running but is not registered — a bug, not a preference */
  jobs_missing: string[]
  jobs_failing: { job_id: string; fails: number; message: string }[]
  models_total: number
  models_broken: { model_id: string; code: string }[]
  default_model: string | null
  /** the model every automated feature would reach is the broken one */
  default_model_broken: boolean
  never_probed: boolean
}

/** 体检报告：自检 + 备份 + 索引 + 用户任务失败 + 整理员，一页看全 */
export interface HealthReport {
  self: SelfCheck
  backups: { count: number; latest_at: string | null }
  kb: { indexer?: { files?: number; chunks?: number }; watcher?: unknown }
  tasks_failing: { id: number; name: string }[]
  tidy: Record<string, unknown>
}

/** 模型竞技场：同一段 prompt 各家并行的成绩单 */
export interface ArenaResult {
  label: string
  ok: boolean
  text?: string
  error?: string
  seconds: number
}

/** 今日页「今天下一步」建议. */
export interface TodayNext {
  text: string
  tone: 'bad' | 'idle'
  /** thread = 「最近动过的那件事」——点进去是接着看，**不是待办** */
  action: { kind: 'settings' | 'thread' | 'none'; label: string; thread_id?: number }
}

/** 一条已生成的产出。`kind` 是哪个引擎写的，`path` 是 vault 相对路径（可直接交给
 *  笔记页打开——它和用户自己的笔记同在一片 vault 里）。 */
export interface WorkOutput {
  kind: 'research' | 'compose' | 'recap' | 'decide' | 'conflict' | 'task' | 'deliver'
  label: string
  path: string
  title: string
  date: string
  mtime: number
}

/** 交付（工作侧成文）：一种体裁或一种读者。定义在后端 `core/deliver.py`，前端不硬编码。 */
export interface DeliverOption {
  id: string
  label: string
}

export interface DeliverCatalogue {
  genres: DeliverOption[]
  audiences: DeliverOption[]
  default_genre: string
  default_audience: string
}

/** 会议闭环（§4-13）的一场：`vault/meetings/<日期>-<名>/` 一个文件夹。
 *  录音、转写、纪要、待办、短稿是同一件事的五个面，所以按"一场"给，不按文件平铺。 */
export interface WorkMeeting {
  name: string
  path: string
  date: string
  title: string
  mtime: number
  /** vault 相对路径；空 = 这一场没留录音 */
  audio: string
  files: { path: string; title: string }[]
}

/** 「一件事」（§4-15）：材料 / 笔记 / 卡片 / 卡点 / 成品 / 判断都挂在它上面。
 *  vault 不搬家——这里只有名字与引用。 */
export type ThreadKind = 'material' | 'note' | 'card' | 'tutor' | 'output' | 'task' | 'decision'

export interface ThreadStep {
  key: string
  label: string
  kinds: ThreadKind[]
}

export interface ThreadCandidate {
  kind: ThreadKind
  ref: string
  title: string
  label: string
  step?: string
}

export interface ThreadItemRow {
  kind: ThreadKind
  ref: string
  title: string
  /** false = 它指的东西已经没了——照常列出来，只是不给落点 */
  exists: boolean
  step: string
  href: string
}

export interface ThreadRow {
  id: number
  name: string
  note: string
  archived: boolean
  created_at: string | null
  updated_at: string | null
  counts: Partial<Record<ThreadKind, number>>
  total: number
}

/** 这件事头上记着的账（§4-16）。`by_model` 同时回答了"用了哪些模型"。 */
export interface ThreadCost {
  tokens_in: number
  tokens_out: number
  total: number
  calls: number
  by_model: Record<string, { in: number; out: number; calls: number }>
}

export interface ThreadDetail extends ThreadRow {
  items: ThreadItemRow[]
  by_step: Record<string, ThreadItemRow[]>
  steps: ThreadStep[]
  suggestions: ThreadCandidate[]
  cost: ThreadCost
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}

export interface NotesChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export async function streamNotesAi(
  action: 'continue' | 'polish' | 'summarize' | 'rewrite' | 'chat',
  content: string,
  onDelta: (text: string) => void,
  signal: AbortSignal,
  extra?: { selection?: string; instruction?: string; question?: string; history?: NotesChatTurn[] }
): Promise<void> {
  const res = await fetch('/api/notes/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, content, ...extra }),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`ai failed: ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      }
      if (!dataLines.length) continue
      const data = JSON.parse(dataLines.join('\n'))
      if (event === 'delta') onDelta(data.text as string)
      else if (event === 'error') throw new Error(data.message as string)
    }
  }
}

// ---------- 对话式教学 ----------

/** end() 的返回：概念/别名/卡点之外，`material_nearby` 是「材料里还有」，
 * 只在自评总结里出现一次（护栏版——不是队列）。
 * `transfer` 是「换个场景试试」的检验问题，同样只在总结里出现一次。 */
export interface TutorEndResult {
  id: number
  verdict: string
  concept: string
  aliases: string
  stuck: string
  transfer: string
  material_nearby: { source: string; title: string; score: number }[]
}

export interface TutorSessionStart {
  id: number
  topic: string
  repo: string
  mode: 'socratic' | 'feynman'
  model_id: string
  /** false = no provider, or a recent probe failed. Say so before the first turn. */
  model_ok: boolean
}

export interface TutorTurn {
  role: 'user' | 'assistant'
  content: string
}

/** 学习画像：教学记录按概念聚合的派生结果（设置页只读展示，注入教学提示词）。 */
export interface TutorProfile {
  known: string[]
  half: string[]
  preferences: { kind: string; content: string }[]
}

/** 一条记录在案的卡点（got/half 才算数）。independent of the rail's 50-row window. */
export interface TutorStuckRow {
  id: number
  concept: string
  stuck: string
  verdict: string
  created_at: string
  /** 非空 = 已解（同一概念后来说通了自动回写，或手动关掉）。空 = 待解。 */
  resolved_at: string
}

/** 「我学到哪了」——按概念收敛后的当前状态（纯派生，无新表）。
 * 与 TutorStuckRow 的分工：那是逐条卡点记录，这是每个概念的一行。
 * verdict/stuck 都取该概念**最近一次**会话的值。 */
export interface TutorConceptRow {
  concept: string
  verdict: 'got' | 'half'
  stuck: string
  /** 这条卡点解没解（同样取最近一次那场）。 */
  stuck_resolved: boolean
  last_at: string
  last_session_id: number
  sessions: number
  recalled: number
}

/** 「材料消化」拆出来的一个点：一句话 + 它为什么容易卡。
 * `id` 是它在 `digest_points`（建议日志）里的行号——点开成教学时带回去标记已教。
 * 落库失败会退化成 0，此时按标题走，不影响开局。 */
export interface TutorDigestPoint {
  id: number
  title: string
  why: string
}

/** 一份材料 → 要搞懂的点。`error` 非空时 points 为空（没模型 / 拆失败），材料本身没丢。 */
export interface TutorDigestResult {
  source: string
  source_label: string
  points: TutorDigestPoint[]
  error: string
}

/** 「未触及」：digest 拆出来、但还没开成教学的点。 */
export interface TutorUntouchedPoint {
  id: number
  point: string
  why: string
  source: string
  created_at: string
}

/** 学习地图：概念分四档。前三档是 TutorConceptRow 的子集（纯派生），
 * 第四档读的是 digest_points 建议日志。 */
export interface TutorLearningMap {
  mastered: TutorConceptRow[]
  learning: TutorConceptRow[]
  stuck: TutorConceptRow[]
  untouched: TutorUntouchedPoint[]
}

/** 成长事件（A3）：一个概念「学会了」的时刻。规则与学习地图「已掌握」同一条——
 * 最近一次说通、且不止一场。零柒的成长面板用它说「最近搞懂」。纯派生。 */
export interface TutorMasteryEvent {
  concept: string
  at: string
  sessions: number
  recalled: number
  /** 这个概念以前半懂过、后来才说通——「从半懂到懂」 */
  from_half: boolean
}

export interface TutorMastery {
  events: TutorMasteryEvent[]
  mastered: number
  learning: number
  sessions: number
}

/** A row in the history rail. `turn_count` is a number here; `TutorDetail.turns`
 * is the message list — two names because one key with two types gets misread. */
export interface TutorSessionRow {
  id: number
  topic: string
  concept: string
  verdict: '' | 'got' | 'half' | 'useless'
  stuck: string
  recalled: boolean
  /** socratic：老师问你答；feynman：反转，你讲它追问；future：和一年后的自己聊 */
  mode: 'socratic' | 'feynman' | 'future'
  turn_count: number
  created_at: string
  ended_at: string | null
}

export interface TutorDetail extends Omit<TutorSessionRow, 'turn_count'> {
  model_id: string
  turns: TutorTurn[]
}

export interface TutorStats {
  days: number
  sessions: number
  got: number
  got_with_recall: number
  concepts: number
}

/** 开场建议：从自己的记录派生的就近入口（半懂概念 / 日记疑问句）。
 * 点了才开会话——不是队列，没有计数，也没有「还没学」的欠账感。 */
export interface TutorStarter {
  kind: 'half' | 'journal'
  topic: string
  note: string
}

/** 一条生成质量评价的聚合（按 kind + 提示词版本 + 模型切分）。 */
export interface QualityGroup {
  kind: string
  prompt_sha: string
  model_id: string
  good: number
  bad: number
  total: number
  rate: number
}

export interface QualitySummary {
  days: number
  total: number
  good: number
  bad: number
  rate: number
  groups: QualityGroup[]
  recent_bad: {
    kind: string
    model_id: string
    prompt_sha: string
    reason: string
    created_at: string | null
  }[]
}

/** 某个成文引擎跑一遍 golden set 的自动得分（结构与人工反馈共用同一个 prompt_sha）。 */
export interface EngineEvalRun {
  id: number
  engine: string
  created_at: string | null
  prompt_sha: string
  model_id: string
  total: number
  /** 无 finding 的用例占比 0-1（确定性判分，不花模型钱） */
  structural: number
  /** 接地判分 0-5 均值；null = 这次只跑了结构判分 */
  grounded: number | null
  seconds: number
}

export interface EngineEvalLatest {
  by_engine: Record<string, EngineEvalRun | null>
  /** 每个引擎的 golden set 有几条用例 */
  coverage: Record<string, number>
  /** 标尺自身的健康度提醒：全顶格（区分度低）、用例偏少 */
  warnings: string[]
}

export interface EngineEvalRunResult {
  runs: EngineEvalRun[]
  skipped: string[]
  judge_model: string
  judged: boolean
  coverage: Record<string, number>
}

// ---------- 零柒：成长 + 能力插件（Track B） ----------

/** 成长的一个来源（「把东西搞懂」等）。全部是累计量，所以只增不减。 */
export interface PetGrowthPart {
  key: 'learning' | 'work' | 'habits' | 'review'
  label: string
  exp: number
}

/** 零柒的成长：等级 / 称号 / 累计 EXP。**只有累计与达成，没有「还欠 N」。** */
export interface PetGrowth {
  level: number
  title: string
  exp: number
  /** 「正在靠近」的下一级称号；空 = 已到顶 */
  next_title: string
  /** 0-1 的进度条（只用来画条，界面不显示「还差 N」） */
  progress: number
  parts: PetGrowthPart[]
  counts: Record<string, number>
}

/** 插件面板：哪种面板 + 它要显示的数。sdk 里叫「面板」。 */
export interface PetPluginPanel {
  kind: 'counter' | 'timer' | 'mood'
  unit?: string
  target?: number
  value?: number
  running?: boolean
  remaining?: number
  minutes?: number
  default_minutes?: number
  /** mood：1–5 的量表上限 */
  scale?: number
  /** mood：记录过的天数 */
  days?: number
  /** mood：最近几天（旧→新），画一条小曲线用 */
  recent?: { day: string; value: number }[]
}

/** 一个装好的能力插件（openpets 范式：权限 / 配额 / 存储 / 计划 / 事件 / 命令 / 面板）。 */
export interface PetPlugin {
  name: string
  label: string
  enabled: boolean
  permissions: string[]
  commands: string[]
  panel: PetPluginPanel
  quota: { used: number; cap: number }
}

export interface PetPluginCommandResult {
  ok: boolean
  name: string
  command: string
  panel: PetPluginPanel
  said: string | null
}

export const api = {  listProviders: () => request<ProviderConfig[]>('/api/settings/providers'),
  createProvider: (p: Partial<ProviderConfig>) =>
    request<ProviderConfig>('/api/settings/providers', { method: 'POST', body: JSON.stringify(p) }),
  updateProvider: (id: number, p: Partial<ProviderConfig>) =>
    request<ProviderConfig>(`/api/settings/providers/${id}`, { method: 'PUT', body: JSON.stringify(p) }),
  deleteProvider: (id: number) =>
    request<{ ok: boolean }>(`/api/settings/providers/${id}`, { method: 'DELETE' }),

  getMcp: () => request<McpView>('/api/settings/mcp'),
  saveMcp: (servers: McpServer[]) =>
    request<McpView>('/api/settings/mcp', { method: 'PUT', body: JSON.stringify({ servers }) }),
  testMcp: (server: McpServer) =>
    request<McpProbe>('/api/settings/mcp/test', { method: 'POST', body: JSON.stringify(server) }),

  listConversations: () => request<Conversation[]>('/api/conversations'),
  getConversation: (id: number) => request<Conversation>(`/api/conversations/${id}`),
  createConversation: (modelId: string) =>
    request<Conversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ model_id: modelId }),
    }),
  deleteConversation: (id: number) =>
    request<{ ok: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),
  forkConversation: (id: number, messageId: number) =>
    request<Conversation>(`/api/conversations/${id}/fork`, {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId }),
    }),
  exportConversation: async (id: number): Promise<void> => {
    const res = await fetch(`/api/conversations/${id}/export`)
    if (!res.ok) throw new Error(`export failed: ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `chat-${id}.md`
    a.click()
    URL.revokeObjectURL(url)
  },
  editMessage: (convId: number, messageId: number, content: string) =>
    request<{ ok: boolean; dropped: number }>(
      `/api/conversations/${convId}/messages/${messageId}`,
      { method: 'PUT', body: JSON.stringify({ content }) }
    ),
  setFeedback: (convId: number, messageId: number, rating: 'up' | 'down' | null) =>
    request<{ ok: boolean; feedback: 'up' | 'down' | null }>(
      `/api/conversations/${convId}/messages/${messageId}/feedback`,
      { method: 'PUT', body: JSON.stringify({ rating }) }
    ),

  listMemories: () => request<MemoryItem[]>('/api/settings/memories'),
  addMemory: (content: string) =>
    request<{ ok: boolean; message: string }>('/api/settings/memories', {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  updateMemory: (id: number, content: string) =>
    request<{ ok: boolean; message: string }>(`/api/settings/memories/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  deleteMemory: (id: number) =>
    request<{ ok: boolean }>(`/api/settings/memories/${id}`, { method: 'DELETE' }),
  clearMemories: () => request<{ ok: boolean; deleted: number }>('/api/settings/memories', { method: 'DELETE' }),
  getMemoryExpose: () => request<MemoryExpose>('/api/settings/mcp/expose'),
  getMemoryTidy: () => request<MemoryTidyStatus>('/api/settings/memories/tidy'),
  runMemoryTidy: () =>
    request<MemoryTidyReport>('/api/settings/memories/tidy', { method: 'POST' }),

  listAgents: () => request<AgentPreset[]>('/api/agents'),
  createAgent: (a: Omit<AgentPreset, 'id'>) =>
    request<AgentPreset>('/api/agents', { method: 'POST', body: JSON.stringify(a) }),
  updateAgent: (id: number, a: Partial<AgentPreset>) =>
    request<AgentPreset>(`/api/agents/${id}`, { method: 'PUT', body: JSON.stringify(a) }),
  deleteAgent: (id: number) => request<{ ok: boolean }>(`/api/agents/${id}`, { method: 'DELETE' }),

  dashboard: () => request<DashboardStats>('/api/dashboard'),
  dashboardBriefing: () => request<DashboardBriefing>('/api/dashboard/briefing'),

  listPrompts: () => request<PromptItem[]>('/api/prompts'),
  createPrompt: (p: { title: string; content: string }) =>
    request<PromptItem>('/api/prompts', { method: 'POST', body: JSON.stringify(p) }),
  updatePrompt: (id: number, p: Partial<PromptItem>) =>
    request<PromptItem>(`/api/prompts/${id}`, { method: 'PUT', body: JSON.stringify(p) }),
  deletePrompt: (id: number) => request<{ ok: boolean }>(`/api/prompts/${id}`, { method: 'DELETE' }),

  listSkills: () => request<{ dir: string; skills: SkillItem[] }>('/api/skills'),
  installSkill: (url: string, name = '', overwrite = false) =>
    request<SkillItem>('/api/skills/install', {
      method: 'POST',
      body: JSON.stringify({ url, name, overwrite }),
    }),
  deleteSkill: (name: string) =>
    request<{ ok: boolean; name: string }>(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  readSkill: (name: string) =>
    request<{ name: string; content: string; raw: string }>(`/api/skills/content?name=${encodeURIComponent(name)}`),
  updateSkill: (name: string, content: string) =>
    request<{ name: string; description: string; chars: number }>(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  globalSearch: async (q: string): Promise<SearchHit[]> => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
    if (!res.ok) throw new Error(`search failed: ${res.status}`)
    const data = (await res.json()) as { results: SearchHit[] }
    return data.results
  },

  listNotes: () =>
    request<{ dir: string; files: { path: string; mtime: number }[] }>('/api/notes'),
  notesBriefing: () =>
    request<{ text: string; cached: boolean; facts: { total: number; today_new: number; this_week_touched: number; latest_titles: string[]; latest_today: string[] } }>(
      '/api/notes/briefing'
    ),
  searchNotes: (q: string) =>
    request<{ query: string; hits: NoteSearchHit[] }>(
      `/api/notes/search?q=${encodeURIComponent(q)}`
    ),
  readNote: (path: string) =>
    request<{ path: string; content: string }>(
      `/api/notes/content?path=${encodeURIComponent(path)}`
    ),
  saveNote: (path: string, content: string) =>
    request<{ ok: boolean; chunks: number }>('/api/notes/content', {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),
  deleteNote: (path: string) =>
    request<{ ok: boolean }>(`/api/notes/content?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),

  clipUrl: (url: string, title?: string) =>    request<{ filename: string; title: string; chars: number; chunks: number }>('/api/kb/clip', {
      method: 'POST',
      body: JSON.stringify({ url, title }),
    }),

  /** 划词助手的「剪藏」：直接落盘所选文本（/api/kb/clip_text） */
  clipText: (text: string, title?: string) =>
    request<{ filename: string; title: string; chars: number; chunks: number }>('/api/kb/clip_text', {
      method: 'POST',
      body: JSON.stringify({ text, title }),
    }),

  /** 信念演化时间线：automemory 事实按语义聚成的「信念线」 */
  beliefThreads: () => request<{ threads: BeliefThread[] }>('/api/beliefs'),

  /** 决策日志 + 校准分：把判断与当时的把握钉下来，回看时才算得出校准 */
  listDecisions: () => request<DecisionLogView>('/api/decisions'),  addDecision: (body: { text: string; basis?: string; topic?: string; confidence?: number }) =>
    request<DecisionEntry>('/api/decisions', { method: 'POST', body: JSON.stringify(body) }),
  reviewDecision: (id: number, outcome: DecisionOutcome, note = '') =>
    request<DecisionEntry>(`/api/decisions/${id}/review`, {
      method: 'PUT',
      body: JSON.stringify({ outcome, note }),
    }),
  deleteDecision: (id: number) =>
    request<{ ok: boolean }>(`/api/decisions/${id}`, { method: 'DELETE' }),

  /** 用量与成本：最近 N 天的 token 花在哪些操作 / 模型上 */
  costSummary: (days = 30) => request<CostSummary>(`/api/cost/summary?days=${days}`),

  /** 语音日记：转写文本按天落盘 vault/journal/（automemory 后台提取，best-effort） */
  journalAdd: (text: string) =>
    request<JournalSaved>('/api/journal', { method: 'POST', body: JSON.stringify({ text }) }),
  journalRecent: () => request<JournalRecent>('/api/journal/recent'),

  /** 卡点讨论播客（对话播客 2.0）：最近的卡点 → 双人讨论音频 */
  podcastFromStuck: (days = 90) =>
    request<{ ok: boolean; id: string; title: string; file: string; duration_sec: number }>(
      '/api/podcast/stuck',
      { method: 'POST', body: JSON.stringify({ days }) }
    ),

  /** 学习小组圆桌：三 persona 笔谈一个卡点，纪要落盘 vault/roundtable/ */
  roundtableRun: (topic = '', days = 90) =>
    request<RoundtableResult>('/api/roundtable', {
      method: 'POST',
      body: JSON.stringify({ topic, days })
    }),
  roundtablePodcast: (file: string) =>
    request<{ ok: boolean; id: string; title: string; file: string; duration_sec: number }>(
      '/api/roundtable/podcast',
      { method: 'POST', body: JSON.stringify({ file }) }
    ),

  /** 研究（学习闭环的中间两跳）：把上一次的报告落成 vault/research/ 里的一篇 md 并进索引 */
  researchSave: (payload: {
    title: string
    sections: { heading: string; body: string }[]
    used: number[]
    sources: { n: number; kind: string; title: string; ref: string }[]
  }) =>
    request<{ filename: string; title: string; chunks: number }>('/api/research/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** 产出（学习闭环的出口跳）：把上次的产出落成 vault/notes/ 里的一篇 md 并进索引 */
  composeSave: (payload: {
    title: string
    sections: { heading: string; body: string }[]
    used: number[]
    sources: { n: number; kind: string; title: string; ref: string }[]
  }) =>
    request<{ filename: string; title: string; chunks: number }>('/api/compose/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** 分析 / 方案：把上一次的方案落成 vault/decisions/ 里的一篇 md 并进索引 */
  decideSave: (payload: {
    title: string
    sections: { heading: string; body: string }[]
    used: number[]
    sources: { n: number; kind: string; title: string; ref: string }[]
  }) =>
    request<{ filename: string; title: string; chunks: number }>('/api/decide/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** 对质：把上一次的报告落成 vault/conflicts/ 里的一篇 md 并进索引 */
  conflictSave: (payload: {
    title: string
    sections: { heading: string; body: string }[]
    used: number[]
    sources: { n: number; kind: string; title: string; ref: string }[]
  }) =>
    request<{ filename: string; title: string; chunks: number }>('/api/conflict/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** 生成质量闭环：一次 👍/👎，挂在 (kind, 提示词版本, 模型) 上 */
  qualityFeedback: (payload: {
    kind: 'research' | 'compose' | 'recap' | 'decide' | 'conflict' | 'deliver'
    verdict: 'good' | 'bad'
    prompt_sha?: string
    model_id?: string
    reason?: string
    ref?: string
  }) =>
    request<{ id: number; kind: string; verdict: string }>('/api/quality/feedback', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  qualitySummary: (days = 90) => request<QualitySummary>(`/api/quality/summary?days=${days}`),

  /** 成文引擎的自动标尺：每个引擎最近一次的得分 + golden set 覆盖 */
  engineEvalLatest: () => request<EngineEvalLatest>('/api/evals/engines/latest'),

  /** 在真模型上跑一遍 golden set（每个用例至少一次模型调用，可能要几分钟） */
  engineEvalRun: (engine?: string) =>
    request<EngineEvalRunResult>('/api/evals/engines/run', {
      method: 'POST',
      body: JSON.stringify(engine ? { engine } : {}),
    }),

  listRepos: () => request<RepoList>('/api/repos'),
  cloneRepo: (url: string, name?: string) =>
    request<RepoItem>('/api/repos', { method: 'POST', body: JSON.stringify({ url, name }) }),
  syncRepo: (name: string) =>
    request<RepoItem>(`/api/repos/${encodeURIComponent(name)}/sync`, { method: 'POST' }),
  deleteRepo: (name: string) =>
    request<{ ok: boolean; sources_removed: number; dir_removed: boolean }>(
      `/api/repos/${encodeURIComponent(name)}`,
      { method: 'DELETE' }
    ),

  listDirs: () => request<DirList>('/api/dirs'),
  addDir: (name: string, path: string) =>
    request<DirItem>('/api/dirs', { method: 'POST', body: JSON.stringify({ name, path }) }),
  syncDir: (name: string) =>
    request<DirItem>(`/api/dirs/${encodeURIComponent(name)}/sync`, { method: 'POST' }),
  toggleDir: (name: string, enabled: boolean) =>
    request<DirItem>(`/api/dirs/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  deleteDir: (name: string) =>
    request<{ ok: boolean; sources_removed: number }>(`/api/dirs/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),

  listFeeds: () => request<FeedList>('/api/feeds'),
  addFeed: (url: string, name?: string) =>
    request<FeedItem>('/api/feeds', { method: 'POST', body: JSON.stringify({ url, name }) }),
  syncFeed: (name: string) =>
    request<{ new: number; total: number; written_to: string | null }>(
      `/api/feeds/${encodeURIComponent(name)}/sync`,
      { method: 'POST' }
    ),
  syncAllFeeds: () =>
    request<{ feeds: number; new: number; results: Record<string, { new?: number; error?: string }> }>(
      '/api/feeds/sync',
      { method: 'POST' }
    ),
  toggleFeed: (name: string, enabled: boolean) =>
    request<FeedItem>(`/api/feeds/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  deleteFeed: (name: string) =>
    request<{ ok: boolean }>(`/api/feeds/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  testMail: () =>
    request<{ ok: boolean; to: string[]; subject: string }>('/api/mail/test', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  listBackups: () => request<BackupList>('/api/backup'),
  runBackup: () =>
    request<{ ok: boolean; name: string; size: number; vault_files: number; pruned: string[] }>(
      '/api/backup/run',
      { method: 'POST' }
    ),
  deleteBackup: (name: string) =>
    request<{ ok: boolean }>(`/api/backup/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  backupDownloadUrl: (name: string) => `/api/backup/download/${encodeURIComponent(name)}`,

  listTasks: () => request<ScheduledTask[]>('/api/tasks'),
  createTask: (t: Partial<ScheduledTask>) =>
    request<ScheduledTask>('/api/tasks', { method: 'POST', body: JSON.stringify(t) }),
  updateTask: (id: number, t: Partial<ScheduledTask>) =>
    request<ScheduledTask>(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(t) }),
  deleteTask: (id: number) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' }),
  runTask: (id: number) => request<TaskRunResult>(`/api/tasks/${id}/run`, { method: 'POST' }),
  /** 人工卡点（§4-12）：放行——这一步的产出交给下游任务 */
  approveRun: (runId: number) =>
    request<{ ok: boolean; approved: boolean; next_task_id: number | null }>(
      `/api/tasks/runs/${runId}/approve`,
      { method: 'POST' }
    ),
  /** 人工卡点（§4-12）：驳回——流程到此为止（产出留着，由你处置） */
  rejectRun: (runId: number) =>
    request<{ ok: boolean; approved: boolean; next_task_id: number | null }>(
      `/api/tasks/runs/${runId}/reject`,
      { method: 'POST' }
    ),
  listTaskTools: () => request<TaskTool[]>('/api/tasks/tools'),
  listTaskRuns: (id: number) => request<TaskRunItem[]>(`/api/tasks/${id}/runs`),
  parseTask: (text: string) =>
    request<{ cron: string; name: string; prompt: string }>('/api/tasks/parse', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  listEvalItems: () => request<EvalItem[]>('/api/evals'),
  createEvalItem: (i: Partial<EvalItem>) =>
    request<EvalItem>('/api/evals', { method: 'POST', body: JSON.stringify(i) }),
  updateEvalItem: (id: number, i: Partial<EvalItem>) =>
    request<EvalItem>(`/api/evals/${id}`, { method: 'PUT', body: JSON.stringify(i) }),
  deleteEvalItem: (id: number) =>
    request<{ ok: boolean }>(`/api/evals/${id}`, { method: 'DELETE' }),
  listEvalRuns: () => request<EvalRun[]>('/api/evals/runs'),
  getEvalRun: (id: number) => request<EvalRun>(`/api/evals/runs/${id}`),
  deleteEvalRun: (id: number) =>
    request<{ ok: boolean }>(`/api/evals/runs/${id}`, { method: 'DELETE' }),
  runEval: (top_k: number | null, judge: boolean) =>
    request<EvalRun>('/api/evals/run', {
      method: 'POST',
      body: JSON.stringify({ top_k, judge }),
    }),

  listImages: () =>
    request<{ config: ImageConfig; images: ImageItem[] }>('/api/images'),
  generateImage: (prompt: string, size = '', model = '') =>
    request<ImageGenResult>('/api/images/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt, size, model }),
    }),
  deleteImage: (name: string) =>
    request<{ ok: boolean }>(`/api/images/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  uploadImage: async (file: File): Promise<ImageItem> => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/images/upload', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
    return res.json()
  },
  asrStatus: () => request<AsrStatus>('/api/asr/status'),
  transcribeAudio: async (blob: Blob): Promise<AsrResult> => {
    const fd = new FormData()
    fd.append('file', blob, 'audio.webm')
    const res = await fetch('/api/asr/transcribe', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
    return res.json()
  },
  ocrImage: (name: string) =>
    request<{ text: string }>('/api/images/ocr', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  ttsVoices: () => request<{ voices: string[]; engines: string[]; max_chars: number }>('/api/tts/voices'),
  tts: (text: string, voice = '', engine = 'edge') =>
    request<TtsResult>('/api/tts', { method: 'POST', body: JSON.stringify({ text, voice, engine }) }),
  listPodcasts: () => request<{ podcasts: PodcastEntry[] }>('/api/podcast'),
  generatePodcast: (paths: string[], hostVoice = '', guestVoice = '', title = '') =>
    request<PodcastEntry>('/api/podcast/generate', {
      method: 'POST',
      // LLM 写脚本 + 逐句 TTS + 音频装配，整体可能要 1-3 分钟
      body: JSON.stringify({ paths, host_voice: hostVoice, guest_voice: guestVoice, title }),
    }),
  deletePodcast: (id: string) =>
    request<{ ok: boolean }>(`/api/podcast/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  artifactsStatus: () => request<ArtifactsStatus>('/api/artifacts/status'),
  runArtifact: (code: string, language: string, timeout?: number) =>
    request<ArtifactsResult>('/api/artifacts/run', {
      method: 'POST',
      body: JSON.stringify({ code, language, timeout }),
    }),
  getKgStatus: () => request<KgStatus>('/api/kg/status'),
  saveKgConfig: (c: { uri: string; user: string; password: string; enabled: boolean }) =>
    request<{ ok: boolean; files?: number; entities?: number; relations?: number }>('/api/kg/config', {
      method: 'PUT',
      body: JSON.stringify(c),
    }),
  buildKg: (maxFiles: number) =>
    request<{ extracted: number; unchanged: number; failed: { file: string; error: string }[] }>('/api/kg/build', {
      method: 'POST',
      body: JSON.stringify({ max_files: maxFiles }),
    }),
  queryKg: (q: string, topK: number) =>
    request<KgRetrieval>('/api/kg/query', { method: 'POST', body: JSON.stringify({ q, top_k: topK }) }),
  clearKg: () => request<{ ok: boolean; deleted_entities: number }>('/api/kg/clear', { method: 'POST' }),

  // ---------- 复习卡片 ----------
  cardQueue: () => request<CardQueue>('/api/cards/queue'),
  cardStats: () => request<CardStats>('/api/cards/stats'),
  listCards: (q: { source?: string; kind?: string; topic?: string; limit?: number } = {}) =>
    request<{ total: number; cards: CardItem[] }>(
      '/api/cards?' +
        new URLSearchParams(
          Object.entries(q)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => [k, String(v)])
        ).toString()
    ),
  saveCards: (body: {
    cards: CardDraft[]
    source: string
    source_label: string
    model_id: string
  }) =>
    request<{ added: number; skipped: number; ids: number[] }>('/api/cards/batch', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  reviewCard: (id: number, grade: CardGrade, seconds: number) =>
    request<CardReviewResult>(`/api/cards/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ grade, seconds }),
    }),
  undoCardReview: (id: number) =>
    request<{ ok: boolean; card: CardItem | null }>(`/api/cards/${id}/undo`, { method: 'POST' }),
  updateCard: (
    id: number,
    patch: Partial<Pick<CardItem, 'front' | 'back' | 'hint' | 'topic' | 'kind' | 'suspended'>>
  ) => request<CardItem>(`/api/cards/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteCard: (id: number) =>
    request<{ ok: boolean }>(`/api/cards/${id}`, { method: 'DELETE' }),
  weakSources: (days = 30) =>
    request<{ days: number; sources: CardSourceStat[] }>(`/api/cards/weak?days=${days}`),
  /** Blank out a selected span. Server-side so the rules are covered by pytest. */
  makeCloze: (body: { text: string; start: number; end: number; topic?: string }) =>
    request<CardDraft>('/api/cards/cloze', { method: 'POST', body: JSON.stringify(body) }),
  cardSources: (q = '', limit = 200) =>
    request<CardSources>(
      `/api/cards/sources?q=${encodeURIComponent(q)}&limit=${limit}`
    ),
  /** Retrieval hits ready to card. First call after a cold start takes ~6s. */
  searchMaterial: (q: string, topK = 6) =>
    request<{ query: string; hits: MaterialHit[] }>(
      `/api/cards/search?q=${encodeURIComponent(q)}&top_k=${topK}`
    ),
  cardMaterial: (source: string) =>
    request<{
      source: string
      source_label: string
      text: string
      /** the file was longer than the pane cap */
      truncated: boolean
      /** how much of it 🤖 出卡 would actually send to the model */
      gen_limit: number
    }>('/api/cards/material?source=' + encodeURIComponent(source)),

  // ---------- 习惯打卡 ----------
  habitsToday: () => request<HabitToday>('/api/habits/today'),
  seedHabits: () =>
    request<{ added: number; message?: string }>('/api/habits/seed', { method: 'POST' }),
  createHabit: (body: {
    name: string
    icon?: string
    kind?: HabitKind
    target?: number
    unit?: string
    weekdays?: string
  }) => request<HabitDef>('/api/habits', { method: 'POST', body: JSON.stringify(body) }),
  updateHabit: (
    id: number,
    patch: Partial<Pick<HabitDef, 'name' | 'icon' | 'target' | 'unit' | 'weekdays' | 'sort' | 'archived'>>
  ) => request<HabitDef>(`/api/habits/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteHabit: (id: number) => request<{ ok: boolean }>(`/api/habits/${id}`, { method: 'DELETE' }),
  tickHabit: (id: number, body: { value?: number; day?: string } = {}) =>
    request<{ ok: boolean; value: number; done: boolean }>(`/api/habits/${id}/tick`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  untickHabit: (id: number) =>
    request<{ ok: boolean; deleted: number }>(`/api/habits/${id}/tick`, { method: 'DELETE' }),

  // ---------- 后台自检 ----------
  probeProvider: (id: number) =>
    request<{ provider: string; results: ModelProbe[]; default_model: string | null }>(
      `/api/settings/providers/${id}/probe`,
      { method: 'POST' }
    ),
  healthJobs: () => request<{ jobs: JobHealth[]; keep_runs: number }>('/api/health/jobs'),
  selfCheck: () => request<SelfCheck>('/api/health/self'),

  /** 体检报告：/api/health/report */
  healthReport: () => request<HealthReport>('/api/health/report'),

  /** 模型竞技场：同一段 prompt 打到所有已启用 provider */
  arenaRun: (prompt: string) =>
    request<{ results: ArenaResult[] }>('/api/arena', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),

  // ---------- 第0周：使用基线 + 今日建议 ----------
  /** best-effort page-open count; fire from Layout on mount, ignore errors */
  visit: (page: string) =>
    request<{ recorded: boolean; page: string; day: string }>('/api/usage/visit', {
      method: 'POST',
      body: JSON.stringify({ page }),
    }),
  todayNext: () => request<TodayNext>('/api/today/next'),

  // ---------- 零柒：成长 + 能力插件（Track B） ----------
  /** 成长：等级 / 称号 / 累计 EXP / 各来源。只正面呈现。 */
  petGrowth: () => request<PetGrowth>('/api/pet/growth'),
  petPlugins: () => request<{ plugins: PetPlugin[] }>('/api/pet/plugins'),
  petPluginCommand: (name: string, command: string, args?: Record<string, unknown>) =>
    request<PetPluginCommandResult>(`/api/pet/plugins/${encodeURIComponent(name)}/command`, {
      method: 'POST',
      body: JSON.stringify({ command, args }),
    }),
  petPluginToggle: (name: string, enabled: boolean) =>
    request<{ ok: boolean; name: string; enabled: boolean }>(
      `/api/pet/plugins/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify({ enabled }) }
    ),

  // ---------- 工作：已经生成出来的产出 ----------
  /** 产出清单：五个引擎落在 vault 里的成品。真值是文件系统，没有登记表。 */
  workOutputs: (limit = 200) => request<{ outputs: WorkOutput[] }>(`/api/work/outputs?limit=${limit}`),

  /** 会议闭环（§4-13）的成品：一场一行 */
  workMeetings: (limit = 100) =>
    request<{ meetings: WorkMeeting[] }>(`/api/work/meetings?limit=${limit}`),
  /** `<audio>` 的原声地址。它带不了请求头，靠的是 cookie 鉴权。 */
  audioUrl: (path: string) => `/api/work/audio?path=${encodeURIComponent(path)}`,
  /** 一键装好会议闭环（inbox + 四步链）。幂等——装过就原样返回。 */
  installMeetingPreset: () =>
    request<{ created: number; tasks: ScheduledTask[] }>('/api/tasks/preset/meeting', {
      method: 'POST',
    }),

  // ---------- 一件事（§4-15） ----------
  listThreads: (includeArchived = false) =>
    request<{ threads: ThreadRow[]; steps: ThreadStep[] }>(
      `/api/threads?include_archived=${includeArchived}`
    ),
  threadDetail: (id: number) => request<ThreadDetail>(`/api/threads/${id}`),
  createThread: (name: string, note = '') =>
    request<ThreadRow>('/api/threads', { method: 'POST', body: JSON.stringify({ name, note }) }),
  updateThread: (id: number, patch: { name?: string; note?: string; archived?: boolean }) =>
    request<ThreadRow>(`/api/threads/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteThread: (id: number) =>
    request<{ ok: boolean }>(`/api/threads/${id}`, { method: 'DELETE' }),
  attachThreadItem: (id: number, kind: ThreadKind, ref: string) =>
    request<{ ok: boolean; attached: boolean }>(`/api/threads/${id}/items`, {
      method: 'POST',
      body: JSON.stringify({ kind, ref }),
    }),
  detachThreadItem: (id: number, kind: ThreadKind, ref: string) =>
    request<{ ok: boolean }>(
      `/api/threads/${id}/items?kind=${kind}&ref=${encodeURIComponent(ref)}`,
      { method: 'DELETE' }
    ),
  /** 还没挂到任何事的条目——允许长期存在，不催 */
  unclassified: (limit = 60) =>
    request<{ items: ThreadCandidate[]; total: number }>(
      `/api/threads/unclassified?limit=${limit}`
    ),
  /** 这个条目该挂到哪件事上（按它自己的标签派生，不用你打字） */
  suggestThreads: (kind: ThreadKind, ref: string) =>
    request<{ label: string; threads: ThreadRow[] }>(
      `/api/threads/suggest?kind=${kind}&ref=${encodeURIComponent(ref)}`
    ),
  /** 就这件事写一份交付——**这一路的模型用量记在这件事头上**（§4-16） */
  deliverIntoThread: (id: number, genre: string, audience: string) =>
    request<{ filename: string; title: string; chunks: number }>(`/api/threads/${id}/deliver`, {
      method: 'POST',
      body: JSON.stringify({ genre, audience }),
    }),

  // ---------- 工作：交付（把材料改写成能交出去的体裁） ----------
  /** 体裁 × 读者的定义（唯一真值在后端） */
  deliverGenres: () => request<DeliverCatalogue>('/api/deliver/genres'),
  /** 把上一次的交付落成 vault/deliver/ 里的一篇 md 并进索引 */
  deliverSave: (payload: {
    title: string
    sections: { heading: string; body: string }[]
    used: number[]
    sources: { n: number; kind: string; title: string; ref: string }[]
  }) =>
    request<{ filename: string; title: string; chunks: number }>('/api/deliver/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // ---------- 对话式教学 ----------
  /** repo 非空 = 代码库陪读：会话取材限定在该仓库；mode = socratic | feynman。
   * origin_point_id 非空 = 从「材料拆出的点」开场，带上就把它标成已教。 */
  tutorStart: (
    topic: string,
    repo?: string,
    mode?: 'socratic' | 'feynman' | 'future',
    origin_point_id?: number,
  ) =>
    request<TutorSessionStart>('/api/tutor/start', {
      method: 'POST',
      body: JSON.stringify({
        topic,
        repo: repo || '',
        mode: mode || 'socratic',
        origin_point_id: origin_point_id || null,
      }),
    }),
  /** 懂了 / 半懂 / 没用 — the only manual input in the product */
  tutorEnd: (session_id: number, verdict: 'got' | 'half' | 'useless') =>
    request<TutorEndResult>('/api/tutor/end', {
      method: 'POST',
      body: JSON.stringify({ session_id, verdict }),
    }),
  tutorSessions: (limit = 50) =>
    request<{ sessions: TutorSessionRow[] }>(`/api/tutor/sessions?limit=${limit}`),
  // 全量卡点：右栏会话列表只取 50 条，第 52 次记的卡点不能跟着消失
  tutorProfile: () =>
    request<TutorProfile>('/api/tutor/profile'),
  tutorStuck: (limit = 200) =>
    request<{ stuck: TutorStuckRow[] }>(`/api/tutor/stuck?limit=${limit}`),
  tutorConcepts: () => request<{ concepts: TutorConceptRow[] }>('/api/tutor/concepts'),
  /** 学习地图：已掌握 / 在学 / 卡住 / 未触及 四档（前三档纯派生，第四档读建议日志）。 */
  tutorMap: () => request<TutorLearningMap>('/api/tutor/map'),
  /** 成长事件：概念「学会了」的时刻（零柒成长面板的原料）。纯派生。 */
  tutorMastery: () => request<TutorMastery>('/api/tutor/mastery'),
  /** 一份材料 → 「要搞懂的点」。逐点去搞懂走 tutorStart（话题就是那个点）。 */
  tutorDigest: (body: { source_path?: string; text?: string }) =>
    request<TutorDigestResult>('/api/tutor/digest', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 手动把一条卡点标成已解 / 待解。主要出口是自动回写（同一概念后来说通了）。 */
  tutorResolveStuck: (session_id: number, resolved = true) =>
    request<{ id: number; resolved: boolean }>(`/api/tutor/stuck/${session_id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolved }),
    }),
  tutorStarters: () => request<{ starters: TutorStarter[] }>('/api/tutor/starters'),
  tutorSession: (id: number) => request<TutorDetail>(`/api/tutor/sessions/${id}`),
  tutorStats: (days = 14) => request<TutorStats>(`/api/tutor/stats?days=${days}`),
}
