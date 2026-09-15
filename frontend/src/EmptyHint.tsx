import type { ReactNode } from 'react'

const PAD = {
  sm: 'px-4 py-6',
  md: 'px-5 py-8',
  lg: 'px-5 py-10',
}

/** 全站空态的统一写法：虚线框 + 一句话说「这里是什么」+ 一句怎么让它有东西。
 *
 *  此前五处各写各的（工作页两处、资产页、陪伴页、卡片清单），虚线框的圆角、留白、
 *  文案语气都在各自漂——空态是「第一次来」看到的那屏，最该统一。 */
export default function EmptyHint({
  title,
  hint,
  action,
  pad = 'md',
  className,
}: {
  /** 主句：这里空着是什么（如「还没有产出。」） */
  title: ReactNode
  /** 次句：怎么让它有东西（给路线，不给命令） */
  hint?: ReactNode
  /** 框内的操作（如「装一条会议流程」按钮） */
  action?: ReactNode
  pad?: keyof typeof PAD
  className?: string
}) {
  return (
    <div
      className={`rounded-xl border border-dashed border-neutral-300 text-center dark:border-neutral-700 ${PAD[pad]} ${className ?? ''}`}
    >
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{title}</p>
      {hint ? (
        <p className="pt-1.5 text-xs leading-relaxed text-neutral-400">{hint}</p>
      ) : null}
      {action ? <div className="pt-2.5">{action}</div> : null}
    </div>
  )
}
