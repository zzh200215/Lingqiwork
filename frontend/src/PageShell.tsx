import type { ReactNode } from 'react'

/** 统一页头骨架：一句话说明 + 统计槽 + 右上主操作 + 内容区。
 *  全站非会话类页面的外壳——用户在任何页都知道「这页是干嘛的、我能干什么」。
 *  会话类页面（对话/教学）是全屏输入流，不套这个壳。
 *
 *  **2026-09-18 版面改版，两处变了**：
 *
 *  1. **宽度**：默认从 `4xl`（896px）放到 `wide`（1600px）。量过：1920 窗口下
 *     4xl 的页面两侧空白占 **47%**（今日那页 54%），而参考项目 Robot Admin 是
 *     full-width + 栅格。**留白不该用来撑版面，该用栅格。**
 *  2. **不再在正文里念一遍页名**：模块与子页的名字现在在顶栏的面包屑里
 *     （`Layout.tsx` 的 `TopBar`）。原来顶栏没有、每页各念一次，既重复又白占一行。
 *     `title` 仍然收着——**它给的是无障碍标签**（`aria-label`）与测试用的锚点，
 *     不再画成一行大标题。真要一行大标题的页面（如知识库）自己写。
 */
export default function PageShell({
  title,
  description,
  stats,
  actions,
  maxWidth = 'wide',
  bodyClassName,
  fill = false,
  children,
}: {
  title: string
  description?: ReactNode
  /** 页头下方的一行实时统计（如「12 张 · 连续 3 天」），纯文本，弱化显示 */
  stats?: ReactNode
  /** 右上角的操作按钮组（每屏至多一个渐变主按钮，规矩在调用方） */
  actions?: ReactNode
  maxWidth?: 'wide' | '3xl' | '4xl' | '5xl'
  /** 内容区的附加类（如 space-y-6），用于迁移期保留各页原有节奏 */
  bodyClassName?: string
  /** 满高模式：页面占满剩余视口、内部自己滚（聊天/教学这类）。高度由 flex 链
   *  推导——禁用 `calc(100vh-Npx)` 魔法数，页头一换行手算的高度就失真（§B）。 */
  fill?: boolean
  children: ReactNode
}) {
  const width = {
    wide: 'max-w-[1600px]',
    '3xl': 'max-w-3xl',
    '4xl': 'max-w-4xl',
    '5xl': 'max-w-5xl',
  }[maxWidth]
  const hasToolbar = Boolean(description || stats || actions)
  // 满高模式（§B 高度规范）：根变 flex 链，内容区 flex-1 min-h-0——高度由布局推导
  const bodyCls =
    [fill ? 'flex min-h-0 flex-1 flex-col' : '', bodyClassName].filter(Boolean).join(' ') ||
    undefined
  return (
    <div
      aria-label={title}
      data-page={title}
      className={`mx-auto ${width} px-6 py-6${fill ? ' flex h-full flex-col' : ''}`}
    >
      {hasToolbar ? (
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-4">
          <div className="min-w-0">
            {description ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">{description}</p>
            ) : null}
            {stats ? (
              // `div` 而不是 `p`：`stats` 收的是 ReactNode，而有的页面往里放的是
              // `<StatTile>`（一段 `<div>`）——`<p>` 里嵌块级元素会被浏览器就地截断，
              // DOM 结构与写下的不一样（方案 §8.3 的「统计砖并入页头 stats」正是那种用法）。
              <div className="pt-0.5 text-xs text-neutral-400 dark:text-neutral-500">{stats}</div>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={bodyCls}>{children}</div>
    </div>
  )
}
