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
  created_at: string
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
  message_id: number
  conversation_id: number
  conversation_title: string
  role: string
  excerpt: string
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    request<{ name: string; content: string }>(`/api/skills/content?name=${encodeURIComponent(name)}`),

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
}
