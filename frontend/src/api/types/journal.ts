// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 journal 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

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
