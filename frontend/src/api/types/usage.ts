// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 usage 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

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
