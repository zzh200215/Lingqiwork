/** 工作 — 干活的一条线，三个标签：**产出**（写一份交付 + 六个引擎的成品清单）、
 *  **引擎**（工作流 + 会议，定时任务从「设置」搬来当一等对象）、**跟进**（「事」，
 *  材料与成品挂到同一件事上，`?tab=follow`）。
 *
 *  **工作流**：这条流程长什么样 / 上次跑到哪 / 为什么失败，同屏可见。每条运行带
 *  接地分（§4-10）：它是无人值守时唯一会说话的东西，「跑成功但悄悄变差」没有别的信号。
 *
 *  **产出**：六个引擎的成品落在 vault 的几个目录里（成文在 notes/，靠日期前缀分辨），
 *  这里把它们列出来、能筛、能点开。
 *
 *  **生成**：交付是唯一在这里就地生成的——其余引擎仍从各自的入口跑，成品自动落到这里。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import {
  api,
  type DeliverCatalogue,
  type MaterialHit,
  type ScheduledTask,
  type TaskRunItem,
  type WorkMeeting,
  type WorkOutput,
} from './api'
import AttachToThread from './AttachToThread'
import EmptyHint from './EmptyHint'
import FeedbackButtons from './FeedbackButtons'
import DispatchPanel from './DispatchPanel'
import FormPane from './FormPane'
import { useDeepLink } from './deeplink'
import { Markdown, reportMarkdown, SourceList } from './markdown'
import { KIND_BADGE } from './OutputCard'
import OutputCard from './OutputCard'
import PageShell from './PageShell'
import PromptLab from './PromptLab'
import StatRow from './StatRow'
import { streamDeliver, type DeliverReport, type ReportDraft } from './stream'
import ThreadsPage from './ThreadsPage'

/** 筛选条的固定顺序——和产出的种类一一对应，不随数据变。 */
const KINDS: { kind: WorkOutput['kind']; label: string }[] = [
  { kind: 'research', label: '研究' },
  { kind: 'compose', label: '成文' },
  { kind: 'recap', label: '复盘' },
  { kind: 'decide', label: '方案' },
  { kind: 'conflict', label: '对质' },
  { kind: 'deliver', label: '交付' },
  { kind: 'task', label: '工作流' },
]

/** 每一种产出的颜色在 OutputCard 里统一定义（产出清单 / 资产页 / 学页回执共用）。 */

const TRIGGER_LABEL: Record<string, string> = {
  cron: '定时',
  watch: '监听',
  chain: '链',
  manual: '手动',
}

/** ISO → "09-12 08:00"（工作流只看得到最近这些，年份没用）。 */
function fmtWhen(iso: string | null): string {
  return iso ? iso.slice(5, 16).replace('T', ' ') : ''
}

/** 这次运行怎么样。`running` / 待审优先——它们还没结束，谈不上成败。 */
function runTone(r: TaskRunItem): { tone: 'bad' | 'warn' | 'good' | 'info'; text: string } {
  if (r.status === 'running') return { tone: 'warn', text: '运行中' }
  if (r.status === 'awaiting_approval') return { tone: 'warn', text: '等你点头' }
  if (r.status === 'ok') return { tone: 'good', text: '✓' }
  if (r.status === 'rejected') return { tone: 'info', text: '已驳回' }
  return { tone: 'bad', text: '✗' }
}

function RunRow({ run }: { run: TaskRunItem }) {
  const tone = runTone(run)
  return (
    <li className="py-1">
      {/* 一次运行 = 一行事实。排布交给 StatRow，和今日概览同一套。 */}
      <StatRow
        items={[
          { label: tone.text, tone: tone.tone },
          { label: fmtWhen(run.started_at) },
          { label: TRIGGER_LABEL[run.trigger] ?? run.trigger },
          // 接地分：够不着材料的那几次没有分，直说「未打分」而不是显示 0
          {
            label: run.grounded == null ? '未打分' : `接地 ${run.grounded}/5`,
            title: run.judge_reason || '这次没有可判的材料',
          },
          ...(run.tool_calls > 0
            ? [{ label: `${run.rounds} 轮 · ${run.tool_calls} 次工具` }]
            : []),
        ]}
        trailing={
          run.error ? (
            <span className="min-w-0 basis-full truncate text-rose-600 dark:text-rose-400" title={run.error}>
              {run.error}
            </span>
          ) : undefined
        }
      />
    </li>
  )
}

function WorkflowRow({
  task,
  nextName,
  open,
  runs,
  busy,
  reviewBusy,
  onToggle,
  onRerun,
  onReview,
}: {
  task: ScheduledTask
  nextName: string
  open: boolean
  runs: TaskRunItem[]
  busy: boolean
  reviewBusy: boolean
  onToggle: () => void
  onRerun: () => void
  onReview: (approve: boolean) => void
}) {
  const waiting = task.awaiting_run_id ?? null
  const tone = task.running
    ? { cls: 'text-amber-600 dark:text-amber-400', text: '运行中' }
    : waiting
      ? { cls: 'text-amber-600 dark:text-amber-400', text: '等你点头' }
      : task.last_status === 'ok'
        ? { cls: 'text-emerald-600 dark:text-emerald-400', text: '✓' }
        : task.last_status === 'error'
          ? { cls: 'text-rose-600 dark:text-rose-400', text: '✗' }
          : { cls: 'text-neutral-400', text: '—' }

  return (
    <li id={`task-${task.id}`} className="py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
            task.enabled
              ? 'border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400'
              : 'border-neutral-200 text-neutral-300 dark:border-neutral-800 dark:text-neutral-600'
          }`}
        >
          {task.trigger_kind === 'watch' ? '监听' : task.mode === 'agent' ? '自主' : '定时'}
        </span>
        <button onClick={onToggle} className="min-w-0 flex-1 text-left" title={task.prompt}>
          <span className="block truncate text-sm text-neutral-700 dark:text-neutral-200">
            {task.name}
            {task.require_approval ? (
              <span className="pl-1.5 text-[11px] text-neutral-400">卡点</span>
            ) : null}
            {!task.enabled ? <span className="pl-1.5 text-[11px] text-neutral-400">已停用</span> : null}
          </span>
          <span className="block truncate text-[11px] text-neutral-400">
            {task.trigger_kind === 'watch' ? `监听 ${task.watch_path || '（未设路径）'}` : task.cron}
            {nextName ? ` → ${nextName}` : ''}
            {task.last_run ? ` · 上次 ${fmtWhen(task.last_run)}` : ' · 还没跑过'}
          </span>
        </button>
        <span className={`shrink-0 text-[11px] ${tone.cls}`}>{tone.text}</span>
        {/* 停在卡点上时，这里就该是放行/驳回——它才是此刻唯一该做的动作 */}
        {waiting ? (
          <>
            <button
              onClick={() => onReview(true)}
              disabled={reviewBusy}
              className="shrink-0 rounded-full border border-emerald-300 px-2 py-0.5 text-[11px] text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-40 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
            >
              通过
            </button>
            <button
              onClick={() => onReview(false)}
              disabled={reviewBusy}
              className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-500 transition-colors hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              驳回
            </button>
          </>
        ) : (
          <button
            onClick={onRerun}
            disabled={busy || task.running}
            className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400"
          >
            {busy ? '跑着…' : '重跑'}
          </button>
        )}
      </div>

      {/* 失败原因直接摊在行下——「为什么失败」不该要再点一次才看得到 */}
      {task.last_status === 'error' && task.last_result ? (
        <p className="mt-1 truncate text-[11px] text-rose-600 dark:text-rose-400" title={task.last_result}>
          {task.last_result}
        </p>
      ) : null}
      {waiting ? (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
          这一步跑完了，等你点头才交给下游{nextName ? `（${nextName}）` : ''}——展开可以看它的产出。
        </p>
      ) : null}

      {open ? (
        runs.length === 0 ? (
          <p className="mt-1 pl-1 text-[11px] text-neutral-400">还没有运行记录。</p>
        ) : (
          <ul className="mt-1 divide-y divide-neutral-100 border-l-2 border-neutral-100 pl-2 dark:divide-neutral-800/70 dark:border-neutral-800">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        )
      ) : null}
    </li>
  )
}

export default function WorkPage() {
  const [outputs, setOutputs] = useState<WorkOutput[]>([])
  const [filter, setFilter] = useState<WorkOutput['kind'] | ''>('')
  const [err, setErr] = useState('')
  const navigate = useNavigate()

  // 标签挂在 ?tab= 上：/threads 的旧链接重定向过来带的就是 tab=follow；
  // 工作流深链 ?task=7 没写 tab，直接落「引擎」才对得上。
  // `lab`（Q1 的提示词对照台）、`form`（Q3 的形态）和 `dispatch`（Q4 的调度台）刻意放在
  // **工作模块**里：提示词工程、数据集、编排都是「非编程的那部分工作」，它们和产出、工作流
  // 是同一张桌子上的事。
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab')
  const tab: 'output' | 'engine' | 'follow' | 'lab' | 'form' | 'dispatch' =
    tabParam === 'engine' ||
    tabParam === 'follow' ||
    tabParam === 'lab' ||
    tabParam === 'form' ||
    tabParam === 'dispatch'
      ? tabParam
      : params.get('task')
        ? 'engine'
        : 'output'
  const setTab = (t: 'output' | 'engine' | 'follow' | 'lab' | 'form' | 'dispatch') =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        n.set('tab', t)
        return n
      },
      { replace: true }
    )

  // 工作流（§4-11）：定义、最近运行、失败原因同屏
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [openRuns, setOpenRuns] = useState<number | null>(null)
  const [runs, setRuns] = useState<TaskRunItem[]>([])
  const [wfBusy, setWfBusy] = useState<number | null>(null)
  const [wfrBusy, setWfrBusy] = useState<number | null>(null) // 正在放行/驳回的那次运行
  const [presetBusy, setPresetBusy] = useState(false)
  // 「处理一项工作」：题目 → 起链 → 三步各自停下等你点头（工作 preset）
  const [workTopic, setWorkTopic] = useState('')
  const [workOpen, setWorkOpen] = useState(false)
  const [workBusy, setWorkBusy] = useState(false)
  const [workMsg, setWorkMsg] = useState('')

  // 从「一件事」点一条工作流过来（`?task=7`）：滚到那条流程并亮一下
  useDeepLink('task', tasks.length > 0)

  // 会议（§4-13）：一场一个文件夹，录音能回听
  const [meetings, setMeetings] = useState<WorkMeeting[]>([])

  // 交付：体裁 × 读者的定义来自后端（唯一真值），话题由你给。
  const [catalogue, setCatalogue] = useState<DeliverCatalogue | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [genre, setGenre] = useState('')
  const [audience, setAudience] = useState('')
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  // 「加进这次产出」（§4-14）：钉进来的材料排在取材结果最前
  const [pinned, setPinned] = useState<{ spec: string; title: string }[]>([])
  const [pinOpen, setPinOpen] = useState(false)
  const [pinQuery, setPinQuery] = useState('')
  const [pinHits, setPinHits] = useState<MaterialHit[]>([])
  const [pinBusy, setPinBusy] = useState(false)
  const [draft, setDraft] = useState<ReportDraft | null>(null)
  const [report, setReport] = useState<DeliverReport | null>(null)
  const [saved, setSaved] = useState('')
  const abort = useRef<AbortController | null>(null)

  const refreshOutputs = useCallback(() => {
    // best-effort：列不出来时给一句实话，不把整页弄成错误页
    api
      .workOutputs()
      .then((r) => setOutputs(r.outputs))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  const refreshTasks = useCallback(() => {
    api.listTasks().then(setTasks).catch(() => {})
  }, [])

  const refreshMeetings = useCallback(() => {
    api.workMeetings().then((r) => setMeetings(r.meetings)).catch(() => {})
  }, [])

  useEffect(() => {
    refreshOutputs()
    refreshTasks()
    refreshMeetings()
    api
      .deliverGenres()
      .then((c) => {
        setCatalogue(c)
        setGenre(c.default_genre)
        setAudience(c.default_audience)
      })
      .catch(() => {}) // 体裁拉不到就不显示生成面板，清单照常用
  }, [refreshOutputs, refreshTasks, refreshMeetings])

  // 切页时掐断还在跑的生成（照 tutor 页）
  useEffect(() => () => abort.current?.abort(), [])

  const toggleRuns = useCallback(
    async (id: number) => {
      if (openRuns === id) {
        setOpenRuns(null)
        return
      }
      setOpenRuns(id)
      setRuns([])
      try {
        setRuns(await api.listTaskRuns(id))
      } catch {
        setRuns([])
      }
    },
    [openRuns]
  )

  const rerun = useCallback(
    async (id: number) => {
      setWfBusy(id)
      try {
        await api.runTask(id)
        refreshTasks()
        if (openRuns === id) setRuns(await api.listTaskRuns(id))
        refreshOutputs() // 任务可能落 vault——产出清单跟着刷新
      } catch {
        /* 失败原因会落在 run 记录里，下一次展开就看得见 */
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
      } catch {
        /* 见上：状态早就变了，刷新即可 */
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
    } catch {
      /* 装不上就什么都不变 */
    } finally {
      setPresetBusy(false)
    }
  }, [refreshTasks])

  /** 处理一项工作：装好（幂等）→ 找到第一步 → 用题目起链。之后三步在你的「通过」下
   *  逐步接手，产物自动落进产出清单。 */
  const startWork = useCallback(async () => {
    const t = workTopic.trim()
    if (!t) {
      setWorkMsg('先写一个题目。')
      return
    }
    setWorkBusy(true)
    setWorkMsg('')
    try {
      const r = await api.installWorkPreset()
      const step1 = r.tasks.find((x) => x.name === '工作·调研')
      if (!step1) {
        setWorkMsg('装不出第一步，去「引擎」标签看看。')
        return
      }
      await api.runTask(step1.id, t)
      setWorkTopic('')
      setWorkOpen(false)
      setWorkMsg('调研跑起来了——跑完停下，去「引擎」标签通过。')
      refreshTasks()
    } catch (e) {
      setWorkMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setWorkBusy(false)
    }
  }, [workTopic, refreshTasks])

  /** 搜一条自己的材料钉进这次产出——检索命中的 `spec` 后端认（vault 路径 / repo: / dir:）。 */
  const searchPin = useCallback(async () => {
    const q = pinQuery.trim()
    if (!q) return
    setPinBusy(true)
    try {
      setPinHits((await api.searchMaterial(q)).hits)
    } catch {
      setPinHits([])
    } finally {
      setPinBusy(false)
    }
  }, [pinQuery])

  const addPin = useCallback((h: MaterialHit) => {
    if (!h.spec) return
    setPinned((cur) =>
      cur.some((p) => p.spec === h.spec) ? cur : [...cur, { spec: h.spec, title: h.title || h.spec }]
    )
    setPinOpen(false)
    setPinHits([])
    setPinQuery('')
  }, [])

  /** 改写成：拿一件产出当**钉住材料**，开交付流换个体裁重写（周报 / 短稿 / 一页纸提案）。
   *  J4 的缺口——产出别只躺在清单里，要能变成「交得出去的那一版」。 */
  const rewriteAs = useCallback((o: WorkOutput) => {
    setTab('output')
    setGenOpen(true)
    setTopic(`把《${o.title}》改写成`)
    setPinned([{ spec: o.path, title: o.title }])
    setReport(null)
    setDraft(null)
    setSaved('')
    setMsg('')
    window.scrollTo({ top: 0 })
  }, [])

  const run = useCallback(async () => {
    const t = topic.trim()
    if (!t || busy || !genre || !audience) return
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setBusy(true)
    setReport(null)
    setDraft(null)
    setSaved('')
    setMsg('取材中…')
    try {
      const r = await streamDeliver(
        t,
        genre,
        audience,
        (event, data) => {
          if (event === 'gathering') setMsg('在你自己的材料里找…')
          else if (event === 'sources') setMsg('材料到手，开始写…')
          else if (event === 'writing') setMsg('成文中…')
          else if (event === 'draft')
            // draft 一帧帧来，正文边生成边渲染；`report` 到了才算数
            setDraft({
              title: String(data.title ?? ''),
              sections: (data.sections ?? []) as ReportDraft['sections'],
            })
        },
        ctl.signal,
        pinned.map((p) => p.spec)
      )
      if (r.ok && r.report) {
        setReport(r.report)
        setMsg('')
      } else {
        setMsg(r.error || '成文失败')
      }
    } catch (e) {
      if (!ctl.signal.aborted) setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [topic, genre, audience, busy, pinned])

  const save = useCallback(async () => {
    if (!report || busy || saved) return
    setBusy(true)
    try {
      const r = await api.deliverSave({
        title: report.title,
        sections: report.sections,
        used: report.used,
        sources: report.sources,
      })
      setSaved(r.filename)
      refreshOutputs()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [report, busy, saved, refreshOutputs])

  const shown = filter ? outputs.filter((o) => o.kind === filter) : outputs
  const present = KINDS.filter((k) => outputs.some((o) => o.kind === k.kind))
  const nameOf = (id: number | null) =>
    id == null ? '' : (tasks.find((t) => t.id === id)?.name ?? '')

  function openPath(rel: string) {
    navigate(`/notes?path=${encodeURIComponent(rel)}`)
  }

  return (
    <PageShell
      title="工作"
      description="写一份交付、跑后台流程、跟进一件事——干活这条线。"
      maxWidth="4xl"
      actions={
        catalogue ? (
          <button
            onClick={() => {
              if (tab !== 'output') setTab('output')
              setGenOpen((v) => !v)
            }}
            className="shrink-0 rounded-xl border border-teal-300 px-3 py-1.5 text-xs text-teal-700 transition-colors hover:bg-teal-50 dark:border-teal-700 dark:text-teal-300 dark:hover:bg-teal-500/10"
          >
            {genOpen && tab === 'output' ? '收起' : '写一份交付'}
          </button>
        ) : null
      }
    >
      {/* 三个标签：「产出」是归宿，「引擎」是后台，「跟进」是「这件事我到哪了」。
          状态各自独立、切走再回来不丢——都在 URL 上，刷新也停在你离开的标签。 */}
      <div className="mb-5 flex gap-1">
        {(
          [
            ['output', '产出'],
            ['engine', '引擎'],
            ['lab', '实验室'],
            ['form', '形态'],
            ['dispatch', '调度台'],
            ['follow', '跟进'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              tab === k
                ? 'bg-neutral-200/80 font-medium text-neutral-800 dark:bg-neutral-700/70 dark:text-neutral-100'
                : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800/70'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'output' && genOpen && catalogue ? (
        <section className="mb-6 rounded-xl border border-teal-200 bg-teal-50/40 p-4 dark:border-teal-500/30 dark:bg-teal-500/10">
          <div className="flex flex-wrap items-center gap-1.5">
            {catalogue.genres.map((g) => (
              <button
                key={g.id}
                onClick={() => setGenre(g.id)}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  genre === g.id
                    ? KIND_BADGE.deliver
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-neutral-400">读者</span>
            {catalogue.audiences.map((a) => (
              <button
                key={a.id}
                onClick={() => setAudience(a.id)}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  audience === a.id
                    ? 'border-teal-400 text-teal-700 dark:border-teal-600 dark:text-teal-300'
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run()
              }}
              placeholder="写什么？（例：这周的 RAG 调研）"
              className="min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              onClick={() => void run()}
              disabled={!topic.trim() || busy}
              className="shrink-0 rounded-xl bg-teal-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-teal-700 disabled:opacity-40"
            >
              {busy ? '生成中…' : '生成'}
            </button>
          </div>

          {/* 「加进这次产出」（§4-14）：钉进来的材料排在取材结果最前 */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {pinned.map((p) => (
              <span
                key={p.spec}
                title={p.spec}
                className="flex items-center gap-1 rounded-full border border-teal-300 px-2 py-0.5 text-[11px] text-teal-700 dark:border-teal-600 dark:text-teal-300"
              >
                {p.title}
                <button
                  onClick={() => setPinned((c) => c.filter((x) => x.spec !== p.spec))}
                  title="取消钉住"
                  className="text-teal-500 hover:text-rose-500"
                >
                  ✕
                </button>
              </span>
            ))}
            <button
              onClick={() => setPinOpen((v) => !v)}
              className="rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-500 transition-colors hover:border-teal-300 hover:text-teal-600 dark:border-neutral-700 dark:text-neutral-400"
            >
              {pinOpen ? '收起' : '＋ 钉一条材料'}
            </button>
          </div>
          {pinOpen ? (
            <div className="mt-2">
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={pinQuery}
                  onChange={(e) => setPinQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void searchPin()
                  }}
                  placeholder="在你自己的材料里搜一条…"
                  className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-[11px] outline-none placeholder:text-neutral-400 focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
                />
                <button
                  onClick={() => void searchPin()}
                  disabled={pinBusy || !pinQuery.trim()}
                  className="shrink-0 rounded-lg border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
                >
                  {pinBusy ? '搜…' : '搜'}
                </button>
              </div>
              {pinHits.length > 0 ? (
                <ul className="mt-1.5 space-y-0.5">
                  {pinHits.map((h) => (
                    <li key={h.spec || h.source}>
                      <button
                        onClick={() => addPin(h)}
                        title={h.text}
                        className="block w-full truncate rounded px-1.5 py-1 text-left text-[11px] text-neutral-600 transition-colors hover:bg-teal-50 hover:text-teal-700 dark:text-neutral-300 dark:hover:bg-teal-500/10"
                      >
                        {h.title || h.source}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {msg ? <p className="mt-2 text-[11px] text-neutral-500">{msg}</p> : null}

          {report || draft ? (
            <div className="mt-3 rounded-lg border border-teal-200/70 bg-white p-3 dark:border-teal-500/20 dark:bg-neutral-900/60">
              <Markdown sources={report?.sources}>{reportMarkdown(report ?? draft!)}</Markdown>
              {report ? (
                <SourceList
                  sources={report.sources}
                  used={report.used}
                  className="border-teal-200/70 dark:border-teal-500/20"
                />
              ) : null}
            </div>
          ) : null}

          {report ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void save()}
                disabled={busy || !!saved}
                className="rounded-full border border-teal-300 px-2.5 py-0.5 text-[11px] text-teal-700 transition-colors hover:bg-teal-100 disabled:opacity-40 dark:border-teal-600 dark:text-teal-300 dark:hover:bg-teal-500/20"
              >
                {saved ? '已存进 vault' : busy ? '保存中…' : '存进 vault'}
              </button>
              {saved ? (
                <span className="text-[11px] text-emerald-600 dark:text-emerald-400">已存到 {saved}</span>
              ) : null}
              <FeedbackButtons
                kind="deliver"
                promptSha={report.prompt_sha}
                modelId={report.model_id}
                artifactRef={saved}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === 'engine' ? (
      <>
      {/* 处理一项工作：给一个题目，三步（调研 → 方案 → 汇报稿）各跑各的、各停下等点头。
          这是「工作」作为一条线的正面入口——不必先去设置里拼任务。 */}
      <section className="mb-6 rounded-xl border border-violet-200/70 bg-violet-50/40 p-4 dark:border-violet-500/30 dark:bg-violet-500/5">
        <div className="flex items-baseline justify-between pb-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
            🗂 处理一项工作
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
            onClick={() => setWorkOpen(true)}
            className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-violet-500"
          >
            起一个题目
          </button>
        )}
        {workMsg ? <p className="pt-2 text-xs text-neutral-500">{workMsg}</p> : null}
      </section>

      <section className="mb-6">
        <div className="flex items-baseline justify-between pb-1">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">工作流</h2>
          <span className="text-xs text-neutral-400">跑完带接地分 —— 「跑成功但变差」只有它看得见</span>
        </div>
        {tasks.length === 0 ? (
          <EmptyHint
            pad="sm"
            title="还没有工作流。"
            hint="在「设置 · 定时任务」里配一条，或者直接装一条现成的（会议录音丢进 vault/meetings/inbox/ 就自己转写、出纪要与待办）。"
            action={
              <button
                onClick={() => void installPreset()}
                disabled={presetBusy}
                className="rounded-xl border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
              >
                {presetBusy ? '正在装…' : '装一条会议流程'}
              </button>
            }
          />
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {tasks.map((t) => (
              <WorkflowRow
                key={t.id}
                task={t}
                nextName={nameOf(t.chain_next_id)}
                open={openRuns === t.id}
                runs={runs}
                busy={wfBusy === t.id}
                reviewBusy={wfrBusy === t.awaiting_run_id}
                onToggle={() => void toggleRuns(t.id)}
                onRerun={() => void rerun(t.id)}
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

      {tab === 'engine' && meetings.length > 0 ? (
        <section className="mb-6">
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
                  <span className="shrink-0 text-[11px] text-neutral-400">{m.date.slice(5)}</span>
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
                    <button
                      key={f.path}
                      onClick={() => openPath(f.path)}
                      title={f.path}
                      className="rounded-full border border-neutral-200 px-2.5 py-0.5 text-[11px] text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-300"
                    >
                      {f.title}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {tab === 'output' && err ? (
        <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          产出清单拉不出来：{err}
        </p>
      ) : null}

      {tab === 'output' ? (
      <section>
        <div className="flex items-baseline justify-between gap-3 pb-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">产出</h2>
          {/* 去哪做——这里的产出是**归宿**，不是起点。交付在上面就地写，
              其余三个引擎在学页、复盘在仪表盘。做成可点的，别只是句说明。 */}
          <span className="text-[11px] text-neutral-400">
            研究 / 方案 / 对质 在
            <Link to="/tutor" className="text-violet-500 hover:underline">
              学
            </Link>
            · 复盘在
            <Link to="/dashboard" className="text-violet-500 hover:underline">
              仪表盘
            </Link>
          </span>
        </div>

        {present.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 pb-4">
            <button
              onClick={() => setFilter('')}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                filter === ''
                  ? 'border-neutral-400 text-neutral-700 dark:border-neutral-500 dark:text-neutral-200'
                  : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
              }`}
            >
              全部 {outputs.length}
            </button>
            {present.map((k) => (
              <button
                key={k.kind}
                onClick={() => setFilter(k.kind)}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  filter === k.kind
                    ? KIND_BADGE[k.kind]
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
                }`}
              >
                {k.label} {outputs.filter((o) => o.kind === k.kind).length}
              </button>
            ))}
          </div>
        ) : null}

        {outputs.length === 0 ? (
          <EmptyHint
            pad="lg"
            title="还没有产出。"
            hint="在上面「写一份交付」，或去「学」「仪表盘」跑一轮；成品会自动落到这里。"
          />
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {shown.map((o) => (
              <li key={o.path}>
                <OutputCard
                  kind={o.kind}
                  label={o.label}
                  title={o.title}
                  meta={o.path}
                  onOpen={() => openPath(o.path)}
                  actions={
                    <>
                      <button
                        onClick={() => rewriteAs(o)}
                        title="拿它当材料，换个体裁重写（周报 / 短稿 / 一页纸提案）"
                        className="hidden shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 group-hover:block dark:border-neutral-700 dark:text-neutral-400"
                      >
                        改写成
                      </button>
                      <AttachToThread
                        kind="output"
                        ref={o.path}
                        className="hidden shrink-0 group-hover:block"
                      />
                      <span className="text-[11px] text-neutral-400">{o.date.slice(5)}</span>
                    </>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      ) : null}

      {tab === 'follow' ? <ThreadsPage chromeless /> : null}
      {tab === 'lab' ? <PromptLab /> : null}
      {tab === 'form' ? <FormPane /> : null}
      {tab === 'dispatch' ? <DispatchPanel /> : null}
    </PageShell>
  )
}
