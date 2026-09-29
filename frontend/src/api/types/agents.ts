// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 agents 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

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
