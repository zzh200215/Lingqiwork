// 零柒的主动提醒（方向 6 第四刀，2026-09-29 自 PetWidget 拆出）：
// 宠物跨模块看到的「你欠的账」，挑最急的一件先开口。纯逻辑，无 React。
import {
  api,
  type CardContradiction,
  type CardStats,
  type DecisionWitness,
  type DeliverWitness,
  type ScheduledTask,
  type TutorStuckRow,
} from './api'
import { ago } from './reltime'

/** 主动提醒：宠物跨模块看到的「你欠的账」，挑最急的一件先开口。
 *
 *  和 feed（任务/摘要/备份的系统事件）分工：feed 是「系统发生了什么」，
 *  nudge 是「**你**有什么没处理」——等你点头的工作流、跑挂的任务、攒着的卡点、
 *  到期没过的卡。安静是默认：一件都没有就一个字都不冒。
 *  同一件事一天只念一次（localStorage 按日期记账），别变成唠叨。
 */
export interface Nudge {
  key: string
  text: string
  to: string
  toLabel: string
}

export const nudgeStorageKey = (k: string) =>
  `pet:nudged:${new Date().toISOString().slice(0, 10)}:${k}`

export function wasNudged(key: string): boolean {
  try {
    return localStorage.getItem(nudgeStorageKey(key)) === '1'
  } catch {
    return false
  }
}

export function markNudged(key: string): void {
  try {
    localStorage.setItem(nudgeStorageKey(key), '1')
  } catch {
    /* 无痕模式下记不了就不记，顶多今天多念一遍 */
  }
}

/** 台词里的引文一律先裁再进句子：气泡是一行，长依据会把那一行撑成一段。 */
function cut(s: string, n: number): string {
  const t = (s || '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 顺序即优先级：等你点头 > 跑挂了 > 卡点 > 到期卡 > 到点的决策见证 > **到点的交付见证**。
 *
 *  前四条都是「今天不处理会挡住、会过期」的事；两条见证排在最后，因为**它们不挡任何事**
 *  （`cards.reschedule` 那条纪律：主动开口越少越好）。但排在最后不等于可以永不开口——
 *  它们是唯一两个「不主动说就永远不会有下次机会」的来源：其余四条下次开机还在，
 *  而一条三个月前的判断、一份三周前交出去的东西，只有被念到才会有人回头看
 *  （理由写在 `core/decision_log.py` 与 `core/delivery.py`）。
 *  一天只念一条（服务端只回一条 + 这里的 localStorage 记账），念的是**当时的事实**：
 *  判断原文 + 当时的依据 + 当时的信心（或：交给了谁 + 什么东西 + 多久以前），不催、不评。
 *
 *  **第六个来源（交付见证）是一次明确让开**（M5 · PLAN3 §13）：同 `decision_log` 那个理由
 *  ——一份交出去的东西沉在 `deliver/` 里，纯拉取式的下场同样是没人回头看，而它比判断更短命
 *  （连一条记录都没有，真值只在文件系统里）。代价一起写在原地：这一层的「回看过」只有
 *  👍/👎 那一个动作，所以定义偏弱（`core/delivery.py` 里写明了为什么要求 24 小时的时差）。
 *  下面那句「§2 T1：不加第六个来源」说的是**当时那件事**（对质那句话只换措辞、不加来源），
 *  不是一条永久禁令——但每加一个都得像这次一样，把「为什么它值得开口」写在原地。
 *
 *  **到期卡那条会换一句话**（PLAN2 T1 场景 A）：卡对应的概念你已经说通 ×2、可它的卡这周
 *  反复重来（≥2）时，念的是那句对质——「你说通过两次，可它的卡这周重来三回，再讲一遍？」。
 *  换的只是**那句话的内容**：来源、优先级、key、去处一样没动。
 *  它只陈述两边的事实，不判谁对——「再讲一遍？」是个问句，裁决权在你。
 *
 *  每个请求各自兜底，挂了当没有。 */
export async function gatherNudges(): Promise<Nudge[]> {
  const [tasks, stuck, stats, witness, delivered] = await Promise.all([
    api.listTasks().catch((): ScheduledTask[] => []),
    api.tutorStuck().catch((): { stuck: TutorStuckRow[] } => ({ stuck: [] })),
    api.cardStats().catch((): CardStats | null => null),
    api.decisionWitness().catch((): DecisionWitness | null => null),
    api.deliverWitness().catch((): DeliverWitness | null => null),
  ])
  const out: Nudge[] = []
  for (const t of tasks) {
    if (t.awaiting_run_id != null)
      out.push({
        key: `approve-${t.id}`,
        text: `「${t.name}」跑完一步了，等你点头才继续。`,
        to: `/work?tab=workflow&task=${t.id}`,
        toLabel: '去放行',
      })
  }
  for (const t of tasks) {
    if (t.enabled && t.awaiting_run_id == null && t.last_status === 'error')
      out.push({
        key: `failed-${t.id}-${t.last_run ?? ''}`,
        text: `「${t.name}」上次跑挂了，失败原因我给你留着。`,
        to: `/work?tab=workflow&task=${t.id}`,
        toLabel: '去看看',
      })
  }
  const open = stuck.stuck.filter((s) => !s.resolved_at)
  if (open.length > 0)
    out.push({
      key: 'stuck',
      text:
        open.length === 1
          ? `「${open[0].concept}」还卡着，要不要现在把它说通？`
          : `攒了 ${open.length} 个卡点没解，清一个是一个。`,
      to: '/tutor',
      toLabel: '去清卡点',
    })
  if (stats && stats.due_now > 0) {
    // 只有真的有到期卡时才去问那句对照（省一次往返，也免得为一个没人看的数开口）
    const x = await api.cardContradiction().catch((): CardContradiction | null => null)
    const c = x?.contradiction
    out.push(
      c
        ? {
            key: 'due',
            // 数字全读得出来才说：说通几次、重来几回，两个数都来自后端算出来的事实。
            // 「再讲一遍？」——**问句不是判决**：不说「你其实没懂」，不替你改任何判定。
            text: `「${cut(c.concept, 24)}」你说通过 ${c.said_n} 次，可它的卡这周重来 ${c.again_7d} 回，再讲一遍？`,
            to: '/review',
            toLabel: '去重讲',
          }
        : {
            key: 'due',
            text: `今天还有 ${stats.due_now} 张卡没过，趁脑子还在。`,
            to: '/review',
            toLabel: '去复习',
          }
    )
  }
  if (witness?.due) {
    const w = witness.due
    // 「几个月前」按天算：90 天 ≈ 3 个月。不足一个月就说天数，别把三周说成「1 个月」。
    const age = w.age_days >= 30 ? `${Math.round(w.age_days / 30)} 个月前` : `${w.age_days} 天前`
    const basis = cut(w.basis, 30)
    out.push({
      key: `witness-${w.id}`,
      // **引用原文依据**：这条提醒的全部价值就是「当时的你怎么想」，转述一遍就没了。
      // 没有依据那一栏就只说到「当时几成把握」——宁可少一句，也不替当时的你编一个理由。
      // 把握写成 `%`（与决策日志页那一行同一个写法）：`70` 后面接「成」会读成七倍。
      text: `${age}你判断：「${cut(w.text, 40)}」。当时 ${w.confidence}% 把握${
        basis ? `，凭的是「${basis}」` : ''
      }。`,
      to: `/dashboard?decision=${w.id}`,
      toLabel: '翻回去看看',
    })
  }
  if (delivered?.due) {
    const d = delivered.due
    // 交给谁那一栏可能空着（老交付没有 frontmatter，或当初就没填）——那就只说「交出去的」，
    // 不替当时的你补一个收件人。
    const who = d.audience ? `交给${d.audience}的` : '交出去的'
    out.push({
      key: `delivered-${d.path}`,
      // 事实三样：多久以前、什么东西、给谁。**问句结尾**——「后来有回音吗」不是「你该去回访」。
      text: `${ago(d.at)}${who}《${cut(d.title, 30)}》—— 后来有回音吗？`,
      to: `/notes?path=${encodeURIComponent(d.path)}`,
      toLabel: '翻回去看看',
    })
  }
  return out
}
