// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 skills 域类型；api.ts 做 type-only 转发，全仓导入路径不变。
import type { FormDomain } from './pet'

export interface SkillItem {
  name: string
  description: string
  model?: string
  tools?: string
  files: string[]
  chars: number
}

/** 一份材料读出来的**能力候选**（环一）。`usable=false` 时只有 `reason` 有意义。 */
export interface SkillCandidateResult {
  ok: boolean
  usable: boolean
  name: string
  description: string
  instructions: string
  /** 一句话：为什么能 / 不能出能力（`ok=false` 时是没读成的原因） */
  reason: string
  /** **这次压根没问成**（网络/后端失败），不是「问过了，判定为不行」。
   *
   *  界面按 `usable` 分派文案，而失败态下它也是 false —— 没有这个标记，
   *  一次请求失败会被讲成「这份材料没出能力」，那是把两件事说成一件。
   *  只有前端造的失败结果会带它；后端正常返回时不带。 */
  failed?: boolean
  /** 材料里明显重叠的已知技能（只用来提醒「这个可能已经有了」） */
  existing: string[]
  source: string
  model_id: string
  strategy?: string
  written: boolean
  /** 同名时停下：已有那份的名字（**不覆盖**，覆盖要显式再点一次） */
  already: string
  /** 草稿落在哪（`written=true` 时才有） */
  path?: string
  chars?: number
  /** 落盘 ≠ 登记：没跑过对照、没有基线，所以永远是 false */
  registered?: boolean
  /** S2：这次是按哪几次运行判断的（「处理一项工作」三步就是三个 id） */
  runs?: number[]
  /** S2：这段工作的题目（那件「事」的名字，没有就退回任务指令） */
  topic?: string
  run_id?: number
}

export interface SkillCandidateRow {
  name: string
  description: string
  files: number
  chars: number
  /** 这一版内容跑出过成绩没有（sha 对得上才算） */
  registered: boolean
  /** 用例条数（尺子） */
  cases: number
  /** 有旧成绩、但内容改过了：那张分数不是现在这版的 */
  stale: boolean
  /** S3：**这份草稿在真实工作里被用过几次**（派生自运行日志里那条 `skill_inject`，
   *  不是第二份真值）。窗口由 `listCandidates` 那层的 `trial_window` 给——界面要说
   *  「最近 N 次运行内被用过」，**不许说「共 N 次」**：老运行会被删掉，这个数会缩水。 */
  trials: { n: number; last_at: string | null; last_ts: number | null }
  baseline: {
    at: string
    model_id: string
    cases: number
    with_passed: number
    rate: number
    ci_low: number
    ci_high: number
    /** 有它比没它多过了几条 / 少过了几条 —— 「有没有用」的直接答案 */
    helped: number
    hurt: number
    /** 「跟着工序做」的判分均值 0-5；null = 没判（不是 0 分） */
    follows_method: number | null
    seconds: number
  } | null
}

/** 一份技能的用例（尺子）+ 断言清单。**默认用哪条断言由后端给**，前端不抄一份。 */
export interface SkillCasesPayload {
  skill: string
  cases: { id: string; intent: string; ask: string; checks: string[] }[]
  model_id: string
  checks: { name: string; why: string }[]
  default_checks: string[]
  file: string
}

/** S3：一次**试用**——某次真实运行吃了这份草稿（派生自运行日志，零新表）。 */
export interface SkillTrial {
  run_id: number
  task_id: number
  task_name: string
  /** 那次的题目：有那件「事」就用它的名字，否则任务指令。它是「把这次当用例」预填的 `ask` */
  topic: string
  status: string
  started_at: string | null
  /** epoch 秒：界面用 `ago()` 说「几天前」要按真实时刻算（naive ISO 被当本地时间会错几小时） */
  at_ts: number | null
  /** 接地分 0-5；null = 没打分（没材料 / 判分没跑成），不是 0 分 */
  grounded: number | null
  /** 这次运行吃到的全部技能（一次最多两份） */
  skills: string[]
  /** 那次产出的预览（给人判「这次试用算不算数」用，正文在运行详情里） */
  answer: string
}

/** 一份草稿的试用记录。**`window` 必须显示出来**：数是窗口内的、会缩水。 */
export interface SkillTrials {
  skill: string
  window: number
  n: number
  last_at: string | null
  last_ts: number | null
  trials: SkillTrial[]
}

/** 一次技能跑分的报告。**`tell=false` 时不许下结论**（区间太宽 / 用例太少）。 */
export interface SkillEvalReport {
  skill: string
  sha: string
  model_id: string
  cases: {
    id: string
    intent: string
    ask: string
    without_ok: boolean
    with_ok: boolean
    delta: number
    follows_method: number | null
    judge_why: string
    with_reply: string
    without_reply: string
    error_with: string
    error_without: string
  }[]
  total: number
  with_passed: number
  /** **`null` = 这一趟被停了**（理由同 `PromptCheckReport.rate`） */
  rate: number | null
  ci: [number, number] | null
  /** `true` = 被「停止」打断：没写基线、没区间 */
  stopped?: boolean
  planned?: number
  tell: boolean
  deltas: { helped: number; hurt: number; same: number }
  follows_method: number | null
  seconds: number
  /** 这次跑分花了几次模型调用（用例数 × 2 + 判分） */
  calls: number
  cases_needed: number
  run_id?: number
}

export interface FormReport {
  domains: FormDomain[]
  min_cases: number
  min_concepts: number
}
