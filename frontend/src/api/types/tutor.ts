// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 tutor 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

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
