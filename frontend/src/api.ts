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
  /** 北极星曲线（PLAN §7）：只画曲线，不设目标、不排名、不进零柒嘴里 */
  northStar: () => request<NorthStar>('/api/dashboard/north-star'),
  /** 过程指标（PLAN §7.2）：半懂率按周。**只进仪表盘**。 */
  process: () => request<ProcessMetrics>('/api/dashboard/process'),
  /** 技能闭环的两条（PLAN3 §6）：试用期漏斗 + 注入命中率。只进仪表盘。 */
  skillLoop: () => request<SkillLoop>('/api/dashboard/skill-loop'),

  listPrompts: (opts?: { q?: string; category?: string; favorite?: boolean }) => {
    const p = new URLSearchParams()
    if (opts?.q) p.set('q', opts.q)
    if (opts?.category) p.set('category', opts.category)
    if (opts?.favorite) p.set('favorite', 'true')
    const qs = p.toString()
    return request<PromptItem[]>(`/api/prompts${qs ? `?${qs}` : ''}`)
  },
  createPrompt: (p: Partial<PromptItem> & { title: string; content: string }) =>
    request<PromptItem>('/api/prompts', { method: 'POST', body: JSON.stringify(p) }),
  updatePrompt: (id: number, p: Partial<PromptItem>) =>
    request<PromptItem>(`/api/prompts/${id}`, { method: 'PUT', body: JSON.stringify(p) }),
  deletePrompt: (id: number) => request<{ ok: boolean }>(`/api/prompts/${id}`, { method: 'DELETE' }),
  /** 分类与标签清单——**从库里算出来**，不另养一份配置 */
  promptFacets: () => request<PromptFacets>('/api/prompts/facets'),
  /** 记一次使用（复制走 / 填完变量发出去时调）。`vars` 是这次填的值，下次复用不必重填。 */
  usePrompt: (id: number, vars: Record<string, string> = {}) =>
    request<{ ok: boolean; used_count: number }>(`/api/prompts/${id}/use`, {
      method: 'POST',
      body: JSON.stringify({ vars }),
    }),
  promptVersions: (id: number) => request<PromptVersionItem[]>(`/api/prompts/${id}/versions`),
  restorePromptVersion: (id: number, versionId: number) =>
    request<PromptItem>(`/api/prompts/${id}/versions/${versionId}/restore`, { method: 'POST' }),
  /** 使用历史。**记了就要能看**——只记不读的那份账换不来任何判断。 */
  promptUsages: (id: number, limit = 50) =>
    request<PromptUsageItem[]>(`/api/prompts/${id}/usages?limit=${limit}`),
  /** 分类表 + 各自几条。改名会**连条目一起搬**；删分类只把条目退回「未分类」。 */
  promptCategories: () => request<PromptCategoryItem[]>('/api/prompts/categories'),
  createPromptCategory: (name: string, color = '') =>
    request<PromptCategoryItem>('/api/prompts/categories', {
      method: 'POST',
      body: JSON.stringify({ name, color }),
    }),
  updatePromptCategory: (
    id: number,
    patch: { name?: string; color?: string; position?: number }
  ) =>
    request<PromptCategoryItem>(`/api/prompts/categories/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deletePromptCategory: (id: number) =>
    request<{ ok: boolean; uncategorized: number }>(`/api/prompts/categories/${id}`, {
      method: 'DELETE',
    }),
  /** 导出成文件。**「拿去其他项目」全靠它。** */
  exportPrompts: async (format: 'json' | 'csv'): Promise<void> => {
    const res = await fetch(`/api/prompts/export?format=${format}`)
    if (!res.ok) throw new Error(`export failed: ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `prompts.${format}`
    a.click()
    URL.revokeObjectURL(url)
  },
  importPrompts: (prompts: Array<Partial<PromptItem> & { title: string; content: string }>) =>
    request<{ added: string[]; skipped: string[] }>('/api/prompts/import', {
      method: 'POST',
      body: JSON.stringify({ prompts }),
    }),

  // AI 三条（只产出文本，**不落库**——写不写进库是你的决定）
  //
  // 三个都收 `signal`：页面上那颗「不等了」据此真的断开请求。**它不是「停止」**——
  // 一次性 POST 断开之后服务端照样跑完那次模型调用。
  promptAiGenerate: (idea: string, signal?: AbortSignal) =>
    request<{ title: string; content: string }>('/api/prompts/ai/generate', {
      method: 'POST',
      body: JSON.stringify({ idea }),
      ...(signal ? { signal } : {}),
    }),
  promptAiRefine: (content: string, instruction: string, signal?: AbortSignal) =>
    request<{ content: string }>('/api/prompts/ai/refine', {
      method: 'POST',
      body: JSON.stringify({ content, instruction }),
      ...(signal ? { signal } : {}),
    }),
  promptAiVars: (content: string, signal?: AbortSignal) =>
    request<PromptVarsResult>('/api/prompts/ai/vars', {
      method: 'POST',
      body: JSON.stringify({ content }),
      ...(signal ? { signal } : {}),
    }),

  // ---------- 提示词登记表 + 对照台（Q1）----------
  //
  // 与上面那三个是**两个东西**：上面是用户的片段库（`Prompt` 表），这里是系统提示词的
  // 登记表（`core/prompts.py::_SPECS`，32 条，有 sha 指纹）。**没有"改"这个动作**——
  // 内容活在源码里，这里只读、只跑对照。
  promptRegistry: () =>
    request<{ prompts: PromptRegistryEntry[]; inline: PromptInlineNote[] }>(
      '/api/prompts/registry'
    ),
  promptEntry: (key: string) =>
    request<PromptRegistryEntryDetail>(`/api/prompts/registry/${encodeURIComponent(key)}`),
  checkPrompt: (key: string, body: { variant?: string; variant_label?: string; model_id?: string }) =>
    request<PromptCheckReport>(`/api/prompts/registry/${encodeURIComponent(key)}/check`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 请正在跑的那次对照停下。**合作式**：每条用例之间生效，所以当前那条会跑完才停
   *  ——界面上因此写「正在停…（这一条跑完就停）」，不写「已停止」。
   *  `stopped: false` = 没有在跑的（如实说，不假装停成功）。 */
  cancelPromptCheck: (key: string) =>
    request<{ stopped: boolean }>(
      `/api/prompts/registry/${encodeURIComponent(key)}/check/cancel`,
      { method: 'POST' }
    ),
  /** 喂一条用例进金标集（**写的是 `backend/evals/prompts/*.json`**，不是提示词）。 */
  addPromptCase: (
    key: string,
    body: { user: string; intent: string; checks: string[]; id?: string }
  ) =>
    request<PromptCaseSpec>(`/api/prompts/registry/${encodeURIComponent(key)}/cases`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removePromptCase: (key: string, caseId: string) =>
    request<{ key: string; removed: string; left: number }>(
      `/api/prompts/registry/${encodeURIComponent(key)}/cases/${encodeURIComponent(caseId)}`,
      { method: 'DELETE' }
    ),
  /** 给一套 golden set 标一个领域（Q3 形态的分组键；写的是用例文件，不是提示词）。 */
  setPromptDomain: (key: string, domain: string) =>
    request<{ key: string; domain: string }>(
      `/api/prompts/registry/${encodeURIComponent(key)}/domain`,
      { method: 'POST', body: JSON.stringify({ domain }) }
    ),

  // ---------- 形态（Q3）----------
  /** 全部领域 + 各自的三个数（只读）。小屋只要长出来的，工作页要全部。 */
  form: () => request<FormReport>('/api/form'),

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
  /** 能力候选（环一）：读一份材料，看它有没有一套值得反复用的工序；有就落一份
   *  SKILL.md 草稿。`ok=false` 是**正常结论**（读不出来 / 没有工序 / 没配模型），
   *  不是错误——所以这个接口不抛 5xx，理由一律走 `reason` 那一句人话。 */
  makeCandidate: (source_path: string, text: string, overwrite = false, signal?: AbortSignal) =>
    request<SkillCandidateResult>('/api/skills/candidate', {
      method: 'POST',
      body: JSON.stringify({ source_path, text, overwrite }),
      // 传进来就带上：页面上那颗「不等了」据此真的断开这次请求。
      // **注意它只是「不等了」**——一次性 POST 断开之后服务端照样跑完那份调用。
      ...(signal ? { signal } : {}),
    }),
  /** S2：读**一次运行**（连带它那条链的最近几步）→ 判断这段工作里有没有一套工序。
   *
   *  与 `makeCandidate` 同一套纪律与落盘出口；差异只在输入——这里给的是**你自己干过的活**
   *  （题目 + 产出），不是一份材料。**不抛 5xx**：读不到那次运行、没有 provider、
   *  判不出工序，都是 `ok=false` / `usable=false` + 一句理由。 */
  draftFromRun: (run_id: number, overwrite = false) =>
    request<SkillCandidateResult>('/api/skills/draft-from-run', {
      method: 'POST',
      body: JSON.stringify({ run_id, overwrite }),
    }),
  /** 现有技能 + 有没有基线（没基线不许当能力展示，这一处说了算）。 */
  listCandidates: () =>
    request<{
      skills: SkillCandidateRow[]
      measured: boolean
      checks: { name: string; why: string }[]
      fixture_dir: string
      /** S3：试用计数的窗口（每个任务只留最近 N 条运行）——界面必须把它显示出来 */
      trial_window: number
    }>('/api/skills/candidates'),
  /** S3：这份草稿在真实工作里被用过几次（派生自运行日志，零新表）。 */
  skillTrials: (name: string) =>
    request<SkillTrials>(`/api/skills/${encodeURIComponent(name)}/trials`),
  /** 给一份技能存用例（尺子）。**不自动生成**：模型自己出题自己考，考的是它会不会出题。 */
  saveSkillCases: (
    name: string,
    cases: { id?: string; intent?: string; ask: string; checks?: string[] }[]
  ) =>
    request<{ skill: string; cases: number; file: string }>(
      `/api/skills/${encodeURIComponent(name)}/cases`,
      { method: 'POST', body: JSON.stringify({ cases }) }
    ),
  /** 读这份技能的用例 + 断言清单（默认值由后端给，前端不自己拼一份）。 */
  skillCases: (name: string) =>
    request<SkillCasesPayload>(`/api/skills/${encodeURIComponent(name)}/cases`),
  /** 量一遍：每条用例问两次（没它 / 有它）+ `k/n` + Wilson 区间。**会花钱**（报告里有 calls）。 */
  runSkillEval: (name: string, model_id = '') =>
    request<SkillEvalReport>(`/api/skills/${encodeURIComponent(name)}/run`, {
      method: 'POST',
      body: JSON.stringify({ model_id }),
    }),
  /** 请正在跑的那次「量一遍」停下（合作式：每条用例之间生效）。
   *  `stopped: false` = 没有在跑的。 */
  cancelSkillEval: (name: string) =>
    request<{ stopped: boolean }>(`/api/skills/${encodeURIComponent(name)}/run/cancel`, {
      method: 'POST',
    }),

  globalSearch: async (q: string): Promise<SearchHit[]> => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
    if (!res.ok) throw new Error(`search failed: ${res.status}`)
    const data = (await res.json()) as { results: SearchHit[] }
    return data.results
  },

  listNotes: () =>
    request<{ dir: string; files: { path: string; mtime: number }[] }>('/api/notes'),

  /** 那一问（R2 · PLAN5 §3）：还没归类的语音备忘。拉取式，只在打开笔记页时取一次。 */
  voiceNotes: () => request<VoicePending>('/api/notes/voice'),

  /** 零柒说过的话（它自己的账本）。今天页拿它摆「最近说的」——那不是新真值，
   *  与挂件里那个气泡读的是同一张表（`pet_events`）。
   *  **端点的形状是 `{events: […]}`，不是裸数组**（2026-09-18 踩过：按数组读，
   *  `lines.length` 是 undefined，那一块就静默不渲染了）。 */
  petFeed: (limit = 8) => request<{ events: PetEvent[] }>('/api/pet/feed?limit=' + limit),
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
  /** 到点的那条判断（M4 · G5）：主动开口的**唯一**一处，走 nudge 管线的第 5 个来源。 */
  decisionWitness: () => request<DecisionWitness>('/api/decisions/witness'),

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
    /** S1：这份产出吃着技能生成的没有。**三态**：不传 = 不知道，`"[]"` = 没有注入，
     *  `'["技能名"]'` = 有注入。点 👍 的那一刻手上有注入清单的调用方才传得起。 */
    injected?: string
  }) =>
    request<{ id: number; kind: string; verdict: string }>('/api/quality/feedback', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  qualitySummary: (days = 90) => request<QualitySummary>(`/api/quality/summary?days=${days}`),

  /** 最近若干聊天回合（W5）。`only` = 只看某一类毛病（keys 见返回里的 filters）。 */
  turns: (limit = 30, only = '') =>
    request<{ traces: TurnTrace[]; filters: TurnFilter[]; only: string }>(
      `/api/turns?limit=${limit}${only ? `&only=${encodeURIComponent(only)}` : ''}`
    ),

  /** 成文引擎的自动标尺：每个引擎最近一次的得分 + golden set 覆盖 */
  engineEvalLatest: () => request<EngineEvalLatest>('/api/evals/engines/latest'),

  /** 回合读数（R1 · PLAN5 §3）：窗口内跑过几个聊天回合、各毛病几例。
   *
   *  **只给计数，不给成功率**——`core/turn_trace.py` 开篇写死的是「诊断工具，不是考核仪表」。
   *  读数与口径一起从后端来（`rules`），界面照抄不自己编。 */
  turnSummary: (days = 30) => request<TurnSummary>(`/api/dashboard/turns?days=${days}`),

  /** 提示词评测（R1 补齐 · PLAN5 §2-2）：登记了多少条、量过几条、几条站得住。
   *
   *  与上面两条同一条红线：**只进仪表盘**，不设目标、不排名、不进零柒嘴里。
   *  这一格尤其不能变成排行榜——载荷里没有任何一条提示词的名字或分数。 */
  promptEvalBoard: () => request<PromptEvalBoard>('/api/dashboard/prompt-eval'),
  agentEvalBoard: () => request<AgentEvalBoard>('/api/dashboard/agent-eval'),

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
  /** 手动跑一次任务。`topic` 是运行期题目覆盖——工作流第一步靠它接住你输入的题目，
   *  不改掉 preset 模板（后端 RunIn）。不给就发空串，省掉无 body 的边界情况。
   *  `thread`（M2）：这次在处理哪件「事」——后端按这个名字复用或新建一条，这一步的
   *  成品就挂到它上面（下游自动继承）。 */
  runTask: (id: number, topic = '', thread = '') =>
    request<TaskRunResult>(`/api/tasks/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ topic, thread }),
    }),
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
  /** **一批任务各自的最近一次运行**——工作页顶那块「最近几次运行」要的就是这个。
   *
   *  原来它是 `t.slice(0, 8).map(t => listTaskRuns(t.id))`：**8 个并发请求换 8 条数据**，
   *  而且每次切回那一档都重来一遍。返回按 task_id 分组（JSON 的键是字符串）；
   *  **没跑过的任务不出现**在结果里——那不叫「跑了但没记录」，叫「没跑过」。 */
  recentTaskRuns: (ids: number[]) =>
    request<Record<string, TaskRunItem>>(`/api/tasks/recent-runs?ids=${ids.join(',')}`),
  /** **一批任务各自的最近 n 条运行**（`n>1` 时后端返回的是数组、新在前）。
   *
   *  工作流清单每行的「最近运行结果条」（Buildkite 式：颜色=结果、高度=耗时）要的
   *  就是这个小历史——展开行才能看到的 20 条它不背，每行扫一眼要的只是最近这几条。
   *  同一个端点：`n` 缺省 1 时返回的是单条（`recentTaskRuns`），形状不动。 */
  recentTaskRunBatches: (ids: number[], n = 10) =>
    request<Record<string, TaskRunItem[]>>(`/api/tasks/recent-runs?ids=${ids.join(',')}&n=${n}`),
  /** 外部事件起一次运行（webhook 触发器，2026-09-26）。`dedupe_seconds > 0`：
   *  窗口内已起过一趟就直接返回那一趟（幂等，不烧两次钱）。 */
  triggerTask: (id: number, body?: { topic?: string; dedupe_seconds?: number }) =>
    request<{ status: string; run?: TaskRunItem }>(`/api/tasks/${id}/trigger`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),
  /** Q4 调度台：确定性编排的看板（状态全部由后端从 tasks/task_runs 算出来） */
  dispatch: (limit = 20) => request<DispatchBoard>(`/api/dispatch?limit=${limit}`),
  parseTask: (text: string) =>
    request<{ cron: string; name: string; prompt: string }>('/api/tasks/parse', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  listEvalItems: () => request<EvalItem[]>('/api/evals'),
  /** 全量配置读/写（夜间回归等开关的家；后端 PUT /api/settings/prefs）。 */
  getPrefs: () => request<Record<string, unknown>>('/api/settings/prefs'),
  updatePrefs: (patch: Record<string, unknown>) =>
    request<Record<string, unknown>>('/api/settings/prefs', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
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
  runEval: (top_k: number | null, judge: boolean, signal?: AbortSignal) =>
    request<EvalRun>('/api/evals/run', {
      method: 'POST',
      body: JSON.stringify({ top_k, judge }),
      signal,
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
  /** 校准曲线（PLAN2 T2）：滚动 N 天，自评 vs 判分。**只进仪表盘**。 */
  cardCalibration: (days = 30) =>
    request<CardCalibration>(`/api/cards/calibration?days=${days}`),
  /** 递卡那句对质的事实来源（PLAN2 T1 场景 A）。没有矛盾时 `contradiction=null`。 */
  cardContradiction: () => request<CardContradiction>('/api/cards/contradiction'),
  /** 双轨矛盾率（PLAN2 §6）。**只进仪表盘**——不设目标、不排名、不进零柒嘴里。 */
  cardGapRate: (days = 30) => request<CardGapRate>(`/api/cards/contradiction-rate?days=${days}`),
  /** 一张卡的对照事实（真值只有一份：与递卡那句同一个后端函数）。 */
  cardCrosscheck: (id: number) => request<CardCrosscheck>(`/api/cards/${id}/crosscheck`),
  /** 这张卡「可能缺的前置」——**拉取式**：点开才有，没有任何东西会催你（PLAN2 T3）。 */
  cardPrereq: (id: number) => request<CardPrereq>(`/api/cards/${id}/prereq`),
  /** 记一笔「这张卡的候选被翻过」（PLAN2 §6 回指采纳的分母）。
   *  **单独一个 POST，不是上面那条 GET 的副作用**：读路径带副作用的话，重试与预取
   *  都会记账，而这一条数的用途是判「这个功能有没有人看」——记不准就会把没人用的
   *  东西判成有人用。丢了不致命，所以界面那边是 fire-and-forget。 */
  markPrereqSeen: (id: number) =>
    request<{ ok: boolean }>(`/api/cards/${id}/prereq/seen`, { method: 'POST' }),
  /** 回指采纳（PLAN2 §6）：翻过多少张搁置卡的候选、其中多少张真开了课。**只进仪表盘**。 */
  prereqAdoption: (days = 90) =>
    request<PrereqAdoption>(`/api/cards/prereq-adoption?days=${days}`),
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
  reviewCard: (id: number, grade: CardGrade, seconds: number, retell = '') =>
    request<CardReviewResult>(`/api/cards/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ grade, seconds, retell }),
    }),
  /** 「讲给它听」：它判档 → 落**同一条**复习记录 → 零柒接一句（判词走 SSE 冒泡）。
   *  `ok=false` 时一个字节都没写，退回自评。判分是一次模型调用（成本写在按钮 tooltip 上）。 */
  retellCard: (id: number, text: string, seconds: number, model_id = '') =>
    request<CardRetellResult>(`/api/cards/${id}/retell`, {
      method: 'POST',
      body: JSON.stringify({ text, seconds, model_id }),
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

  /** 模型竞技场：同一段 prompt 打到几家 provider。
   *
   *  `models` 空 = 所有已启用的（原行为）；给了就只打这几家——
   *  提示词页的「对打」是**选 2–4 个比一比**，不必每次把全家桶叫起来。 */
  /** 对打：**两段输入**（§8.2 区2「同一输入并排比」）——`system` 是提示词（怎么答），
   *  `prompt` 是这一问（答什么）。`system` 不传 = 老行为（整段当 user 消息）。 */
  arenaRun: (prompt: string, models?: string[], system?: string, signal?: AbortSignal) =>
    request<{ results: ArenaResult[] }>('/api/arena', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        ...(models && models.length ? { models } : {}),
        ...(system ? { system } : {}),
      }),
      // 「不等了」据此真的断开这次请求。**它不是「停止」**：服务端那一趟并行调用
      // 会照旧跑完（最多 90 秒/家），钱照花——所以按钮上不写「停止」。
      ...(signal ? { signal } : {}),
    }),
  /** 历次对打记录（`vault/prompts/duels/`，新在前封顶 50）——对打浏览器的清单。
   *  正文不在这里：记录就是普通 md，点开走既有的笔记页。 */
  listArenaRecords: () =>
    request<{ records: { path: string; title: string; mtime: number }[] }>('/api/arena/records'),
  /** 把这次对打落成 `vault/prompts/duels/` 里一篇 md 并进索引。
   *  **一份对照记录，不是一条断言**——为什么不进评测区的金标集，见后端 `arena.save_record`。 */
  arenaSave: (payload: {
    title?: string
    system: string
    prompt: string
    model_id?: string
    results: ArenaResult[]
  }) =>
    request<{ filename: string; chunks: number }>('/api/arena/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // ---------- 第0周：使用基线 + 今日建议 ----------
  /** best-effort page-open count; fire from Layout on mount, ignore errors */
  visit: (page: string) =>
    request<{ recorded: boolean; page: string; day: string }>('/api/usage/visit', {
      method: 'POST',
      body: JSON.stringify({ page }),
    }),
  /** 功能真实用量（CTO review #6）：model_usage 按操作名聚合，「30 天自用窗口」的读数。 */
  usageFeatures: () =>
    request<{ features: UsageFeatureRow[]; page_opens?: Record<string, number> }>(
      '/api/usage/features'
    ),
  todayNext: () => request<TodayNext>('/api/today/next'),
  /** 今日概览五档：失败任务 / 未消化 / 到期卡 / 卡点 / 进行中产出。空档不返回。 */
  todaySummary: () => request<{ rows: TodaySummaryRow[] }>('/api/today/summary'),

  // ---------- 产出归档（人工出口） ----------
  /** 可选体裁。真值在后端 `mcp._ARTIFACT_KINDS`（决定了落点目录），前端不硬编码。 */
  outputKinds: () =>
    request<{ kinds: { kind: string; label: string; dir: string }[] }>('/api/outputs/kinds'),
  /** 把一条已有回答存成产出。返回回执，调用方把它写回那条消息。 */
  saveOutputFromMessage: (conversationId: number, messageId: number, kind: string, title = '') =>
    request<ArtifactRef>('/api/outputs/from-message', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: conversationId,
        message_id: messageId,
        kind,
        title,
      }),
    }),
  /** 把一段**不在会话里**的 AI 回答存成产出（导师 / 陪伴 / 笔记对话 / 划词助手…）。
   *  同一条工具路径落盘；回执直接返回、由调用方就地展示。 */
  saveOutputFromText: (kind: string, content: string, title = '') =>
    request<ArtifactRef>('/api/outputs/from-text', {
      method: 'POST',
      body: JSON.stringify({ kind, title, content }),
    }),

  // ---------- 零柒：成长 + 能力插件（Track B） ----------
  /** 成长：等级 / 称号 / 累计 EXP / 各来源。只正面呈现。 */
  /** 零柒**此刻**的状态。`idleSec` / `path` 由前端算好传进去——服务端不存它们。 */
  petState: (idleSec?: number, path?: string) => {
    const q = new URLSearchParams()
    if (idleSec != null && Number.isFinite(idleSec)) {
      q.set('idle_sec', String(Math.max(0, Math.round(idleSec))))
    }
    if (path) q.set('path', path)
    const s = q.toString()
    return request<PetState>(`/api/pet/state${s ? `?${s}` : ''}`)
  },
  petGrowth: () => request<PetGrowth>('/api/pet/growth'),
  /** 小屋：它攒下的东西 + 今天喂了它什么 + 架上那几份产出。 */
  petRoom: () => request<PetRoom>('/api/pet/room'),
  /** 陈述式周报（M4）：这一周已经发生的事。任何一天都能看，周日那句问候说的是同一份。 */
  weeklyReport: () => request<WeeklyReport>('/api/pet/weekly-report'),
  /** 周报 → 一段音频（单音色念稿，不过模型）。空的一周回 422，界面照实说。 */
  weeklyPodcast: (voice = '') =>
    request<PodcastEntry>('/api/pet/weekly-report/podcast', {
      method: 'POST',
      body: JSON.stringify({ voice }),
    }),
  petPlugins: () => request<{ plugins: PetPlugin[] }>('/api/pet/plugins'),
  /** 最近几轮跟零柒的问答（旧 → 新）。P5 落库之后，刷新、隔天回来它还记得。 */
  petChats: (limit = 30) => request<{ chats: PetChatMsg[] }>(`/api/pet/chats?limit=${limit}`),
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
  /** 一键装好工作流：三步链（调研 → 方案 → 汇报稿），每步一个人工卡点。幂等。 */
  installWorkPreset: () =>
    request<{ created: number; tasks: ScheduledTask[] }>('/api/tasks/preset/work', {
      method: 'POST',
    }),
  /** 一键装好语音进料（R2）：`voice/inbox/` + 一个监听它的转写任务。幂等。
   *
   *  丢进 `voice/inbox/` 的录音会变成 `vault/voice/YYYY-MM-DD-HHMM.md`，
   *  **原录音随后被删掉**——这条 preset 只留文本（会议闭环那条留着原声）。 */
  installVoicePreset: () =>
    request<{ created: number; tasks: ScheduledTask[] }>('/api/tasks/preset/voice', {
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
  /** 局部更新。`status`/`deadline` 是方案 §8.4 的状态机与截止日。
   *
   *  **`deadline` 传空串 = 清掉；不传 = 不改它**（后端 `None` 就是「这次不动」，
   *  所以「清掉」另给一个 `clear_deadline`——两者不能都用 undefined 表达）。 */
  updateThread: (
    id: number,
    patch: {
      name?: string
      note?: string
      archived?: boolean
      status?: 'open' | 'done'
      deadline?: string
      clear_deadline?: boolean
    }
  ) => request<ThreadRow>(`/api/threads/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
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
  /** 收件箱的候选：还没挂到任何事、**也没被忽略过**的条目 */
  unclassified: (limit = 60) =>
    request<{ items: ThreadCandidate[]; total: number }>(
      `/api/threads/unclassified?limit=${limit}`
    ),
  /** 从收件箱里划掉一条（§8.4）。幂等。**东西一件都不动**——只是不再出现在收件箱里。
   *  收件箱的目标是清空，而候选是派生的：没有这一档它永远清不空。 */
  ignoreInboxItem: (kind: ThreadKind, ref: string) =>
    request<{ ok: boolean; ignored: boolean }>('/api/threads/inbox/ignore', {
      method: 'POST',
      body: JSON.stringify({ kind, ref }),
    }),
  /** 撤销忽略——它回到收件箱里。 */
  unignoreInboxItem: (kind: ThreadKind, ref: string) =>
    request<{ ok: boolean }>(
      `/api/threads/inbox/ignore?kind=${kind}&ref=${encodeURIComponent(ref)}`,
      { method: 'DELETE' }
    ),
  /** 这个条目该挂到哪件事上（按它自己的标签派生，不用你打字） */
  suggestThreads: (kind: ThreadKind, ref: string) =>
    request<{ label: string; threads: ThreadRow[] }>(
      `/api/threads/suggest?kind=${kind}&ref=${encodeURIComponent(ref)}`
    ),
  /** 就这件事写一份交付——**这一路的模型用量记在这件事头上**（§4-16） */
  /** 就这件事写一份交付。**这一路的账记在这件事头上**（§4-16）。
   *
   *  `signal` 传进来就带上——而且这一条的取消**是真停**：客户端断开 → Starlette 取消
   *  这个请求 → 取消沿 await 链传到 `llm.stream_chat`，那里 `finally` 显式关上游流。
   *  所以界面上写的是「停止」，不是「不等了」。 */
  deliverIntoThread: (id: number, genre: string, audience: string, signal?: AbortSignal) =>
    request<{ filename: string; title: string; chunks: number }>(`/api/threads/${id}/deliver`, {
      method: 'POST',
      body: JSON.stringify({ genre, audience }),
      ...(signal ? { signal } : {}),
    }),

  // ---------- 工作：交付（把材料改写成能交出去的体裁） ----------
  /** 体裁 × 读者的定义（唯一真值在后端，含「长稿」判据） */
  deliverGenres: () => request<DeliverCatalogue>('/api/deliver/genres'),
  /** 先出提纲（§8.1 双模的长稿那一模）：**不取材**，只拿话题与体裁×读者问一次结构。
   *  确认之后才带着 `outline` 调 `/api/deliver` 取材成文——取材与成文才是贵的那两段。 */
  deliverOutline: (payload: { topic: string; genre: string; audience: string }) =>
    request<DeliverOutline>('/api/deliver/outline', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // 自定义体裁模板（§8.1 行2）。**它是体裁，不是别的东西**——所以列表那一份并进
  // `/deliver/genres`，这一份只给编辑用（带结构指令）。
  /** 你自己写的体裁模板（含结构指令）。 */
  deliverTemplates: () => request<DeliverTemplate[]>('/api/deliver/templates'),
  deliverTemplateCreate: (payload: { label: string; prompt: string; long: boolean }) =>
    request<DeliverTemplate>('/api/deliver/templates', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  /** 改模板。只改传进来的字段（`undefined` = 不动）。**id 不会变**：`prompt_sha` 按它分版本，
   *  改名不该让质量闭环的历史断裂。 */
  deliverTemplateUpdate: (
    id: string,
    payload: { label?: string; prompt?: string; long?: boolean }
  ) =>
    request<DeliverTemplate>(`/api/deliver/templates/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  /** 删模板。**已经写出去的成品一份都不动**（它们在 vault 里，文件头写的是界面名）。 */
  deliverTemplateDelete: (id: string) =>
    request<{ deleted: string }>(`/api/deliver/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  /** 把上一次的交付落成 vault/deliver/ 里的一篇 md 并进索引。
   *  `genre` / `audience` 会写进文件头（M5）——「这份是给谁写的」存下来才留得住，
   *  交付的事后见证（`deliverWitness`）就是读它。 */
  deliverSave: (payload: {
    title: string
    sections: { heading: string; body: string }[]
    used: number[]
    sources: { n: number; kind: string; title: string; ref: string }[]
    genre?: string
    audience?: string
  }) =>
    request<{ filename: string; title: string; chunks: number }>('/api/deliver/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  /** 交付的事后见证（M5）：到点的一份 + 还有几份在等着（nudge 的第 6 个来源）。 */
  deliverWitness: () => request<DeliverWitness>('/api/deliver/witness'),
  /** GB/T 9704 公文版式 docx 导出。两种给法二选一：`path` = vault 里已落盘的那份
   *  （阅读视图用）；`title+sections` = 生成屏上还没存的。`org` = 红头单位名
   *  （空 = 不加红头——后端不替用户编造机关名）。文件走 blob 下载（同会话导出）。 */
  exportWorkDocx: async (
    body: {
      path?: string
      title?: string
      sections?: { heading: string; body: string }[]
      org?: string
    },
    fileName: string,
  ): Promise<void> => {
    const res = await fetch('/api/work/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`export failed: ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName.endsWith('.docx') ? fileName : `${fileName}.docx`
    a.click()
    URL.revokeObjectURL(url)
  },

  // ---------- 对话式教学 ----------
  /** repo 非空 = 代码库陪读：会话取材限定在该仓库；mode = socratic | feynman。
   * origin_point_id 非空 = 从「材料拆出的点」开场，带上就把它标成已教。
   * prereq_card_id 非空 = 从**那张搁置卡的前置候选**点进来的（PLAN2 §6 回指采纳的分子）。 */
  tutorStart: (
    topic: string,
    repo?: string,
    mode?: 'socratic' | 'feynman' | 'future' | 'interview',
    origin_point_id?: number,
    prereq_card_id?: number,
  ) =>
    request<TutorSessionStart>('/api/tutor/start', {
      method: 'POST',
      body: JSON.stringify({
        topic,
        repo: repo || '',
        mode: mode || 'socratic',
        origin_point_id: origin_point_id || null,
        prereq_card_id: prereq_card_id || null,
      }),
    }),
  /** 懂了 / 半懂 / 没用 — the only manual input in the product */
  tutorEnd: (session_id: number, verdict: 'got' | 'half' | 'useless') =>
    request<TutorEndResult>('/api/tutor/end', {
      method: 'POST',
      body: JSON.stringify({ session_id, verdict }),
    }),
  /** M1 场景 B：「我来讲 · 让它判」——它读完整场对话给一档，**走同一条 `end()`**
   *  （概念/卡点照常回写，「又卡住」那条链路一行都没改）。
   *  `judged=false` 时什么都没动：退回你自己标一档，**不编分**。 */
  tutorJudge: (session_id: number, model_id = '') =>
    request<TutorJudgeResult>(`/api/tutor/sessions/${session_id}/judge`, {
      method: 'POST',
      body: JSON.stringify({ model_id }),
    }),
  /** M3 面试陪练：题库（只读）与散场报告。报告落 `vault/reports/`，题库文件不动。 */
  interviewBank: () => request<InterviewBank>('/api/interview/bank'),
  interviewReport: (session_id: number, model_id = '') =>
    request<InterviewReportResult>(`/api/interview/${session_id}/report`, {
      method: 'POST',
      body: JSON.stringify({ model_id }),
    }),
  tutorSessions: (limit = 50) =>
    request<{ sessions: TutorSessionRow[] }>(`/api/tutor/sessions?limit=${limit}`),
  // 全量卡点：右栏会话列表只取 50 条，第 52 次记的卡点不能跟着消失
  tutorProfile: () =>
    request<TutorProfile>('/api/tutor/profile'),
  tutorStuck: (limit = 200) =>
    request<{ stuck: TutorStuckRow[] }>(`/api/tutor/stuck?limit=${limit}`),
  tutorConcepts: () => request<{ concepts: TutorConceptRow[] }>('/api/tutor/concepts'),
  /** 「又卡住」的那几个概念：接住过卡在哪、最近一次还是半懂、就在这几天。
   *  **与零柒那句台词同一个判据**（后端 `tutor.is_recurring_mistake`）——界面和它说的
   *  必须是同一批，否则「它凭什么这么说」就查不到了。 */
  tutorRecurring: (days = 7) =>
    request<{ recurring: TutorConceptRow[] }>(`/api/tutor/recurring?days=${days}`),
  /** 把两个概念并成一个（**人工**，Q3.5）。
   *
   *  机器自己只在有量出来的余量的地方并（相似度 0.80，尺子在 `backend/smoke_concept.py`：
   *  零误并、余量 +0.10）；**同领域的相邻概念它分不开**，只能由你指认。
   *  只改 concept 与 aliases 两列，可复算。 */
  mergeConcepts: (source: string, into: string) =>
    request<{ from: string; into: string; moved: number }>('/api/tutor/concepts/merge', {
      method: 'POST',
      body: JSON.stringify({ source, into }),
    }),
  /** 学习地图：已掌握 / 在学 / 卡住 / 未触及 四档（前三档纯派生，第四档读建议日志）。 */
  tutorMap: () => request<TutorLearningMap>('/api/tutor/map'),
  /** 会话侧校准（PLAN2 P2-3）：自己标的 vs 让它判的。**只进仪表盘**。 */
  tutorCalibration: (days = 90) =>
    request<SessionCalibration>(`/api/tutor/calibration?days=${days}`),
  /** 成长事件：概念「学会了」的时刻（零柒成长面板的原料）。纯派生。 */
  tutorMastery: () => request<TutorMastery>('/api/tutor/mastery'),
  /** 一个概念的「邻居」（同一件事 / 同一份材料 / 语义相近）。纯派生。 */
  tutorNeighbors: (concept: string, limit = 6) =>
    request<{ neighbors: TutorNeighbor[] }>(
      `/api/tutor/neighbors?concept=${encodeURIComponent(concept)}&limit=${limit}`
    ),
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
