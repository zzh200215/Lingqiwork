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
  trigger_kind: 'cron' | 'watch'
  watch_path: string
  chain_next_id: number | null
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

/** 今日页「今天下一步」建议 (PLAN 第0周). */
export interface TodayNext {
  text: string
  tone: 'bad' | 'normal' | 'idle'
  action: { kind: 'settings' | 'review' | 'make_card' | 'none'; label: string }
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

// ---------- 对话式教学 (PLAN.md 第 6 节) ----------

/** end() 的返回：概念/别名/卡点之外，`material_nearby` 是「材料里还有」，
 * 只在自评总结里出现一次（PLAN.md 第 7 节，第 2 节护栏版——不是队列）。
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

export const api = {
  listProviders: () => request<ProviderConfig[]>('/api/settings/providers'),
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

  /** 生成质量闭环：一次 👍/👎，挂在 (kind, 提示词版本, 模型) 上 */
  qualityFeedback: (payload: {
    kind: 'research' | 'compose' | 'recap' | 'decide'
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

  // ---------- 对话式教学 ----------
  /** repo 非空 = 代码库陪读：会话取材限定在该仓库；mode = socratic | feynman */
  tutorStart: (topic: string, repo?: string, mode?: 'socratic' | 'feynman' | 'future') =>
    request<TutorSessionStart>('/api/tutor/start', {
      method: 'POST',
      body: JSON.stringify({ topic, repo: repo || '', mode: mode || 'socratic' }),
    }),
  /** 懂了 / 半懂 / 没用 — the only manual input in the product (PLAN.md 第 4 节) */
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
  tutorStarters: () => request<{ starters: TutorStarter[] }>('/api/tutor/starters'),
  tutorSession: (id: number) => request<TutorDetail>(`/api/tutor/sessions/${id}`),
  tutorStats: (days = 14) => request<TutorStats>(`/api/tutor/stats?days=${days}`),
}
