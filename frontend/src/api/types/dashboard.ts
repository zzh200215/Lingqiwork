// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 dashboard 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

export interface DashboardNarrative {
  today_messages: number
  yesterday_messages: number
  this_week_messages: number
  prev_week_messages: number
  today_tokens: number
  today_vault_files: number
  week_start: string
}

export interface DashboardBriefing {
  text: string
  cached: boolean
  facts: {
    conversations: number
    memories: number
    vault_files: number
    today_messages: number
    yesterday_messages: number
    this_week_messages: number
    prev_week_messages: number
    today_tokens: number
    today_vault_files: number
    task_runs_30d: number
    task_ok_30d: number
    task_err_30d: number
    recent_titles: string[]
  }
}

export interface DashboardStats {
  conversations: number
  messages: number
  memories: number
  vault_files: number
  tokens_total: number
  daily_tokens: { date: string; tokens: number }[]
  task_stats: {
    runs_30d: number
    ok: number
    error: number
    rate: number | null
    /** **按任务分解**（方案 §8.3：工作流清单每行要自己的 30 天成功率）。
     *  键是 `task_id` 的字符串形式；**30 天内没跑过的任务不出现**——别摆一个 0%，
     *  那会把「没跑过」说成「全挂了」。 */
    by_task?: Record<string, { runs: number; ok: number; rate: number | null }>
  }
  tasks: {
    id: number
    name: string
    cron: string
    mode?: string
    trigger_kind?: string
    watch_path?: string
    next_run: string | null
    last_run: string | null
    last_status: string
  }[]
  tasks_total: number
  /** 最近 7 天里**真的打开过应用**的天数（`usage_visits` 的真相源）。
   *  后端一直在返回它，只是这个类型漏了（2026-09-18 补）。 */
  open_days_7d: number
  recent_conversations: { id: number; title: string; model_id: string; updated_at: string }[]
  daily_messages: { date: string; count: number }[]
  top_models: { model_id: string; count: number }[]
  narrative: DashboardNarrative
}

/** 今日页「今天下一步」建议. */
export interface TodayNext {
  text: string
  tone: 'bad' | 'idle'
  /** thread = 「最近动过的那件事」——点进去是接着看，**不是待办** */
  action: { kind: 'settings' | 'thread' | 'none'; label: string; thread_id?: number }
}

/** 今日概览的一行：一个计数 + 一个直达落点。空档后端直接省略，不返回 0。
 *  与 TodayNext 分开——那条是一句会主动开口的建议；这里只是「有几件、去哪」。 */
export interface TodaySummaryRow {
  key: 'tasks_failing' | 'untouched' | 'due_cards' | 'awaiting' | 'inflight'
  label: string
  count: number
  href: string
  tone: 'bad' | 'warn' | 'info'
}

/** 陈述式周报（M4 · PLAN §3 G4）：这一周**读出来的**事实 + 它说的那句话。
 *
 *  区间是**本自然周**（周一 → 今天）：周三点开时它只是半周，所以 `week` 一起给出来，
 *  界面上得能看见这个区间——别让半周的数看起来像整周的数。
 *  `text` 是唯一那句（后端的 `weekly.text()`）：界面显示的就是它会说的，没有第二份文案；
 *  `empty`（`text === ''`）时那句问候退回普通问候，界面上也就别摆一句「什么都没有」。
 */
export interface WeeklyReport {
  week: { start: string; end: string }
  facts: {
    /** 消化了几**份材料**（`digest_points.source` 去重） */
    sources: number
    /** 拆出几个点 */
    points: number
    got: number
    half: number
    outputs: number
    /** 「又卡住」的概念（`tutor.is_recurring_mistake` 那条判据） */
    recurring: string[]
  }
  text: string
  empty: boolean
}

/** 技能闭环的两条（PLAN3 §6）：**试用期漏斗** + **注入命中率**。
 *
 *  同一条红线：只进仪表盘——不设目标、不排名、不进零柒嘴里。
 *  三条限定随数据一起给（`rules` / `*_rules`），界面照抄：被用过那段是**窗口内**的；
 *  注入那格是**观察性差异不是对照**；接地分空着是「没材料可判」，不是 0 分。 */
export interface SkillLoop {
  funnel: {
    readable: boolean
    error: string
    /** 被用过那段的窗口（每个任务只留最近 N 条运行） */
    window: number
    skills: {
      name: string
      /** 被注入的次数（窗口内） */
      used: number
      last_ts: number | null
      cases: number
      registered: boolean
      stale: boolean
    }[]
    totals: { skills: number; used: number; with_cases: number; cases: number; registered: number }
  }
  funnel_rules: Record<string, string>
  injection: {
    readable: boolean
    error: string
    days: number
    runs: { total: number; injected: number; plain: number }
    grounded: { injected: { n: number; mean: number | null }; plain: { n: number; mean: number | null } }
    by_engine: {
      engine: string
      label: string
      total: number
      injected: number
      grounded_injected: { n: number; mean: number | null }
      grounded_plain: { n: number; mean: number | null }
    }[]
  }
  injection_rules: Record<string, string>
}

/** 北极星（PLAN §7）：周内「重讲作答 ≥1 且 消化材料 ≥1」的天数 / 7。
 *
 *  **只画曲线**：不设目标、不排名、不进零柒嘴里。`readable=false` 是「读不到」，
 *  不是「什么都没发生」——那两种情况长得一样的话，这把尺子就不值得信。
 *  `rules` 是口径原文，界面上照抄：同一个词在代码里和界面上必须是一个意思。 */
export interface NorthStar {
  readable: boolean
  error: string
  window: { start: string; end: string; days: number }
  days: { date: string; retell: number; digested: number; counted: boolean }[]
  counted: number
  denominator: number
  rate: number | null
  rules: { retell: string; digested: string; bias: string }
}

/** 过程指标（PLAN §7.2）：半懂率按周——八个自然周，每周「半懂 / (说通 + 半懂)」。
 *
 *  北极星说这周**动没动**，这一条说动的那部分**有没有落下**。
 *  **空的一周 `rate` 是 `null` 而不是 0**：0 读作「这周教的全都说通了」，
 *  「这周没开过教学」是另一件事——两种情况长得一样的话，这条线会替不存在的一周报喜。
 *  与北极星同一条红线：**只进仪表盘**，不设目标、不排名、不进零柒嘴里。 */
export interface HalfRateWeek {
  /** 周一（本地日） */
  start: string
  end: string
  got: number
  half: number
  /** 说通 + 半懂。「没用」不进任何一个分母。 */
  n: number
  rate: number | null
  is_current: boolean
}

export interface ProcessMetrics {
  readable: boolean
  error: string
  window: { start: string; end: string; weeks: number }
  weeks: HalfRateWeek[]
  totals: { got: number; half: number; n: number; rate: number | null }
  rules: { half: string; useless: string; week: string }
}
