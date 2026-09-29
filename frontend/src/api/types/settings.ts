// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 settings 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

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
