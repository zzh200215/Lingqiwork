// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 threads 域类型；api.ts 做 type-only 转发，全仓导入路径不变。
import type { QualityNote } from '../../stream'

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
