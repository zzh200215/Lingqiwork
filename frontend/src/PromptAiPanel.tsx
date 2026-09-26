/** 「AI 生成提示词」那一块（方案 §8.2 区1 的工具行里那颗 `AI 生成`）。
 *
 *  ## 为什么单独一份文件
 *
 *  `PromptLibrary.tsx` 顶到 1004 行，越过了方案 §十二 那条「单文件 ≤1000 行、单一域职责
 *  即停手」。这一块**边界干净**：一个输入框 + 一颗按钮 + 一次 AI 调用的三态
 *  （跑着 / 出错 / 闲），进出只有 `idea` 与 `aiPhase` 两样东西。
 *
 *  ## 状态仍然在库里
 *
 *  `aiPhase` / `aiErr` **不搬过来**：编辑器（`PromptEditor`）也在用同一个 phase 显示
 *  「快速优化 / 提取变量」那两条 AI 动作的状态——一次只可能跑一条。所以这里只收 props，
 *  是**一块视图**，不是第二个真值。
 *
 *  ## 「不等了」不是「停止」
 *
 *  `/api/prompts/ai/generate` 是一次性 POST：断开连接之后**服务端照样跑完那次模型调用**。
 *  所以按钮上不写「停止」（RunPanel 的 `cancelLabel`）。
 */
import { Sparkles } from 'lucide-react'

import RunPanel from './RunPanel'

export default function PromptAiPanel({
  idea,
  setIdea,
  phase,
  err,
  onGenerate,
  onCancel,
}: {
  idea: string
  setIdea: (v: string) => void
  phase: 'idle' | 'planning' | 'done' | 'error'
  err: string
  onGenerate: () => void
  onCancel: () => void
}) {
  return (
    <section
      data-prompt-ai
      className="mb-3 rounded-lg border border-sky-200 bg-sky-50/50 p-4 dark:border-sky-500/30 dark:bg-sky-500/10"
    >
      <p className="flex items-center gap-1.5 pb-2 text-[13px] font-medium uppercase tracking-wider text-sky-700 dark:text-sky-300">
        <Sparkles className="h-4 w-4" /> AI 生成提示词
      </p>
      <div className="flex gap-2">
        <input
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onGenerate()
          }}
          aria-label="想要的提示词"
          placeholder="例：帮我把一段技术材料讲给非技术的 leader 听"
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-sky-400 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          onClick={onGenerate}
          disabled={!idea.trim() || phase === 'planning'}
          className="shrink-0 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-700 disabled:opacity-40"
        >
          {phase === 'planning' ? '生成中…' : '生成'}
        </button>
      </div>
      {/* 长任务走 RunPanel 六态（方案 §六）：原来只有按钮上一个「生成中…」+ 一段手写的红字。 */}
      {phase !== 'idle' ? (
        <div className="pt-2">
          <RunPanel
            phase={phase === 'error' ? 'error' : 'progress'}
            tone={phase === 'error' ? 'rose' : 'sky'}
            icon="✨"
            title="生成一条提示词"
            status="正在写——可能要十几秒"
            error={phase === 'error' ? err : undefined}
            onCancel={onCancel}
            cancelLabel="不等了"
            onRetry={onGenerate}
          />
        </div>
      ) : null}
      <p className="pt-2 text-[13px] text-neutral-400">
        生成的东西只进右边的草稿——改完再点「保存」，才真的进库。
      </p>
    </section>
  )
}
