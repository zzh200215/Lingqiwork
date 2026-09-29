// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 evals 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

export interface EvalItem {
  id: number
  question: string
  expected_source: string
  note: string
  /** 领域（Q3 形态）：分组用的标签，'' = 还没归类 */
  domain: string
}

export interface EvalCaseResult {
  id: number
  question: string
  expected_source: string
  rank: number | null
  hits: (string | null)[]
  answer: string
  score: number | null
  reason: string
  error: string
}

export interface EvalRun {
  id: number
  created_at: string | null
  top_k: number
  hybrid: boolean
  rerank: boolean
  full_context: boolean
  judge_model: string
  total: number
  hit1: number
  hit3: number
  hitk: number
  mrr: number
  faithfulness: number | null
  seconds: number
  labelled?: number
  detail?: EvalCaseResult[]
  /** 合作式取消后提前收工（跳过的用例不计入指标）。未取消时是 false/缺省 */
  stopped?: boolean
}

export interface TurnFilter {
  key: string
  label: string
  hint: string
}

/** 某个成文引擎跑一遍 golden set 的自动得分（结构与人工反馈共用同一个 prompt_sha）。 */
export interface EngineEvalRun {
  id: number
  engine: string
  created_at: string | null
  prompt_sha: string
  model_id: string
  total: number
  /** 无 finding 的用例占比 0-1（确定性判分，不花模型钱） */
  structural: number
  /** 接地判分 0-5 均值；null = 这次只跑了结构判分 */
  grounded: number | null
  seconds: number
}

export interface EngineEvalLatest {
  by_engine: Record<string, EngineEvalRun | null>
  /** 每个引擎的 golden set 有几条用例 */
  coverage: Record<string, number>
  /** 标尺自身的健康度提醒：全顶格（区分度低）、用例偏少 */
  warnings: string[]
}

export interface EngineEvalRunResult {
  runs: EngineEvalRun[]
  skipped: string[]
  judge_model: string
  judged: boolean
  coverage: Record<string, number>
}

/** 回合读数（R1 · PLAN5 §3）：窗口内跑过几个聊天回合、每一类毛病各几例。
 *
 *  **没有成功率 / 比率这一项**，而且不该有：`turn_trace` 是诊断工具不是考核仪表。
 *  `turns` 是**说出来的分母**（让计数有参照），`total` 是窗口里真实跑了多少轮；
 *  两者不同时 `truncated=true`（库很大时只数了最近 N 轮），界面要照实说。 */
export interface TurnSummary {
  readable: boolean
  error: string
  days: number
  /** 实际数进计数的回合数（可能被 `truncated` 截住） */
  turns: number
  /** 窗口里真实落过账的回合数 */
  total: number
  truncated: boolean
  /** 每一类毛病的回合数，键就是 `filters` 里的 key */
  counts: Record<string, number>
  /** P3：材料用掉了几条。**两个计数 + 一个有材料却没引用的回合数，没有比率** ——
   *  分母是 `turns_with_material`（注入过材料的回合），不是 `turns`：没检索的回合
   *  （闲聊跳过 / RAG 关）注入本来就是 0，算进来就是把「没检索」读成「检索了没人用」。 */
  sources: {
    /** 窗口内**注入过材料**的回合数（这一块自己的分母） */
    turns_with_material: number
    /** 这些回合一共注入了几条材料 */
    injected: number
    /** 这些回合的正文真引用到了几条 */
    cited: number
    /** 其中有几轮**一条都没引用**——检索质量下滑最早的那个信号 */
    uncited_turns: number
  }
  filters: TurnFilter[]
  rules: { window: string; counts: string; no_rate: string; sources: string; truncated: string }
}

/** 提示词评测（R1 补齐 · PLAN5 §2-2 点名的九条之一）：登记了多少条、量过几条、几条站得住。
 *
 *  **它量的是「尺子有没有被量过」，不是「哪条提示词更好」**：所以载荷里**没有任何一条
 *  提示词的名字或分数**，界面也不许自己再算一份（那是第二份判据）。读不到时
 *  `readable=false`——「一条都没读到」与「读到了、一条都没跑过」是两件事。 */
export interface PromptEvalBoard {
  readable: boolean
  error: string
  /** 登记表里的提示词条数（分母） */
  registered: number
  /** 其中跑过 golden set、有成绩的条数（分子） */
  measured: number
  /** 其中 Wilson 区间够窄、下得了结论的条数 */
  decidable: number
  /** 其中基线跑完之后内容又改过（那个分数不是这一版的） */
  stale: number
  /** 有成绩的那些一共跑过多少条用例 */
  cases: number
  rules: { registered: string; measured: string; decidable: string; stale: string }
  /** 已知偏差：基线是某一个模型跑出来的，换模型不适用 */
  bias: string
}

/** A0 任务级基线（跑分落下来的报告，只读投影）——计量局那一格。 */
export interface AgentEvalBoard {
  readable: boolean
  error?: string
  /** 报告落在哪（人看得出来它读的是哪一份） */
  path?: string
  /** 什么时候跑的、跑的是哪一版金标（`tasks_sha`）——**这一格读的是当时的成绩** */
  at?: string
  tasks_sha?: string
  prompt_sha?: string
  model_id?: string
  seconds?: number
  tasks?: number
  done?: number
  done_rate?: number
  clean?: number
  clean_rate?: number
  /** 谎报 / 编造路径 / 伪引用那三条（长文没落盘单列，不算底线） */
  floor_failures?: number
  tool_not_allowed?: number
  tool_not_used?: number
  over_budget?: number
  errors?: number
  trace_missing?: number
  rounds?: { median: number; p90: number; max: number; mean: number }
  counts?: Record<string, number>
  by_tag?: Record<string, { tasks: number; done: number }>
  /** A1/A2 的委托读数：几个回合委托了、几次、子代理共几轮、以及「该委托而没委托」 */
  delegated_turns?: number
  delegate_calls?: number
  delegate_rounds?: number
  delegate_expected?: number
  delegate_missed?: number
  /** 报告里没有金标指纹 → 这一格比不了（`--compare` 会报「不可比」） */
  sha_missing?: boolean
  /** 口径原文（后端来，逐行照抄——界面不自己编） */
  rules?: Record<string, string>
}
