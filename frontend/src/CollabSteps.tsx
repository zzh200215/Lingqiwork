/** 协作的**逐步账**（A2 的 `step` 事件；`Agent升级.md` §3「逐步账流出来了但没做界面呈现」那一笔）。
 *
 *  **它回答的是哪一问**：一句话交给几个 agent 跑完之后，用户只看到一段纪要——**贵在哪、
 *  卡在哪、哪一步交的是占位符**都没处看。后端每一步都流了一条事实出来（谁、几轮、几次工具、
 *  几秒、有没有烧光、是不是并行那一波），这里只把它摆出来。
 *
 *  **两条纪律**（与 `TurnLedger` 同一套）：
 *  1. **不自己算**：轮数/工具/秒数全部照抄后端的 `fact`，界面不加权、不聚合、不排名——
 *     一处加个"总耗时"就会与后端那笔账分叉；
 *  2. **`rounds_exhausted` 要说出来**：烧光那一步交回来的是占位符，它在正文里长得像一段
 *     正常回答（A2 撞过：四步全烧光被判成"干净"）。所以这里给它一个显眼的记号，
 *     别让读的人以为那一步"跑完了"。
 *
 *  **它不是历史**：这一份来自流式事件，后端不落库（同 `tools`）——刷新之后只剩纪要正文。
 */
import type { CollabStep } from './stream'

/** phase → 一眼看得出的记号。`read`/`digest` 是②之后 fanout 拆出来的两步。 */
const PHASE_MARK: Record<string, string> = {
  read: '📖',
  digest: '🧩',
  work: '🔨',
  draft: '✍️',
  review: '🔍',
  revise: '♻️',
  merge: '🧬',
}

function toolNote(tools: string[]): string {
  if (!tools.length) return '没用工具'
  const uniq = Array.from(new Set(tools))
  const many = tools.length > uniq.length ? `${tools.length} 次` : ''
  return `${many || `${tools.length} 次`}：${uniq.join('、')}`
}

export default function CollabSteps({ steps }: { steps: CollabStep[] }) {
  if (!steps.length) return null
  const burned = steps.filter((s) => s.rounds_exhausted).length
  const failed = steps.filter((s) => s.error).length
  const totalTools = steps.reduce((n, s) => n + (s.tools?.length ?? 0), 0)
  const parallel = steps.filter((s) => s.parallel).length
  return (
    <div
      data-collab-steps
      className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50/60 p-2.5 text-xs dark:border-neutral-800 dark:bg-neutral-900/40"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 text-neutral-500 dark:text-neutral-400">
        <span className="font-medium text-neutral-600 dark:text-neutral-300">逐步账</span>
        <span>
          {steps.length} 步 · {totalTools} 次工具
          {parallel > 0 ? ` · ${parallel} 步并行` : ''}
        </span>
        {burned > 0 && (
          <span data-collab-steps-burned className="text-amber-600 dark:text-amber-400">
            · {burned} 步把轮数烧光（交回的是占位符，不是答案）
          </span>
        )}
        {failed > 0 && (
          <span data-collab-steps-failed className="text-rose-500">
            · {failed} 步报错
          </span>
        )}
      </div>
      <ul className="mt-1.5 space-y-1">
        {steps.map((s) => (
          <li
            key={`${s.step}-${s.title}`}
            data-collab-step={s.step}
            className="flex flex-wrap items-baseline gap-x-2 text-neutral-500 dark:text-neutral-400"
          >
            <span className="w-4 shrink-0 tabular-nums">{s.step}</span>
            <span className="shrink-0">{PHASE_MARK[s.phase] ?? '•'}</span>
            <span className="min-w-0 truncate text-neutral-700 dark:text-neutral-200">
              {s.title}
            </span>
            <span className="shrink-0 rounded bg-neutral-200/70 px-1 text-xs dark:bg-neutral-800">
              {s.agent}
            </span>
            <span className="shrink-0 tabular-nums">{s.rounds} 轮</span>
            <span className="min-w-0 truncate">{toolNote(s.tools ?? [])}</span>
            <span className="shrink-0 tabular-nums">{s.seconds}s</span>
            {s.rounds_exhausted && (
              <span className="shrink-0 text-amber-600 dark:text-amber-400">烧光</span>
            )}
            {s.error && (
              <span
                data-collab-step-error={s.step}
                className="min-w-0 truncate text-rose-500"
                title={s.error}
              >
                {s.error}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
