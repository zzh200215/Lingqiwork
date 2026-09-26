/** 家底砖：一个数 + 一句它是什么 + 可选落点。
 *
 *  2026-09-18：为「页面内容太少」这件事加的。量过：资产页只有 205 字、今日页 205 字，
 *  而同一台机器的仪表盘有 2905 字——差别不在版面，在**这一页到底摆了几件事**。
 *
 *  **它只陈述「有多少」，不设目标、不给评价**（§4-2）：`0` 就是 0，
 *  不写成「还差 N 个」。`value` 为 `null` 时摆 `—`——「读不到」与「零」是两件事（§4-8）。
 *
 *  2026-09-19：`icon` 收 `ReactNode`（lucide 图标组件直接塞进来），配 `accent`
 *  给图标一个彩色 chip 底——彩色的职责是**分区**（一排砖里扫一眼认出哪块是哪块），
 *  不是评级，所以色板由调用方按板块固定，不随数值大小变。
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export default function StatTile({
  icon,
  label,
  value,
  sub,
  href,
  accent,
}: {
  /** lucide 图标（`<FileText className="h-4 w-4" />`）；传 emoji 字符串也照旧渲染 */
  icon: ReactNode
  /** 这个数是什么（小字） */
  label: string
  /** 那个数。`null` = 读不到（摆 `—`，**不摆 0**） */
  value: number | string | null
  /** 数字下面那句补充（如「其中 2 份量过」） */
  sub?: ReactNode
  /** 有落点就整块可点 */
  href?: string
  /** 图标 chip 的配色（bg/fg 两段类名，如 `bg-emerald-100 text-emerald-600 dark:…`） */
  accent?: string
}) {
  const body = (
    <>
      <p className="flex items-center gap-2 text-xs font-medium text-neutral-400 dark:text-neutral-500">
        <span
          className={`wb-chip h-7 w-7 rounded-lg ${
            accent ?? 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
          }`}
        >
          {typeof icon === 'string' ? <span className="text-[13px] leading-none">{icon}</span> : icon}
        </span>
        <span className="truncate">{label}</span>
      </p>
      <p
        data-stat-tile={label}
        className="pt-1.5 text-2xl font-semibold tabular-nums text-neutral-800 dark:text-neutral-100"
      >
        {value === null ? '—' : value}
      </p>
      {sub ? (
        <p className="pt-0.5 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
          {sub}
        </p>
      ) : null}
    </>
  )
  if (href) {
    return (
      <Link to={href} className="wb-card wb-card-hover block p-4">
        {body}
      </Link>
    )
  }
  return <div className="wb-card p-4">{body}</div>
}
