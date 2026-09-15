/** 会话流里的**一行回执**：这一轮存下来的成品，指到产出详情，正文不在对话里。
 *
 *  为什么单独一行而不是把正文摊开：长文卡是「页面乱」的最大单点——一份周报糊在
 *  对话里，上下文的对话全被推走。回执只留「体裁 + 标题 + 去哪看」，正文活在
 *  vault 文件里（`/notes?path=…`），工作页产出清单也照样能翻到。
 */
import { Link } from 'react-router-dom'

import type { ArtifactRef } from './stream'

/** 落盘动作 → 回执尾巴。老回执没有 `action`，按「存为」显示。
 *
 *  「更新」和「另存」必须说出来：前者是这一轮里覆盖了模型自己刚写的那版，后者是
 *  同名已存在、另开了一个文件（没有静默盖掉之前那份）。用户看不出区别的话，
 *  「已存入产出」这四个字在某些轮次上就是含糊的。 */
const TAIL: Record<string, string> = {
  存为: '已存入产出 →',
  更新: '已更新本轮版本 →',
  另存: '同名已有，已另存 →',
  未变: '内容未变 →',
}

export default function ArtifactReceipt({ art }: { art: ArtifactRef }) {
  return (
    <Link
      to={art.href}
      className="not-prose flex items-center gap-2 rounded-xl border border-teal-200 bg-teal-50/70 px-3 py-2 text-xs transition-colors hover:border-teal-300 hover:bg-teal-50 dark:border-teal-500/30 dark:bg-teal-500/10 dark:hover:border-teal-500/50"
    >
      <span className="shrink-0 text-sm leading-none">📄</span>
      <span className="shrink-0 rounded border border-teal-300 px-1.5 py-0.5 text-[10px] text-teal-700 dark:border-teal-600 dark:text-teal-300">
        {art.label}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-teal-800 dark:text-teal-200">
        {art.title}
      </span>
      <span className="shrink-0 text-teal-600 dark:text-teal-400">
        {TAIL[art.action ?? '存为'] ?? TAIL['存为']}
      </span>
    </Link>
  )
}
