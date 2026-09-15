/** 成长页：把「你和这件事的关系」摆一屏 —— 学习 / 工作 / 习惯三条线的积累。
 *
 *  这一页的数据**全部是派生、全部是累计**（`pet.growth` + 掌握事件 + 习惯 + 产出 +
 *  小屋的里程碑），所以它只会往上走。刻意没有「还欠 N 个」「连续 0 天」这种欠债口吻
 *  ——成长可以只呈现事实（beaverhabits 的「无目标习惯」是同一立场）。
 *
 *  四个来源格子、里程碑时间线、最近搞懂、坚持、最近交出去，分别对应 B1 的 `parts`
 *  与它背后那几条线；里程碑那份 `things` 与「小屋」是**同一份**（见 `pet_room`）。
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import PageShell from './PageShell'
import {
  api,
  type HabitToday,
  type PetGrowth,
  type PetPluginPanel,
  type PetRoom,
  type TutorMastery,
  type WorkOutput,
} from './api'

/** 每个来源格子的图标与「背后那几个数」怎么读——数来自 growth.counts。 */
const PART_ICON: Record<string, string> = {
  learning: '📚',
  teach: '🎓',
  work: '🛠',
  habits: '🔥',
  review: '⟳',
}

// 心情 1–5 的表情，index 0 = 1 分（与宠物面板同一个量表）。
const MOOD_FACES = ['😞', '😕', '😐', '🙂', '😄']

function partDetail(key: string, c: Record<string, number>): string {
  if (key === 'learning') return `掌握 ${c.mastered ?? 0} 个 · 教学 ${c.sessions ?? 0} 场`
  // 「讲通」是费曼模式说通的次数（你讲给它听，它听懂了）；半懂也是真干了的活，
  // 所以单独报出来，而不是并进讲通里。
  if (key === 'teach') {
    const got = c.taught ?? 0
    const half = c.taught_half ?? 0
    return half > 0 ? `讲通 ${got} 个 · 讲了半截 ${half} 个` : `讲通 ${got} 个`
  }
  if (key === 'work') return `跑成 ${c.runs_ok ?? 0} 次 · 交出 ${c.outputs ?? 0} 份`
  if (key === 'habits') return `打卡 ${c.habit_days ?? 0} 天`
  if (key === 'review') return `答题 ${c.reviews ?? 0} 次`
  return ''
}

export default function GrowthPage({ chromeless }: { chromeless?: boolean }) {
  const [growth, setGrowth] = useState<PetGrowth | null>(null)
  const [mastery, setMastery] = useState<TutorMastery | null>(null)
  const [habits, setHabits] = useState<HabitToday | null>(null)
  const [outputs, setOutputs] = useState<WorkOutput[]>([])
  const [mood, setMood] = useState<PetPluginPanel | null>(null)
  const [room, setRoom] = useState<PetRoom | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const [g, m, h, w, pl, rm] = await Promise.all([
          api.petGrowth(),
          api.tutorMastery().catch(() => null),
          api.habitsToday().catch(() => null),
          api.workOutputs(5).then((r) => r.outputs).catch(() => []),
          api.petPlugins().then((r) => r.plugins).catch(() => []),
          // 里程碑与「小屋」是同一份 things（`pet_room` 算一次，两处展示）。
          // 它挂了不该把整页拖垮——成长的主体数据还在。
          api.petRoom().catch(() => null),
        ])
        setGrowth(g)
        setMastery(m)
        setHabits(h)
        setOutputs(w)
        setRoom(rm)
        const moodPanel = pl.find((p) => p.name === 'mood')?.panel
        setMood(moodPanel?.kind === 'mood' ? moodPanel : null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 text-sm text-red-600 dark:text-red-300">
        读成长数据出错了：{error}
      </div>
    )
  }
  if (!growth) {
    return <div className="px-6 py-10 text-sm text-neutral-400">正在读…</div>
  }

  const events = mastery?.events ?? []
  const habitRows = (habits?.habits ?? []).filter((h) => h.scheduled)
  const hasAnything = growth.exp > 0

  const body = (
    <>
      {/* 等级卡：只写累计与「正在靠近」，不写「还差 N」 */}
      <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-semibold tabular-nums">Lv.{growth.level}</span>
          <span className="text-lg text-neutral-700 dark:text-neutral-200">{growth.title}</span>
          <div className="flex-1" />
          <span className="text-sm tabular-nums text-neutral-500 dark:text-neutral-400">
            累计 EXP {growth.exp}
          </span>
        </div>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
          <div
            className="h-full rounded-full bg-violet-500 transition-all"
            style={{ width: `${Math.round(growth.progress * 100)}%` }}
          />
        </div>
        {growth.next_title && (
          <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
            正在靠近「{growth.next_title}」
          </p>
        )}
      </section>

      {!hasAnything && (
        <p className="text-sm text-neutral-400 dark:text-neutral-500">
          还没有积累。去「学」搞懂一点东西，或让一条工作流跑一次，这里就会长起来。
        </p>
      )}

      {/* 四个来源 */}
      {growth.parts.length > 0 && (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {growth.parts.map((p) => (
            <div
              key={p.key}
              className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div className="text-lg">{PART_ICON[p.key] ?? '·'}</div>
              <div className="mt-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">
                {p.label}
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-violet-600 dark:text-violet-400">
                +{p.exp}
              </div>
              <div className="mt-0.5 text-[11px] text-neutral-400 dark:text-neutral-500">
                {partDetail(p.key, growth.counts)}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* 里程碑：不是聊天流，是**跨过门槛的那些时刻**（第 5 份成品、第一次讲通……）。
          与小屋是同一份 things——那边看「攒下了什么」，这边看「什么时候攒到的」。 */}
      {(room?.things.length ?? 0) > 0 && (
        <section>
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">里程碑</h2>
            <div className="flex-1" />
            <Link to="/companion?tab=room" className="text-xs text-violet-500 hover:underline">
              去小屋
            </Link>
          </div>
          <ol
            data-milestones
            className="ml-1.5 space-y-0 border-l border-neutral-200 dark:border-neutral-800"
          >
            {room!.things.map((t) => (
              <li key={t.id} data-milestone={t.id} className="relative pb-3 pl-4 last:pb-0">
                <span className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full bg-violet-400 ring-2 ring-white dark:ring-neutral-950" />
                <div className="flex items-baseline gap-2 text-sm">
                  <span>{t.icon}</span>
                  <span className="text-neutral-700 dark:text-neutral-200">{t.label}</span>
                  <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                    {t.detail}
                  </span>
                  <div className="flex-1" />
                  <span className="shrink-0 text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500">
                    {t.at.slice(0, 10)}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* 最近搞懂：学习线的产出 */}
      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">最近搞懂</h2>
          <div className="flex-1" />
          <Link to="/tutor" className="text-xs text-violet-500 hover:underline">
            去学
          </Link>
        </div>
        {events.length === 0 ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500">
            还没有一个概念走到「搞懂」——说通两次才算数。
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {events.map((e) => (
              <li key={e.concept} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                <span className="text-neutral-700 dark:text-neutral-200">{e.concept}</span>
                {e.from_half && (
                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400">
                    从半懂到懂
                  </span>
                )}
                <div className="flex-1" />
                <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                  {e.sessions} 场 · {e.at.slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 坚持：习惯线。只写累计与真实连续天数，不写「连续 0 天」 */}
      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">坚持</h2>
          <div className="flex-1" />
          <Link to="/review" className="text-xs text-violet-500 hover:underline">
            去打卡
          </Link>
        </div>
        {habitRows.length === 0 ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500">
            还没有习惯。今日页可以一键播种三条。
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {habitRows.map((h) => (
              <li key={h.id} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                <span>{h.icon}</span>
                <span className="text-neutral-700 dark:text-neutral-200">{h.name}</span>
                <div className="flex-1" />
                {h.streak > 0 && (
                  <span className="text-xs text-orange-500 dark:text-orange-400">
                    连续 {h.streak} 天
                  </span>
                )}
                <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                  累计 {h.history.length} 天
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 心情：插件记下的那条线。只画记过的天，不画「漏了几天」 */}
      {mood && (mood.recent?.length ?? 0) > 0 && (
        <section>
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">心情</h2>
            <div className="flex-1" />
            <span className="text-xs text-neutral-400 dark:text-neutral-500">
              最近 {mood.recent!.length} 天
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-neutral-200 px-4 py-3 dark:border-neutral-800">
            {mood.recent!.map((d) => (
              <span key={d.day} title={`${d.day} · ${d.value}/${mood.scale ?? 5}`} className="text-lg">
                {MOOD_FACES[d.value - 1] ?? '·'}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* 最近交出去：工作线的产出 */}
      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">最近交出去</h2>
          <div className="flex-1" />
          <Link to="/work" className="text-xs text-violet-500 hover:underline">
            去工作
          </Link>
        </div>
        {outputs.length === 0 ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500">
            还没有交出去的东西。
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {outputs.map((o) => (
              <li key={o.path} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  {o.label}
                </span>
                <span className="truncate text-neutral-700 dark:text-neutral-200">{o.title}</span>
                <div className="flex-1" />
                <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                  {o.date}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )

  // chromeless：整页搬进陪伴页「成长」标签时不要页头——那里已经有「陪伴」的页头。
  if (chromeless) return <div className="space-y-6">{body}</div>
  return (
    <PageShell
      title="成长"
      description="你和这件事的关系——只累计，不记账。"
      maxWidth="3xl"
      bodyClassName="space-y-6"
    >
      {body}
    </PageShell>
  )
}
