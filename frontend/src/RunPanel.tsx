import type { ReactNode } from 'react'

/** AI 长任务的统一面板。全站所有「点一下要跑几秒到几分钟」的动作
 *  （研究/理清/对质/拆点/出题/成文/播客…）都用它呈现，规矩：
 *
 *  - 六态之一必须可见，禁止「转圈无文字」：
 *    planning（读题/规划）→ progress（进度行）→ streaming（半截渲染）
 *    → done（成品）→ error（可重试）；idle 不渲染。
 *  - 取消/重试由调用方给回调；成品态才显示右上 actions（存档等）。
 *  - tone 决定边框语义色，四选一，与全站语义色一致。 */
export type RunPhase =
  | 'planning'
  | 'progress'
  | 'streaming'
  | 'done'
  | 'error'

const TONES = {
  sky: 'border-sky-200 bg-sky-50/60 dark:border-sky-500/30 dark:bg-sky-500/10',
  violet:
    'border-violet-200 bg-violet-50/60 dark:border-violet-500/30 dark:bg-violet-500/10',
  teal: 'border-teal-200 bg-teal-50/60 dark:border-teal-500/30 dark:bg-teal-500/10',
  amber:
    'border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10',
  rose: 'border-rose-200 bg-rose-50/60 dark:border-rose-500/30 dark:bg-rose-500/10',
} as const

const TEXT = {
  sky: 'text-sky-700 dark:text-sky-300',
  violet: 'text-violet-700 dark:text-violet-300',
  teal: 'text-teal-700 dark:text-teal-300',
  amber: 'text-amber-700 dark:text-amber-300',
  rose: 'text-rose-700 dark:text-rose-300',
} as const

export default function RunPanel({
  phase,
  tone,
  icon,
  title,
  status,
  error,
  actions,
  onCancel,
  onRetry,
  footer,
  children,
}: {
  phase: RunPhase
  tone: keyof typeof TONES
  icon: string
  title: string
  /** 进度行的文字（planning/progress/streaming 态显示） */
  status?: string
  /** error 态的错误文字 */
  error?: string
  /** 成品态的右上动作（存进知识库等） */
  actions?: ReactNode
  onCancel?: () => void
  onRetry?: () => void
  /** 成品态的底部（反馈按钮等），与正文间有分隔线 */
  footer?: ReactNode
  children?: ReactNode
}) {
  const running = phase === 'planning' || phase === 'progress' || phase === 'streaming'
  return (
    <div className={`rounded-xl border p-4 ${TONES[tone]}`}>
      <div className="flex items-center justify-between gap-2 pb-1">
        <p className={`text-[11px] font-medium uppercase tracking-wider ${TEXT[tone]}`}>
          {icon} {title}
        </p>
        <div className="flex items-center gap-1.5">
          {phase === 'done' && actions}
          {running && onCancel ? (
            <button
              onClick={onCancel}
              className="rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-rose-300 hover:text-rose-600 dark:border-neutral-700 dark:hover:border-rose-500/40"
            >
              停止
            </button>
          ) : null}
          {phase === 'error' && onRetry ? (
            <button
              onClick={onRetry}
              className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${TEXT[tone]} border-current/30 hover:bg-white/60 dark:hover:bg-neutral-900/40`}
            >
              重试
            </button>
          ) : null}
        </div>
      </div>

      {phase === 'error' && error ? (
        <p className="text-[11px] text-rose-600 dark:text-rose-400">{error}</p>
      ) : null}
      {running && status ? (
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">{status}</p>
      ) : null}

      {children ? <div className={running ? 'pt-1' : ''}>{children}</div> : null}

      {phase === 'done' && footer ? (
        <div className="mt-2 border-t border-neutral-200/70 pt-2 dark:border-neutral-700/70">
          {footer}
        </div>
      ) : null}
    </div>
  )
}
