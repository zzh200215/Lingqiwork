// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 memories 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

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
