/** 调度台（Q4）：确定性编排的看板 —— 谁在跑、卡在哪、点谁放行。
 *
 *  为什么是「看板」而不是「项目经理」：`docs/ai-dev-plan.md` ③ 写清了不做自主 PM 的三条理由
 *  （仓库自己否决过；单 agent 的失真会相乘；最阴的失败是编排者拿着不完整信息继续推进）。
 *  所以这一屏只做两件事：**把服务端算出来的状态画出来** + **提供真的动作按钮**。
 *
 *  - 状态**全部来自后端**（`/api/dispatch`，从 `tasks` / `task_runs` 算的）——界面不自己推状态，
 *    推了就是第二份真值；
 *  - 按钮点的是**现成的接口**：`run` / `approve` / `reject`（不是聊天里 @ 一下）；
 *  - 红线（照 `quality.py`）：这是看板不是考核 —— 不设目标、不催、不排名。
 *
 *  2026-09-19 画法升级：步骤从「一行行列表」改成**流水线节点图**——每步一颗
 *  状态色节点（在跑=天空蓝呼吸、等人=琥珀、跑完=绿、出错=红），步与步之间连线，
 *  上一步跑完线就变绿。数据还是那一份，只是把「第 2 步在等第 1 步」这件事
 *  画成人一眼能读的形状。
 */
import { useCallback, useEffect, useState } from 'react'

import { api, type DispatchBoard, type DispatchStep } from './api'
import { SkeletonRows } from './Skeleton'

const TONE: Record<string, string> = {
  running: 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-300',
  awaiting:
    'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300',
  ok: 'border-emerald-200 bg-emerald-50/70 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  error: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300',
  rejected: 'border-rose-200 bg-rose-50/70 text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
  blocked: 'border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-400',
  idle: 'border-neutral-200 bg-white text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400',
  off: 'border-neutral-200 bg-neutral-100 text-neutral-400 dark:border-neutral-700 dark:bg-neutral-800/40 dark:text-neutral-500',
}

const DOT: Record<string, string> = {
  // **sky = 运行**（全站语义色约定）。这里原来是品牌紫，与同一屏里
  // 标签色（`TONE.running`）和计数 chip 的 sky 分岔——同一个「在跑」三种颜色。
  // 光晕的色在 `index.css` 的 `wb-node-pulse` 里，已一并改成 sky。
  running: 'bg-sky-500 wb-node-running',
  awaiting: 'bg-amber-400',
  ok: 'bg-emerald-500',
  error: 'bg-rose-500',
  rejected: 'bg-rose-300 dark:bg-rose-500/60',
  blocked: 'bg-neutral-300 dark:bg-neutral-600',
  idle: 'bg-neutral-300 dark:bg-neutral-700',
  off: 'bg-neutral-200 dark:bg-neutral-700/60',
}

function StepNode({
  step,
  isLast,
  next,
  busy,
  onAction,
}: {
  step: DispatchStep
  isLast: boolean
  next: DispatchStep | undefined
  busy: boolean
  onAction: (step: DispatchStep, kind: string, label: string) => void
}) {
  return (
    <li
      data-dispatch-step={step.task_id}
      data-dispatch-state={step.state}
      className="flex min-w-40 flex-1 flex-col"
    >
      {/* 节点与连线：上一步跑完，这条线就是绿的 */}
      <div className="flex h-4 items-center">
        <span className={`h-3 w-3 shrink-0 rounded-full ${DOT[step.state] ?? DOT.idle}`} />
        {isLast ? (
          <span className="flex-1" />
        ) : (
          <span
            className={`h-0.5 flex-1 rounded-full ${
              step.state === 'ok'
                ? 'bg-emerald-300/80 dark:bg-emerald-500/40'
                : 'bg-neutral-200 dark:bg-neutral-700'
            }`}
            title={next ? `下一步：${next.name}` : undefined}
          />
        )}
      </div>

      <div className="mt-2.5 flex flex-col items-start gap-1.5 pr-4">
        <p className="flex w-full items-baseline gap-1.5 text-sm text-neutral-700 dark:text-neutral-200">
          <span className="shrink-0 text-xs tabular-nums text-neutral-400">{step.index}</span>
          <span className="min-w-0 truncate" title={step.name}>
            {step.name}
          </span>
        </p>
        <p className="w-full truncate text-xs text-neutral-400" title={step.who}>
          {step.who}
        </p>
        {step.state === 'blocked' && step.blocked_by ? (
          <p className="text-xs text-neutral-400">等第 {step.index - 1} 步</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            data-dispatch-label={step.state}
            className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${TONE[step.state] ?? TONE.idle}`}
          >
            {step.state_label}
          </span>
          {(step.actions ?? []).map((a) => (
            <button
              key={a.kind}
              data-dispatch-action={a.kind}
              data-dispatch-target={a.run_id ?? a.task_id}
              disabled={busy}
              onClick={() => onAction(step, a.kind, a.label)}
              className={`shrink-0 rounded-md border px-2 py-0.5 text-xs transition-colors disabled:opacity-40 ${
                a.kind === 'reject'
                  ? 'border-neutral-300 text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800'
                  : 'border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-500/50 dark:text-violet-300 dark:hover:bg-violet-500/10'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </li>
  )
}

function CountChip({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${tone}`}
    >
      <b className="tabular-nums">{value}</b> {label}
    </span>
  )
}

export default function DispatchPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [board, setBoard] = useState<DispatchBoard | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    try {
      setBoard(await api.dispatch())
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '读调度台出错')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 跟着工作流页的心跳重读（`refreshKey` 每跳一次 = 页面刚刷过一遍任务）。
  // 「谁在跑、卡在哪」是一块**会过期的看板**——只有挂载那一次的看板，
  // 摆的是打开页面那一刻的世界。动作之后 `load()` 自己会刷，两条路不打架。
  useEffect(() => {
    if (refreshKey > 0) void load()
  }, [refreshKey, load])

  async function act(step: DispatchStep, kind: string, label: string) {
    const a = (step.actions ?? []).find((x) => x.kind === kind)
    if (!a) return
    setBusy(true)
    setNote('')
    try {
      if (a.kind === 'approve') await api.approveRun(a.run_id as number)
      else if (a.kind === 'reject') await api.rejectRun(a.run_id as number)
      else await api.runTask(a.task_id as number)
      setNote(`已${label}：${step.name}`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '动作没成功')
    } finally {
      setBusy(false)
    }
  }

  if (err) {
    return (
      <p data-dispatch-error className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
        读调度台出错：{err}
      </p>
    )
  }
  if (!board) {
    return (
      <div className="space-y-2">
        <SkeletonRows rows={4} />
      </div>
    )
  }

  return (
    <div data-dispatch className="space-y-4">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        这是一块看板：谁在跑、卡在哪、下一步该谁，全部从任务与运行记录算出来。
        它不替你做决定，也不催你 —— 需要人动手的地方才给按钮。
      </p>

      {/* 宠物那一句：只说事实（谁在跑、谁在等），不催不排名 */}
      <p
        data-dispatch-broadcast
        className="rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2 text-sm text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200"
      >
        🐾 {board.broadcast}
      </p>

      <div className="flex flex-wrap gap-2">
        <CountChip label="条链" value={board.counts.chains} tone="border-violet-200 bg-violet-50/70 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300" />
        <CountChip label="步" value={board.counts.steps} tone="border-neutral-200 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300" />
        {board.counts.running ? (
          <CountChip label="步在跑" value={board.counts.running} tone="border-sky-200 bg-sky-50/70 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300" />
        ) : null}
        {board.counts.needs_attention ? (
          <CountChip label="条等人动手" value={board.counts.needs_attention} tone="border-amber-200 bg-amber-50/70 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300" />
        ) : null}
      </div>

      {note ? <p className="text-xs text-emerald-600 dark:text-emerald-400">{note}</p> : null}

      {board.chains.length === 0 ? (
        <p data-dispatch-empty className="rounded-md border border-dashed border-neutral-300 px-3 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
          还没有任务链。工作流页建两条、用「链到下一个」串起来，这里就会出现一条流水线。
        </p>
      ) : (
        /* bento：链卡两列并排——单步链全宽时一头字一边空白，是最显空的版式；
           只有一条链时它独占整行。步骤顺序与状态锚点不动。 */
        <div className="grid grid-cols-1 items-stretch gap-4 xl:grid-cols-2">
          {board.chains.map((c) => (
            <section
              key={c.root_id}
              data-dispatch-chain={c.root_id}
              className={`wb-card p-4 ${board.chains.length === 1 ? 'xl:col-span-2' : ''}`}
            >
              <header className="mb-3 flex items-baseline gap-2">
                <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{c.name}</h3>
                <span className="text-xs text-neutral-400">
                  {c.length} 步
                  {c.needs_attention && c.stuck_at ? ` · 卡在「${c.stuck_at.name}」` : ' · 没有在等人的环节'}
                </span>
              </header>
              <ol className="flex overflow-x-auto pb-1">
                {c.steps.map((s, i) => (
                  <StepNode
                    key={s.task_id}
                    step={s}
                    isLast={i === c.steps.length - 1}
                    next={c.steps[i + 1]}
                    busy={busy}
                    onAction={(st, kind, label) => void act(st, kind, label)}
                  />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
