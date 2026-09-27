/** 提示词编辑器：右栏那张「新建 / 编辑」的表单。
 *
 *  ## 它为什么单独一份
 *
 *  它是**一屏完整的表单**（标题 / 正文 / 分类 / 标签 / 收藏 / 评分 / 出处 / 备注 +
 *  AI 快速优化 + 底部那排动作），而 `PromptLibrary.tsx` 主组件那份已经很长了。
 *
 *  ## 它几乎不持有状态，这是有意的
 *
 *  除了「AI 优化那句自己想说的话」（`refineAsk`）与「正在等 AI」（`aiPhase`），
 *  其余全是 `draft` / `setDraft` 的受控字段——**草稿只有一个真值**，就在父组件那里。
 *  在这边再存一份 `useState` 的话，「重置改动」「关掉时问一句」都要去两个地方对齐。
 *
 *  ## 三处说法是有来历的，别顺手改短
 *
 *  - 「未保存」那个标：没有它，「关掉会问你一句」这件事**只有当你要走的时候才知道**。
 *  - 「改的是右边这份草稿」：AI 那一排按钮挨着正文，不写清楚会让人以为直接改了库。
 *  - 「关掉」不叫「取消」：它问一句再决定，而「取消」在别处是「什么都不做」的意思。
 */
import { Sparkles } from 'lucide-react'

import { star } from './PromptViews'
import RunPanel from './RunPanel'
import { varsIn, type Draft } from './promptDraft'
import type { PromptCategoryItem } from './api'

export default function PromptEditor({
  draft,
  setDraft,
  dirty,
  cats,
  busy,
  aiPhase,
  aiErr,
  onAiCancel,
  refineAsk,
  setRefineAsk,
  onSave,
  onClose,
  onReset,
  onHistory,
  onUsages,
  onRefine,
  onVars,
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  /** 改了没存。只用来摆那个「未保存」的小标。 */
  dirty: boolean
  /** 分类下拉的候选（`<datalist>`）。**只是建议**——真正的分类是 `draft.category` 那个字符串。 */
  cats: PromptCategoryItem[]
  busy: boolean
  aiPhase: 'idle' | 'planning' | 'done' | 'error'
  aiErr: string
  /** 「不等了」：掐掉正在等的那次 AI 调用（**不是「停止」**，见 RunPanel 那段注释）。 */
  onAiCancel: () => void
  refineAsk: string
  setRefineAsk: (s: string) => void
  onSave: () => void
  onClose: () => void
  onReset: () => void
  onHistory: () => void
  onUsages: () => void
  /** `ask` 非空 = 用户自己说的那句；空串 = 上面那排预设按钮。 */
  onRefine: (ask: string) => void
  /** 「提取变量」：让模型把变量挖出来填进正文。 */
  onVars: () => void
}) {
  const vars = varsIn(draft.content)

  return (
    <div
      // `wb-card` 而不是手抄一份同款边框——见 `DeliverOutlineBox` 里那条注释。
      className="wb-card p-4 transition-colors"
      data-prompt-editor
    >      <h2 className="flex items-center gap-2 pb-3 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
        {draft.id == null ? '新建提示词' : `编辑《${draft.title || '未命名'}》`}
        {/* 改了没存之前有个看得见的标。否则「点关掉会问一句」那件事
            只有当你要走的时候才知道 —— 而那时候已经晚了。 */}
        {dirty ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-normal text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            未保存
          </span>
        ) : null}
      </h2>

      <div className="space-y-3">
        <label className="block">
          <span className="text-[13px] text-neutral-500 dark:text-neutral-400">标题</span>
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="给它起个一眼能认的名字"
            className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>

        <label className="block">
          <span className="text-xs text-neutral-400">
            正文 · 每次会变的地方写成 {'{变量}'}，用的时候会问你
          </span>
          <textarea
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            rows={10}
            className="mt-1 w-full resize-y rounded-lg border border-neutral-300 bg-white px-2 py-1.5 font-mono text-xs leading-relaxed outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
          />
          {vars.length ? (
            <span className="mt-1 block text-xs text-violet-600 dark:text-violet-400">
              会问到的变量：{vars.map((v) => `{${v}}`).join(' ')}
            </span>
          ) : null}
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[13px] text-neutral-500 dark:text-neutral-400">分类</span>
            <input
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
              list="prompt-categories"
              placeholder="例：汇报"
              className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <datalist id="prompt-categories">
              {cats.map((c) => (
                <option key={c.name} value={c.name} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className="text-[13px] text-neutral-500 dark:text-neutral-400">标签（逗号分隔，全角也认）</span>
            <input
              value={draft.tags}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
              placeholder="写作, 周报"
              className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <input
              type="checkbox"
              checked={draft.favorite}
              onChange={(e) => setDraft({ ...draft, favorite: e.target.checked })}
            />
            收藏
          </label>
          <label className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            评分
            <select
              value={draft.rating}
              onChange={(e) => setDraft({ ...draft, rating: Number(e.target.value) })}
              className="rounded-lg border border-neutral-300 bg-white px-1.5 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? '没评' : star(n)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[13px] text-neutral-500 dark:text-neutral-400">出处（哪来的）</span>
            <input
              value={draft.source}
              onChange={(e) => setDraft({ ...draft, source: e.target.value })}
              placeholder="自己写的 / 一个链接"
              className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="block">
            <span className="text-[13px] text-neutral-500 dark:text-neutral-400">备注（为什么留它）</span>
            <input
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        </div>
      </div>

      {/* AI 快速优化（AI Gist 那一排快捷动作）——**同样只改草稿** */}
      <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50/50 p-3 dark:border-sky-500/30 dark:bg-sky-500/10">
        <p className="pb-2 text-[13px] font-medium uppercase tracking-wider text-sky-700 dark:text-sky-300">
          <Sparkles className="h-4 w-4" /> 快速优化这条
        </p>
        <div className="flex flex-wrap gap-1.5">
          {['更清晰', '更简洁', '补充边界', '结构化模板'].map((s) => (
            <button
              key={s}
              onClick={() => onRefine(s)}
              disabled={aiPhase === 'planning' || !draft.content.trim()}
              className="rounded-full border border-sky-300 px-2.5 py-0.5 text-[13px] text-sky-700 transition-colors hover:bg-sky-100 disabled:opacity-40 dark:border-sky-600 dark:text-sky-300 dark:hover:bg-sky-500/10"
            >
              {s}
            </button>
          ))}
          <button
            onClick={onVars}
            disabled={aiPhase === 'planning' || !draft.content.trim()}
            className="rounded-full border border-sky-300 px-2.5 py-0.5 text-[13px] text-sky-700 transition-colors hover:bg-sky-100 disabled:opacity-40 dark:border-sky-600 dark:text-sky-300 dark:hover:bg-sky-500/10"
          >
            提取变量
          </button>
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={refineAsk}
            onChange={(e) => setRefineAsk(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && refineAsk.trim()) onRefine(refineAsk)
            }}
            aria-label="手动调整指令"
            placeholder="或者自己说一句，例：保留变量结构，补上负责人和截止时间"
            className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-sky-400 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            onClick={() => onRefine(refineAsk)}
            disabled={!refineAsk.trim() || aiPhase === 'planning'}
            className="shrink-0 rounded-lg border border-sky-300 px-2.5 py-1 text-sm text-sky-700 transition-colors hover:bg-sky-100 disabled:opacity-40 dark:border-sky-600 dark:text-sky-300"
          >
            {aiPhase === 'planning' ? '改中…' : '改'}
          </button>
        </div>
        {/* 长任务走 RunPanel 六态（方案 §六）：原来只有按钮上一个「改中…」+ 一段
            手写的红字。**「不等了」不是「停止」**——一次性 POST 断开之后服务端照样
            跑完那次调用。这里不摆「重试」：改哪一句在输入框里，重试就是再点一次「改」。 */}
        {aiPhase !== 'idle' ? (
          <div className="pt-2">
            <RunPanel
              phase={aiPhase === 'error' ? 'error' : 'progress'}
              tone={aiPhase === 'error' ? 'rose' : 'violet'}
              icon="✍️"
              title="改这条提示词"
              status="正在改——可能要十几秒"
              error={aiPhase === 'error' ? aiErr : undefined}
              onCancel={onAiCancel}
              cancelLabel="不等了"
            />
          </div>
        ) : null}
        <p className="pt-2 text-[13px] text-neutral-400">
          改的是右边这份草稿——没点「保存」之前，库里那条一个字都没动。
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          onClick={onSave}
          disabled={busy}
          className="rounded-md wb-btn-primary px-4 py-2 text-sm"
        >
          {busy ? '保存中…' : draft.id == null ? '存进库' : '保存'}
        </button>
        <button
          onClick={onClose}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-500 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
        >
          关掉
        </button>
        <button
          onClick={onReset}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-500 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
        >
          重置改动
        </button>
        {draft.id != null ? (
          <>
            <button
              onClick={onHistory}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-500 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
            >
              看历史
            </button>
            <button
              onClick={onUsages}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-500 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
            >
              看使用记录
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}
