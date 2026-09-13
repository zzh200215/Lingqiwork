/** 工作 — 在你不在的时候跑的流程，和它们产出的东西。
 *
 *  **工作流**：定时任务从「设置」里的配置表单搬到这里当一等对象——这条流程长什么样 /
 *  上次跑到哪 / 为什么失败，同屏可见。每条运行带接地分（§4-10）：它是无人值守时唯一
 *  会说话的东西，「跑成功但悄悄变差」没有别的信号。
 *
 *  **产出**：六个引擎的成品落在 vault 的几个目录里（成文在 notes/，靠日期前缀分辨），
 *  这里把它们列出来、能筛、能点开。
 *
 *  **生成**：交付是唯一在 /work 上就地生成的——其余引擎仍从各自的入口跑，成品自动落到这里。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

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
import FeedbackButtons from './FeedbackButtons'
import { Markdown, reportMarkdown, SourceList } from './markdown'
import { streamDeliver, type DeliverReport, type ReportDraft } from './stream'

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

/** 每一种产出的颜色，和「学」页里那几个动作的配色对齐。 */
const KIND_CLS: Record<WorkOutput['kind'], string> = {
  research: 'border-sky-300 text-sky-700 dark:border-sky-700 dark:text-sky-300',
  compose: 'border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300',
  recap: 'border-violet-300 text-violet-700 dark:border-violet-700 dark:text-violet-300',
  decide: 'border-violet-300 text-violet-700 dark:border-violet-700 dark:text-violet-300',
  conflict: 'border-rose-300 text-rose-700 dark:border-rose-700 dark:text-rose-300',
  deliver: 'border-teal-300 text-teal-700 dark:border-teal-700 dark:text-teal-300',
  task: 'border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300',
}

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
function runTone(r: TaskRunItem): { cls: string; text: string } {
  if (r.status === 'running') return { cls: 'text-amber-600 dark:text-amber-400', text: '运行中' }
  if (r.status === 'awaiting_approval')
    return { cls: 'text-amber-600 dark:text-amber-400', text: '等你点头' }
  if (r.status === 'ok') return { cls: 'text-emerald-600 dark:text-emerald-400', text: '✓' }
  if (r.status === 'rejected') return { cls: 'text-neutral-400', text: '已驳回' }
  return { cls: 'text-rose-600 dark:text-rose-400', text: '✗' }
}

function RunRow({ run }: { run: TaskRunItem }) {
  const tone = runTone(run)
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1 text-[11px]">
      <span className={`shrink-0 font-medium ${tone.cls}`}>{tone.text}</span>
      <span className="shrink-0 text-neutral-400">{fmtWhen(run.started_at)}</span>
      <span className="shrink-0 text-neutral-400">{TRIGGER_LABEL[run.trigger] ?? run.trigger}</span>
      {/* 接地分：够不着材料的那几次没有分，直说「未打分」而不是显示 0 */}
      <span
        className="shrink-0 text-neutral-400"
        title={run.judge_reason || '这次没有可判的材料'}
      >
        {run.grounded == null ? '未打分' : `接地 ${run.grounded}/5`}
      </span>
      {run.tool_calls > 0 ? (
        <span className="shrink-0 text-neutral-400">
          {run.rounds} 轮 · {run.tool_calls} 次工具
        </span>
      ) : null}
      {run.error ? (
        <span className="min-w-0 basis-full truncate text-rose-600 dark:text-rose-400" title={run.error}>
          {run.error}
        </span>
      ) : null}
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
    <li className="py-2.5">
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

  // 工作流（§4-11）：定义、最近运行、失败原因同屏
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [openRuns, setOpenRuns] = useState<number | null>(null)
  const [runs, setRuns] = useState<TaskRunItem[]>([])
  const [wfBusy, setWfBusy] = useState<number | null>(null)
  const [wfrBusy, setWfrBusy] = useState<number | null>(null) // 正在放行/驳回的那次运行
  const [presetBusy, setPresetBusy] = useState(false)

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
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="flex items-start justify-between gap-3 pb-5">
        <div>
          <h1 className="text-xl font-semibold text-neutral-800 dark:text-neutral-100">工作</h1>
          <p className="pt-1 text-sm text-neutral-500 dark:text-neutral-400">
            在你不在的时候跑的流程，和它们产出的东西。
          </p>
        </div>
        {catalogue ? (
          <button
            onClick={() => setGenOpen((v) => !v)}
            className="shrink-0 rounded-xl border border-teal-300 px-3 py-1.5 text-xs text-teal-700 transition-colors hover:bg-teal-50 dark:border-teal-700 dark:text-teal-300 dark:hover:bg-teal-500/10"
          >
            {genOpen ? '收起' : '写一份交付'}
          </button>
        ) : null}
      </header>

      {genOpen && catalogue ? (
        <section className="mb-6 rounded-xl border border-teal-200 bg-teal-50/40 p-4 dark:border-teal-500/30 dark:bg-teal-500/10">
          <div className="flex flex-wrap items-center gap-1.5">
            {catalogue.genres.map((g) => (
              <button
                key={g.id}
                onClick={() => setGenre(g.id)}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  genre === g.id
                    ? KIND_CLS.deliver
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

      <section className="mb-6">
        <div className="flex items-baseline justify-between pb-1">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">工作流</h2>
          <span className="text-xs text-neutral-400">跑完带接地分 —— 「跑成功但变差」只有它看得见</span>
        </div>
        {tasks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-300 px-5 py-6 text-center dark:border-neutral-700">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">还没有工作流。</p>
            <p className="pt-1.5 text-xs text-neutral-400">
              在「设置 · 定时任务」里配一条，或者直接装一条现成的：
            </p>
            <button
              onClick={() => void installPreset()}
              disabled={presetBusy}
              className="mt-2.5 rounded-xl border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
            >
              {presetBusy ? '正在装…' : '装一条会议流程'}
            </button>
            <p className="pt-2 text-[11px] text-neutral-400">
              装好后，把会议录音丢进 vault/meetings/inbox/ 就会自己转写、出纪要与待办
            </p>
          </div>
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

      {meetings.length > 0 ? (
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

      {err ? (
        <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          产出清单拉不出来：{err}
        </p>
      ) : null}

      <section>
        <div className="flex items-baseline justify-between pb-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">产出</h2>
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
                    ? KIND_CLS[k.kind]
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
                }`}
              >
                {k.label} {outputs.filter((o) => o.kind === k.kind).length}
              </button>
            ))}
          </div>
        ) : null}

        {outputs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-300 px-5 py-10 text-center dark:border-neutral-700">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">还没有产出。</p>
            <p className="pt-2 text-xs leading-relaxed text-neutral-400">
              研究 / 方案 / 对质 在「学」页里跑，复盘在「仪表盘」；交付在上面「写一份交付」。跑完成品会自动落到这里。
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {shown.map((o) => (
              <li key={o.path} className="group flex items-center gap-3 py-2.5">
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${KIND_CLS[o.kind]}`}
                >
                  {o.label}
                </span>
                <button
                  onClick={() => openPath(o.path)}
                  title={o.path}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm text-neutral-700 dark:text-neutral-200">
                    {o.title}
                  </span>
                  <span className="block truncate text-[11px] text-neutral-400">{o.path}</span>
                </button>
                <AttachToThread
                  kind="output"
                  ref={o.path}
                  className="hidden shrink-0 group-hover:block"
                />
                <span className="shrink-0 text-[11px] text-neutral-400">{o.date.slice(5)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
