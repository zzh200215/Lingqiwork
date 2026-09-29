// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 pet 域类型；api.ts 做 type-only 转发，全仓导入路径不变。
import type { WorkOutput } from './work'

/** 零柒说过的一句话（`pet_events` 的一行）。挂件的气泡与今天页的「最近说的」共用它。 */
export interface PetEvent {
  id: number
  kind: string
  text: string
  detail: string
  created_at: string
}

// ---------- 零柒：成长 + 能力插件（Track B） ----------

/** 成长的一个来源（「把东西搞懂」等）。全部是累计量，所以只增不减。 */
export interface PetGrowthPart {
  key: 'learning' | 'teach' | 'work' | 'habits' | 'review'
  label: string
  exp: number
}

/** 零柒的成长：等级 / 称号 / 累计 EXP。**只有累计与达成，没有「还欠 N」。** */
export interface PetGrowth {
  level: number
  title: string
  exp: number
  /** 「正在靠近」的下一级称号；空 = 已到顶 */
  next_title: string
  /** 0-1 的进度条（只用来画条，界面不显示「还差 N」） */
  progress: number
  parts: PetGrowthPart[]
  counts: Record<string, number>
  /** 称号旁那一行**风味小注**（Z4）：按喂养分布说一句事实（「这阵子喂它最多的是…」）。
   *  **空串 = 数不出来或开关关着**，界面上那一行干脆不出现（不猜、不硬凑）。 */
  flavor: string
}

/** 插件面板：哪种面板 + 它要显示的数。sdk 里叫「面板」。 */
export interface PetPluginPanel {
  kind: 'counter' | 'timer' | 'mood'
  unit?: string
  target?: number
  value?: number
  running?: boolean
  remaining?: number
  minutes?: number
  default_minutes?: number
  /** mood：1–5 的量表上限 */
  scale?: number
  /** mood：记录过的天数 */
  days?: number
  /** mood：最近几天（旧→新），画一条小曲线用 */
  recent?: { day: string; value: number }[]
}

/** 一个装好的能力插件（openpets 范式：权限 / 配额 / 存储 / 计划 / 事件 / 命令 / 面板）。 */
export interface PetPlugin {
  name: string
  label: string
  enabled: boolean
  permissions: string[]
  commands: string[]
  panel: PetPluginPanel
  quota: { used: number; cap: number }
}

export interface PetPluginCommandResult {
  ok: boolean
  name: string
  command: string
  panel: PetPluginPanel
  said: string | null
}

/** 零柒**此刻**的状态（P1 · 维度一）：摆什么姿势、说什么话、还剩多少精神。
 *
 *  与 `PetGrowth` 刻意分开：成长是**累计**（只增不减），状态是**当下**——
 *  跨天自然归零、不记账、没有「还欠 N」。精力说的是「我有点蔫」，
 *  不是「你欠了 3 小时专注」。 */
export type PetStateMode =
  | 'idle'
  | 'focusing'
  | 'working'
  | 'learning'
  | 'reviewing'
  | 'celebrating'
  | 'gated'
  | 'busy'
  | 'idling'
  | 'pupil'
  | 'resting'
  | 'tired'
  | 'sleepy'
  /** P2：连着几个晚上熬到很晚 → 蔫。与 `tired` 同一个姿势，靠台词区分 */
  | 'night_owl'
  /** P5：好几天没见 → 久别重逢。挥手的姿势，台词里带着「走的时候在拆什么」 */
  | 'returning'

export interface PetState {
  mode: PetStateMode
  /** 直接对应 `frontend/public/pet/<action>.webp` 那九个动画 */
  action: string
  /** 0–100，此刻的精神。不是要还的债。 */
  energy: number
  /** 零柒此刻的一句话；`idle` 时是空串（安静是默认） */
  line: string
  path: string
  /** 此刻在跑的是什么（引擎的中文名，如「复盘」）；没有名字的运行是空串。 */
  busy_with?: string
  /** 停在人工卡点上等你点头的件数。**只报事实**，界面别写成「你还欠 N 件」。 */
  gated?: number
}

/** 跟零柒的一轮问答（P5 落库后的回放）。`tools` 是那一轮它真的做了什么——
 *  形状与 `petChat.PetToolReceipt` 一致，回放时面板照样摆得出那排小 chip。 */
export interface PetChatMsg {
  id: number
  created_at: string
  role: 'user' | 'pet'
  text: string
  tools?: { tool: string; plugin: string; command: string; panel: Record<string, unknown>; said: string | null }[]
}

/** 小屋里的一件东西（P4）：某个真实累计量跨过一个门槛的结果。
 *
 *  **日期是跨过门槛的那一刻**（第 5 份成品落盘的时间），不是「最近一次」——
 *  所以它稳定：明天再多交两份，这件东西还是那天到手的。
 *
 *  时间给两个字段是刻意的（后端注释里有完整来由）：`at` 是本地墙钟串给人看，
 *  `at_ts` 是 epoch 用来排序和算「多久以前」——前端因此不必猜时区。 */
export interface PetThing {
  id: string
  /** `badge` 第一次那枚 / `prop` 屋里的一件摆设 / `output` **刚叼回来的那份成品** */
  kind: 'badge' | 'prop' | 'output'
  module: string
  module_label: string
  icon: string
  label: string
  /** 一句事实：「第 5 份成品」 */
  detail: string
  at: string
  at_ts: number
  count: number
  /** 这件东西对应架上哪一份成品（**只有 `kind='output'` 时有**）。
   *  小屋据此在架上那一行标出「它刚叼回来的」——不自己再算一遍谁最新。 */
  ref?: string
}

/** 今天喂了它什么：**每条线今天的真实成果**，一条一件。 */
export interface PetMeal {
  key: string
  module: string
  module_label: string
  icon: string
  label: string
  count: number
}

/** 屋里的一张**概念卡**（P2 · F13）：学习地图在小屋里的镜子。
 *
 *  与技能卡、枝都不同：它照的是**此刻在哪一档**（已掌握 / 在学 / 卡住），所以同一个
 *  概念的卡会变色——它不是到手了就永远不变的东西。`state` 就是地图那一档，
 *  屋里**不重判**（「一场是运气、两场才算」只有 `tutor.is_mastered` 一份）。
 *
 *  「未触及」不在这份契约里：那是「拆出来还没开成教」的点，一张「还没做的事」的
 *  清单，小屋不摆账（后端连读都不读它）。词与色在 `conceptState.ts` 一处。 */
export interface PetConceptCard {
  id: string
  name: string
  /** mastered | learning | stuck（认不出来的档照实显示档位名，不猜颜色） */
  state: string
  /** 这个概念的会话数（自评 got / half 的那些） */
  sessions: number
  /** 卡在哪——**只有 stuck 那一档有**，别的档一律空串 */
  stuck: string
  at: string
  at_ts: number
}

export interface PetConceptCards {
  /** 最近碰到的那些（最多 12 张），新 → 旧 */
  cards: PetConceptCard[]
  /** 镜子照到的全量，**不含「未触及」**。比 `cards` 多时界面要说「共 N 个」 */
  total: number
}

/** 屋里的**技能卡**（Q2）：跑过对照的提示词才算技能。
 *
 *  「技能只有一个到手方式：它被证明有效过」——没有基线的提示词不是技能，是一段还没验过的
 *  文本，宠物不展示它。`stale` 是诚实的一部分：基线跑完之后内容又改过，卡上的分数就不是
 *  这一版的了。 */
export interface PetSkillCard {
  name: string
  module: string
  purpose: string
  kind: string
  sha: string
  /** 领域（Q3 形态）：卡片按它进对应那根枝；'' = 这套用例还没归类 */
  domain: string
  passed: number
  cases: number
  rate: number
  ci_low: number
  ci_high: number
  at: string
  model_id: string
  stale: boolean
}

/** 形态（Q3）：一个领域的三个数。三样都够 → `grown`。
 *
 *  **只由可验证的能力算**：检索质量、已掌握的概念数、技能卡的通过率。**不是**上传量——
 *  这个仓库不微调，堆文件只改变检索覆盖，堆出来的形态是纯装饰。
 *
 *  `enough === false` 的那一样只说「样本不足」，界面上**不许写成「还差 N」**：那正是
 *  这个项目一直在躲的欠账口吻。 */
export interface FormRetrieval {
  enough: boolean
  /** 这次真的算进去的题数（最近一次覆盖够的评测里，这个领域的那几条） */
  cases: number
  /** 这个领域一共标了多少条源（`cases` 可能更少：评测是过去跑的） */
  labelled: number
  hits: number
  hit_rate: number | null
  ci_low: number | null
  ci_high: number | null
  faithfulness: number | null
  /** 忠实度是判过几条算出来的——只判了 1 条时，那个平均不是「平均水平」 */
  judged: number
  run_id: number | null
  at: string | null
  note: string
}

export interface FormConcepts {
  enough: boolean
  mastered: number
  seen: number
  names: string[]
  at: string
}

export interface FormSkill {
  name: string
  purpose: string
  passed: number
  cases: number
  rate: number
  ci_low: number
  ci_high: number
  at: string
  stale: boolean
  enough: boolean
}

export interface FormDomain {
  domain: string
  retrieval: FormRetrieval
  concepts: FormConcepts
  skills: FormSkill[]
  /** 三样都够。小屋只摆长出来的那些 */
  grown: boolean
}

/** 零柒的小屋：攒下的东西（道具 / 徽章）、架上的真产出、今天喂了什么、学会的技能、
 *  记住的概念（学习地图的镜子）。
 *
 *  `carried` 是**它身上挂着的那件**：屋里最新到手的一件，或一份刚交出去的成品——
 *  门槛是稀疏的（第 1、5、25 份），而「交出一份成品 → 它叼回来」每一份都发生。
 *
 *  **屋里有两类东西，规矩不一样**（后端 `pet_room` 的 docstring 里有完整来由）：
 *  攒下的（`things` / `today`）跨过门槛就多一件、只增不减；镜子（`concepts`，
 *  也可能是一根还没长成的枝）照的是**此刻**，状态会来回动。
 *
 *  空屋子只是空的——**没有「还差 N 件」「它饿了」这种欠账口吻**。 */
export interface PetRoom {
  things: PetThing[]
  carried: PetThing | null
  shelf: WorkOutput[]
  today: { meals: PetMeal[]; date: string }
  /** 它学会的技能（Q2）：只收跑过对照的提示词 */
  skills: PetSkillCard[]
  /** 它长出的枝（Q3）：**只收三样都够的领域**。少了哪一样都不进屋 */
  form: FormDomain[]
  /** 它记住的概念（P2 · F13）：学习地图的镜子。**「未触及」不在这里面** */
  concepts: PetConceptCards
  /** 喂养风味（Z4）：这一行与成长页那一行**同源**（都来自 `pet_tone.flavor()`）。
   *  小屋没有称号可以摆在旁边，所以它摆在小屋顶上——「喂它什么」正是这一页的题眼。
   *  **空串 = 数不出来或开关关着**：一个字都不摆。 */
  flavor: string
  empty: boolean
}
