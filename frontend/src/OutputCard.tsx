import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import type { WorkOutput } from './api'

/** 每一种产出的标签配色，和「学」页那几个动作、RunPanel 的语义色对齐。
 *  对齐一处放，产出清单（工作页 / 资产页）与学页工具回执行共用同一套。 */
export const KIND_BADGE: Record<WorkOutput['kind'], string> = {
  research: 'border-sky-300 text-sky-700 dark:border-sky-700 dark:text-sky-300',
  compose: 'border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300',
  recap: 'border-violet-300 text-violet-700 dark:border-violet-700 dark:text-violet-300',
  decide: 'border-violet-300 text-violet-700 dark:border-violet-700 dark:text-violet-300',
  conflict: 'border-rose-300 text-rose-700 dark:border-rose-700 dark:text-rose-300',
  deliver: 'border-teal-300 text-teal-700 dark:border-teal-700 dark:text-teal-300',
  task: 'border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300',
}

/** 一条产出记录的一行式呈现：体裁标签 + 标题 + 附带事实 + 右侧动作。
 *
 *  「产出清单里的某一件」与「刚跑完的那个引擎产物」是同一副样子——工作页/资产页的
 *  产出列表、学页工具完成后的回执行都长这样，所以合成一个。
 *  正文不在这里：这一行的职责是**指到**产物（`href`/`onOpen`），不是展示它。 */
export default function OutputCard({
  kind,
  label,
  title,
  meta,
  href,
  onOpen,
  actions,
  className,
}: {
  kind?: WorkOutput['kind']
  /** 体裁标签的文案（研究 / 方案 / 交付…）；不给就不渲染标签——如学页回执行，
   *  那里卡头已经写了「研究」，再挂一个标签是重复 */
  label?: ReactNode
  title: ReactNode
  /** 标题下/旁的一行事实（来源 12 条、路径、日期…） */
  meta?: ReactNode
  /** 有 href 就渲染成链接；否则配 onOpen 渲染成按钮 */
  href?: string
  onOpen?: () => void
  /** 右侧动作（挂到…、改写成、存进知识库…） */
  actions?: ReactNode
  className?: string
}) {
  const titleClass =
    'min-w-0 flex-1 truncate text-left text-sm text-neutral-700 transition-colors hover:text-violet-700 dark:text-neutral-200 dark:hover:text-violet-300'
  return (
    <div className={`group flex items-center gap-3 py-2.5 ${className ?? ''}`}>
      {label !== undefined ? (
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
            kind ? KIND_BADGE[kind] : 'border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300'
          }`}
        >
          {label}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        {href ? (
          <Link to={href} title={typeof title === 'string' ? title : undefined} className={`block ${titleClass}`}>
            {title}
          </Link>
        ) : onOpen ? (
          <button onClick={onOpen} className={`block ${titleClass}`}>
            {title}
          </button>
        ) : (
          <span className="block truncate text-sm text-neutral-700 dark:text-neutral-200">{title}</span>
        )}
        {meta ? <div className="truncate text-[11px] text-neutral-400">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}
