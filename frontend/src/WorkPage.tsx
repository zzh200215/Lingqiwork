/** 工作 — 干活的一条线，**四个业务域**（方案 §一，2026-09-25 定稿）：
 *
 *  - **报告**（`?tab=report`）—— 写一个交得出去的东西。整域在 `ReportPage.tsx`。
 *  - **提示词**（`?tab=prompt`）—— 攒 → 试 → 量，一页闭环。库/对打/评测/技能/数据形态五区。
 *  - **工作流**（`?tab=workflow`）—— 让它自己跑的事。链的定义与它的运行同屏。
 *  - **事项**（`?tab=thread`）—— 这件事我到哪了。
 *
 *  **这一页只剩「档」的分发与页头**：每个域的实现都在自己的文件里
 *  （`ReportPage` / `PromptLibrary` / `PromptLab` / `CapabilityCandidate` / `FormPane` /
 *  `DispatchPanel` / `ThreadsPage`）。判据是方案 §十二：**单一域职责即停手**。
 *
 *  **旧地址全部由 `routes.tsx` 的别名层接住**（`deliver→report`、`automation→workflow`、
 *  `eval→prompt`，以及更早那六个技术构件名），所以这一页永远只见新 key。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Activity, Briefcase, Cpu, HeartPulse } from 'lucide-react'

import { api, type TaskRunItem } from './api'
import EmptyHint from './EmptyHint'
import DispatchPanel from './DispatchPanel'
import FormPane from './FormPane'
import { useDeepLink } from './deeplink'
import PageShell from './PageShell'
import { humanErr, useTaskCenter, useWorkMeetings, useWorkOutputs } from './workData'
import CapabilityCandidate from './CapabilityCandidate'
import PromptLab from './PromptLab'
import PromptLibrary from './PromptLibrary'
import ReportPage from './ReportPage'
import WorkflowRow from './WorkflowRow'
import { resolveWorkTab, type WorkTab } from './routes'
import StatTile from './StatTile'
import EnginePulse, { type PulseStats } from './EnginePulse'
import ThreadsPage from './ThreadsPage'



/** 折叠区（方案 §8.3 的两块次要内容：运行视图 / 后台作业）。
 *
 *  **默认收起**：它们是「想查的时候才看」的东西，摊在首屏会把主体（清单）挤下去。
 *  用原生 `<details>` 而不是手写开合状态——键盘、读屏、锚点跳转全都白拿，
 *  也不必为一个纯展示的分组引一份 state。 */
function Fold({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <details className="wb-card mb-4 px-4 py-3">
      <summary className="flex cursor-pointer items-baseline gap-2">
        <span className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">{title}</span>
        {hint ? <span className="text-xs text-neutral-400">{hint}</span> : null}
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  )
}

/** 页头那句说明**按档换**（方案 §六：每页顶部一句人话主题句）。
 *
 *  原来它在每一档都写着同一句话——在提示词、工作流、事项这几档，
 *  那句话一个字都没说到你眼前这屏在干什么。**页头说的和页面做的对不上**，
 *  和那个「写一份报告」按钮是同一类毛病。
 */
const WORK_DESC: Record<WorkTab, string> = {
  report: '写一个交得出去的东西。',
  prompt: '攒 → 试 → 量，一页闭环。',
  workflow: '让它自己跑的事。',
  thread: '这件事我到哪了。',
}
/** 提示词页的五区（方案 §8.2）。**id 与锚点导航同一份定义**——
 *  两处各写一份的那天，点了没反应还没人报错（同 `WORK_TABS` 那条纪律）。 */
const PROMPT_SECTIONS = [
  { id: 'prompt-lib', label: '库' },
  { id: 'prompt-duel', label: '对打' },
  { id: 'prompt-eval', label: '评测' },
  { id: 'prompt-skill', label: '技能' },
  { id: 'prompt-form', label: '数据形态' },
] as const

/** 提示词页的**一个区**：标题 + 副标题 + 落点（方案 §8.2 给五区各写了一句副标题）。

 *  **为什么包一层而不是改那三个组件**：评测 / 技能草稿 / 数据形态是**现成组件原样并入**的
 *  （方案原话）。它们自己有内容，但没有「这一区叫什么、它是干嘛的」。把标题写进它们里面，
 *  等于为了一个页头去动三个各有各的家的文件；包一层则谁都不动。
 *
 *  副标题那句话**照抄方案**——它是用户走查时「看标签名猜中页面内容」那条验收的一部分，
 *  不是随便写的说明。
 */
function PromptSection({
  id,
  title,
  sub,
  children,
}: {
  id: string
  title: string
  sub: string
  children: ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-14">
      <div className="flex flex-wrap items-baseline justify-between gap-2 pb-1">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">{title}</h2>
        <span className="text-xs text-neutral-400">{sub}</span>
      </div>
      {children}
    </section>
  )
}

export default function WorkPage() {
  const [err, setErr] = useState('')
  /** 每条的 30 天成绩（`/api/dashboard` 的 `task_stats.by_task`）。
   *  由 `EnginePulse` 回报——那一份数据本来就是它在读，不新增请求。 */
  const [taskStats, setTaskStats] = useState<
    Record<string, { runs: number; ok: number; rate: number | null }>
  >({})

  /** 页头那三块统计砖的数（方案 §8.3：砖并入页头）。取数仍在 `EnginePulse` 里，
   *  它算好了报上来——**取数与呈现分开**，但只读一次那三个接口。 */
  const [pulse, setPulse] = useState<PulseStats | null>(null)

  // 标签挂在 ?tab= 上：/threads 的旧链接重定向过来带的就是 tab=follow；
  // 工作流深链 ?task=7 没写 tab，直接落「工作流」才对得上。
  // `lab`（Q1 的提示词对照台）、`form`（Q3 的形态）和 `dispatch`（Q4 的调度台）刻意放在
  // **工作模块**里：提示词工程、数据集、编排都是「非编程的那部分工作」，它们和产出、工作流
  // 是同一张桌子上的事。
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab')
  // 标签清单在 `routes.tsx`（侧栏与这一页**同一份**）：`?tab=` 是唯一入口，
  // 页面里那排标签按钮已经删掉（2026-09-18 导航改版）。
  const tab: WorkTab = resolveWorkTab(tabParam) ?? (params.get('task') ? 'workflow' : 'report')
  const setTab = (t: WorkTab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        n.set('tab', t)
        return n
      },
      { replace: true }
    )

  // 工作流（§4-11）：定义、最近运行、失败原因同屏
  const [openRuns, setOpenRuns] = useState<number | null>(null)
  /** `null` = **还不知道**（正在拉 / 拉不到），`[]` = 拉到了、确实没有。 */
  const [runs, setRuns] = useState<TaskRunItem[] | null>(null)
  const [wfBusy, setWfBusy] = useState<number | null>(null)
  const [wfrBusy, setWfrBusy] = useState<number | null>(null) // 正在放行/驳回的那次运行
  const [presetBusy, setPresetBusy] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  // 「处理一项工作」：题目 → 起链 → 三步各自停下等你点头（工作 preset）
  const [workTopic, setWorkTopic] = useState('')
  const [workOpen, setWorkOpen] = useState(false)
  const [workBusy, setWorkBusy] = useState(false)
  const [workMsg, setWorkMsg] = useState('')
  // M2：这一步/这条流程的产物挂到哪件「事」上。名字当场就有（起链的回执里带着），
  // 不必再拉一次详情——「挂到哪了」是运行期就知道的事，不该等下一次刷新。
  const [workThread, setWorkThread] = useState<{ id: number; name: string } | null>(null)

  // **域级取数收在 "workData.ts"**：加载、错误、刷新一处管。原来这里是三个各写各的
  // "useCallback"，错误处理三种写法——"refreshOutputs" 报错、"refreshTasks" 与
  // "refreshMeetings" 静默吞。同一页面上「读不到」有时候说话有时候不说，没人故意这么定。
  const { outputs, refresh: refreshOutputs } = useWorkOutputs(setErr)
  const { tasks, lastRuns, history, refresh: refreshTasks } = useTaskCenter(setErr)
  // 会议只在挂载时拉一次（这一页没有手动刷新会议的动作）——所以不取它的 refresh
  const { meetings } = useWorkMeetings(setErr)

  // 从「一件事」点一条工作流过来（`?task=7`）：滚到那条流程并亮一下。
  // **必须在 `tasks` 之后**——它按「任务到没到」决定要不要找那一行。
  useDeepLink('task', tasks.length > 0)

  /** 活性（2026-09-26）：这一页的主角是「让它自己跑的事」，页面自己得知道世界变了。
   *  原来任务只在挂载时拉一次，之后只有点重跑/放行才刷新——cron 半夜跑完的、
   *  卡点上等了半天的，屏幕上一概无感，要自己想起来刷新才能看见。
   *  节拍跟状态走：**有在跑或在等的**每 5 秒（看得到推进），闲时 30 秒（「上次跑于」
   *  不至于是一小时的旧闻）；页面切走或不可见就不打——没人看不花请求。
   *  每拍就两个只读请求（任务清单 + 批量最近运行），打的是本机后端。 */
  const wfActive = tab === 'workflow' && tasks.some((t) => t.running || t.awaiting_run_id != null)
  const [wfTick, setWfTick] = useState(0)
  useEffect(() => {
    if (tab !== 'workflow') return
    const t = window.setInterval(
      () => {
        if (document.hidden) return
        refreshTasks()
        setWfTick((n) => n + 1)
      },
      wfActive ? 5000 : 30000
    )
    return () => window.clearInterval(t)
  }, [tab, wfActive, refreshTasks])

  /** 展开的那条**在跑**时，运行记录跟着心跳重读——步骤条与日志才会长出新的脚步，
   *  「运行中」那行跑完时自己翻面成结果。拉不到就保持原样：轮询不往错误条里灌噪音。 */
  useEffect(() => {
    if (!wfTick || openRuns == null) return
    if (!tasks.find((t) => t.id === openRuns)?.running) return
    let live = true
    api
      .listTaskRuns(openRuns)
      .then((r) => live && setRuns(r))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [wfTick, openRuns, tasks])

  /** 页头那个「＋ 新建提示词」推给 PromptLibrary 的信号（按钮在页头、草稿状态在那一层）。 */
  const [promptNewSignal, setPromptNewSignal] = useState(0)
  /** 同上，给「写一份报告」推给 `ReportPage`——面板的展开状态归它自己，
   *  页头只管把信号推过去（同 PromptLibrary 的写法）。 */
  const [reportNewSignal, setReportNewSignal] = useState(0)
  /** 同上，给事项页的「＋ 新的一件事」（方案 §8.4）。 */
  const [threadNewSignal, setThreadNewSignal] = useState(0)

  const toggleRuns = useCallback(
    async (id: number) => {
      if (openRuns === id) {
        setOpenRuns(null)
        return
      }
      setOpenRuns(id)
      // `null` = **还不知道**（正在拉 / 拉不到），`[]` = 拉到了、确实没有。
      // 这个区别就是「读不到 ≠ 没有」在类型上的落点。
      setRuns(null)
      try {
        setRuns(await api.listTaskRuns(id))
      } catch (e) {
        // **别把「拉不到」摆成「没有」**：要是这里 `setRuns([])`，页级错误条刚说完
        // 「运行记录拉不出来」，紧挨着下面一行又斩钉截铁地说「还没有运行记录」——
        // 两句话矛盾，而用户会信下面那句具体的。留在 `null` 上，那一行就不出现，
        // 由错误条独家解释为什么这一栏是空的。
        setErr(`运行记录拉不出来：${humanErr(e)}`)
      }
    },
    [openRuns]
  )

  const rerun = useCallback(
    /** `topic` 非空 = **这次运行换一个题目**（`runTask` 的运行期覆盖，不改任务模板）。
     *  方案 §8.3 第 5 条：重跑要能改本次参数——否则「想换个说法再跑一次」只能去设置里改任务。 */
    async (id: number, topic = '') => {
      setWfBusy(id)
      try {
        // **没传 topic 就只传 id**：这次运行与「改参数」之前逐字一致，
        // 后端也照旧用任务自己的 prompt（不是「传一个空题目覆盖掉」）。
        if (topic) await api.runTask(id, topic)
        else await api.runTask(id)
        refreshTasks()
        if (openRuns === id) setRuns(await api.listTaskRuns(id))
        refreshOutputs() // 任务可能落 vault——产出清单跟着刷新
      } catch (e) {
        // 原来这里是空 catch，注释写着「失败原因会落在 run 记录里」——可后端不可达时
        // **连 run 记录都不会产生**，于是点了重跑、什么都没发生、也没人说一句。
        setErr(`重跑没起来：${humanErr(e)}`)
      } finally {
        setWfBusy(null)
      }
    },
    [openRuns, refreshTasks, refreshOutputs]
  )

  /** 人工卡点（§4-12）：通过 / 驳回。冲突（已经审过了）不吵人——刷新出来的就是事实。 */
  const review = useCallback(
    async (taskId: number, runId: number, approve: boolean) => {
      setWfrBusy(runId)
      try {
        if (approve) await api.approveRun(runId)
        else await api.rejectRun(runId)
        refreshOutputs() // 放行后下游可能落 vault
      } catch (e) {
        // 「状态早就变了，刷新即可」只对**冲突**成立。后端不可达时状态根本没变，
        // 而用户点的是「通过 / 驳回」——那一下没生效，必须说。
        setErr(`没成功：${humanErr(e)}`)
      } finally {
        setWfrBusy(null)
        refreshTasks()
        if (openRuns === taskId) {
          try {
            setRuns(await api.listTaskRuns(taskId))
          } catch {
            /* 列表拉不到就保持原样 */
          }
        }
      }
    },
    [openRuns, refreshTasks, refreshOutputs]
  )

  /** 一键装会议闭环：装完工作流区就有四步链了（幂等，重复点不会装第二遍）。 */
  const installPreset = useCallback(async () => {
    setPresetBusy(true)
    try {
      await api.installMeetingPreset()
      refreshTasks()
    } catch (e) {
      // 原来是空 catch，注释写「装不上就什么都不变」——**UI 上真的什么都不变**，
      // 用户只会以为按钮坏了。装了要说、装不上更要说。
      setErr(`会议流程装不上：${humanErr(e)}`)
    } finally {
      setPresetBusy(false)
    }
  }, [refreshTasks])

  /** 一键装语音进料（R2）：装完 `voice/inbox/` 就有个监听它的任务。
   *  与会议那条**故意分开**——会议要留着原声并往下走三步，这条只留文本（转完删录音）。 */
  const installVoice = useCallback(async () => {
    setVoiceBusy(true)
    try {
      await api.installVoicePreset()
      refreshTasks()
    } catch (e) {
      // 原来是空 catch，注释写「装不上就什么都不变」——**UI 上真的什么都不变**，
      // 用户只会以为按钮坏了。装了要说、装不上更要说。
      setErr(`会议流程装不上：${humanErr(e)}`)
    } finally {
      setVoiceBusy(false)
    }
  }, [refreshTasks])

  /** 处理一项工作：装好（幂等）→ 找到第一步 → 用题目起链。之后三步在你的「通过」下
   *  逐步接手，产物自动落进产出清单。
   *  M2：题目同时是这件事的**名字**——后端按它复用或新建一条「事」，三步的成品都挂上去。
   *  所以这里不只是起一条流水线，是**开一件有名字的工作**：做完之后它自己收口。 */
  const startWork = useCallback(async () => {
    const t = workTopic.trim()
    if (!t) {
      setWorkMsg('先写一个题目。')
      return
    }
    setWorkBusy(true)
    setWorkMsg('')
    setWorkThread(null)
    try {
      const r = await api.installWorkPreset()
      // **认链头，不认名字**。原来是 `find((x) => x.name === '工作·调研')`——preset 里的
      // 任务名一改（那是后端的事），这个 find 会静默返回 undefined，用户只看到
      // 「装不出第一步」，没人知道是前端硬编码的名字过期了。
      // 链头 = **没有任何一条把它当作下游**的那一步；这是链本身的结构，不是名字。
      const downstream = new Set(
        r.tasks.map((x) => x.chain_next_id).filter((x): x is number => x != null)
      )
      const step1 = r.tasks.find((x) => !downstream.has(x.id)) ?? r.tasks[0]
      if (!step1) {
        setWorkMsg('装不出第一步——preset 返回了空的任务清单。')
        return
      }
      const ran = await api.runTask(step1.id, t, t)
      setWorkTopic('')
      setWorkOpen(false)
      setWorkThread(ran.thread ? { id: ran.thread.id, name: ran.thread.name } : null)
      // 按钮本来就在这一页（「自动化」＝原「引擎」），别再把人支使到别处去
      setWorkMsg('调研跑起来了——跑完会在这页停下等你通过。')
      refreshTasks()
    } catch (e) {
      setWorkMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setWorkBusy(false)
    }
  }, [workTopic, refreshTasks])
  const nameOf = (id: number | null) =>
    id == null ? '' : (tasks.find((t) => t.id === id)?.name ?? '')
  /** 停在人工卡点上、等你放行的那些步（方案 §8.3：置顶横幅）。 */
  const waiting = tasks.filter((t) => t.awaiting_run_id != null)
  /** 清单顺序：**待放行的排最前**（方案 §8.3），其余保持后端给的顺序。
   *  用 sort 而不是两次 filter 拼接：两次拼接会丢掉「后端顺序」这个稳定前提。 */
  const orderedTasks = [...tasks].sort((a, b) => {
    const aw = a.awaiting_run_id != null ? 0 : 1
    const bw = b.awaiting_run_id != null ? 0 : 1
    return aw - bw
  })

  return (
    <PageShell
      title="工作"
      description={WORK_DESC[tab]}
      // 方案 §8.3：三块统计砖**并入页头 stats**——它们是「这台机器现在什么状态」，
      // 埋在折叠区里等于每次都要先展开才看得见。砖本身仍是 §七 说的 `<StatTile>`。
      stats={
        tab === 'workflow' && pulse ? (
          <div className="flex flex-wrap gap-3 pt-2">
            <StatTile
              icon={<Cpu className="h-3.5 w-3.5" />}
              accent="bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300"
              label="工作流"
              value={pulse.tasks}
              sub={pulse.waiting > 0 ? `${pulse.waiting} 条在等点头` : undefined}
            />
            <StatTile
              icon={<Activity className="h-3.5 w-3.5" />}
              accent="bg-emerald-100 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300"
              label="30 天成功率"
              value={pulse.rate}
              sub={pulse.runs30d > 0 ? `${pulse.runs30d} 次运行` : undefined}
            />
            <StatTile
              icon={<HeartPulse className="h-3.5 w-3.5" />}
              accent="bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"
              label="后台作业"
              value={pulse.jobs ? pulse.jobs.normal : null}
              sub={
                pulse.jobs
                  ? `共 ${pulse.jobs.total} 个${pulse.jobs.failing ? ` · 连挂 ${pulse.jobs.failing}` : ''}`
                  : undefined
              }
            />
          </div>
        ) : undefined
      }
      // 方案 §七：内容区 `space-y-4`。**间距归容器管，不归每个区块自己管**——
      // 原来是每块各写一个 `mb-6`，于是「两块之间到底多远」要读完所有区块才知道，
      // 而且条件渲染（`? : null`）一多，空隙就会在没人注意的时候叠起来。
      bodyClassName="space-y-4"
      actions={
        /* **页头主操作按档换**。原来它在每一档都写着「写一份交付」——
           在提示词那一档点下去会跳去交付，是「按钮说的」和「按钮做的」对不上。
           现在三档各有自己的主操作（方案 §8.1/§8.3：主操作一个实心按钮）。 */
        tab === 'prompt' ? (
          <button
            onClick={() => setPromptNewSignal((n) => n + 1)}
            className="shrink-0 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-700"
          >
            ＋ 新建提示词
          </button>
        ) : tab === 'workflow' ? (
          <button
            onClick={() => setWorkOpen(true)}
            className="shrink-0 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-700"
          >
            起一个题目
          </button>
        ) : tab === 'thread' ? (
          <button
            onClick={() => setThreadNewSignal((n) => n + 1)}
            className="shrink-0 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-700"
          >
            ＋ 新的一件事
          </button>
        ) : (
          /* 报告页的主操作（方案 §8.1）。**实心 teal**——它是这一页的主操作，
             不是次要动作（契约：主操作一个实心按钮，其余收为次要）。
             点它：当前不在报告档就先切过去，再推一个信号让生成面板展开。
             按钮字面**不跟着面板开合变**：面板的开合状态归 `ReportPage` 自己，
             为了改一个按钮字而把状态提上来，是拿两处的耦合换四个字。 */
          <button
            onClick={() => {
              if (tab !== 'report') setTab('report')
              setReportNewSignal((n) => n + 1)
            }}
            className="shrink-0 rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-teal-700"
          >
            写一份报告
          </button>
        )
      }
    >
      {/* 那排标签（产出 / 引擎 / 实验室 / 形态 / 调度台 / 跟进）已经搬到**侧栏**
          （2026-09-18 导航改版）：同一件事不留两个入口，页面上只剩内容。
          切页仍然走 `?tab=`，所以旧书签、深链、`/threads` → `/work?tab=thread` 都不破。 */}

      {/* 方案 §8.3：**等你放行置顶**（仿 GitHub Actions 的 Waiting + Review deployments）。
          停在卡点上的步骤是此刻唯一非做不可的事，摆在清单顶上就地放行，
          省掉「先去清单里找到那一行」。没有待放行时整块不出现。 */}
      {tab === 'workflow' && waiting.length > 0 ? (
        <section
          data-waiting-banner
          className="rounded-lg border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-500/40 dark:bg-amber-500/10"
        >
          <h2 className="pb-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
            {waiting.length} 步等你放行
          </h2>
          <ul className="divide-y divide-amber-200/70 dark:divide-amber-500/20">
            {waiting.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-neutral-700 dark:text-neutral-200">
                  {t.name}
                  {nameOf(t.chain_next_id) ? (
                    <span className="pl-1.5 text-xs text-neutral-400">
                      → {nameOf(t.chain_next_id)}
                    </span>
                  ) : null}
                </span>
                {t.last_result ? (
                  <span
                    className="min-w-0 max-w-[280px] truncate text-xs text-neutral-500"
                    title={t.last_result}
                  >
                    {t.last_result}
                  </span>
                ) : null}
                <button
                  onClick={() => void review(t.id, t.awaiting_run_id!, true)}
                  disabled={wfrBusy === t.awaiting_run_id}
                  className="shrink-0 rounded-full border border-emerald-300 px-2.5 py-0.5 text-xs text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-40 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
                >
                  通过
                </button>
                <button
                  onClick={() => void review(t.id, t.awaiting_run_id!, false)}
                  disabled={wfrBusy === t.awaiting_run_id}
                  className="shrink-0 rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs text-neutral-500 transition-colors hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  驳回
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {tab === 'workflow' ? (
      <>
      {/* 处理一项工作：给一个题目，三步（调研 → 方案 → 汇报稿）各跑各的、各停下等点头。
          这是「工作」作为一条线的正面入口——不必先去设置里拼任务。
          `p-5`：方案 §8.3 给 hero 定的是这个（§七 也写着「页面主入口/hero `wb-card-hero p-5`」），
          与报告页那块生成面板同一个档。 */}
      <section className="wb-card-hero rounded-lg p-5">
        <div className="flex items-center justify-between gap-3 pb-2">
          <h2 className="flex items-center gap-2.5 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            <span className="wb-chip h-7 w-7 rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300">
              <Briefcase className="h-4 w-4" />
            </span>
            处理一项工作
          </h2>
          <span className="text-xs text-neutral-400">题目 → 调研 → 方案 → 汇报稿，每步停下等你点头</span>
        </div>
        {workOpen ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={workTopic}
              onChange={(e) => setWorkTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void startWork()
              }}
              autoFocus
              placeholder="一句话题目（例：要不要上向量库选型）"
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
            <button
              onClick={() => void startWork()}
              disabled={workBusy}
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-violet-500 disabled:opacity-40"
            >
              {workBusy ? '起链…' : '开始'}
            </button>
            <button
              onClick={() => {
                setWorkOpen(false)
                setWorkMsg('')
              }}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-700 dark:border-neutral-700 dark:text-neutral-400"
            >
              收起
            </button>
          </div>
        ) : (
          <button
            data-open-work
            onClick={() => setWorkOpen(true)}
            className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-violet-500"
          >
            起一个题目
          </button>
        )}
        {workMsg ? <p className="pt-2 text-xs text-neutral-500">{workMsg}</p> : null}
        {/* M2：题目就是这件事的名字——三步的成品都会挂上去，所以当场给一个去处，
            不用等你想起来「这件事我给它起过名字」。 */}
        {workThread ? (
          <p className="pt-1 text-xs text-neutral-500">
            产物会挂到「
            <Link
              to={`/work?tab=thread&thread=${workThread.id}`}
              className="text-violet-600 hover:underline dark:text-violet-400"
            >
              {workThread.name}
            </Link>
            」这件事上 —— 调研 / 方案 / 汇报稿都会落在那里。
          </p>
        ) : null}
      </section>

      <section>
        <div className="flex items-baseline justify-between pb-1">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">工作流</h2>
          <span className="text-xs text-neutral-400">跑完带接地分 —— 「跑成功但变差」只有它看得见</span>
        </div>
        {tasks.length === 0 ? (
          <EmptyHint
            pad="sm"
            title="还没有工作流。"
            hint="在「设置 · 定时任务」里配一条，或者直接装一条现成的。会议那条：录音丢进 vault/meetings/inbox/ 就自己转写、出纪要与待办。语音备忘那条：录音丢进 vault/voice/inbox/ 就转成文本（vault/voice/ 里一份 md，原录音转完就删）。"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void installPreset()}
                  disabled={presetBusy}
                  className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
                >
                  {presetBusy ? '正在装…' : '装一条会议流程'}
                </button>
                {/* R2 · PLAN5 §3：语音进料。与会议那条分开摆，是因为**行为不一样**——
                    会议留着原声往下走三步，这条只留文本、转完就删掉录音。 */}
                <button
                  data-install-voice
                  onClick={() => void installVoice()}
                  disabled={voiceBusy}
                  className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
                >
                  {voiceBusy ? '正在装…' : '装一条语音备忘'}
                </button>
              </div>
            }
          />
        ) : (
          <ul className="wb-card divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {orderedTasks.map((t) => (
              <WorkflowRow
                key={t.id}
                task={t}
                nextName={nameOf(t.chain_next_id)}
                open={openRuns === t.id}
                runs={runs}
                rate={taskStats[String(t.id)]}
                lastRun={lastRuns[String(t.id)]}
                history={history[String(t.id)]}
                busy={wfBusy === t.id}
                reviewBusy={wfrBusy === t.awaiting_run_id}
                onToggle={() => void toggleRuns(t.id)}
                onRerun={(topic) => void rerun(t.id, topic)}
                onReview={(approve) => {
                  if (t.awaiting_run_id != null) void review(t.id, t.awaiting_run_id, approve)
                }}
              />
            ))}
          </ul>
        )}
      </section>
      </>
      ) : null}

      {tab === 'workflow' && meetings.length > 0 ? (
        <section>
          <div className="flex items-baseline justify-between pb-1">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">会议</h2>
            <span className="text-xs text-neutral-400">一场一个文件夹，原声留着可回听</span>
          </div>
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {meetings.map((m) => (
              <li key={m.path} className="py-3">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-700 dark:text-neutral-200">
                    {m.title}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400">{m.date.slice(5)}</span>
                </div>
                {m.audio ? (
                  <audio
                    controls
                    preload="none"
                    src={api.audioUrl(m.audio)}
                    className="mt-1.5 h-8 w-full max-w-md"
                  />
                ) : null}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {m.files.map((f) => (
                    <Link
                      key={f.path}
                      to={`/notes?path=${encodeURIComponent(f.path)}`}
                      title={f.path}
                      className="rounded-full border border-neutral-200 px-2.5 py-0.5 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-300"
                    >
                      {f.title}
                    </Link>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 方案 §8.3 的排列：**清单是主体**，这两块排在它后面、**默认收起**，
          于是首屏只剩「等你放行 + 起题目 + 清单」。
          EnginePulse 给统计砖（工作流数 / 30 天成功率 / 后台作业）与作业健康；
          DispatchPanel 是「谁在跑、卡在哪」。两者都是「想查才看」。 */}
      {tab === 'workflow' ? (
        <Fold title="运行视图 · 谁在跑、卡在哪">
          {/* refreshKey：跟着上面的心跳走——「谁在跑」是一块会过期的看板，
              只在挂载时读一次的看板，摆的是打开页面那一刻的世界。 */}
          <DispatchPanel refreshKey={wfTick} />
        </Fold>
      ) : null}

      {tab === 'workflow' ? (
        <Fold title="后台作业" hint="这台机器上常驻的那几个，以及最近几次运行">
          <EnginePulse
            tasks={tasks}
            lastRuns={lastRuns}
            onTaskStats={setTaskStats}
            onPulse={setPulse}
          />
        </Fold>
      ) : null}

      {/* 页级错误条。**不按 tab 门控**——原来它只在「交付」档渲染，于是别的档里
          `setErr` 写进去却永远不显示：错误被静默吞掉，切回那一档还会突然弹一条陈旧的。
          文案也不再写死「产出清单拉不出来」：现在它要报的重跑失败、放行失败、
          装流程失败、搜材料失败……**说话的是写入方**，这里只管显示。 */}
      {err ? (
        <p
          data-work-err
          className="flex items-start justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        >
          <span className="min-w-0">{err}</span>
          <button
            onClick={() => setErr('')}
            className="shrink-0 text-xs text-rose-500 underline hover:text-rose-700 dark:hover:text-rose-200"
          >
            知道了
          </button>
        </p>
      ) : null}


      {/* 报告 = 生成面板 + 报告清单 + 阅读视图，整域在 ReportPage.tsx */}
      {tab === 'report' ? (
        <ReportPage
          newSignal={reportNewSignal}
          outputs={outputs}
          refresh={refreshOutputs}
          onError={setErr}
        />
      ) : null}
      {tab === 'thread' ? (
        <ThreadsPage
          chromeless
          newSignal={threadNewSignal}
          /* 就地起工作链（方案 §8.4）：把事名带过去预填题目，然后切到工作流页——
             **只预填、不起链**：起链要花模型钱，最后那一下得由人按。 */
          onStartWork={(name) => {
            setWorkTopic(name)
            setWorkOpen(true)
            setWorkMsg('')
            setTab('workflow')
          }}
        />
      ) : null}
      {/* 提示词页 = 五区同页（方案 §8.2）：库 / 对打 / 评测 / 技能 / 数据形态。
          前三区里的「库 + 对打」在 `PromptLibrary` 里（那两区本来就归它），
          后三块是现成组件原样并入——**不把它们 import 进 PromptLibrary**：
          那会凭空造一个「谁编排谁」的耦合，而它们的家各自清楚。

          锚点导航放在这一层，因为**五区的挂载点在这里**；id 与 `PROMPT_SECTIONS`
          同一份定义（两处各写一份的那天，点了没反应还没人报错）。 */}
      {tab === 'prompt' ? (
        <>
          <nav
            data-prompt-sections
            className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-1.5 bg-white/95 px-1 py-2 backdrop-blur dark:bg-neutral-950/95"
          >
            {PROMPT_SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="rounded-full border border-neutral-200 px-2.5 py-0.5 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-700 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-violet-600 dark:hover:text-violet-300"
              >
                {s.label}
              </a>
            ))}
          </nav>

          {/* 库与对打两块在 `PromptLibrary` 里渲染（对打要用它手上那份提示词清单，
              所以只能在那儿）——它们的 id 因此也**跟着各自的内容走**，写在
              `PromptLibrary` / `PromptDuel` 里。`PROMPT_SECTIONS` 是这五个 id 的清单，
              而 `WorkPage.test` 与 `PromptLibrary.test` 各查自己拥有的那几个。 */}
          <div id="prompt-lib" className="scroll-mt-14">
            <PromptLibrary newSignal={promptNewSignal} />
          </div>
          <PromptSection
            id="prompt-eval"
            title="评测"
            sub="系统提示词的对照台——改了有没有变好，拿金标题量"
          >
            <PromptLab />
          </PromptSection>
          <PromptSection
            id="prompt-skill"
            title="技能草稿"
            sub="把材料读成 SKILL.md 草稿，跑过对照才算数"
          >
            <CapabilityCandidate />
          </PromptSection>
          <PromptSection id="prompt-form" title="数据形态" sub="金标题集的领域分布">
            <FormPane />
          </PromptSection>
        </>
      ) : null}
    </PageShell>
  )
}