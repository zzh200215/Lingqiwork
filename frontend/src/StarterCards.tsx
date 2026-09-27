/** 起手建议卡（2026-09-27 从陪伴页抽出）：聊天空态、教它空态、挂件快捷条共用的一份。
 *
 *  三处原本各抄一份——卡片样式约 50 行逐字重复、三条快捷对话文案两处维护，
 *  改一处漏两处（宠物模块改造 §#6/#26）。抽到这里之后：
 *  - 文案只有这一份（挂件快捷条 = 前三张卡；标题被 CompanionPage 的测试钉死，别改字）；
 *  - 卡片样式只有这一份（`starterTileClass` / `StarterTile` / `StarterGrid`）。
 */
import type { ReactNode } from 'react'

export interface StarterCard {
  icon: string
  title: string
  desc: string
  /** 点下去发的那句话 */
  q: string
}

/** 还没开聊时的建议卡——成熟聊天产品的空态范式（ChatGPT/豆包同款）：
 *  每张卡就是第一句话本身。 */
export const STARTER_CARDS: StarterCard[] = [
  { icon: '📋', title: '排一下今天', desc: '看看都欠着什么，排个先后。', q: '帮我看看现在都欠着什么，排个先后。' },
  { icon: '💭', title: '陪我聊两句', desc: '随便什么都行，不用有事。', q: '陪我聊两句，随便什么都行。' },
  { icon: '🌇', title: '总结今天', desc: '我今天都干了点什么。', q: '总结一下我今天都干了什么。' },
  { icon: '🧠', title: '讲讲我的卡点', desc: '挑一个没解的卡点，讲成人话。', q: '挑一个我没解的卡点，用大白话讲讲我卡在哪。' },
]

/** 建议卡的样子：白底描边，hover 时边框变品牌色。Link 卡（教它的两条出路）也用它。 */
export const starterTileClass =
  'rounded-md border border-neutral-200 bg-white p-3.5 text-left transition-all hover:border-violet-300 disabled:opacity-40 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-violet-500/50'

/** 一张能点的建议卡。desc 默认完整多行（聊天的建议句）；传 `descTruncate` 则一行截断、
 *  hover 看全文（教它的选题卡）。 */
export function StarterTile({
  icon,
  title,
  desc,
  descTitle,
  descTruncate,
  footer,
  disabled,
  onClick,
}: {
  icon: string
  title: string
  desc?: string
  /** desc 的 hover 提示（截断时看不全的那一截） */
  descTitle?: string
  descTruncate?: boolean
  /** 底部那行品牌色引导（如「讲这个 →」） */
  footer?: ReactNode
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={starterTileClass}>
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
        <span className="mr-1.5">{icon}</span>
        <span>{title}</span>
      </p>
      {desc ? (
        <p
          className={`mt-0.5 text-xs text-neutral-400 dark:text-neutral-500 ${
            descTruncate ? 'truncate' : 'leading-relaxed'
          }`}
          title={descTitle}
        >
          {desc}
        </p>
      ) : null}
      {footer ? <p className="mt-1 text-xs font-medium text-violet-500">{footer}</p> : null}
    </button>
  )
}

/** 空态卡网格：两列、限宽——1600px 宽屏上不是半屏空白。 */
export function StarterGrid({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 grid w-full max-w-xl grid-cols-1 gap-2.5 sm:grid-cols-2">{children}</div>
  )
}
