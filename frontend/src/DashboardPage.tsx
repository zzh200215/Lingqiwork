import { useCallback, useEffect, useState } from 'react'

import Layout from './Layout'
import { api, type DashboardStats, type TutorStats } from './api'

// 仪表盘 — 零柒视角
// 顶部 banner 用零柒 sprite + LLM 生成的今日一句话；
// 5 张叙事卡片把裸数字包成"本周你聊了 N 次 / 比上周 +X"这种说法；
// 其余图表与列表保留。
//
// 第二张卡原来是「今天到期 N 张 · 连续 N 天 · 习惯 x/y」，按 PLAN.md 第 3 节封存换掉了：
// 到期数是那一版唯一还留在导航页上的债，第 2 节的判断标准就是它。换成「学」的记录 ——
// 已经发生过的事，没有到期，也没有未完成计数。

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [tutor, setTutor] = useState<TutorStats | null>(null)
  const [briefing, setBriefing] = useState<{ text: string; cached: boolean } | null>(null)
  const [briefingLoading, setBriefingLoading] = useState(true)
  const [error, setError] = useState('')

  const refreshBriefing = useCallback(async () => {
    setBriefingLoading(true)
    try {
      const b = await api.dashboardBriefing()
      setBriefing({ text: b.text, cached: b.cached })
    } catch {
      setBriefing({ text: '今天挺安静的，适合写点东西。', cached: false })
    } finally {
      setBriefingLoading(false)
    }
  }, [])

  useEffect(() => {
    api.dashboard().then(setStats).catch((e) => setError(String(e)))
    // swallowed on purpose: the dashboard must never blank out over one endpoint
    api.tutorStats().then(setTutor).catch(() => {})
    void refreshBriefing()
  }, [refreshBriefing])

  const nar = stats?.narrative
  const thisWeek = nar?.this_week_messages ?? 0
  const prevWeek = nar?.prev_week_messages ?? 0
  const chatDelta = thisWeek - prevWeek
  const chatDeltaText =
    prevWeek === 0
      ? thisWeek > 0
        ? '本周全新'
        : '还在等第一句'
      : chatDelta > 0
        ? `比上周 +${chatDelta}`
        : chatDelta === 0
          ? '和上周持平'
          : `比上周 −${Math.abs(chatDelta)}`

  const days: { date: string; count: number; label: string; isToday: boolean }[] = []
  if (stats) {
    const byDate = new Map(stats.daily_messages.map((d) => [d.date, d.count]))
    const todayKey = new Date().toISOString().slice(0, 10)
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const utc = d.toISOString().slice(0, 10)
      days.push({ date: utc, count: byDate.get(utc) ?? 0, label: `${d.getMonth() + 1}/${d.getDate()}`, isToday: utc === todayKey })
    }
  }
  const maxCount = Math.max(1, ...days.map((d) => d.count))

  const totalModel = stats?.top_models.reduce((s, x) => s + x.count, 0) || 1

  const tokTotal = stats?.tokens_total ?? 0
  const tokTotalText =
    tokTotal >= 1_000_000 ? `${(tokTotal / 1_000_000).toFixed(1)}M` : tokTotal >= 1000 ? `${(tokTotal / 1000).toFixed(1)}K` : `${tokTotal}`

  const ts = stats?.task_stats
  const taskRate = ts?.rate != null ? Math.round(ts.rate * 100) : null

  return (
    <Layout page="dashboard">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <section className="relative overflow-hidden rounded-3xl border border-neutral-200 bg-gradient-to-br from-violet-50 via-white to-fuchsia-50 p-6 shadow-sm dark:border-neutral-800 dark:from-violet-950/40 dark:via-neutral-900 dark:to-fuchsia-950/30">
          <div className="flex items-start gap-5">
            <div className="shrink-0">
              <img
                src="/pet/idle.webp"
                alt="零柒"
                className="h-20 w-20 object-contain drop-shadow"
                onError={(e) => {
                  e.currentTarget.src = '/pet-avatar.png'
                }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs font-medium text-violet-700 dark:text-violet-300">
                <span>零柒 · 今日要点</span>
                {briefing?.cached && (
                  <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] dark:bg-violet-900/60">缓存</span>
                )}
              </div>
              <p className="mt-2 text-lg font-medium leading-relaxed text-neutral-800 dark:text-neutral-100">
                {briefingLoading ? '正在看你的近况…' : briefing?.text}
              </p>
              <div className="mt-3 flex items-center gap-3 text-xs text-neutral-400">
                <span>
                  {new Date().toLocaleString('zh-CN', {
                    month: 'long',
                    day: 'numeric',
                    weekday: 'long',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <button
                  onClick={() => void refreshBriefing()}
                  className="rounded-full border border-neutral-200 px-2.5 py-0.5 transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:hover:border-violet-500 dark:hover:text-violet-300"
                >
                  换一句
                </button>
              </div>
            </div>
          </div>
        </section>

        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
          <NarrativeCard
            tone="violet"
            eyebrow="聊天"
            headline={`${thisWeek}`}
            label="本周消息"
            sub={chatDeltaText}
            href="/"
          />
          <NarrativeCard
            tone="sky"
            eyebrow="学"
            headline={`${tutor?.sessions ?? 0}`}
            label={`近 ${tutor?.days ?? 14} 天搞懂过`}
            sub={
              tutor && tutor.sessions > 0
                ? [
                    `${tutor.got} 次说通了`,
                    tutor.got_with_recall > 0 ? `${tutor.got_with_recall} 次接上以前卡的点` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : '还没开过口'
            }
            href="/tutor.html"
          />
          <NarrativeCard
            tone="fuchsia"
            eyebrow="记忆"
            headline={`${stats?.memories ?? 0}`}
            label="零柒记下的事"
            sub={nar && nar.today_messages > 0 ? `今天聊了 ${nar.today_messages} 条` : '还在观察'}
            href="/settings.html"
          />
          <NarrativeCard
            tone="emerald"
            eyebrow="笔记"
            headline={nar ? `+${nar.today_vault_files}` : '0'}
            label="vault 今天新增"
            sub={stats ? `共 ${stats.vault_files} 篇笔记` : '加载中…'}
            href="/kb.html"
          />
          <NarrativeCard
            tone={ts && (ts.error ?? 0) > 0 ? 'rose' : 'sky'}
            eyebrow="任务"
            headline={taskRate != null ? `${taskRate}%` : '—'}
            label="30 天成功率"
            sub={ts ? `${ts.ok}/${ts.runs_30d} 完成` : '还没有任务记录'}
            href="/settings.html"
          />
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/60">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">最近 7 天</h2>
              <span className="text-xs text-neutral-400">消息数</span>
            </div>
            <div className="mt-5 flex h-32 items-end gap-2">
              {days.map((d) => {
                const h = Math.max(4, (d.count / maxCount) * 100)
                return (
                  <div key={d.date} className="group flex flex-1 flex-col items-center gap-1.5">
                    <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
                      {d.count > 0 ? d.count : ''}
                    </span>
                    <div className="w-full" style={{ height: '100%' }}>
                      <div
                        className={`w-full rounded-t-md bg-gradient-to-t transition-all ${
                          d.isToday ? 'from-violet-600 to-fuchsia-500' : 'from-violet-400/70 to-fuchsia-300/70'
                        } ${d.count ? '' : 'opacity-25'}`}
                        style={{ height: `${h}%`, minHeight: '4px', marginTop: 'auto' }}
                        title={`${d.label}: ${d.count}`}
                      />
                    </div>
                    <span
                      className={`text-[10px] ${d.isToday ? 'font-semibold text-violet-600 dark:text-violet-300' : 'text-neutral-400'}`}
                    >
                      {d.label}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/60">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">常用模型</h2>
            {stats && stats.top_models.length > 0 ? (
              <ul className="mt-4 space-y-2.5">
                {stats.top_models.map((m) => (
                  <li key={m.model_id}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate font-mono text-neutral-600 dark:text-neutral-300">{m.model_id}</span>
                      <span className="ml-2 shrink-0 text-neutral-400">{m.count}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all"
                        style={{ width: `${(m.count / totalModel) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-xs text-neutral-400">{stats ? '还没有对话记录' : '加载中…'}</p>
            )}
          </section>

          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/60">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">Token 总用量</h2>
            <p className="mt-3 bg-gradient-to-r from-sky-600 to-cyan-500 bg-clip-text text-3xl font-bold text-transparent dark:from-sky-400 dark:to-cyan-300">
              {tokTotalText}
            </p>
            <p className="mt-2 text-xs text-neutral-400">累计消耗 · 不含本地 embedding</p>
          </section>
        </div>

        <section className="mt-5 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/60">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">最近对话</h2>
            <a href="/" className="text-xs text-violet-600 hover:underline dark:text-violet-400">
              打开对话页 →
            </a>
          </div>
          {stats && stats.recent_conversations.length > 0 ? (
            <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-800">
              {stats.recent_conversations.map((c) => (
                <li key={c.id}>
                  <a
                    href={`/?conv=${c.id}`}
                    className="group flex items-center justify-between rounded-lg px-2 py-2.5 transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                  >
                    <span className="truncate text-sm text-neutral-700 group-hover:text-violet-700 dark:text-neutral-200 dark:group-hover:text-violet-300">
                      {c.title}
                    </span>
                    <span className="ml-3 shrink-0 truncate font-mono text-[11px] text-neutral-400">
                      {c.model_id} · {new Date(c.updated_at).toLocaleDateString()}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-neutral-400">{stats ? '还没有对话，去发第一条消息吧' : '加载中…'}</p>
          )}
        </section>

        <section className="mt-5 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/60">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              定时任务{stats && stats.tasks_total ? ` · ${stats.tasks_total} 个启用中` : ''}
            </h2>
            <a href="/settings.html" className="text-xs text-violet-600 hover:underline dark:text-violet-400">
              管理任务 →
            </a>
          </div>
          {stats && stats.tasks.length > 0 ? (
            <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-800">
              {stats.tasks.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-2 py-2.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm text-neutral-700 dark:text-neutral-200">
                      {t.mode === 'agent' ? '🤖' : t.trigger_kind === 'watch' ? '📁' : '⏰'} {t.name}
                    </span>
                    {t.last_status === 'error' && (
                      <span className="shrink-0 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] text-rose-600 dark:bg-rose-950/60 dark:text-rose-300">
                        上次失败
                      </span>
                    )}
                  </span>
                  <span className="ml-3 shrink-0 font-mono text-[11px] text-neutral-400">
                    {t.trigger_kind === 'watch'
                      ? `📁 ${t.watch_path || 'vault'}`
                      : `${t.cron} · 下次 ${t.next_run ? t.next_run.slice(5, 16).replace('T', ' ') : '—'}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-neutral-400">
              {stats ? '还没有启用的定时任务，可在设置页创建' : '加载中…'}
            </p>
          )}
        </section>

        {error && (
          <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:bg-rose-950/40 dark:text-rose-400">
            {error}
          </p>
        )}
      </div>
    </Layout>
  )
}

function NarrativeCard({
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
    <a
      href={href}
      className="group block rounded-2xl border border-neutral-200 bg-white p-5 transition-all hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-md hover:shadow-violet-100/60 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-violet-500/40"
    >
      <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">{eyebrow}</p>
      <p className={`mt-2 bg-gradient-to-r bg-clip-text text-3xl font-bold text-transparent ${toneClasses[tone]}`}>
        {headline}
      </p>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className="mt-2 text-[11px] font-medium text-violet-600 dark:text-violet-400">{sub}</p>
    </a>
  )
}