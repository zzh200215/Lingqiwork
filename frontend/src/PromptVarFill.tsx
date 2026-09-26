/** 填值使用（方案 §8.2 区1②）——复制之前把 `{变量}` 填上，弹表单。
 *
 *  ## 为什么是弹窗（方案原话）
 *
 *  原来是列表上方一块内联面板。方案写的是「弹表单 Modal：每个变量一行 input，
 *  底部「生成并复制」」——**弹窗少占版面**，而且填值这件事是「就这一条，填完拿走」，
 *  是一次性的动作，不是常驻的一栏。分类管理那一屏也是同一个做法（`PromptCategoryManager`）。
 *
 *  ## 右边那半屏是这一步的重点
 *
 *  「填进去之后长什么样」当场看得见——变量不再是「问一句填一句」的盲填。
 *  这是这一块唯一值得单独说的设计：**填值与结果同屏**，所以两栏而不是一栏。
 *
 *  ## 「上次填过的值已经预填好了」那句话是有前提的
 *
 *  预填来自 `PromptItem.last_vars`（后端记着上一次用过什么）。父组件保证打开时先把它
 *  铺进 `vals`；这里不自己取数——**取数只有一处**，不然两个地方各填一次会打架。
 */
import { Clock } from 'lucide-react'

import { fill, varsIn } from './promptDraft'
import { useEscapeClose } from './workShared'
import type { PromptItem } from './api'

export default function PromptVarFill({
  item,
  vals,
  setVals,
  onCopy,
  onUsages,
  onClose,
}: {
  /** 正在填的那条提示词。 */
  item: PromptItem
  vals: Record<string, string>
  setVals: (v: Record<string, string>) => void
  /** 底部那颗实心按钮：把填好的正文交给剪贴板。 */
  onCopy: () => void
  onUsages: () => void
  onClose: () => void
}) {
  const names = varsIn(item.content)
  const done = names.filter((v) => vals[v]).length
  // Esc 关掉这一层（仓里 11 处浮层都守这条；这一处 2026-09-25 才补上）
  useEscapeClose(onClose)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-label={`填值使用 ${item.title}`}
      data-prompt-fill
      // 点遮罩关掉：弹窗的常规预期（里面那颗「收起」才是显式出口）
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* 模态是**唯一允许有阴影**的地方（契约：shadows only for modals/drawers/dropdowns），
          圆角也单独一档（10px）——与分类管理那一屏同一个壳。 */}
      <div className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-[10px] border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-baseline justify-between border-b border-neutral-200 bg-neutral-50 px-5 py-3 dark:border-neutral-800 dark:bg-neutral-800/50">
          <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            ✎ 填写 · {item.title}
          </p>
          <span className="flex items-center gap-3">
            <span className="text-xs text-neutral-400">
              已填写 {done}/{names.length}
            </span>
            <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700" aria-label="关闭">
              ✕
            </button>
          </span>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-2">
          <div className="space-y-2">
            {names.length === 0 ? (
              <p className="text-xs text-neutral-400">这条没有 {'{变量}'}——直接复制就行。</p>
            ) : (
              names.map((v) => (
                <label key={v} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 truncate text-[13px] text-neutral-500 dark:text-neutral-400">
                    {'{' + v + '}'}
                  </span>
                  <input
                    autoFocus={v === names[0]}
                    value={vals[v] ?? ''}
                    onChange={(e) => setVals({ ...vals, [v]: e.target.value })}
                    aria-label={`变量 ${v}`}
                    className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                </label>
              ))
            )}
          </div>
          {/* 填进去之后长什么样——**这一步是 AI Gist 最值得抄的地方**：
              变量不再是「问一句填一句」，而是当场看得见结果。 */}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs leading-relaxed text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950/50 dark:text-neutral-300">
            {fill(item.content, vals)}
          </pre>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-neutral-200 bg-neutral-50 px-5 py-3 dark:border-neutral-800 dark:bg-neutral-800/50">
          <button
            onClick={onCopy}
            className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700"
          >
            生成并复制
          </button>
          <button
            onClick={() => setVals({})}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
          >
            清空
          </button>
          <button
            onClick={onUsages}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
          >
            <Clock className="h-4 w-4" /> 使用记录
          </button>
          <span className="ml-auto text-xs text-neutral-400">上次填过的值已经预填好了——不用重填。</span>
        </div>
      </div>
    </div>
  )
}
