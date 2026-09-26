/** 步骤条（方案 §8.3）：点一次运行 → 看清它每一步干了什么。
 *
 *  ## 步骤从哪来
 *
 *  **运行日志里**（`task_runs.log_json`）——那个数组的顺序就是发生的顺序，而顺序正是
 *  步骤条的全部价值。里面两种形状：工具调用（`tool`）与引擎相位（`step`，取材/成文/落盘）。
 *  分两个数组就没法交错：两边都没有时间戳，插不回正确的位置。
 *
 *  ## 三条「不编」
 *
 *  - **没有步骤就说没有**：纯提示词那一趟既不调工具、也不走引擎相位，日志是空的。
 *    这里如实说一句，而不是摆一条「运行 → 完成」的假步骤条。
 *  - **耗时是量出来的**：`ms` 缺失就不摆那一格（老运行行没有这一列）。
 *  - **失败的那一步留着**：`ok=false` 的步骤照样在条上——省掉它，那趟失败看上去
 *    会像「没跑过」，而它明明跑到了取材。
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'

import type { TaskRunItem } from './api'

export interface Step {
  name: string
  ok: boolean
  ms: number | null
  /** 一句话说明（几条材料 / 几节 / 为什么失败） */
  note: string
  /** 落了什么（vault 相对路径） */
  ref: string
  /** 工具那一步才有：输入与输出。展开时看 */
  args?: Record<string, unknown>
  result?: string
  isTool: boolean
}

/** `run.log` → 步骤表。**原序**，不做排序——那份顺序本身就是真值。

 *  `skill_inject` 那项不算一步：它是**注入痕迹**，不是工序；运行行的小结里已经写着
 *  「注入 X」了，再在步骤条上摆一个「注入」会让人以为它是一次调用。
 */
export function stepsOf(run: TaskRunItem): Step[] {
  const out: Step[] = []
  for (const e of run.log ?? []) {
    if (e.tool === 'skill_inject') continue
    const name = e.step || e.tool
    if (!name) continue
    out.push({
      name,
      // `ok` 缺省当成功：老日志项没有这一列，而它们是**跑完了才会被记下来**的那些
      ok: e.ok !== false,
      ms: typeof e.ms === 'number' ? e.ms : null,
      note: e.note || '',
      ref: e.ref || '',
      args: e.args,
      result: e.result,
      isTool: !e.step,
    })
  }
  return out
}

/** 毫秒 → 人话。不足一秒给毫秒（那里的差别有意义），过了一秒给秒。 */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`
  return `${(ms / 1000).toFixed(1)} 秒`
}

function pretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

export default function RunSteps({ run }: { run: TaskRunItem }) {
  const [open, setOpen] = useState<number | null>(null)
  const steps = stepsOf(run)

  if (!steps.length) {
    return (
      <p data-run-steps className="pl-1 pt-1 text-xs text-neutral-400">
        这次没留下步骤——它是纯提示词那一趟，既没调工具，也没走引擎相位。
      </p>
    )
  }

  return (
    <ol data-run-steps className="space-y-0.5 pt-1">
      {steps.map((s, i) => (
        <li key={i} className="pl-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${s.ok ? 'bg-emerald-500' : 'bg-rose-500'}`}
              title={s.ok ? '这一步过了' : '这一步没过'}
            />
            <button
              onClick={() => setOpen(open === i ? null : i)}
              className="shrink-0 text-xs text-neutral-700 transition-colors hover:text-violet-600 dark:text-neutral-200 dark:hover:text-violet-300"
            >
              {s.name}
            </button>
            {/* 耗时是量出来的：没有就不摆（老运行行没有这一列，摆 0 秒是编） */}
            {s.ms != null ? <span className="text-xs text-neutral-400">{fmtMs(s.ms)}</span> : null}
            {s.note ? (
              <span className={`text-xs ${s.ok ? 'text-neutral-400' : 'text-rose-600 dark:text-rose-400'}`}>
                {s.note}
              </span>
            ) : null}
            {s.ref ? (
              <Link
                to={`/notes?path=${encodeURIComponent(s.ref)}`}
                className="truncate text-xs text-teal-600 hover:underline dark:text-teal-400"
                title={s.ref}
              >
                {s.ref}
              </Link>
            ) : null}
            {s.isTool ? (
              <button
                onClick={() => setOpen(open === i ? null : i)}
                className="shrink-0 text-xs text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
              >
                {open === i ? '收起' : '输入/输出'}
              </button>
            ) : null}
          </div>

          {open === i ? (
            <div className="ml-4 mt-1 space-y-1 rounded-md border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-900/60">
              {s.isTool ? (
                <>
                  <p className="text-xs text-neutral-400">输入</p>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-neutral-600 dark:text-neutral-300">
                    {pretty(s.args ?? {})}
                  </pre>
                  <p className="text-xs text-neutral-400">输出</p>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-neutral-600 dark:text-neutral-300">
                    {s.result || '（空）'}
                  </pre>
                </>
              ) : (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {s.note || '这一步没有留下说明。'}
                </p>
              )}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  )
}
