import type { ReactNode } from 'react'

/** 统一页头骨架：标题 + 一句话说明 + 统计槽 + 右上主操作 + 内容区。
 *  全站非会话类页面的外壳——用户在任何页都知道「这页是干嘛的、我能干什么」。
 *  会话类页面（对话/教学）是全屏输入流，不套这个壳。 */
export default function PageShell({
  title,
  description,
  stats,
  actions,
  maxWidth = '4xl',
  bodyClassName,
  children,
}: {
  title: string
  description?: ReactNode
  /** 页头下方的一行实时统计（如「12 张 · 连续 3 天」），纯文本，弱化显示 */
  stats?: ReactNode
  /** 右上角的操作按钮组（每屏至多一个渐变主按钮，规矩在调用方） */
  actions?: ReactNode
  maxWidth?: '3xl' | '4xl' | '5xl'
  /** 内容区的附加类（如 space-y-6），用于迁移期保留各页原有节奏 */
  bodyClassName?: string
  children: ReactNode
}) {
  const width = { '3xl': 'max-w-3xl', '4xl': 'max-w-4xl', '5xl': 'max-w-5xl' }[maxWidth]
  return (
    <div className={`mx-auto ${width} px-6 py-8`}>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-800 dark:text-neutral-100">
            {title}
          </h1>
          {description ? (
            <p className="pt-1 text-sm text-neutral-500 dark:text-neutral-400">{description}</p>
          ) : null}
          {stats ? (
            <p className="pt-1.5 text-xs text-neutral-400 dark:text-neutral-500">{stats}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className={bodyClassName}>{children}</div>
    </div>
  )
}
