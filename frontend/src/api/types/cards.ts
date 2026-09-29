// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 cards 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

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
