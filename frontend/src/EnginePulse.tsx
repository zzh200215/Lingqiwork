/** EnginePulse —— 「后台作业 + 最近几次运行」两块次要内容 + 页头三块统计砖的取数。
 *
 *  2026-09-26 从 `WorkPage.tsx` 搬出来：那一页涨破了 1000 行守卫，而这一块
 *  本来就是**单一域职责**（读三个接口、算状态、报上去），谁也不再 import 它，
 *  独立成文件是按方案 §十二的同一把尺子剪的。
 */
import { useEffect, useMemo, useState } from 'react'

import { api, type JobHealth, type ScheduledTask, type TaskRunItem } from './api'
import StatRow from './StatRow'
import { ago } from './reltime'
import { runTone, TRIGGER_LABEL } from './workShared'

/** 页头那三块统计砖要的数（方案 §8.3：**统计砖并入页头 stats**）。
 *
 *  `null` 一律表示「还没读到」——砖上摆 `—`，**不摆 0**（「读不到」与「零」是两件事）。 */
export type PulseStats = {
  /** 有几条工作流；`null` = 还没读到 */
  tasks: number | null
  /** 其中几条停在人工卡点上等你点头 */
  waiting: number
  /** 30 天成功率；`null` = 还没跑过（**不是 0%**） */
  rate: string | null
  runs30d: number
  /** 后台作业：共几个 / 正常几个 / 连续失败几个；`null` = 还没读到 */
  jobs: { total: number; normal: number; failing: number } | null
}

/** 引擎那一档的「这台机器现在什么状态」（2026-09-18 内容太少那一轮加的）。
 *
 *  数据全部是现成接口的聚合：任务清单（`/api/tasks`）、30 天运行成败（`/api/dashboard`
 *  的 `task_stats`，这一页此前从没读过）、作业健康（`/api/health/jobs`）。
 *
 *  **它现在只画折叠区里那两块**（最近几次运行 / 后台作业）——三块统计砖搬去了页头
 *  （方案 §8.3 的原话：「EnginePulse 统计砖**并入页头 stats**」）。取数仍在这一块，
 *  因为它是唯一同时读那三个接口的地方；数字通过 `onPulse` 交上去。
 *
 *  **只陈述**：不给成功率评级、不排名、不催（§4-2）。读不到就不摆这一块（§4-8/§4-9）。
 */
export default function EnginePulse({
  tasks,
  lastRuns,
  onTaskStats,
  onPulse,
}: {
  /** 工作流定义。**由页面给**（`useTaskCenter` 拉的）——这一块以前自己再拉一遍，
   *  同一份数据两个请求；顺手把「最近一次运行」也一起拿到了（每行要写耗时）。 */
  tasks: ScheduledTask[]
  /** 每条最近一次运行（批量接口给的，没跑过的任务不在里面）。 */
  lastRuns: Record<string, TaskRunItem>
  /** 把「按任务的 30 天统计」回报给页面——工作流清单每行要自己的成功率（方案 §8.3）。
   *  **不新增请求**：`task_stats` 这一份本来就是这一块在读的。 */
  onTaskStats?: (m: Record<string, { runs: number; ok: number; rate: number | null }>) => void
  /** 把页头那三块砖要的数回报上去。 */
  onPulse?: (p: PulseStats) => void
}) {
  const [jobs, setJobs] = useState<JobHealth[] | null>(null)
  const [stats, setStats] = useState<{ runs_30d: number; rate: number | null } | null>(null)

  /* 只跑一次。**`tasks` 与运行记录不再在这里拉**——那是页面的活（`useTaskCenter`），
   *  同一份数据两个组件各拉一遍，就是两次请求换同一屏东西。 */
  useEffect(() => {
    let live = true
    api
      .healthJobs()
      .then((r) => live && setJobs(r.jobs))
      .catch(() => {})
    api
      .dashboard()
      .then((d) => {
        if (!live) return
        setStats(d.task_stats)
        onTaskStats?.(d.task_stats.by_task ?? {})
      })
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 「最近几次运行」：取前 8 条任务里**跑过的**那些（与清单同一个批量数据）。 */
  const recent = useMemo(
    () =>
      tasks
        .slice(0, 8)
        .map((task) => {
          const run = lastRuns[String(task.id)]
          return run ? { task, run } : null
        })
        .filter((r): r is { task: ScheduledTask; run: TaskRunItem } => !!r),
    [tasks, lastRuns]
  )

  const shownJobs = (jobs ?? []).filter((j) => j.registered)
  const normalJobs = shownJobs.filter((j) => !j.disabled && j.consecutive_failures === 0).length
  const failJobs = shownJobs.filter((j) => j.consecutive_failures > 0).length
  const waiting = tasks.filter((t) => t.awaiting_run_id != null).length

  /** 三块统计砖的那几个数（方案 §8.3：**砖并入页头 stats**，别埋在折叠区里）。 */
  const pulse: PulseStats = useMemo(
    () => ({
      tasks: tasks.length,
      waiting,
      rate:
        stats && stats.runs_30d > 0 && stats.rate != null
          ? `${Math.round(stats.rate * 100)}%`
          : null,
      runs30d: stats && stats.runs_30d > 0 ? stats.runs_30d : 0,
      jobs: jobs ? { total: shownJobs.length, normal: normalJobs, failing: failJobs } : null,
    }),
    [tasks, stats, jobs, waiting, shownJobs.length, normalJobs, failJobs]
  )
  // 数字是这一块取的，砖画在页头上——**取数与呈现分开**，所以得把它们报上去。
  // 放在 `pulseEmpty` 那个提前 return **之前**：那一块整体不显示时，页头照样该有数。
  //
  // **一个都还没回来就先不报**：砖上 `—` 的意思是「读不到」，不是「还没读到」。
  // 挂载瞬间报一次空的，会让页头在每次进这一档时闪三块 `—`。
  useEffect(() => {
    if (!jobs && !tasks.length && !stats) return
    onPulse?.(pulse)
  }, [pulse, onPulse, jobs, tasks, stats])

  const pulseEmpty = !shownJobs.length && !recent.length && !tasks.length && !stats
  if (pulseEmpty) return null

  return (
    <div className="space-y-4" data-engine-pulse>
      <div className="grid items-start gap-4 xl:grid-cols-2">
        {recent.length > 0 ? (
          <section>
            <h2 className="pb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              最近几次运行
            </h2>
            <ul className="wb-card divide-y divide-neutral-100 dark:divide-neutral-800/70">
              {recent.map(({ task, run }) => (
                <li key={run.id} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        run.status === 'ok'
                          ? 'bg-emerald-500'
                          : run.status === 'running'
                            ? 'bg-sky-500 wb-node-running'
                            : run.status === 'awaiting_approval'
                              ? 'bg-amber-400'
                              : run.status === 'rejected'
                                ? 'bg-rose-300 dark:bg-rose-500/60'
                                : 'bg-rose-500'
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-neutral-200">
                      {task.name}
                    </span>
                    {/* 状态与触发器**说人话**（与清单行同一份映射）——这里原来直接印
                        `running` / `awaiting_approval` / `cron` 英文码，同一屏两种语言。 */}
                    <span
                      className={`shrink-0 text-xs font-medium ${
                        run.status === 'ok'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : run.status === 'running'
                            ? 'text-sky-600 dark:text-sky-400'
                            : run.status === 'awaiting_approval'
                              ? 'text-amber-600 dark:text-amber-400'
                              : run.status === 'rejected'
                                ? 'text-rose-500 dark:text-rose-400'
                                : 'text-rose-600 dark:text-rose-400'
                      }`}
                    >
                      {runTone(run).text}
                    </span>
                    <span className="shrink-0 text-xs text-neutral-400">
                      {run.started_at ? ago(Date.parse(run.started_at) / 1000) : ''}
                    </span>
                  </div>
                  <StatRow
                    className="pt-0.5"
                    items={[
                      { label: TRIGGER_LABEL[run.trigger] ?? run.trigger },
                      { label: '轮', value: run.rounds },
                      { label: run.model_id || '—' },
                      run.grounded === null
                        ? { label: '接地分', value: '—', title: '这次没量到分（没材料 / 判分没跑成）' }
                        : { label: '接地分', value: run.grounded.toFixed(2) },
                    ]}
                    trailing={
                      run.error ? (
                        <span className="min-w-0 truncate text-rose-500" title={run.error}>
                          {run.error}
                        </span>
                      ) : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {shownJobs.length > 0 ? (
          <section>
            <h2 className="pb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              后台作业
            </h2>
            <ul className="wb-card divide-y divide-neutral-100 dark:divide-neutral-800/70">
              {shownJobs.map((j) => (
                <li key={j.job_id} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-600 dark:text-neutral-300">
                    {j.job_id}
                  </span>
                  {j.disabled ? (
                    <span className="shrink-0 rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-400 dark:border-neutral-700">
                      已关
                    </span>
                  ) : j.consecutive_failures > 0 ? (
                    <span className="shrink-0 rounded-full border border-rose-200 bg-rose-50/70 px-2 py-0.5 text-xs font-medium text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400">
                      连挂 {j.consecutive_failures} 次
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50/70 px-2 py-0.5 text-xs text-emerald-600 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
                      正常
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-neutral-400">
                    {j.last?.at ? `上次 ${ago(Date.parse(j.last.at) / 1000)}` : '还没跑过'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  )
}
