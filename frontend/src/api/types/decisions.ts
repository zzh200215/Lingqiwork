// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 decisions 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

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

/** 到点的决策见证（M4 · PLAN §3 G5）：一条 + 还有几条在等着。
 *
 *  **只回一条**——一次全摆出来就是一张「你还欠」的清单。字段是台词要引用的原文：
 *  判断本身 / 当时的依据 / 当时的信心 / 判断的年纪。 */
export interface DecisionWitness {
  due: (DecisionEntry & { due_at: string | null; age_days: number }) | null
  count: number
}
