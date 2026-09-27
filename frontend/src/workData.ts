/** 工作模块的**域级数据**：每样东西**一处**管加载、错误、刷新。
 *
 *  ## 为什么要有这个文件
 *
 *  方案 §3.2 要「每域一个数据 hook」，但原话是「**不拆页面文件，hook 可先放同文件上半部**」
 *  ——那条走不通：这个模块每个标签的取数**分散在各自的独立文件**里
 *  （`ThreadsPage.tsx` / `PromptLab.tsx` / `FormPane.tsx` / `DispatchPanel.tsx`），
 *  放在 `WorkPage.tsx` 上半部它们**根本 import 不到**，而那个文件已经两千多行。
 *  所以收在这里：**一个模块，谁都能 import**。
 *
 *  ## 它解决的具体毛病
 *
 *  这些取数原来是三个各写各的 `useCallback`，**错误处理三种写法**：
 *  `refreshOutputs` 报错、`refreshTasks` 静默吞、`refreshMeetings` 静默吞。
 *  同一个页面上「读不到」有时候说话有时候不说，没人是故意这么定的——是各写各的写出来的。
 *  收进来之后**一处的纪律管全部**：读不到就说读不到。
 *
 *  ## 用法
 *
 *  ```tsx
 *  const { outputs, refresh: refreshOutputs } = useWorkOutputs(setErr)
 *  ```
 *  hook **自己会挂载时拉一次**，不用调用方再写 `useEffect`。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  api,
  type DeliverCatalogue,
  type ScheduledTask,
  type TaskRunItem,
  type WorkMeeting,
  type WorkOutput,
} from './api'

/** 把 `request()` 抛的那串 `503: {"detail":"…"}` 里那句人话挖出来。 */
export function humanErr(e: unknown): string {  const raw = e instanceof Error ? e.message : String(e)
  const m = raw.match(/\{"detail":"([\s\S]*?)"\}/)
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`) as string
    } catch {
      return m[1]
    }
  }
  return raw
}

/** 把 `onError` 放进 ref：调用方多半直接传 `setErr`（每次渲染都是新函数），
 *  直接进依赖数组会让 `refresh` 每次渲染都换身份，挂载 effect 于是反复重跑。 */
function useErrSink(onError?: (m: string) => void) {
  const ref = useRef(onError)
  ref.current = onError
  return useCallback((m: string) => ref.current?.(m), [])
}

/** 模型以外的四个引擎产出（`/api/work/outputs`）：清单 + 加载态 + 刷新。 */
export function useWorkOutputs(onError?: (m: string) => void) {
  const [outputs, setOutputs] = useState<WorkOutput[]>([])
  const [loading, setLoading] = useState(true)
  const fail = useErrSink(onError)

  const refresh = useCallback(() => {
    // best-effort：列不出来时给一句实话，不把整页弄成错误页
    api
      .workOutputs()
      .then((r) => setOutputs(r.outputs))
      .catch((e) => fail(`产出清单拉不出来：${humanErr(e)}`))
      .finally(() => setLoading(false))
  }, [fail])

  useEffect(() => {
    refresh()
  }, [refresh])
  return { outputs, loading, refresh }
}

/** 工作流定义（`/api/tasks`）：定义 + **每条最近一段运行历史** + 刷新。
 *
 *  **为什么拉的是「历史」不是单条**：清单每行两处要用运行数据——行内「上次跑于何时、
 *  跑了多久」（只活在某一次 `TaskRun` 上），以及「最近运行结果条」（Buildkite 式，
 *  颜色=结果、高度=耗时，比「30 天 82%」一个聚合数看得见趋势）。一次批量请求
 *  （`recent-runs?n=10`）两处都喂饱，`lastRuns` 从历史的第一条**派生**，
 *  不另发一次请求。
 *
 *  `lastRuns` / `history` 按 task_id（字符串键，与后端的分组键一致）给；
 *  **没跑过的任务不在里面**——调用方据此区分「没跑过」与「读不到」，
 *  别把两者都说成「没有耗时」。
 */
export function useTaskCenter(onError?: (m: string) => void) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [history, setHistory] = useState<Record<string, TaskRunItem[]>>({})
  const [loading, setLoading] = useState(true)
  const fail = useErrSink(onError)

  const refresh = useCallback(() => {
    api
      .listTasks()
      .then((t) => {
        setTasks(t)
        // 批量只读（`recent-runs?ids=` 自己封顶 50 个 id；n=10 给结果条用）。
        // **读不到就不摆耗时那一格**——不是编一个 0 出来，也不是把整页弄成错误页。
        const ids = t.slice(0, 50).map((x) => x.id)
        if (!ids.length) return
        api
          .recentTaskRunBatches(ids)
          .then(setHistory)
          .catch(() => setHistory({}))
      })
      // 原来是 `.catch(() => {})` —— 工作流拉不到，界面就摆一个空列表，
      // 看起来像「你一条都没建」。**拿失败冒充「没有」**，这一页点过名的毛病。
      .catch((e) => fail(`工作流拉不出来：${humanErr(e)}`))
      .finally(() => setLoading(false))
  }, [fail])

  useEffect(() => {
    refresh()
  }, [refresh])

  /** 每条最近一次运行（= 历史的**第一条**，新在前）。 */
  const lastRuns: Record<string, TaskRunItem> = useMemo(() => {
    const out: Record<string, TaskRunItem> = {}
    for (const [k, v] of Object.entries(history)) if (v[0]) out[k] = v[0]
    return out
  }, [history])

  return { tasks, lastRuns, history, loading, refresh }
}

/** 会议（`/api/work/meetings`）：一场一个文件夹，录音能回听。 */
export function useWorkMeetings(onError?: (m: string) => void) {
  const [meetings, setMeetings] = useState<WorkMeeting[]>([])
  const fail = useErrSink(onError)

  const refresh = useCallback(() => {
    api
      .workMeetings()
      .then((r) => setMeetings(r.meetings))
      .catch((e) => fail(`会议拉不出来：${humanErr(e)}`))
  }, [fail])

  useEffect(() => {
    refresh()
  }, [refresh])
  return { meetings, refresh }
}

/** 交付的体裁 × 读者定义（**唯一真值在后端**）。
 *
 *  它拉不到时**不当成错误**：面板不显示，清单照常用——这是原来就定好的行为，
 *  收进来的时候照旧（不是每一条读不到都值得吵一次）。 */
export function useDeliverCatalogue() {
  const [catalogue, setCatalogue] = useState<DeliverCatalogue | null>(null)
  useEffect(() => {
    api
      .deliverGenres()
      .then((c) => setCatalogue(c))
      .catch(() => {})
  }, [])
  return catalogue
}
