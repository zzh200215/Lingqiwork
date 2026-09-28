// API types + fetch helpers

import type { ArtifactRef, CollabStep, QualityNote } from './stream'

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
  /**
   * A3 的两个症状读数（2026-09-22 起**症状驱动**，不再是一个工具数）：
   * 成本看 `chars` / `biggest`（工具定义那一坨每轮都重发），选择看仪表盘那一格
   * （`tool_not_allowed` / `tool_not_used`，A0 报告来的）。`review_hint` 只是"到了就复看
   * 一遍"的提示，**不是及格线**——所以这里没有 `fired` 那种布尔。
   */
  tools?: {
    count: number
    names: string[]
    mcp: number
    chars: number
    biggest: { name: string; chars: number }[]
    review_hint: number
  }
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
  /**
   * A2：**工具白名单**（原来是个布尔开关 `tools_enabled`）。
   * 空 = 不限制；`none` = 一个都不给；其余按 fnmatch（`vault_*`、`kb_search`、`server__*`，
   * 逗号或空格分隔）。语义在后端 `mcp.filter_specs` 一处。
   */
  tool_whitelist: string
  enabled: boolean
}

/** Q4 调度台：一步的状态与它能点的动作。**状态与动作都由后端算**（界面不自己推）。 */
export interface DispatchStep {
  index: number
  task_id: number
  name: string
  /** running / awaiting / ok / error / rejected / idle / blocked / off */
  state: string
  state_label: string
  blocked_by?: number | null
  who: string
  model_id: string
  mode: string
  run_id?: number | null
  error?: string
  grounded?: number | null
  require_approval?: boolean
  next_task_id?: number | null
  /** 这一步能点的按钮（**由后端算**：awaiting 给 approve+reject，其余给 run）。 */
  actions?: { kind: 'run' | 'approve' | 'reject'; task_id?: number; run_id?: number; label: string }[]
}

export interface DispatchChain {
  root_id: number
  name: string
  length: number
  steps: DispatchStep[]
  stuck_at?: DispatchStep | null
  needs_attention: boolean
  enabled: boolean
}

export interface DispatchBoard {
  chains: DispatchChain[]
  counts: { chains: number; steps: number; needs_attention: number; running: number }
  states: Record<string, string>
  broadcast: string
}

export interface Message {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  sources?: unknown
  /** 这一轮落盘的产出回执（`save_artifact` 的副产物）。正文在 vault 文件里，
   *  刷新后就是靠它把「已存入产出」那行重建出来的。 */
  artifacts?: ArtifactRef[] | null
  /** W2a 的两条底线校验结论（从回合账本读，不在界面重算）。 */
  quality?: QualityNote | null
  /** A2 的**逐步账**（只有协作那条路有）：刷新之后靠它把那一栏重建出来。
   *  **照抄后端那份事实**——界面不聚合、不自己算总耗时（那会与后端那笔账分叉）。
   *  `null`/缺省 = 那时候没有这笔账（老行、聊天那条路），**不是空账**。 */
  steps?: CollabStep[] | null
  model_id?: string | null
  feedback?: 'up' | 'down' | null
  created_at: string
}

export interface PromptItem {
  id: number
  title: string
  content: string
  created_at: string
  /** 改过的时间（没改过是空串）——列表按它排「最近动过的」 */
  updated_at: string
  /** 标签。**存的是逗号分隔的一列**，接口上给数组（全角逗号也认） */
  tags: string[]
  category: string
  favorite: boolean
  /** 0 = 还没评；1–5 */
  rating: number
  /** 从哪来的（自己写的 / 一个 URL）——「网上看到的好东西」要记出处 */
  source: string
  note: string
  /** 用过几次。**从使用记录聚合出来的**，不是自己存的一个计数 */
  used_count: number
  version_count: number
  /** 最近一次填过的变量值——复制时预填，下次不必重填 */
  last_vars: Record<string, string>
  /** 最近一次用是什么时候（空串 = 没用过）。「最近使用」按它排，不是按次数。 */
  last_used_at: string
}

/** 一条历史版本：`content` 是**改之前**那一版的样子。 */
export interface PromptVersionItem {
  id: number
  title: string
  content: string
  at: string
  sha: string
}

/** 一次使用记录。`sha` 说这一次用的是**哪一版**正文；`vars` 是那次填进去的值。 */
export interface PromptUsageItem {
  id: number
  at: string
  sha: string
  vars: Record<string, string>
}

/** 四种视图（对齐 AI Gist：卡片 / 网格 / 表格 / 文件夹）。 */
export type PromptView = 'card' | 'grid' | 'table' | 'category'

/** 列表排序。**默认「最近动过的排前面」**——库是拿来用的，不是拿来归档的。 */
export type PromptSort = 'updated' | 'used' | 'rating' | 'title'

export interface PromptFacets {
  /** 分类是**一等对象**（参照 AI Gist）：有名字、有颜色、有计数。 */
  categories: PromptCategoryItem[]
  /** 标签带计数——界面上的「翻译 (1)」是从库里数出来的，不是另养的配置。 */
  tags: PromptTagItem[]
  total: number
  uncategorized: number
}

/** 分类：成员关系在 `prompts.category`（唯一真值），颜色与顺序在这里。 */
export interface PromptCategoryItem {
  id: number
  name: string
  /** `#rrggbb`；空串 = 没挑过色，界面按名字派一个稳定的默认色 */
  color: string
  position: number
  count: number
}

export interface PromptTagItem {
  name: string
  count: number
}

/** AI 三条里「提取变量」的答复：`via` 说这一次是谁提的（模型提不动就退回本地正则）。 */
export interface PromptVarsResult {
  vars: string[]
  via: 'model' | 'local'
}

// ---------- 提示词登记表 + 对照台（Q1）----------

/** 登记表里的一条系统提示词。`sha` 是内容指纹：改了内容它就会变（测试会提醒你）。 */
export interface PromptRegistryEntry {
  name: string
  module: string
  purpose: string
  kind: string
  sha: string
  bytes: number
  /** 模块加载不出来 = 登记漂移（内容缺失） */
  drifted: boolean
  /** golden set 有几条用例；0 = 还没接线，跑不了对照 */
  cases: number
  fixture: string
  /** 领域（Q3 形态）：写在这条提示词的 golden set 里，没标就是 '' */
  domain: string
  /** 已登记内容最近一次跑出的成绩；null = 没有基线 */
  baseline: {
    at: string
    passed: number
    cases: number
    rate: number
    ci_low: number
    ci_high: number
    model_id: string
    /** 基线是用**另一版内容**跑出来的（内容改过了，基线过期） */
    stale: boolean
  } | null
}

export interface PromptInlineNote {
  module: string
  line: number
  purpose: string
}

/** 一条断言 + 它对应提示词的哪句话（`why` 由后端给，界面不抄）。 */
export interface PromptCheckSpec {
  name: string
  why: string
}

export interface PromptCaseSpec {
  id: string
  intent: string
  /** 聊天型：那次真实输入。判分型没有这个字段。 */
  user: string
  /** 聊天型：它必须满足的断言。判分型没有这个字段（判据是人工档位）。 */
  checks: string[]
  // ---- 判分型（P2-1 的重讲判分）只有下面这几样：卡三样 + 重讲原文 + 人工档位 ----
  front?: string
  back?: string
  excerpt?: string
  retell?: string
  /** 人工档位：4 简单 / 3 良好 / 2 困难 / 1 重来 / 0 = 人工也认为该「不判」 */
  grade?: number
  /** 这条的档位有争议（两处口径撞车）——摆在报告里但不计分 */
  contested?: boolean
  why?: string
}

export interface PromptRegistryEntryDetail {
  name: string
  module: string
  purpose: string
  kind: string
  sha: string
  content: string
  fixture: string
  note: string
  /** 领域（Q3 形态）：'教学' 这种短词，空 = 还没归类 */
  domain: string
  /** 用例是哪种形状：`chat` = 输入 + 断言；`grade` = 卡三样 + 人工档位 */
  case_kind: 'chat' | 'grade'
  cases: PromptCaseSpec[]
  checks: PromptCheckSpec[]
  runs: PromptCheckRun[]
}

export interface PromptCheckRun {
  id: number
  at: string
  key: string
  prompt_sha: string
  variant_sha: string
  variant_label: string
  model_id: string
  cases: number
  passed: number
  rate: number
  ci_low: number
  ci_high: number
  seconds: number
  detail_json: string
}

/** 一次对照的结果。**带 Wilson 区间**——裸比例会让人把噪声当结论。 */
export interface PromptCheckReport {
  key: string
  module: string
  purpose: string
  kind: string
  /** 判分型（P2-1）才有：判据是人工档位，不是断言。界面据此换一套说法。 */
  report_kind?: 'grade'
  prompt_sha: string
  /** 空 = 跑的是已登记内容（基线/回归）；非空 = 这是一段候选变体 */
  variant_sha: string
  variant_label: string
  model_id: string
  total: number
  passed: number
  /** **`null` = 这一趟被停了**（半趟的 k/n 会被读成「变差了」，所以不给比率）。 */
  rate: number | null
  /** Wilson 区间 [lo, hi]。`null` 同上——区间是给一个**完整**样本算的。 */
  ci: [number, number] | null
  /** 这个 n 下区间的宽度够不够下结论 */
  tell: boolean
  /** `true` = 这一趟是被「停止」打断的：没落库、没区间，`total` 是跑完的条数 */
  stopped?: boolean
  /** 计划跑多少条（`stopped` 时用来写「停在第 2/7 条」） */
  planned?: number
  assertions: { total: number; failed: number }
  seconds: number
  calls: number
  baseline: { at: string; passed: number; total: number; variant_label: string } | null
  /** 与基线比，哪几条用例翻面了 */
  flips: { id: string; was: boolean; now: boolean }[]
  context: string
  run_id?: number
  /** ---- 判分型专有（P2-1）：有序档位上的第二个数与它的偏 ---- */
  near?: number
  near_rate?: number
  near_ci?: [number, number]
  /** 它说「判不了」的条数（正当结论，但不算判对） */
  fallback?: number
  /** 高判 / 低判：提示词承诺「宁可低判不高判」，这一对就是那句话的尺子 */
  over?: number
  under?: number
  /** 4×4 混淆矩阵：`matrix[人工档][判分档] = 条数` */
  matrix?: Record<string, Record<string, number>>
  /** 有争议、不计分的那些条 */
  contested?: { id: string; expect: number; got: number; why: string }[]
  expect_source?: string
  cases: {
    id: string
    intent: string
    user: string
    checks: string[]
    passed: boolean
    failed: { name: string; why: string }[]
    reply: string
    chars: number
    seconds: number
    error: string
    /** ---- 判分型专有 ---- */
    expect?: number
    got?: number
    label?: string
    near?: boolean
    fallback?: boolean
    over?: boolean
    under?: boolean
    contested?: boolean
    why?: string
    missed_points?: string[]
  }[]
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
    /** **按任务分解**（方案 §8.3：工作流清单每行要自己的 30 天成功率）。
     *  键是 `task_id` 的字符串形式；**30 天内没跑过的任务不出现**——别摆一个 0%，
     *  那会把「没跑过」说成「全挂了」。 */
    by_task?: Record<string, { runs: number; ok: number; rate: number | null }>
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
  /** 最近 7 天里**真的打开过应用**的天数（`usage_visits` 的真相源）。
   *  后端一直在返回它，只是这个类型漏了（2026-09-18 补）。 */
  open_days_7d: number
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
  /** '' = 还没回看。**回看仍然是拉取式的**：这里没有任何催办。
   *  唯一的例外是 M4 的见证（`decisionWitness`）——到点之后气泡会提**一句**，
   *  见 `witness_days` 与后端 `core/decision_log.py` 开篇那段「让开一步」。 */
  outcome: DecisionOutcome
  note: string
  /** 多久之后值得回头看一眼（天，默认 90）。M4 起它到点会被气泡提一句——见 `DecisionWitness` */
  witness_days?: number
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
  /** 这一步做什么：prompt = 跑提示词；transcribe = 本地 ASR 转写录音；
   *  其余 = 把一个成文引擎按表跑一遍（见 ENGINES），产出落进引擎自己的 vault 目录 */
  action: 'prompt' | 'transcribe' | 'research' | 'compose' | 'recap' | 'decide' | 'conflict'
  /** 产物落哪个 vault 子目录（空 = tasks/）。沿链条继承，所以一条流水线的各步同目录。 */
  landing_dir: string
  /** 这条流程处理的是哪件「事」（M2）；null = 没挂（普通定时任务就是这样）。
   *  起链时按题目写进来，下游继承——所以三步看到的是同一个 id。 */
  thread_id?: number | null
  /** 停在人工卡点上的那次运行；null/缺省 = 没有待审的。放行/驳回用它。 */
  awaiting_run_id?: number | null
  conversation_id: number | null
  last_run: string | null
  last_status: string
  last_result: string
  next_run: string | null
  running?: boolean
  /** 步级超时（秒）：一次执行最多等多久。null/缺省 = 引擎默认（900）。 */
  timeout_seconds?: number | null
  /** 接地分门禁（0-5）：低于它停在卡点等人，不自动流向下游。null/缺省 = 只记分。 */
  gate_min_grounded?: number | null
}

export interface SkillItem {
  name: string
  description: string
  model?: string
  tools?: string
  files: string[]
  chars: number
}

/** 一份材料读出来的**能力候选**（环一）。`usable=false` 时只有 `reason` 有意义。 */
export interface SkillCandidateResult {
  ok: boolean
  usable: boolean
  name: string
  description: string
  instructions: string
  /** 一句话：为什么能 / 不能出能力（`ok=false` 时是没读成的原因） */
  reason: string
  /** **这次压根没问成**（网络/后端失败），不是「问过了，判定为不行」。
   *
   *  界面按 `usable` 分派文案，而失败态下它也是 false —— 没有这个标记，
   *  一次请求失败会被讲成「这份材料没出能力」，那是把两件事说成一件。
   *  只有前端造的失败结果会带它；后端正常返回时不带。 */
  failed?: boolean
  /** 材料里明显重叠的已知技能（只用来提醒「这个可能已经有了」） */
  existing: string[]
  source: string
  model_id: string
  strategy?: string
  written: boolean
  /** 同名时停下：已有那份的名字（**不覆盖**，覆盖要显式再点一次） */
  already: string
  /** 草稿落在哪（`written=true` 时才有） */
  path?: string
  chars?: number
  /** 落盘 ≠ 登记：没跑过对照、没有基线，所以永远是 false */
  registered?: boolean
  /** S2：这次是按哪几次运行判断的（「处理一项工作」三步就是三个 id） */
  runs?: number[]
  /** S2：这段工作的题目（那件「事」的名字，没有就退回任务指令） */
  topic?: string
  run_id?: number
}

export interface SkillCandidateRow {
  name: string
  description: string
  files: number
  chars: number
  /** 这一版内容跑出过成绩没有（sha 对得上才算） */
  registered: boolean
  /** 用例条数（尺子） */
  cases: number
  /** 有旧成绩、但内容改过了：那张分数不是现在这版的 */
  stale: boolean
  /** S3：**这份草稿在真实工作里被用过几次**（派生自运行日志里那条 `skill_inject`，
   *  不是第二份真值）。窗口由 `listCandidates` 那层的 `trial_window` 给——界面要说
   *  「最近 N 次运行内被用过」，**不许说「共 N 次」**：老运行会被删掉，这个数会缩水。 */
  trials: { n: number; last_at: string | null; last_ts: number | null }
  baseline: {
    at: string
    model_id: string
    cases: number
    with_passed: number
    rate: number
    ci_low: number
    ci_high: number
    /** 有它比没它多过了几条 / 少过了几条 —— 「有没有用」的直接答案 */
    helped: number
    hurt: number
    /** 「跟着工序做」的判分均值 0-5；null = 没判（不是 0 分） */
    follows_method: number | null
    seconds: number
  } | null
}

/** 一份技能的用例（尺子）+ 断言清单。**默认用哪条断言由后端给**，前端不抄一份。 */
export interface SkillCasesPayload {
  skill: string
  cases: { id: string; intent: string; ask: string; checks: string[] }[]
  model_id: string
  checks: { name: string; why: string }[]
  default_checks: string[]
  file: string
}

/** S3：一次**试用**——某次真实运行吃了这份草稿（派生自运行日志，零新表）。 */
export interface SkillTrial {
  run_id: number
  task_id: number
  task_name: string
  /** 那次的题目：有那件「事」就用它的名字，否则任务指令。它是「把这次当用例」预填的 `ask` */
  topic: string
  status: string
  started_at: string | null
  /** epoch 秒：界面用 `ago()` 说「几天前」要按真实时刻算（naive ISO 被当本地时间会错几小时） */
  at_ts: number | null
  /** 接地分 0-5；null = 没打分（没材料 / 判分没跑成），不是 0 分 */
  grounded: number | null
  /** 这次运行吃到的全部技能（一次最多两份） */
  skills: string[]
  /** 那次产出的预览（给人判「这次试用算不算数」用，正文在运行详情里） */
  answer: string
}

/** 一份草稿的试用记录。**`window` 必须显示出来**：数是窗口内的、会缩水。 */
export interface SkillTrials {
  skill: string
  window: number
  n: number
  last_at: string | null
  last_ts: number | null
  trials: SkillTrial[]
}

/** 一次技能跑分的报告。**`tell=false` 时不许下结论**（区间太宽 / 用例太少）。 */
export interface SkillEvalReport {
  skill: string
  sha: string
  model_id: string
  cases: {
    id: string
    intent: string
    ask: string
    without_ok: boolean
    with_ok: boolean
    delta: number
    follows_method: number | null
    judge_why: string
    with_reply: string
    without_reply: string
    error_with: string
    error_without: string
  }[]
  total: number
  with_passed: number
  /** **`null` = 这一趟被停了**（理由同 `PromptCheckReport.rate`） */
  rate: number | null
  ci: [number, number] | null
  /** `true` = 被「停止」打断：没写基线、没区间 */
  stopped?: boolean
  planned?: number
  tell: boolean
  deltas: { helped: number; hurt: number; same: number }
  follows_method: number | null
  seconds: number
  /** 这次跑分花了几次模型调用（用例数 × 2 + 判分） */
  calls: number
  cases_needed: number
  run_id?: number
}

export interface TaskTool {
  name: string
  description: string
}

/** 运行日志的一项。**两种形状同一个数组**（顺序就是发生的顺序，而步骤条要的正是顺序）：
 *  - 工具调用：`{tool, args, ok, result, ms}`；
 *  - 一步工序：`{step, ok, ms, note?, ref?}`（引擎跑的那几步，**没有 `tool` 键**）。
 *
 *  为什么不分两个数组：两边都没有时间戳，插不回正确的位置。读的人按 `tool` / `step`
 *  各自过滤，互不干扰（`skill_inject` 那项是注入痕迹，不是一步工序）。 */
export interface TaskRunLogEntry {
  tool?: string
  args?: Record<string, unknown>
  ok?: boolean
  result?: string
  /** 一步工序的名字（引擎相位：取材 / 成文 / 落盘） */
  step?: string
  /** 这一步花了多久（毫秒）。工具调用与引擎相位都有。 */
  ms?: number
  /** 一句话说明：找到几条材料、写了几节、为什么失败 */
  note?: string
  /** 这一步落了什么（vault 相对路径） */
  ref?: string
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
  /** 这趟运行在处理哪件「事」（M2）。S2 的「读成技能」按它把三步合成一次输入。 */
  thread_id: number | null
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
  /** 这次运行在处理的哪件「事」（M2）；null = 没挂（普通定时任务就是这样） */
  thread_id: number | null
  /** 起链时按题目落的那件「事」——`created=false` 表示复用了同名的 */
  thread?: ThreadRow & { created: boolean }
}

export interface EvalItem {
  id: number
  question: string
  expected_source: string
  note: string
  /** 领域（Q3 形态）：分组用的标签，'' = 还没归类 */
  domain: string
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
  /** 合作式取消后提前收工（跳过的用例不计入指标）。未取消时是 false/缺省 */
  stopped?: boolean
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

/** M1（PLAN §3 G1）：重讲判分的结果。
 *
 *  `ok=false` 时**什么都没写**——判分没跑成 ≠ 差评，界面据此退回 1–4 自评；
 *  那时把重讲原文带在自评那次请求上（`reviewCard(..., retell)`），
 *  「这一天你确实重讲了」就不会因为模型没跑成而丢掉（北星指标读的就是它）。 */
export interface CardRetellResult {
  ok: boolean
  /** 1 重来 | 2 困难 | 3 良好 | 4 简单；`ok=false` 时是 0 */
  grade: number
  label: string
  missed_points?: string[]
  hint?: string
  reason?: string
  model_id?: string
  /** 判分已落账时，回带那张卡的新状态（含 `requeue`）——界面照它往下走，不再写第二次 */
  card: CardReviewResult | null
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
  /** 这一次调用吃进去/吐出来的 token。**`null` = 上游没报**（有的 provider 不回用量），
   *  界面上那一格就不摆——`0` 与「没报」是两件事。 */
  tokens_in?: number | null
  tokens_out?: number | null
}

/** 功能真实用量（CTO review #6）：model_usage 按操作名聚合成的一行。 */
export interface UsageFeatureRow {
  /** 操作名（usage_ledger 的 span 标签，如 briefing / deliver / pet）。 */
  kind: string
  /** 发生次数（span 数）。 */
  spans: number
  /** 模型调用次数。 */
  calls: number
  /** tokens_in + tokens_out 合计。 */
  tokens: number
  first: string
  last: string
}

/** 今日页「今天下一步」建议. */
export interface TodayNext {
  text: string
  tone: 'bad' | 'idle'
  /** thread = 「最近动过的那件事」——点进去是接着看，**不是待办** */
  action: { kind: 'settings' | 'thread' | 'none'; label: string; thread_id?: number }
}

/** 今日概览的一行：一个计数 + 一个直达落点。空档后端直接省略，不返回 0。
 *  与 TodayNext 分开——那条是一句会主动开口的建议；这里只是「有几件、去哪」。 */
export interface TodaySummaryRow {
  key: 'tasks_failing' | 'untouched' | 'due_cards' | 'awaiting' | 'inflight'
  label: string
  count: number
  href: string
  tone: 'bad' | 'warn' | 'info'
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
  /** 正文字数（后端 `_chars_of`：剥 front-matter 后的非空白字符）。
   *  `undefined` = 旧响应没带——界面就不摆这一格，不摆 0。 */
  chars?: number
}

/** 交付（工作侧成文）：一种体裁或一种读者。定义在后端 `core/deliver.py`，前端不硬编码。 */
export interface DeliverOption {
  id: string
  label: string
}

/** 体裁：比读者多一个「长稿」判据——它决定界面走哪一模（先出提纲 / 一键直出）。
 *  **判据在后端**：哪个体裁算长稿是体裁的属性，不是界面的属性。 */
export interface DeliverGenre extends DeliverOption {
  long: boolean
  /** 你自己写的模板（能编辑/删除）。内置那五条是代码，改不了。 */
  custom: boolean
}

/** 自定义体裁模板（§8.1 行2）：**带结构指令**——编辑要用。
 *  `/deliver/genres` 那份列表不带 `prompt`（chips 用不上），这一份才带。 */
export interface DeliverTemplate {
  id: string
  label: string
  prompt: string
  long: boolean
}

export interface DeliverCatalogue {
  genres: DeliverGenre[]
  audiences: DeliverOption[]
  default_genre: string
  default_audience: string
}

/** 提纲（§8.1 长稿那一模）：**只有小节名，没有正文**——正文等提纲定下来再写。 */
export interface DeliverOutline {
  title: string
  sections: string[]
  model_id?: string
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
/** 「一件事」上能挂什么。`session` 是**一场教学会话**（R3 从 `tutor` 改的名）——
 *  这一列说的是「挂的是什么东西」（其余六个都是东西），不是一个功能名。 */
export type ThreadKind = 'material' | 'note' | 'card' | 'session' | 'output' | 'task' | 'decision'

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
  /** 挂上来的时刻。详情的时间线按它倒序（方案 §8.4）。 */
  created_at: string | null
}

export interface ThreadRow {
  id: number
  name: string
  note: string
  archived: boolean
  /** 状态机（方案 §8.4）：`open` 进行中 / `done` 完成。**你设的，所以它存着**。 */
  status: 'open' | 'done'
  /** 「N 天没动静」——**算出来的，不是存的**。`done` 时恒为 false
   *  （完成了的事没动静是因为结束了，不是因为停了）。 */
  stalled: boolean
  /** 距上次动静几天（后端算好给的，界面不自己减日期——时区在那一处管）。 */
  idle_days: number
  /** 截止日 `YYYY-MM-DD`；null = 没设。**不编一个默认期限出来**。 */
  deadline: string | null
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

export { request } from './api/request'

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
  /** 领域（Q3 形态）：和概念一起提取的分组词，'' = 没归到某个领域 */
  domain: string
  aliases: string
  stuck: string
  transfer: string
  material_nearby: { source: string; title: string; score: number }[]
  /** 这次把新叫法并进了哪个已有概念（没有就是 null）。
   *
   *  「它自己换了个名字」如果界面上不说，就是一件用户看不见也查不到的事 —— 说出
   *  来 + 凭什么（`why`）才算诚实。 */
  merged: { from: string; into: string; why: string; score: number } | null
}

/** 「我来讲 · 让它判」的返回。`judged=false` = 判分没跑成（没有模型 / 输出读不出来），
 *  `ended` 为 null 且**会话一个字都没动**——退回自评是设计好的降级，不是错误。 */
export interface TutorJudgeResult {
  judged: boolean
  reason?: string
  verdict?: 'got' | 'half' | 'useless'
  missed_points?: string[]
  model_id?: string
  ended: TutorEndResult | null
}

/** 面试陪练的题库（M3 · PLAN §3 G3）。**只读**：`vault/面试准备.md` +
 *  半懂 / 又卡住的概念 + 到期卡；每条标出它是哪儿来的。 */
export interface InterviewBank {
  file: string
  questions: string[]
  concepts: { concept: string; recurring: boolean; stuck: string }[]
  cards: string[]
  count: number
}

/** 复盘报告的四个格子。**报告不算「成品」**：落 `vault/reports/`，不进产出清单、
 *  不上小屋架子、也没有零柒那句「交出去了」——它是给你自己看的。 */
export interface InterviewReportSections {
  summary: string
  solid: string[]
  stuck: string[]
  teach_next: string[]
}

export interface InterviewReportResult {
  ok: boolean
  reason?: string
  path?: string
  asked?: number
  model_id?: string
  chars?: number
  sections?: InterviewReportSections
}

export interface TutorSessionStart {
  id: number
  topic: string
  repo: string
  mode: 'socratic' | 'feynman' | 'future' | 'interview'
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
  /** 卡片轨的现状（PLAN2 T1 场景 B）：`{n, mature, again_7d}`。
   *  **只在这一点名下真的有卡时才在**——没有卡的概念连这个键都没有（「只摆非零」），
   *  所以界面上是 `c.cards_summary ? ... : null`，不是拿零去凑一行。 */
  cards_summary?: CardsSummary
}

/** 一个概念名下的卡：几张 / 几张成熟 / 近 7 天重来几次。 */
export interface CardsSummary {
  n: number
  mature: number
  again_7d: number
  /** 这些数字是按哪几个话题词算出来的（`Card.topic` 原样）——地图那一行点过去时，
   *  复习页照它精确筛，别名那种情况才不会少几张。 */
  topics: string[]
}

/** 一张卡与它对应概念的对照事实（PLAN2 T1）。**只陈述两边的事实，不判谁对**。
 *  `concept` 为空 = 这张卡的话题词没关联上任何概念——那是常态，不是错误。 */
export interface CardCrosscheck {
  card_id: number
  concept: string
  /** 那个概念在概念轨上算不算「已掌握」（判据只有一个：说通 ×2）。 */
  mastered: boolean
  /** 你在它面前**说通过几次**（不是说通过的场次数，见后端注释）。 */
  said_n: number
  /** 同 topic 的卡近 7 天判「重来」的次数。 */
  again_7d: number
  /** 两边都成立才算：已掌握 × 重来 ≥2。 */
  contradiction: boolean
}

/** 一张卡「可能缺的前置」（PLAN2 T3）。**建议不是结论**；`candidates` 空 = 找不到，不硬凑。 */
export interface CardPrereq {
  card_id: number
  topic: string
  concept: string
  suspended: boolean
  lapses: number
  candidates: { concept: string; status: string }[]
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

/** 一个概念的「邻居」：同一件事 / 同一份材料 / 语义相近。纯派生。 */
export interface TutorNeighbor {
  concept: string
  /** 空 = 只是语义相近；否则是结构性证据（「同一件事 · 同一份材料」） */
  why: string
  score: number
}

/** A row in the history rail. `turn_count` is a number here; `TutorDetail.turns`
 * is the message list — two names because one key with two types gets misread. */
export interface TutorSessionRow {
  id: number
  topic: string
  concept: string
  /** 领域（Q3 形态）：这场会话归一到的短词，'' = 没归到某个领域 */
  domain: string
  verdict: '' | 'got' | 'half' | 'useless'
  stuck: string
  recalled: boolean
  /** socratic：老师问你答；feynman：反转，你讲它追问；future：和一年后的自己聊；
   *  interview：面试陪练（只问不教，散场出复盘报告） */
  mode: 'socratic' | 'feynman' | 'future' | 'interview'
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
  /** S1（PLAN3 §9.2 决策4）：同一份成绩里「有注入 / 没注入 / 不知道」各是多少。
   *
   *  注入**不改变** `prompt_sha`（它是模块级常量的指纹），所以不加这一维，两种工序的
   *  👍/👎 会混成一份；而 key 一个没动——原来那几个数还是原来那几个数。
   *  `unknown`（`""`）与 `plain`（`"[]"`）是**两件事**：从产出清单**事后**点的评价
   *  那时手上没有注入信息，它落在「不知道」，不许记成「没注入」。 */
  split: Record<InjectState, { good: number; bad: number }>
}

/** 注入那一维的三态。 */
export type InjectState = 'injected' | 'plain' | 'unknown'

/** 一次聊天回合的记录（W5）：为什么慢、为什么贵、为什么没落盘。
 *
 *  **诊断账本，不是考核仪表**：不设目标、不催、不做排行榜（沿用 `quality.py` 的红线）。
 *  `tool_calls` 只有名称/大小/毫秒/成功与否 —— 正文该在 vault 里，账本不抄一份。
 *  `flags` 由后端判定（`core/turn_trace.py` 的 `_matches`），界面只负责显示：
 *  同一个判断的第二份实现，分叉的那天这个数就没人敢信了。 */
export interface TurnTrace {
  id: number
  at: string
  conversation_id: number | null
  message_id: number | null
  model_id: string
  prompt_sha: string
  /** 确定性路由（W3）：还没接路由时是 '' */
  route_level: string
  route_kind: string
  /** W2a/W4 的校验结论：那些数**由后端算**，界面只显示（`quality`） */
  quality?: QualityNote & {
    route?: { delivery?: boolean; kind?: string; level?: string; confidence?: number; reason?: string }
    length?: { budget?: number | null; chars?: number; over?: boolean; saves?: number }
  }
  rounds: number
  tool_calls: { name: string; args_chars: number; result_chars: number; ms: number; ok: boolean }[]
  tokens_in: number
  tokens_out: number
  artifacts: { kind?: string; path?: string; title?: string }[]
  /** 回复正文的长度。**只有数字**：正文自己活在 messages 里 */
  answer_chars: number
  claim_checked: boolean
  claim_truthful: boolean
  retried: number
  /** P3：这一轮注入了几条材料、模型真引用了几条。**没有「使用率」这个字段** ——
   *  比率在聚合那一处算，逐条读的时候要的是两个原始计数（没检索的回合注入就是 0，
   *  拿它当分母是错的）。 */
  sources_injected: number
  sources_cited: number
  seconds: number
  error: string
  /** 这一轮命中的毛病（就是筛选项那几个 key），由后端算 */
  flags: string[]
}

export interface TurnFilter {
  key: string
  label: string
  hint: string
}

export interface QualitySummary {  days: number
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

/** 回合读数（R1 · PLAN5 §3）：窗口内跑过几个聊天回合、每一类毛病各几例。
 *
 *  **没有成功率 / 比率这一项**，而且不该有：`turn_trace` 是诊断工具不是考核仪表。
 *  `turns` 是**说出来的分母**（让计数有参照），`total` 是窗口里真实跑了多少轮；
 *  两者不同时 `truncated=true`（库很大时只数了最近 N 轮），界面要照实说。 */
export interface TurnSummary {
  readable: boolean
  error: string
  days: number
  /** 实际数进计数的回合数（可能被 `truncated` 截住） */
  turns: number
  /** 窗口里真实落过账的回合数 */
  total: number
  truncated: boolean
  /** 每一类毛病的回合数，键就是 `filters` 里的 key */
  counts: Record<string, number>
  /** P3：材料用掉了几条。**两个计数 + 一个有材料却没引用的回合数，没有比率** ——
   *  分母是 `turns_with_material`（注入过材料的回合），不是 `turns`：没检索的回合
   *  （闲聊跳过 / RAG 关）注入本来就是 0，算进来就是把「没检索」读成「检索了没人用」。 */
  sources: {
    /** 窗口内**注入过材料**的回合数（这一块自己的分母） */
    turns_with_material: number
    /** 这些回合一共注入了几条材料 */
    injected: number
    /** 这些回合的正文真引用到了几条 */
    cited: number
    /** 其中有几轮**一条都没引用**——检索质量下滑最早的那个信号 */
    uncited_turns: number
  }
  filters: TurnFilter[]
  rules: { window: string; counts: string; no_rate: string; sources: string; truncated: string }
}

/** 提示词评测（R1 补齐 · PLAN5 §2-2 点名的九条之一）：登记了多少条、量过几条、几条站得住。
 *
 *  **它量的是「尺子有没有被量过」，不是「哪条提示词更好」**：所以载荷里**没有任何一条
 *  提示词的名字或分数**，界面也不许自己再算一份（那是第二份判据）。读不到时
 *  `readable=false`——「一条都没读到」与「读到了、一条都没跑过」是两件事。 */
export interface PromptEvalBoard {
  readable: boolean
  error: string
  /** 登记表里的提示词条数（分母） */
  registered: number
  /** 其中跑过 golden set、有成绩的条数（分子） */
  measured: number
  /** 其中 Wilson 区间够窄、下得了结论的条数 */
  decidable: number
  /** 其中基线跑完之后内容又改过（那个分数不是这一版的） */
  stale: number
  /** 有成绩的那些一共跑过多少条用例 */
  cases: number
  rules: { registered: string; measured: string; decidable: string; stale: string }
  /** 已知偏差：基线是某一个模型跑出来的，换模型不适用 */
  bias: string
}

/** A0 任务级基线（跑分落下来的报告，只读投影）——计量局那一格。 */
export interface AgentEvalBoard {
  readable: boolean
  error?: string
  /** 报告落在哪（人看得出来它读的是哪一份） */
  path?: string
  /** 什么时候跑的、跑的是哪一版金标（`tasks_sha`）——**这一格读的是当时的成绩** */
  at?: string
  tasks_sha?: string
  prompt_sha?: string
  model_id?: string
  seconds?: number
  tasks?: number
  done?: number
  done_rate?: number
  clean?: number
  clean_rate?: number
  /** 谎报 / 编造路径 / 伪引用那三条（长文没落盘单列，不算底线） */
  floor_failures?: number
  tool_not_allowed?: number
  tool_not_used?: number
  over_budget?: number
  errors?: number
  trace_missing?: number
  rounds?: { median: number; p90: number; max: number; mean: number }
  counts?: Record<string, number>
  by_tag?: Record<string, { tasks: number; done: number }>
  /** A1/A2 的委托读数：几个回合委托了、几次、子代理共几轮、以及「该委托而没委托」 */
  delegated_turns?: number
  delegate_calls?: number
  delegate_rounds?: number
  delegate_expected?: number
  delegate_missed?: number
  /** 报告里没有金标指纹 → 这一格比不了（`--compare` 会报「不可比」） */
  sha_missing?: boolean
  /** 口径原文（后端来，逐行照抄——界面不自己编） */
  rules?: Record<string, string>
}

/** 零柒说过的一句话（`pet_events` 的一行）。挂件的气泡与今天页的「最近说的」共用它。 */
export interface PetEvent {
  id: number
  kind: string
  text: string
  detail: string
  created_at: string
}

/** 语音备忘的一条（那一问的候选）。 */export interface VoiceNoteItem {
  /** vault 相对路径（`voice/YYYY-MM-DD-HHMM.md`）——挂事与拆点都用它当引用 */
  path: string
  name: string
  title: string
  chars: number
  mtime: number
}

/** 那一问（R2 · PLAN5 §3）：哪几份语音备忘还没回答「这是材料还是工作留痕」。
 *
 *  **拉取式**：只在打开它的时候回答，不催、不计数、不进零柒的提醒来源。
 *  `readable=false` 是「读不到」——**不是**「都归类完了」（§4-8）。 */
export interface VoicePending {
  readable: boolean
  error: string
  /** 还没回答的那几份（回答了就从这里下去） */
  open: VoiceNoteItem[]
  counts: { total: number; material: number; thread: number; open: number }
  rules: { pull: string; material: string; thread: string; state: string }
}

// ---------- 零柒：成长 + 能力插件（Track B） ----------

/** 成长的一个来源（「把东西搞懂」等）。全部是累计量，所以只增不减。 */
export interface PetGrowthPart {
  key: 'learning' | 'teach' | 'work' | 'habits' | 'review'
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
  /** 称号旁那一行**风味小注**（Z4）：按喂养分布说一句事实（「这阵子喂它最多的是…」）。
   *  **空串 = 数不出来或开关关着**，界面上那一行干脆不出现（不猜、不硬凑）。 */
  flavor: string
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

/** 零柒**此刻**的状态（P1 · 维度一）：摆什么姿势、说什么话、还剩多少精神。
 *
 *  与 `PetGrowth` 刻意分开：成长是**累计**（只增不减），状态是**当下**——
 *  跨天自然归零、不记账、没有「还欠 N」。精力说的是「我有点蔫」，
 *  不是「你欠了 3 小时专注」。 */
export type PetStateMode =
  | 'idle'
  | 'focusing'
  | 'working'
  | 'learning'
  | 'reviewing'
  | 'celebrating'
  | 'gated'
  | 'busy'
  | 'idling'
  | 'pupil'
  | 'resting'
  | 'tired'
  | 'sleepy'
  /** P2：连着几个晚上熬到很晚 → 蔫。与 `tired` 同一个姿势，靠台词区分 */
  | 'night_owl'
  /** P5：好几天没见 → 久别重逢。挥手的姿势，台词里带着「走的时候在拆什么」 */
  | 'returning'

export interface PetState {
  mode: PetStateMode
  /** 直接对应 `frontend/public/pet/<action>.webp` 那九个动画 */
  action: string
  /** 0–100，此刻的精神。不是要还的债。 */
  energy: number
  /** 零柒此刻的一句话；`idle` 时是空串（安静是默认） */
  line: string
  path: string
  /** 此刻在跑的是什么（引擎的中文名，如「复盘」）；没有名字的运行是空串。 */
  busy_with?: string
  /** 停在人工卡点上等你点头的件数。**只报事实**，界面别写成「你还欠 N 件」。 */
  gated?: number
}

/** 跟零柒的一轮问答（P5 落库后的回放）。`tools` 是那一轮它真的做了什么——
 *  形状与 `petChat.PetToolReceipt` 一致，回放时面板照样摆得出那排小 chip。 */
export interface PetChatMsg {
  id: number
  created_at: string
  role: 'user' | 'pet'
  text: string
  tools?: { tool: string; plugin: string; command: string; panel: Record<string, unknown>; said: string | null }[]
}

/** 小屋里的一件东西（P4）：某个真实累计量跨过一个门槛的结果。
 *
 *  **日期是跨过门槛的那一刻**（第 5 份成品落盘的时间），不是「最近一次」——
 *  所以它稳定：明天再多交两份，这件东西还是那天到手的。
 *
 *  时间给两个字段是刻意的（后端注释里有完整来由）：`at` 是本地墙钟串给人看，
 *  `at_ts` 是 epoch 用来排序和算「多久以前」——前端因此不必猜时区。 */
export interface PetThing {
  id: string
  /** `badge` 第一次那枚 / `prop` 屋里的一件摆设 / `output` **刚叼回来的那份成品** */
  kind: 'badge' | 'prop' | 'output'
  module: string
  module_label: string
  icon: string
  label: string
  /** 一句事实：「第 5 份成品」 */
  detail: string
  at: string
  at_ts: number
  count: number
  /** 这件东西对应架上哪一份成品（**只有 `kind='output'` 时有**）。
   *  小屋据此在架上那一行标出「它刚叼回来的」——不自己再算一遍谁最新。 */
  ref?: string
}

/** 今天喂了它什么：**每条线今天的真实成果**，一条一件。 */
export interface PetMeal {
  key: string
  module: string
  module_label: string
  icon: string
  label: string
  count: number
}

/** 屋里的一张**概念卡**（P2 · F13）：学习地图在小屋里的镜子。
 *
 *  与技能卡、枝都不同：它照的是**此刻在哪一档**（已掌握 / 在学 / 卡住），所以同一个
 *  概念的卡会变色——它不是到手了就永远不变的东西。`state` 就是地图那一档，
 *  屋里**不重判**（「一场是运气、两场才算」只有 `tutor.is_mastered` 一份）。
 *
 *  「未触及」不在这份契约里：那是「拆出来还没开成教」的点，一张「还没做的事」的
 *  清单，小屋不摆账（后端连读都不读它）。词与色在 `conceptState.ts` 一处。 */
export interface PetConceptCard {
  id: string
  name: string
  /** mastered | learning | stuck（认不出来的档照实显示档位名，不猜颜色） */
  state: string
  /** 这个概念的会话数（自评 got / half 的那些） */
  sessions: number
  /** 卡在哪——**只有 stuck 那一档有**，别的档一律空串 */
  stuck: string
  at: string
  at_ts: number
}

export interface PetConceptCards {
  /** 最近碰到的那些（最多 12 张），新 → 旧 */
  cards: PetConceptCard[]
  /** 镜子照到的全量，**不含「未触及」**。比 `cards` 多时界面要说「共 N 个」 */
  total: number
}

/** 屋里的**技能卡**（Q2）：跑过对照的提示词才算技能。
 *
 *  「技能只有一个到手方式：它被证明有效过」——没有基线的提示词不是技能，是一段还没验过的
 *  文本，宠物不展示它。`stale` 是诚实的一部分：基线跑完之后内容又改过，卡上的分数就不是
 *  这一版的了。 */
export interface PetSkillCard {
  name: string
  module: string
  purpose: string
  kind: string
  sha: string
  /** 领域（Q3 形态）：卡片按它进对应那根枝；'' = 这套用例还没归类 */
  domain: string
  passed: number
  cases: number
  rate: number
  ci_low: number
  ci_high: number
  at: string
  model_id: string
  stale: boolean
}

/** 形态（Q3）：一个领域的三个数。三样都够 → `grown`。
 *
 *  **只由可验证的能力算**：检索质量、已掌握的概念数、技能卡的通过率。**不是**上传量——
 *  这个仓库不微调，堆文件只改变检索覆盖，堆出来的形态是纯装饰。
 *
 *  `enough === false` 的那一样只说「样本不足」，界面上**不许写成「还差 N」**：那正是
 *  这个项目一直在躲的欠账口吻。 */
export interface FormRetrieval {
  enough: boolean
  /** 这次真的算进去的题数（最近一次覆盖够的评测里，这个领域的那几条） */
  cases: number
  /** 这个领域一共标了多少条源（`cases` 可能更少：评测是过去跑的） */
  labelled: number
  hits: number
  hit_rate: number | null
  ci_low: number | null
  ci_high: number | null
  faithfulness: number | null
  /** 忠实度是判过几条算出来的——只判了 1 条时，那个平均不是「平均水平」 */
  judged: number
  run_id: number | null
  at: string | null
  note: string
}

export interface FormConcepts {
  enough: boolean
  mastered: number
  seen: number
  names: string[]
  at: string
}

export interface FormSkill {
  name: string
  purpose: string
  passed: number
  cases: number
  rate: number
  ci_low: number
  ci_high: number
  at: string
  stale: boolean
  enough: boolean
}

export interface FormDomain {
  domain: string
  retrieval: FormRetrieval
  concepts: FormConcepts
  skills: FormSkill[]
  /** 三样都够。小屋只摆长出来的那些 */
  grown: boolean
}

export interface FormReport {
  domains: FormDomain[]
  min_cases: number
  min_concepts: number
}

/** 零柒的小屋：攒下的东西（道具 / 徽章）、架上的真产出、今天喂了什么、学会的技能、
 *  记住的概念（学习地图的镜子）。
 *
 *  `carried` 是**它身上挂着的那件**：屋里最新到手的一件，或一份刚交出去的成品——
 *  门槛是稀疏的（第 1、5、25 份），而「交出一份成品 → 它叼回来」每一份都发生。
 *
 *  **屋里有两类东西，规矩不一样**（后端 `pet_room` 的 docstring 里有完整来由）：
 *  攒下的（`things` / `today`）跨过门槛就多一件、只增不减；镜子（`concepts`，
 *  也可能是一根还没长成的枝）照的是**此刻**，状态会来回动。
 *
 *  空屋子只是空的——**没有「还差 N 件」「它饿了」这种欠账口吻**。 */
export interface PetRoom {
  things: PetThing[]
  carried: PetThing | null
  shelf: WorkOutput[]
  today: { meals: PetMeal[]; date: string }
  /** 它学会的技能（Q2）：只收跑过对照的提示词 */
  skills: PetSkillCard[]
  /** 它长出的枝（Q3）：**只收三样都够的领域**。少了哪一样都不进屋 */
  form: FormDomain[]
  /** 它记住的概念（P2 · F13）：学习地图的镜子。**「未触及」不在这里面** */
  concepts: PetConceptCards
  /** 喂养风味（Z4）：这一行与成长页那一行**同源**（都来自 `pet_tone.flavor()`）。
   *  小屋没有称号可以摆在旁边，所以它摆在小屋顶上——「喂它什么」正是这一页的题眼。
   *  **空串 = 数不出来或开关关着**：一个字都不摆。 */
  flavor: string
  empty: boolean
}

/** 陈述式周报（M4 · PLAN §3 G4）：这一周**读出来的**事实 + 它说的那句话。
 *
 *  区间是**本自然周**（周一 → 今天）：周三点开时它只是半周，所以 `week` 一起给出来，
 *  界面上得能看见这个区间——别让半周的数看起来像整周的数。
 *  `text` 是唯一那句（后端的 `weekly.text()`）：界面显示的就是它会说的，没有第二份文案；
 *  `empty`（`text === ''`）时那句问候退回普通问候，界面上也就别摆一句「什么都没有」。
 */
export interface WeeklyReport {
  week: { start: string; end: string }
  facts: {
    /** 消化了几**份材料**（`digest_points.source` 去重） */
    sources: number
    /** 拆出几个点 */
    points: number
    got: number
    half: number
    outputs: number
    /** 「又卡住」的概念（`tutor.is_recurring_mistake` 那条判据） */
    recurring: string[]
  }
  text: string
  empty: boolean
}

/** 到点的决策见证（M4 · PLAN §3 G5）：一条 + 还有几条在等着。
 *
 *  **只回一条**——一次全摆出来就是一张「你还欠」的清单。字段是台词要引用的原文：
 *  判断本身 / 当时的依据 / 当时的信心 / 判断的年纪。 */
export interface DecisionWitness {
  due: (DecisionEntry & { due_at: string | null; age_days: number }) | null
  count: number
}

/** 到点的**交付**见证（M5 · PLAN3 §13）：一份交出去之后就没人回头看的东西。
 *
 *  真值在文件系统：`vault/deliver/` 里的文件就是交出去的东西本身，`at` 是它的 mtime（epoch 秒）。
 *  「回看过了」= 有一条隔了 24 小时以上的 👍/👎（当天点的赞说的是「写得好」）。
 *  **只回一条 + 一个计数**，与决策见证同一个形状。 */
export interface DeliverWitness {
  due: {
    path: string
    title: string
    /** 文件头 frontmatter 里的体裁 / 读者（老文件可能没有，那就是空串） */
    genre: string
    audience: string
    /** 交出去的时刻（epoch 秒） */
    at: number
    at_iso: string
    reviewed: boolean
    due_in_days: number
  } | null
  count: number
  /** 交付目录里一共有几份（含没到点的） */
  total: number
  window_days: number
}

/** 技能闭环的两条（PLAN3 §6）：**试用期漏斗** + **注入命中率**。
 *
 *  同一条红线：只进仪表盘——不设目标、不排名、不进零柒嘴里。
 *  三条限定随数据一起给（`rules` / `*_rules`），界面照抄：被用过那段是**窗口内**的；
 *  注入那格是**观察性差异不是对照**；接地分空着是「没材料可判」，不是 0 分。 */
export interface SkillLoop {
  funnel: {
    readable: boolean
    error: string
    /** 被用过那段的窗口（每个任务只留最近 N 条运行） */
    window: number
    skills: {
      name: string
      /** 被注入的次数（窗口内） */
      used: number
      last_ts: number | null
      cases: number
      registered: boolean
      stale: boolean
    }[]
    totals: { skills: number; used: number; with_cases: number; cases: number; registered: number }
  }
  funnel_rules: Record<string, string>
  injection: {
    readable: boolean
    error: string
    days: number
    runs: { total: number; injected: number; plain: number }
    grounded: { injected: { n: number; mean: number | null }; plain: { n: number; mean: number | null } }
    by_engine: {
      engine: string
      label: string
      total: number
      injected: number
      grounded_injected: { n: number; mean: number | null }
      grounded_plain: { n: number; mean: number | null }
    }[]
  }
  injection_rules: Record<string, string>
}

/** 北极星（PLAN §7）：周内「重讲作答 ≥1 且 消化材料 ≥1」的天数 / 7。
 *
 *  **只画曲线**：不设目标、不排名、不进零柒嘴里。`readable=false` 是「读不到」，
 *  不是「什么都没发生」——那两种情况长得一样的话，这把尺子就不值得信。
 *  `rules` 是口径原文，界面上照抄：同一个词在代码里和界面上必须是一个意思。 */
export interface NorthStar {
  readable: boolean
  error: string
  window: { start: string; end: string; days: number }
  days: { date: string; retell: number; digested: number; counted: boolean }[]
  counted: number
  denominator: number
  rate: number | null
  rules: { retell: string; digested: string; bias: string }
}

/** 过程指标（PLAN §7.2）：半懂率按周——八个自然周，每周「半懂 / (说通 + 半懂)」。
 *
 *  北极星说这周**动没动**，这一条说动的那部分**有没有落下**。
 *  **空的一周 `rate` 是 `null` 而不是 0**：0 读作「这周教的全都说通了」，
 *  「这周没开过教学」是另一件事——两种情况长得一样的话，这条线会替不存在的一周报喜。
 *  与北极星同一条红线：**只进仪表盘**，不设目标、不排名、不进零柒嘴里。 */
export interface HalfRateWeek {
  /** 周一（本地日） */
  start: string
  end: string
  got: number
  half: number
  /** 说通 + 半懂。「没用」不进任何一个分母。 */
  n: number
  rate: number | null
  is_current: boolean
}

/** 会话侧校准（PLAN2 P2-3）：**自己标的** vs **让它判的**，各是什么成色。
 *
 *  与卡片侧那条同一条红线：**只进仪表盘**——不设目标、不排名、不进零柒嘴里。
 *  两个已知性质写在 `rules` 里、界面照抄：**两边的样本不是同一批会话**（你可能把有把握的
 *  自己标、没把握的丢给它判），以及**样本小**（区间不重叠才算看得出来，`decidable`）。 */
export interface SessionVerdictSide {
  dist: { got: number; half: number; useless: number }
  /** 说通 + 半懂。「没用」不进这个分母（教学没成，证明不了水平）。 */
  n: number
  /** 说通率；没有样本时是 `null`，不是 0 */
  rate: number | null
  ci: [number, number]
  tell: boolean
}

export interface SessionCalibration {
  readable: boolean
  error: string
  days: number
  self: SessionVerdictSide
  judged: SessionVerdictSide
  /** 自评说通率 − 判分说通率（正数 = 自己标的更宽）；任一侧没样本 → null */
  gap: number | null
  /** 两个区间不重叠（样本小的时候它就是 false——那是答案，不是缺陷） */
  decidable: boolean
  judge_sha: string
  /** 窗口里的判分行来自不止一版判分器 */
  mixed: boolean
  rules: { rate: string; window: string; confound: string; small: string; mixed?: string; sample?: string }
}

export interface ProcessMetrics {
  readable: boolean
  error: string
  window: { start: string; end: string; weeks: number }
  weeks: HalfRateWeek[]
  totals: { got: number; half: number; n: number; rate: number | null }
  rules: { half: string; useless: string; week: string }
}

/** 校准曲线（PLAN2 T2）：滚动 N 天里，你自评的档位分布 vs 判分器判的档位分布。
 *
 *  `delta = 自评均值 − 判分均值`（正数 = 给自己打分更高）。**全自评时它是 `null` 而不是 0**
 *  ——0 读作「你和它判得一样准」，`null` 读作「还没对过账」，两回事。
 *  `notes` 是三条「读之前必须知道的事」的原文（判分器没有基线 / 历史行是未知 / 没存提示词
 *  版本），界面照抄，不自己编一份说法。**只进仪表盘**：不设目标、不排名、不进零柒嘴里。 */
/** 判分器的一个版本，以及它在这段窗口里判了什么（PLAN2 §9.4）。
 *  `sha` 为空 = **版本未知**（v9–v10 之间的历史行：判过，但那时候还没记版本）。 */
export interface CalibrationSegment {
  sha: string
  current: boolean
  n: number
  dist: Record<string, number>
  /** 这一版给出的档位均值（这把尺子偏松还是偏紧） */
  mean: number | null
}

export interface CardCalibration {
  readable: boolean
  error: string
  days: number
  /** 档位 → 次数，键恒为 1–4（没打过的档是 0）。 */
  self_dist: Record<string, number>
  judged_dist: Record<string, number>
  delta: number | null
  n_self: number
  n_judged: number
  judge_sha: string
  /** 按判分器版本分段：换过版之后这条曲线上就不是一把尺子了 */
  segments: CalibrationSegment[]
  /** 窗口里混了不止一版（`delta` 是两把尺子量出来的——页脚那句会写出来） */
  mixed: boolean
  notes: string[]
}

/** 「今天到期的卡里最该说破的那一条矛盾」——零柒递卡那句话的内容来源（PLAN2 T1 场景 A）。
 *  它**不是一个新的提醒来源**：服务的是原来那条「到期卡」，只换那句话的内容。
 *  `contradiction=null` 时界面照旧念到期卡。 */
export interface CardContradiction {
  contradiction: (Omit<CardCrosscheck, 'card_id'> & { card_id: number }) | null
}

/** 回指采纳（PLAN2 §6 第三条）：搁置卡的前置候选有没人看。
 *
 *  `n` = 从候选点进去开了课的**卡数**，`denominator` = 翻过候选的卡数（两个都是卡数，
 *  不然同一张卡点两下就能把率刷上去）。**一张都没翻过时 `rate` 是 `null` 而不是 0**：
 *  0 读作「翻了但一次都没点」，「没人翻过」是另一件事。
 *  `bias` 是那条已知偏差：分母由界面记一笔，取候选失败的那次不会记进去——所以它只会偏小。 */
export interface PrereqAdoption {
  readable: boolean
  error: string
  days: number
  n: number
  denominator: number
  rate: number | null
  rule: string
  bias: string
}
/** 双轨矛盾率（PLAN2 §6）：已掌握的概念里，名下的卡这些天还在重来的占多少。
 *
 *  **分母为 0 时 `rate` 是 `null` 而不是 0**：一个概念都没掌握（还没有数据）与
 *  一条矛盾都没有（桥真的通了）是两件事。`rule` 是口径原文，界面照抄。
 *  **只进仪表盘**：不设目标、不排名、不进零柒嘴里——它降说明桥通了，它不该变成考核。 */
export interface CardGapRate {
  readable: boolean
  error: string
  days: number
  n: number
  denominator: number
  rate: number | null
  rule: string
}

// 方向 6 第一刀（2026-09-28）：api 对象按域拆到 src/api/，这里组合成同一个对象——
// 全仓 `import { api } from './api'` 的导入路径不变；类型仍住在本文件，域文件只 `import type`。
import { agentsApi } from './api/agents'
import { backupsApi } from './api/backups'
import { cardsApi } from './api/cards'
import { conversationsApi } from './api/conversations'
import { dashboardApi } from './api/dashboard'
import { decisionsApi } from './api/decisions'
import { evalsApi } from './api/evals'
import { habitsApi } from './api/habits'
import { imagesApi } from './api/images'
import { journalApi } from './api/journal'
import { kbApi } from './api/kb'
import { kgApi } from './api/kg'
import { memoriesApi } from './api/memories'
import { notesApi } from './api/notes'
import { outputsApi } from './api/outputs'
import { petApi } from './api/pet'
import { podcastApi } from './api/podcast'
import { promptsApi } from './api/prompts'
import { settingsApi } from './api/settings'
import { skillsApi } from './api/skills'
import { sourcesApi } from './api/sources'
import { tasksApi } from './api/tasks'
import { threadsApi } from './api/threads'
import { tutorApi } from './api/tutor'
import { usageApi } from './api/usage'
import { workApi } from './api/work'

export const api = {
  ...agentsApi,
  ...backupsApi,
  ...cardsApi,
  ...conversationsApi,
  ...dashboardApi,
  ...decisionsApi,
  ...evalsApi,
  ...habitsApi,
  ...imagesApi,
  ...journalApi,
  ...kbApi,
  ...kgApi,
  ...memoriesApi,
  ...notesApi,
  ...outputsApi,
  ...petApi,
  ...podcastApi,
  ...promptsApi,
  ...settingsApi,
  ...skillsApi,
  ...sourcesApi,
  ...tasksApi,
  ...threadsApi,
  ...tutorApi,
  ...usageApi,
  ...workApi,
}
