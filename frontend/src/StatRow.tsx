import type { ReactNode } from 'react'

/** 语义色，与 RunPanel 一套：坏 / 注意 / 好 / 中性。 */
const TONE: Record<NonNullable<StatItem['tone']>, string> = {
  bad: 'text-rose-600 dark:text-rose-400',
  warn: 'text-amber-600 dark:text-amber-400',
  good: 'text-emerald-600 dark:text-emerald-400',
  info: 'text-neutral-400',
}

export type StatItem = {
  label: ReactNode
  /** 可选的值；不给我只渲染 label（用于「未打分」这类本身即结论的档） */
  value?: ReactNode
  tone?: 'bad' | 'warn' | 'good' | 'info'
  /** 悬停解释（如接地分为什么没打） */
  title?: string
}

/** 一行 4-5 个事实（状态 · 时间 · 触发 · 接地分 · 轮数…）。
 *
 *  抽取自工作页的运行记录行——同一种「一行把这次运行说清」的排布散在任务运行、
 *  今日概览两处，先归一，免得两处各自漂。 */
export default function StatRow({
  items,
  trailing,
  className,
}: {
  items: StatItem[]
  /** 行尾跟随元素（如错误信息、箭头） */
  trailing?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs ${className ?? ''}`}>
      {items.map((it, i) => (
        <span
          key={i}
          title={it.title}
          className={`shrink-0 ${it.tone ? TONE[it.tone] : 'text-neutral-400'} ${
            it.tone && it.tone !== 'info' ? 'font-medium' : ''
          }`}
        >
          {it.label}
          {it.value !== undefined ? <> {it.value}</> : null}
        </span>
      ))}
      {trailing}
    </div>
  )
}
