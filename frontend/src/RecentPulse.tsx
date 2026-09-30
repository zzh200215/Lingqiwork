import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarCheck, FilePlus2, MessageSquare } from 'lucide-react'
import StatTile from './StatTile'
import { api, type Conversation, type DashboardStats, type PetEvent } from './api'
import { ago } from './reltime'

/** 这一页的「最近」那一栏（2026-09-18 内容太少那一轮加的）。
 *
 *  三块**各自独立取、各自独立坏**：零柒的账本、最近的对话、这周的足迹。
 *  三块都读不到时整块不渲染——不摆一排 0（§4-8），也不假装这里本来就没东西。
 *
 *  **不催**：这些是「已经发生过什么」，不是「你还欠什么」（§4-1 镜子不是掌柜）。
 */
function RecentPulse() {
  const [lines, setLines] = useState<PetEvent[] | null>(null)
  const [convs, setConvs] = useState<Conversation[] | null>(null)
  const [week, setWeek] = useState<DashboardStats | null>(null)

  useEffect(() => {
    api.petFeed(6).then((r) => setLines(r.events)).catch(() => {})
    api.listConversations().then(setConvs).catch(() => {})
    api.dashboard().then(setWeek).catch(() => {})
  }, [])

  const recentConvs = (convs ?? []).slice(0, 4)
  const nar = week?.narrative
  const hasWeek = week !== null
  if (!lines?.length && !recentConvs.length && !hasWeek) return null

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1.4fr_1fr]" data-recent-pulse>
      <section className="flex flex-col gap-4">
        {lines && lines.length > 0 ? (
          <div>
            <h2 className="pb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              零柒最近说的
            </h2>
            <ul className="wb-card divide-y divide-neutral-100 px-3 dark:divide-neutral-800/70">
              {lines.map((e) => (
                <li key={e.id} className="flex items-baseline gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-600 dark:text-neutral-300">
                    {e.text}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400">
                    {ago(Date.parse(e.created_at) / 1000)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {recentConvs.length > 0 ? (
          <div>
            <div className="flex items-baseline justify-between pb-2">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                最近聊过
              </h2>
              <Link to="/" className="text-xs text-violet-500 hover:underline">
                去对话 →
              </Link>
            </div>
            <ul className="wb-card divide-y divide-neutral-100 px-3 dark:divide-neutral-800/70">
              {recentConvs.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/?conv=${c.id}`}
                    className="flex items-baseline gap-2 py-2 text-xs text-neutral-600 transition-colors hover:text-violet-600 dark:text-neutral-300 dark:hover:text-violet-300"
                  >
                    <span className="min-w-0 flex-1 truncate">{c.title || '（没起名）'}</span>
                    <span className="shrink-0 text-xs text-neutral-400">
                      {c.updated_at ? ago(Date.parse(c.updated_at) / 1000) : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {hasWeek ? (
        <section>
          <h2 className="pb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
            这一周
          </h2>
          <div className="grid grid-cols-3 gap-3">
            <StatTile
              icon={<CalendarCheck className="h-3.5 w-3.5" />}
              accent="bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"
              label="打开过"
              value={`${week.open_days_7d} 天`}
            />
            <StatTile
              icon={<MessageSquare className="h-3.5 w-3.5" />}
              accent="bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300"
              label="消息"
              value={nar?.this_week_messages ?? 0}
            />
            <StatTile
              icon={<FilePlus2 className="h-3.5 w-3.5" />}
              accent="bg-emerald-100 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300"
              label="vault 新增"
              value={nar?.today_vault_files ?? 0}
              sub="今天"
            />
          </div>
        </section>
      ) : null}
    </div>
  )
}

export default RecentPulse
