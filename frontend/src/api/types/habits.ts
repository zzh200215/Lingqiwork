// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 habits 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

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
