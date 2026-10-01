import type { Dispatch, SetStateAction } from 'react'
import type { CardStats } from './api'

// 总结屏（phase === 'summary'）——JSX 从 ReviewPage 原样搬来（方向 6）。
// 会话计数与正确率的展示件；「回到今日」「再出几张」仍是宿主动作。
export default function ReviewSummary(props: {
  answered: number
  session: { again: number; hard: number; good: number; easy: number; ms: number }
  accuracy: number | null
  stats: CardStats | null
  load: () => Promise<void>
  setMakerOpen: Dispatch<SetStateAction<boolean>>
}) {
  const { answered, session, accuracy, stats, load, setMakerOpen } = props
  return (
          <section className="wb-card p-8">
            <p className="text-3xl">✅</p>
            <h2 className="mt-3 text-lg font-semibold">
              过完 {answered} 张{stats && stats.streak > 0 ? ` · 连续 ${stats.streak} 天` : ''}
            </h2>
            <div className="mt-4 flex flex-wrap gap-4 text-sm">
              {[
                ['重来', session.again, 'text-rose-600 dark:text-rose-400'],
                ['困难', session.hard, 'text-amber-600 dark:text-amber-400'],
                ['良好', session.good, 'text-emerald-600 dark:text-emerald-400'],
                ['简单', session.easy, 'text-sky-600 dark:text-sky-400'],
              ].map(([label, n, cls]) => (
                <span key={String(label)} className={cls as string}>
                  {label} {n as number}
                </span>
              ))}
              {accuracy != null && (
                <span className="text-neutral-500 dark:text-neutral-400">正确率 {accuracy}%</span>
              )}
              {session.ms > 0 && (
                <span className="text-neutral-500 dark:text-neutral-400">
                  用时 {Math.round(session.ms / 1000)}s
                </span>
              )}
            </div>
            {stats?.next_due && (
              <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
                下一批 {new Date(stats.next_due).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 到期
              </p>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                onClick={() => void load()}
                className="wb-btn-primary px-4 py-2 text-sm"
              >
                回到今日
              </button>
              {session.again > 0 && (
                <button
                  onClick={() => setMakerOpen(true)}
                  className="rounded-lg border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
                >
                  就答错的内容再出几张
                </button>
              )}
            </div>
          </section>
  )
}
