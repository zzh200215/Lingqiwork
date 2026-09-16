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
 */
import { useCallback, useEffect, useState } from 'react'

import { api, type DispatchBoard, type DispatchStep } from './api'

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

function StepRow({
  step,
  busy,
  onAction,
}: {
  step: DispatchStep
  busy: boolean
  onAction: (step: DispatchStep, kind: string, label: string) => void
}) {
  return (
    <li data-dispatch-step={step.task_id} data-dispatch-state={step.state} className="flex items-center gap-2 py-1.5">
      <span className="w-5 shrink-0 text-right text-[11px] text-neutral-400 tabular-nums">{step.index}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-neutral-700 dark:text-neutral-200" title={step.name}>
        {step.name}
      </span>
      <span className="hidden truncate text-[11px] text-neutral-400 sm:inline" title={step.who}>
        {step.who}
      </span>
      {step.state === 'blocked' && step.blocked_by ? (
        <span className="shrink-0 text-[10px] text-neutral-400">等第 {step.index - 1} 步</span>
      ) : null}
      <span
        data-dispatch-label={step.state}
        className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${TONE[step.state] ?? TONE.idle}`}
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
          className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-40 ${
            a.kind === 'reject'
              ? 'border-neutral-300 text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800'
              : 'border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-500/50 dark:text-violet-300 dark:hover:bg-violet-500/10'
          }`}
        >
          {a.label}
        </button>
      ))}
    </li>
  )
}

export default function DispatchPanel() {
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
    return <p className="text-sm text-neutral-400">正在读调度台…</p>
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
        className="rounded-xl border border-violet-200 bg-violet-50/60 px-3 py-2 text-sm text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200"
      >
        🐾 {board.broadcast}
      </p>

      {note ? <p className="text-xs text-emerald-600 dark:text-emerald-400">{note}</p> : null}

      {board.chains.length === 0 ? (
        <p data-dispatch-empty className="rounded-xl border border-dashed border-neutral-300 px-3 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
          还没有任务链。工作流页建两条、用「链到下一个」串起来，这里就会出现一条流水线。
        </p>
      ) : (
        board.chains.map((c) => (
          <section
            key={c.root_id}
            data-dispatch-chain={c.root_id}
            className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800"
          >
            <header className="mb-1 flex items-baseline gap-2">
              <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{c.name}</h3>
              <span className="text-[11px] text-neutral-400">
                {c.length} 步
                {c.needs_attention && c.stuck_at ? ` · 卡在「${c.stuck_at.name}」` : ' · 没有在等人的环节'}
              </span>
            </header>
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {c.steps.map((s) => (
                <StepRow key={s.task_id} step={s} busy={busy} onAction={(st, kind, label) => void act(st, kind, label)} />
              ))}
            </ul>
          </section>
        ))
      )}

      <p className="text-[11px] text-neutral-400">
        共 {board.counts.chains} 条链、{board.counts.steps} 步
        {board.counts.running ? ` · 在跑 ${board.counts.running} 步` : ''}
        {board.counts.needs_attention ? ` · 等人动手 ${board.counts.needs_attention} 条` : ''}
      </p>
    </div>
  )
}
