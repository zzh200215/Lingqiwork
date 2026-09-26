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
  cancelLabel = '停止',
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
  /** 「取消」那颗按钮的字。默认「停止」。
   *
   *  **为什么允许改**：不是每一次取消都是真停。流式接口上掐请求 = 服务端生成器被取消
   *  （真停）；一次性 POST 上掐请求只是「我不等了」——**服务端照样跑完、照样花那份钱**。
   *  给它也写「停止」就是撒谎，而这一页的规矩是「读不到就说读不到」。
   *  真能停的（`prompt_eval` / `skill_eval` 那两条合作式取消的路）保持默认。 */
  cancelLabel?: string
  /** 成品态的底部（反馈按钮等），与正文间有分隔线 */
  footer?: ReactNode
  children?: ReactNode
}) {
  const running = phase === 'planning' || phase === 'progress' || phase === 'streaming'
  return (
    <div
      className={`rounded-md border p-4 ${TONES[tone]}`}
      /* `data-phase`：**测试锚点**。对长任务的断言原来只能钉中文文案（「取材中…」
         之类），改一句措辞就红一片，而红的理由看起来像功能坏了。
         阶段是**状态**、文案是**表达**——断言钉在状态上，两边各自能改。 */
      data-phase={phase}
      data-run-panel={title}
    >
      <div className="flex items-center justify-between gap-2 pb-1">
        <p className={`text-xs font-medium uppercase tracking-wider ${TEXT[tone]}`}>
          {icon} {title}
        </p>
        <div className="flex items-center gap-1.5">
          {phase === 'done' && actions}
          {running && onCancel ? (
            <button
              onClick={onCancel}
              className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-rose-300 hover:text-rose-600 dark:border-neutral-700 dark:hover:border-rose-500/40"
            >
              {cancelLabel}
            </button>
          ) : null}
          {phase === 'error' && onRetry ? (
            <button
              onClick={onRetry}
              className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${TEXT[tone]} border-current/30 hover:bg-white/60 dark:hover:bg-neutral-900/40`}
            >
              重试
            </button>
          ) : null}
        </div>
      </div>

      {phase === 'error' && error ? (
        <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
      ) : null}
      {running && status ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{status}</p>
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
