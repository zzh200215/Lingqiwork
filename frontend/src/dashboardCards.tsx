// 方向 6 第五刀（2026-09-29）：自 DashboardPage 拆出的指标卡——
// 北极星/校准/过程/技能闭环/双轨矛盾率 + 叙事卡与功能用量。口径注释原样随迁。
// 测试（DashboardPage.test.tsx）引用的名字经 DashboardPage.tsx re-export，路径不变。
import { Link } from 'react-router-dom'
import {
  type CardCalibration,
  type CardGapRate,
  type NorthStar,
  type PrereqAdoption,
  type ProcessMetrics,
  type SessionCalibration,
  type SkillLoop,
  type UsageFeatureRow,
} from './api'

// 信念时间线的月份标签：ISO 时间 → 「3月」
export function monthOf(iso: string | null): string {
  if (!iso) return '?'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '?' : `${d.getMonth() + 1}月`
}

/** 0-1 → 百分比整数（校准分显示用） */
export function pct(r: number): string {
  return `${Math.round(r * 100)}%`
}

/** ISO → M/D（决策日志里按天看就够） */
export function dayOf(iso: string | null): string {
  if (!iso) return '?'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '?' : `${d.getMonth() + 1}/${d.getDate()}`
}

export function NarrativeCard({
  tone,
  eyebrow,
  headline,
  label,
  sub,
  href,
}: {
  tone: 'violet' | 'fuchsia' | 'emerald' | 'sky' | 'rose'
  eyebrow: string
  headline: string
  label: string
  sub: string
  href: string
}) {
  const toneClasses: Record<typeof tone, string> = {
    violet: 'from-violet-600 to-fuchsia-600',
    fuchsia: 'from-fuchsia-600 to-pink-500',
    emerald: 'from-emerald-600 to-teal-500',
    sky: 'from-sky-600 to-cyan-500',
    rose: 'from-rose-600 to-orange-500',
  }
  return (
    <Link
      to={href}
      className="group block rounded-lg border border-neutral-200 bg-white p-5 transition-all hover:border-violet-300 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-violet-500/40"
    >
      <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">{eyebrow}</p>
      <p className={`mt-2 bg-gradient-to-r bg-clip-text text-3xl font-bold text-transparent ${toneClasses[tone]}`}>
        {headline}
      </p>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className="mt-2 text-xs font-medium text-violet-600 dark:text-violet-400">{sub}</p>
    </Link>
  )
}

/** 北极星（PLAN §7）：周内「重讲作答 ≥1 且 消化材料 ≥1」的天数 / 7。
 *
 *  三条刻意的选择，都写在这里免得下一个人"顺手优化"掉：
 *  1. **只画曲线**：没有目标线、没有百分比、没有排名——口径原文从后端来（`rules`），
 *     界面上照抄，同一个词在两处必须是一个意思；
 *  2. **读不到就说读不到**：不给一条全零的曲线充数（零是"什么都没发生"）；
 *  3. **一句话都不催**：0 天的时候也不写「还差 N 天」「加油」——那正是这个仓库封存过的机制。
 *
 *  （导出是给测试用的：这一格的规矩都在这张卡里，见 `DashboardPage.test.tsx`。）
 */
/** 功能真实用量（CTO review #6）：账本按操作名聚合——「30 天自用窗口」的读数。
 *
 *  只摆事实：哪个功能发生过几次、烧了多少 token。零记录 ≠ 不存在——是还没被用过，
 *  裁决（留/删）等窗口结束拿数据说话。读不到（接口挂了）整卡不摆，不占位。
 *
 *  方向 4 补的第二只读：`pageOpens` 是各页**打开过的天数**——只读面不跑模型，
 *  没有它，那些面在裁决的尺子上是盲的。没拉到就不摆（读不到 ≠ 零）。
 */
export function UsageFeaturesCard({
  rows,
  pageOpens,
}: {
  rows: UsageFeatureRow[] | null
  pageOpens?: Record<string, number> | null
}) {
  if (rows === null) return null
  const total = rows.reduce((n, r) => n + r.spans, 0)
  const opens = Object.entries(pageOpens ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([page, days]) => `${page} ${days} 天`)
  return (
    <section className="wb-card p-5" data-usage-features>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">功能真实用量</h2>
        <span className="text-xs text-neutral-400">账本实测 · 全部历史</span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-xs text-neutral-400">还没有任何模型调用记录。</p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {rows.map((r) => (
            <li key={r.kind}>
              <div className="flex items-center justify-between text-xs">
                <span className="truncate font-mono text-neutral-600 dark:text-neutral-300">{r.kind}</span>
                <span className="ml-2 shrink-0 text-neutral-400">
                  {r.spans} 次 · {r.calls} 调用 · {r.tokens} tok
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all"
                  style={{ width: `${total > 0 ? Math.round((r.spans / total) * 100) : 0}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {opens.length > 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-neutral-400" data-page-opens>
          打开过的页面（不跑模型也计数）：{opens.join(' · ')}
        </p>
      ) : null}
      <p className="mt-3 text-xs leading-relaxed text-neutral-400">
        「30 天自用窗口」的读数：零记录的功能不是不存在，是还没被用过——裁决等数据说话。
      </p>
    </section>
  )
}

export function NorthStarCard({ n }: { n: NorthStar | null }) {
  if (!n) return null
  const today = n.days[n.days.length - 1]?.date
  return (
    <section
      data-north-star
      className="wb-card p-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">北极星</h2>
        <span data-north-star-count className="text-2xl font-bold tabular-nums text-violet-600 dark:text-violet-300">
          {/* 读不到时**不摆 0/0**：那个数会读成「七天里一天都没有」，与「没读到」是两回事 */}
          {n.readable ? `${n.counted}/${n.denominator}` : '—'}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          天：同一天里「讲了一遍」和「消化了一份」都发生过
        </span>
        <div className="flex-1" />
        <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
          {n.window.start.slice(5)} – {n.window.end.slice(5)}
        </span>
      </div>

      {!n.readable ? (
        <p data-north-star-error className="mt-2 text-xs text-rose-500">
          这条曲线现在读不出来（{n.error}）。零是「什么都没发生」，读不到是另一回事——不拿零充数。
        </p>
      ) : (
        <>
          <div className="mt-4 flex items-end gap-2">
            {n.days.map((d) => (
              <div
                key={d.date}
                data-north-star-day={d.date}
                data-counted={d.counted ? '1' : '0'}
                className="flex flex-1 flex-col items-center gap-1"
              >
                <div className="flex h-16 w-full flex-col justify-end gap-0.5">
                  <div
                    data-north-star-retell={d.retell}
                    title={`重讲作答 ${d.retell} 次`}
                    className={`w-full rounded-t ${
                      d.retell ? 'bg-violet-500' : 'bg-neutral-200 dark:bg-neutral-800'
                    }`}
                    style={{ height: d.retell ? '50%' : '6px' }}
                  />
                  <div
                    data-north-star-digested={d.digested}
                    title={`拆出 ${d.digested} 个点`}
                    className={`w-full rounded-b ${
                      d.digested ? 'bg-fuchsia-400' : 'bg-neutral-200 dark:bg-neutral-800'
                    }`}
                    style={{ height: d.digested ? '50%' : '6px' }}
                  />
                </div>
                <span
                  className={`text-xs tabular-nums ${
                    d.date === today
                      ? 'font-semibold text-violet-600 dark:text-violet-300'
                      : 'text-neutral-400 dark:text-neutral-500'
                  }`}
                >
                  {d.date.slice(5)}
                </span>
                <span className="text-xs text-violet-500">{d.counted ? '✓' : ''}</span>
              </div>
            ))}
          </div>
          {n.counted === 0 ? (
            <p data-north-star-empty className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
              这 7 天里还没有一天两件事都发生过。上面每一格的两条柱子，就是那天的两件事。
            </p>
          ) : null}
        </>
      )}

      {/* 口径与已知偏差：直接来自后端（`rules`），界面不自己编一份说法 */}
      <p data-north-star-rule className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
        「重讲」= {n.rules.retell}；「消化」= {n.rules.digested}。{n.rules.bias}
      </p>
    </section>
  )
}

const GRADE_ROWS: { g: number; label: string }[] = [
  { g: 1, label: '重来' },
  { g: 2, label: '困难' },
  { g: 3, label: '良好' },
  { g: 4, label: '简单' },
]

/** 校准曲线（PLAN2 T2 · N1）。三件事与北极星同一条纪律：
 *
 *  1. **只画分布**：不设目标线、不给百分比、不排名——差值那一格写的是「自评 − 判分 = x 档」，
 *     一个事实，不是「你高估了自己」那句判决（PLAN2 §8.5：那句话永远不说出口）；
 *  2. **读不到就说读不到**：不给两条全零的分布充数（零是「一条都没有」）；
 *  3. **一处都不催**：`n_self`/`n_judged` 是事实，不是「快去重讲几张凑样本」。
 *
 *  页脚那几行**原文来自后端**（`notes`）：历史行是未知 / 账本没存提示词版本。
 *  **第一条（判分器的基线）单独提成一行**——它说的是「这把尺子准不准」，
 *  而不是「这条曲线怎么读」：没跑过金标集时，这条曲线的**绝对值根本不成立**。
 *  最后一行把**当前判分器的指纹**摆出来——曲线是按那一版判分器算的，这一格必须看得见。
 *
 *  （导出是给测试用的，同 `NorthStarCard`：这一格的规矩都在这张卡里。）
 */
export function CalibrationCard({
  c,
  s,
}: {
  c: CardCalibration | null
  /** 会话侧那半（P2-3）：**自己标的** vs **让它判的**。没有就不显示这一段。 */
  s?: SessionCalibration | null
}) {
  if (!c) return null
  const selfMax = Math.max(1, ...Object.values(c.self_dist || {}))
  const judgedMax = Math.max(1, ...Object.values(c.judged_dist || {}))
  const empty = c.n_self === 0 && c.n_judged === 0
  // 后端把「基线」摆在 `notes[0]`（`cards.calibration` 的 `[_baseline_note(), *CALIB_NOTES]`），
  // 另外两条是常年不变的口径。这里按位置拆开：**基线单独提一行**（它说的是「这把尺子准不准」），
  // 剩下两条留在页脚。位置约定写在这里，是因为契约就在后端那一行的顺序上。
  const baseline = c.notes?.[0] ?? ''
  const notes = c.notes?.slice(1) ?? []
  return (
    <section
      data-calibration
      className="wb-card p-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">校准</h2>
        <span
          data-calibration-delta
          className="text-2xl font-bold tabular-nums text-sky-600 dark:text-sky-300"
        >
          {/* 没有对过账时不摆 0：0 读作「你和它判得一样准」，那是另一件事 */}
          {c.delta === null ? '—' : `${c.delta > 0 ? '+' : ''}${c.delta}`}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          档：自评 − 判分（正数 = 给自己打的档更高）
        </span>
        <div className="flex-1" />
        <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
          滚动 {c.days} 天 · 自评 {c.n_self} · 判分 {c.n_judged}
        </span>
      </div>

      {/* **判分器的基线**（PLAN2 P2-1）单独摆一行，不混进页脚那三条须知里。
          理由：这条曲线的 y 轴是「这台判分器判得比你严还是松」，而那句话成立与否，
          取决于它跟人对得上多少——**没跑过金标集时，这条曲线的绝对值根本不成立**。
          这是读这张卡之前必须先知道的一件事，埋在页脚第一条小字里等于没说。
          三种状态（跑过 / 跑过但是旧版 / 没跑过）全部由后端决定，这里照抄。 */}
      {baseline ? (
        <p
          data-calibration-baseline
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200"
        >
          <span className="font-medium">判分器基线</span>：{baseline}
        </p>
      ) : null}

      {!c.readable ? (
        <p data-calibration-error className="mt-2 text-xs text-rose-500">
          这条曲线现在读不出来（{c.error}）。零是「一条都没有」，读不到是另一回事——不拿零充数。
        </p>
      ) : empty ? (
        <p data-calibration-empty className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
          这 {c.days} 天里还没有可对账的行：复习一次（自评或重讲都算）就会落在这里。
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          {GRADE_ROWS.map(({ g, label }) => (
            <div key={g} className="flex items-center gap-2 text-xs">
              <span className="w-8 shrink-0 text-neutral-500 dark:text-neutral-400">{label}</span>
              <div className="h-3 flex-1 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
                <div
                  data-calibration-self={g}
                  className="h-full rounded-r bg-violet-500"
                  style={{
                    width: `${(((c.self_dist?.[g] ?? 0) / selfMax) * 100).toFixed(1)}%`,
                  }}
                  title={`自评「${label}」${c.self_dist?.[g] ?? 0} 次`}
                />
              </div>
              <span className="w-6 shrink-0 text-right tabular-nums text-neutral-400">
                {c.self_dist?.[g] ?? 0}
              </span>
              <div className="h-3 flex-1 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
                <div
                  data-calibration-judged={g}
                  className="h-full rounded-r bg-sky-500"
                  style={{
                    width: `${(((c.judged_dist?.[g] ?? 0) / judgedMax) * 100).toFixed(1)}%`,
                  }}
                  title={`判分器判「${label}」${c.judged_dist?.[g] ?? 0} 次`}
                />
              </div>
              <span className="w-6 shrink-0 text-right tabular-nums text-neutral-400">
                {c.judged_dist?.[g] ?? 0}
              </span>
            </div>
          ))}
          <p className="flex gap-3 pl-10 text-xs text-neutral-400 dark:text-neutral-500">
            <span className="text-violet-500">■ 你自评</span>
            <span className="text-sky-500">■ 判分器判</span>
          </p>
        </div>
      )}

      {/* 三条须知里剩下的两条 + 判分器指纹：原文来自后端，界面不自己编一份说法。
          第一条（基线）已经单独提到上面那一行去了，所以这里从第二条开始摆。 */}
      {notes.map((n) => (
        <p
          key={n}
          data-calibration-note
          className="mt-2 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500"
        >
          {n}
        </p>
      ))}
      {c.judge_sha ? (
        <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
          判分器指纹 <span data-calibration-sha className="font-mono">{c.judge_sha}</span>
          ——曲线是按这一版判分器算的。
        </p>
      ) : null}
      {/* 按版本分段（PLAN2 §9.4）：换过版之后这条曲线上就不是一把尺子了。
          混版那句警告由后端插在 `notes` 里（这里照抄），这一段只补**每一版各判了什么**。 */}
      {c.segments.length > 0 ? (
        <p
          data-calibration-segments
          className="mt-1 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500"
        >
          分段：
          {c.segments.map((s, i) => (
            <span key={s.sha || 'unknown'} data-calibration-segment={s.sha || ''}>
              {i > 0 ? ' · ' : ''}
              {s.current ? '本版 ' : s.sha ? `${s.sha.slice(0, 6)} ` : '版本未知 '}
              {s.n} 条
              {s.mean != null ? `（均值 ${s.mean}）` : ''}
            </span>
          ))}
        </p>
      ) : null}

      {/* 会话侧（PLAN2 P2-3）：同一张卡上的另一半——那里比的是**两个总体**（自己标的 vs
          让它判的），而不是同一批会话的对照。所以摆的是两个计数和一个差，**不摆百分比**；
          两边的样本不是同一批、样本又小，这两件事都写在下面那行口径里（后端给的原文）。 */}
      {s ? (
        <div
          data-session-calibration
          className="mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">会话侧</h3>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">说通 /（说通+半懂）</span>
            <span
              data-session-self
              className="text-lg font-bold tabular-nums text-violet-600 dark:text-violet-300"
            >
              {s.self.n ? `${s.self.dist.got}/${s.self.n}` : '—'}
            </span>
            <span className="text-xs text-neutral-400">自己标的</span>
            <span
              data-session-judged
              className="text-lg font-bold tabular-nums text-sky-600 dark:text-sky-300"
            >
              {s.judged.n ? `${s.judged.dist.got}/${s.judged.n}` : '—'}
            </span>
            <span className="text-xs text-neutral-400">让它判的</span>
            <div className="flex-1" />
            <span
              data-session-gap
              className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400"
            >
              {s.gap === null ? '差 —' : `差 ${s.gap > 0 ? '+' : ''}${s.gap}`}
            </span>
          </div>
          {!s.readable ? (
            <p data-session-error className="mt-2 text-xs text-rose-500">
              这半边现在读不出来（{s.error}）。
            </p>
          ) : null}
          <p
            data-session-rule
            className="mt-2 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500"
          >
            {s.rules.rate}。{s.rules.confound}
            {s.rules.mixed ? ` ${s.rules.mixed}` : ''}
            {s.rules.sample ? ` ${s.rules.sample}` : ''}
          </p>
        </div>
      ) : null}
    </section>
  )
}

/** 过程指标（PLAN §7.2 · 半懂率按周）。与北极星同一条红线的第二条曲线：
 *  那条说「这周动没动」，这条说「动的那部分有没有落下」。
 *
 *  三条纪律：
 *  1. **不摆百分比**（沿 §7.1 的先例）：写的是「半懂 12 / 共 27 场」，比率只在柱子高度里。
 *     一旦写成「44% 半懂」，它会立刻变成一个要压低的考核数——而压低它最省事的办法
 *     就是少标「半懂」，那正好把这个数变成假的；
 *  2. **空的一周是空的**：`rate` 为 `null` 的那一格画成一条浅灰底线、标 `—`——
 *     「这周没开过教学」与「这周全都说通了」不是一件事，也不该长得一样；
 *  3. **一处都不催**：没有目标线、没有「还差几周」，也没有「这周比上周好」的评语。
 *
 *  （导出是给测试用的，同 `NorthStarCard` / `CalibrationCard`。）
 */
export function ProcessCard({ p }: { p: ProcessMetrics | null }) {
  if (!p) return null
  const t = p.totals
  return (
    <section
      data-process
      className="wb-card p-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">半懂</h2>
        <span
          data-process-total
          className="text-2xl font-bold tabular-nums text-violet-600 dark:text-violet-300"
        >
          {/* 摆的是**两个计数**，不是百分比（见上面第 1 条） */}
          {p.readable ? `${t.half} / ${t.n}` : '—'}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          场：这 {p.window.weeks} 个自然周里标了「半懂」的 / 说通或半懂的总场次
        </span>
        <div className="flex-1" />
        <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
          {p.window.start.slice(5)} – {p.window.end.slice(5)}
        </span>
      </div>

      {!p.readable ? (
        <p data-process-error className="mt-2 text-xs text-rose-500">
          这条曲线现在读不出来（{p.error}）。零是「这周没开过教学」，读不到是另一回事——不拿零充数。
        </p>
      ) : t.n === 0 ? (
        <p data-process-empty className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
          这 {p.window.weeks} 个自然周里还没有开过教学：讲完一场、标一次「懂了 / 半懂」，这里就有格子了。
        </p>
      ) : (
        <div className="mt-4 flex items-end gap-2">
          {p.weeks.map((w) => (
            <div
              key={w.start}
              data-process-week={w.start}
              data-rate={w.rate === null ? '' : String(w.rate)}
              className="flex flex-1 flex-col items-center gap-1"
            >
              <span className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
                {w.n === 0 ? '—' : `${w.half}/${w.n}`}
              </span>
              <div className="flex h-16 w-full flex-col justify-end">
                <div
                  data-process-bar
                  title={
                    w.n === 0
                      ? '这一周没开过教学'
                      : `半懂 ${w.half} · 说通 ${w.got}（共 ${w.n} 场）`
                  }
                  className={`w-full rounded-t ${
                    w.rate === null
                      ? 'bg-neutral-200 dark:bg-neutral-800'
                      : w.is_current
                        ? 'bg-violet-500'
                        : 'bg-violet-400/70'
                  }`}
                  style={{ height: w.rate === null ? '6px' : `${Math.max(6, w.rate * 100)}%` }}
                />
              </div>
              <span
                className={`text-xs tabular-nums ${
                  w.is_current
                    ? 'font-semibold text-violet-600 dark:text-violet-300'
                    : 'text-neutral-400 dark:text-neutral-500'
                }`}
              >
                {w.start.slice(5)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 口径原文来自后端，界面不自己编一份说法 */}
      <p data-process-rule className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
        {p.rules.half}。{p.rules.useless}。{p.rules.week}
      </p>
    </section>
  )
}

/** 技能闭环（PLAN3 §6）：**试用期漏斗** + **注入命中率**。
 *
 *  与这一页别的曲线同一条红线：只摆事实——没有目标、没有排名、没有一句「继续努力」，
 *  也不进零柒嘴里。三条口径都由后端给（`rules`），界面照抄，不自己编一份说法：
 *
 *  - 漏斗三段数的是**不同单位**（被注入的次数 / 用例的条数 / 升格技能的份数），所以摆的是
 *    三个计数与一根箭头，**不摆转化率**——比率会把「一份技能被用 10 次」与「10 份各被用 1 次」
 *    读成同一件事；
 *  - 被用过那一段是**窗口内**的（每个任务只留最近 20 条运行），所以它只会变小、不会变大；
 *  - 注入那一格是**观察性差异、不是对照**（技能是因为话题相关才被注入的），而且接地分只在
 *    「开了检索 + 命中材料 + 有产出」时才有——读不到就写读不到，不补 0。
 */
export function SkillLoopCard({ s }: { s: SkillLoop | null }) {
  if (!s) return null
  const f = s.funnel
  const hit = s.injection
  const inj = hit.grounded.injected
  const plain = hit.grounded.plain
  return (
    <section
      data-skill-loop
      className="wb-card p-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">技能闭环</h2>
        <span
          data-skill-funnel-total
          className="text-2xl font-bold tabular-nums text-teal-600 dark:text-teal-300"
        >
          {f.readable ? `${f.totals.used} → ${f.totals.cases} → ${f.totals.registered}` : '—'}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          被用过（次） → 用例（条） → 升格（份）
        </span>
      </div>

      {!f.readable ? (
        <p data-skill-funnel-error className="mt-2 text-xs text-rose-500">
          这张表现在读不出来（{f.error}）。
        </p>
      ) : f.totals.skills === 0 ? (
        <p data-skill-funnel-empty className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
          还没有一份草稿：读一份材料、或在运行记录上点「读成技能」，这里就有第一行。
        </p>
      ) : (
        <ul data-skill-funnel-rows className="mt-3 space-y-1">
          {f.skills.map((r) => (
            <li
              key={r.name}
              data-skill-row={r.name}
              className="flex flex-wrap items-baseline gap-x-2 text-xs text-neutral-500 dark:text-neutral-400"
            >
              <span className="text-neutral-700 dark:text-neutral-200">{r.name}</span>
              <span className="tabular-nums">{r.used} 次</span>
              <span className="text-neutral-300 dark:text-neutral-600">·</span>
              <span className="tabular-nums">{r.cases} 条用例</span>
              <span className="text-neutral-300 dark:text-neutral-600">·</span>
              <span>
                {r.registered ? '已升格' : r.stale ? '改过、得重新量' : '还没量过'}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">带技能跑的运行</span>
          <span
            data-skill-inject-total
            className="text-lg font-bold tabular-nums text-teal-600 dark:text-teal-300"
          >
            {hit.readable ? `${hit.runs.injected} / ${hit.runs.total}` : '—'}
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            （近 {hit.days} 天，只数引擎运行）
          </span>
        </div>

        {!hit.readable ? (
          <p data-skill-inject-error className="mt-1 text-xs text-rose-500">
            这一格现在读不出来（{hit.error}）。
          </p>
        ) : hit.runs.total === 0 ? (
          <p data-skill-inject-empty className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
            近 {hit.days} 天还没有引擎运行跑过——这里暂时没有可看的对照。
          </p>
        ) : (
          <p data-skill-inject-grounded className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            接地分：带技能{' '}
            {inj.mean === null ? '读不到' : `${inj.mean}（${inj.n} 次有分）`} · 没带{' '}
            {plain.mean === null ? '读不到' : `${plain.mean}（${plain.n} 次有分）`}
          </p>
        )}

        {/* 口径原文来自后端，界面不自己编一份说法 */}
        <p data-skill-loop-rule className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
          {s.funnel_rules.window}。{s.injection_rules.bias}。{s.injection_rules.grounded}。
        </p>
      </div>
    </section>
  )
}

/** 双轨矛盾率（PLAN2 §6 · T1 的对面）。这条数是**本规划要消灭的东西**，所以这张卡的
 *  写法与别的卡正好相反：它越接近 0 越好，而这一页**绝对不许这么说**——
 *  没有目标线、没有「还差多少」、没有一句「继续努力」。只摆三个事实：分子、分母、窗口，
 *  以及「这条数在量什么」。分母为 0 时说「还没有已掌握的概念」，不摆 0%。
 *
 *  （导出是给测试用的，同 `NorthStarCard`。）
 */
export function GapRateCard({ g, a }: { g: CardGapRate | null; a?: PrereqAdoption | null }) {
  if (!g) return null
  return (
    <section
      data-gap-rate
      className="wb-card p-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">双轨</h2>
        <span
          data-gap-rate-count
          className="text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-300"
        >
          {/* 分母为 0 时不摆 0/0：那是「还没有数据」，不是「一条矛盾都没有」 */}
          {g.readable && g.denominator > 0 ? `${g.n}/${g.denominator}` : '—'}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          个已掌握的概念，名下的卡这 {g.days} 天还在重来
        </span>
        <div className="flex-1" />
        <Link
          to="/tutor"
          className="text-xs text-neutral-400 transition-colors hover:text-violet-600 dark:text-neutral-500"
        >
          去地图看每个概念 →
        </Link>
      </div>

      {!g.readable ? (
        <p data-gap-rate-error className="mt-2 text-xs text-rose-500">
          这条数现在读不出来（{g.error}）。读不到就说读不到——不拿 0 充数。
        </p>
      ) : g.denominator === 0 ? (
        <p data-gap-rate-empty className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
          还没有已掌握的概念，所以这条数现在没有分母。
        </p>
      ) : null}

      {/* 口径原文来自后端，界面不自己编一份说法；**也一个字都不催** */}
      <p
        data-gap-rate-rule
        className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500"
      >
        {g.rule}
      </p>

      {/* 回指采纳（PLAN2 §6 第三条 · T3 的对面）：拉取式功能「有没有人看」是它唯一的
          生死指标。这张卡放它是因为它和上面那条同属「两条轨之间的桥」——那条量桥通没通，
          这条量桥有没有人走。**尤其不能变成目标**：它的用途是「没人看就撤」。 */}
      {a ? (
        <div data-adoption className="mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">回指</h3>
            <span
              data-adoption-count
              className="text-lg font-bold tabular-nums text-violet-600 dark:text-violet-300"
            >
              {a.readable ? `${a.n}/${a.denominator}` : '—'}
            </span>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              张：翻过「可能缺前置」的搁置卡里，真从候选开了课的
            </span>
            <div className="flex-1" />
            <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
              近 {a.days} 天
            </span>
          </div>
          {!a.readable ? (
            <p data-adoption-error className="mt-2 text-xs text-rose-500">
              这条数现在读不出来（{a.error}）。读不到就说读不到——不拿 0 充数。
            </p>
          ) : a.denominator === 0 ? (
            <p data-adoption-empty className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
              这 {a.days} 天里还没有人翻过搁置卡的候选——所以这条数现在没有分母。
            </p>
          ) : null}
          <p
            data-adoption-rule
            className="mt-2 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500"
          >
            {a.rule} {a.bias}
          </p>
        </div>
      ) : null}
    </section>
  )
}
