// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 prompts 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

export interface PromptItem {
  id: number
  title: string
  content: string
  created_at: string
  /** 改过的时间（没改过是空串）——列表按它排「最近动过的」 */
  updated_at: string
  /** 标签。**存的是逗号分隔的一列**，接口上给数组（全角逗号也认） */
  tags: string[]
  category: string
  favorite: boolean
  /** 0 = 还没评；1–5 */
  rating: number
  /** 从哪来的（自己写的 / 一个 URL）——「网上看到的好东西」要记出处 */
  source: string
  note: string
  /** 用过几次。**从使用记录聚合出来的**，不是自己存的一个计数 */
  used_count: number
  version_count: number
  /** 最近一次填过的变量值——复制时预填，下次不必重填 */
  last_vars: Record<string, string>
  /** 最近一次用是什么时候（空串 = 没用过）。「最近使用」按它排，不是按次数。 */
  last_used_at: string
}

/** 一条历史版本：`content` 是**改之前**那一版的样子。 */
export interface PromptVersionItem {
  id: number
  title: string
  content: string
  at: string
  sha: string
}

/** 一次使用记录。`sha` 说这一次用的是**哪一版**正文；`vars` 是那次填进去的值。 */
export interface PromptUsageItem {
  id: number
  at: string
  sha: string
  vars: Record<string, string>
}

/** 四种视图（对齐 AI Gist：卡片 / 网格 / 表格 / 文件夹）。 */
export type PromptView = 'card' | 'grid' | 'table' | 'category'

/** 列表排序。**默认「最近动过的排前面」**——库是拿来用的，不是拿来归档的。 */
export type PromptSort = 'updated' | 'used' | 'rating' | 'title'

export interface PromptFacets {
  /** 分类是**一等对象**（参照 AI Gist）：有名字、有颜色、有计数。 */
  categories: PromptCategoryItem[]
  /** 标签带计数——界面上的「翻译 (1)」是从库里数出来的，不是另养的配置。 */
  tags: PromptTagItem[]
  total: number
  uncategorized: number
}

/** 分类：成员关系在 `prompts.category`（唯一真值），颜色与顺序在这里。 */
export interface PromptCategoryItem {
  id: number
  name: string
  /** `#rrggbb`；空串 = 没挑过色，界面按名字派一个稳定的默认色 */
  color: string
  position: number
  count: number
}

export interface PromptTagItem {
  name: string
  count: number
}

/** AI 三条里「提取变量」的答复：`via` 说这一次是谁提的（模型提不动就退回本地正则）。 */
export interface PromptVarsResult {
  vars: string[]
  via: 'model' | 'local'
}

// ---------- 提示词登记表 + 对照台（Q1）----------

/** 登记表里的一条系统提示词。`sha` 是内容指纹：改了内容它就会变（测试会提醒你）。 */
export interface PromptRegistryEntry {
  name: string
  module: string
  purpose: string
  kind: string
  sha: string
  bytes: number
  /** 模块加载不出来 = 登记漂移（内容缺失） */
  drifted: boolean
  /** golden set 有几条用例；0 = 还没接线，跑不了对照 */
  cases: number
  fixture: string
  /** 领域（Q3 形态）：写在这条提示词的 golden set 里，没标就是 '' */
  domain: string
  /** 已登记内容最近一次跑出的成绩；null = 没有基线 */
  baseline: {
    at: string
    passed: number
    cases: number
    rate: number
    ci_low: number
    ci_high: number
    model_id: string
    /** 基线是用**另一版内容**跑出来的（内容改过了，基线过期） */
    stale: boolean
  } | null
}

export interface PromptInlineNote {
  module: string
  line: number
  purpose: string
}

/** 一条断言 + 它对应提示词的哪句话（`why` 由后端给，界面不抄）。 */
export interface PromptCheckSpec {
  name: string
  why: string
}

export interface PromptCaseSpec {
  id: string
  intent: string
  /** 聊天型：那次真实输入。判分型没有这个字段。 */
  user: string
  /** 聊天型：它必须满足的断言。判分型没有这个字段（判据是人工档位）。 */
  checks: string[]
  // ---- 判分型（P2-1 的重讲判分）只有下面这几样：卡三样 + 重讲原文 + 人工档位 ----
  front?: string
  back?: string
  excerpt?: string
  retell?: string
  /** 人工档位：4 简单 / 3 良好 / 2 困难 / 1 重来 / 0 = 人工也认为该「不判」 */
  grade?: number
  /** 这条的档位有争议（两处口径撞车）——摆在报告里但不计分 */
  contested?: boolean
  why?: string
}

export interface PromptRegistryEntryDetail {
  name: string
  module: string
  purpose: string
  kind: string
  sha: string
  content: string
  fixture: string
  note: string
  /** 领域（Q3 形态）：'教学' 这种短词，空 = 还没归类 */
  domain: string
  /** 用例是哪种形状：`chat` = 输入 + 断言；`grade` = 卡三样 + 人工档位 */
  case_kind: 'chat' | 'grade'
  cases: PromptCaseSpec[]
  checks: PromptCheckSpec[]
  runs: PromptCheckRun[]
}

export interface PromptCheckRun {
  id: number
  at: string
  key: string
  prompt_sha: string
  variant_sha: string
  variant_label: string
  model_id: string
  cases: number
  passed: number
  rate: number
  ci_low: number
  ci_high: number
  seconds: number
  detail_json: string
}

/** 一次对照的结果。**带 Wilson 区间**——裸比例会让人把噪声当结论。 */
export interface PromptCheckReport {
  key: string
  module: string
  purpose: string
  kind: string
  /** 判分型（P2-1）才有：判据是人工档位，不是断言。界面据此换一套说法。 */
  report_kind?: 'grade'
  prompt_sha: string
  /** 空 = 跑的是已登记内容（基线/回归）；非空 = 这是一段候选变体 */
  variant_sha: string
  variant_label: string
  model_id: string
  total: number
  passed: number
  /** **`null` = 这一趟被停了**（半趟的 k/n 会被读成「变差了」，所以不给比率）。 */
  rate: number | null
  /** Wilson 区间 [lo, hi]。`null` 同上——区间是给一个**完整**样本算的。 */
  ci: [number, number] | null
  /** 这个 n 下区间的宽度够不够下结论 */
  tell: boolean
  /** `true` = 这一趟是被「停止」打断的：没落库、没区间，`total` 是跑完的条数 */
  stopped?: boolean
  /** 计划跑多少条（`stopped` 时用来写「停在第 2/7 条」） */
  planned?: number
  assertions: { total: number; failed: number }
  seconds: number
  calls: number
  baseline: { at: string; passed: number; total: number; variant_label: string } | null
  /** 与基线比，哪几条用例翻面了 */
  flips: { id: string; was: boolean; now: boolean }[]
  context: string
  run_id?: number
  /** ---- 判分型专有（P2-1）：有序档位上的第二个数与它的偏 ---- */
  near?: number
  near_rate?: number
  near_ci?: [number, number]
  /** 它说「判不了」的条数（正当结论，但不算判对） */
  fallback?: number
  /** 高判 / 低判：提示词承诺「宁可低判不高判」，这一对就是那句话的尺子 */
  over?: number
  under?: number
  /** 4×4 混淆矩阵：`matrix[人工档][判分档] = 条数` */
  matrix?: Record<string, Record<string, number>>
  /** 有争议、不计分的那些条 */
  contested?: { id: string; expect: number; got: number; why: string }[]
  expect_source?: string
  cases: {
    id: string
    intent: string
    user: string
    checks: string[]
    passed: boolean
    failed: { name: string; why: string }[]
    reply: string
    chars: number
    seconds: number
    error: string
    /** ---- 判分型专有 ---- */
    expect?: number
    got?: number
    label?: string
    near?: boolean
    fallback?: boolean
    over?: boolean
    under?: boolean
    contested?: boolean
    why?: string
    missed_points?: string[]
  }[]
}
