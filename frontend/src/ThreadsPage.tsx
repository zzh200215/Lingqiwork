/** 「事」——「一件事」这个单位的页面（§4-15）。
 *
 *  为什么要有它：所有表都按**生产者**键（卡片、教学、判断各管各的），vault 按**功能**分目录，
 *  于是「这件事我到哪了」「我这个月干了什么」都答不出来。这一页把六条线上的条目挂到同一个
 *  单位上，按五步摆开。
 *
 *  两条护栏（PLAN §4-15）：
 *  - **vault 不搬家**：删掉一件事只少一层索引，东西一件都不动（页面上明说）。
 *  - **能完全不手打标签**：候选是**派生**出来的——拿条目的标签去比对已有「事」的名字，
 *    你只点确认；连"该挂到哪"都需要新建时，用条目自己的名字建。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'

import AttachToThread from './AttachToThread'
import EmptyHint from './EmptyHint'
import RunPanel from './RunPanel'
import PageShell from './PageShell'
import { ago } from './reltime'
import {
  api,
  type DeliverCatalogue,
  type ThreadCandidate,
  type ThreadDetail,
  type ThreadKind,
  type ThreadRow,
} from './api'

/** 时间线节点的**语义色**（方案 §六）：产出=teal、运行=sky、裁决=amber——
 *  「卡在哪」一眼可见；材料与知识条目维持中性灰，不与状态色争。 */
const KIND_DOT: Record<string, string> = {
  output: 'bg-teal-500',
  task: 'bg-sky-500',
  decision: 'bg-amber-500',
}

const KIND_ICON: Record<string, string> = {
  material: '📥',
  note: '📝',
  card: '🗂',
  tutor: '🎓',
  output: '📄',
  task: '⏱',
  decision: '⚖️',
}

const key = (kind: string, ref: string) => `${kind}:${ref}`

/** 1.2k —— 这一栏是给人一眼看的，不需要精确到个位 */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** 状态机（方案 §8.4）：进行中 / 停滞 / 完成。
 *
 *  **「停滞」是后端算的**（`stalled` + `idle_days`），界面不自己减日期——
 *  时区与阈值都在 `core/threads.py` 一处，两边各算一份的那天会分叉。 */
type StatusKey = 'open' | 'stalled' | 'done'

function statusOf(t: ThreadRow): StatusKey {
  if (t.status === 'done') return 'done'
  return t.stalled ? 'stalled' : 'open'
}

/** 三种状态一个说法，颜色与点都在这里取（语义色见 docs/ui-design-contract.md）。 */
const STATUS: Record<StatusKey, { label: string; dot: string; text: string }> = {
  open: { label: '进行中', dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300' },
  stalled: { label: '停滞', dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-300' },
  done: {
    label: '完成',
    dot: 'bg-neutral-300 dark:bg-neutral-600',
    text: 'text-neutral-400',
  },
}

const FILTERS: { key: StatusKey | ''; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'open', label: '进行中' },
  { key: 'stalled', label: '停滞' },
  { key: 'done', label: '完成' },
]

/** 「N 天前」——这一栏是给人扫的，不需要精确到时刻。 */
function idleText(days: number): string {
  if (days <= 0) return '今天动过'
  if (days === 1) return '昨天动过'
  return `${days} 天没动`
}

/** `chromeless`：不带 PageShell 页头地渲染——整页搬进工作页「事项」标签时用，
    那里已经有「工作」的页头，再来一个「事」就是两层标题。
    `newSignal`：页头那颗「＋ 新的一件事」推过来的信号（同 `ReportPage`/`PromptLibrary`）。 */
export default function ThreadsPage({
  chromeless,
  newSignal,
  onStartWork,
}: {
  chromeless?: boolean
  newSignal?: number
  /** 「起一个工作链」（方案 §8.4）：把**这件事的名字**带给工作流页的起链面板预填。
   *  **只预填、不起链**——起链是花模型钱的动作，得由人按最后那一下。 */
  onStartWork?: (name: string) => void
}) {
  const [threads, setThreads] = useState<ThreadRow[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<ThreadDetail | null>(null)
  const [orphans, setOrphans] = useState<ThreadCandidate[]>([])
  const [draft, setDraft] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  /** 左栏的状态筛选（方案 §8.4：列表可按状态过滤）。 */
  const [statusFilter, setStatusFilter] = useState<StatusKey | ''>('')
  /** 新建面板：页头那颗「＋ 新的一件事」推信号展开（同 ReportPage 的写法）。 */
  const [creating, setCreating] = useState(false)
  // 「就这件事写一份交付」——这一路的模型用量会记在这件事头上（§4-16）
  const [cat, setCat] = useState<DeliverCatalogue | null>(null)
  const [genre, setGenre] = useState('')
  const [audience, setAudience] = useState('')
  const [writing, setWriting] = useState(false)
  /** 「忽略全部」的两段式确认：第一下只立起确认，第二下才真执行——
   *  批量动作不可逆（忽略后要从 unignore 里捞回来），值得多按一下。 */
  const [ignoreAllArm, setIgnoreAllArm] = useState(false)
  /** 「写一份」那一次的 AbortController。**这一条的取消是真停**（见 `writeForThread`）。 */
  const writeAbort = useRef<AbortController | null>(null)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const refreshList = useCallback(async () => {
    try {
      const r = await api.listThreads()
      setThreads(r.threads)
      // `r.steps`（五步的定义）不再用：详情改成**时间线**了（方案 §8.4）——
      // 「我到哪了」是时间问题，不是分类问题。后端照旧返回它，别人还在读。
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const refreshOrphans = useCallback(async () => {
    try {
      setOrphans((await api.unclassified()).items)
    } catch {
      setOrphans([]) // 未归类拉不到就不显示这一块，页面照常
    }
  }, [])

  const loadDetail = useCallback(async (id: number) => {
    try {
      const d = await api.threadDetail(id)
      setDetail(d)
      setNameDraft(d.name)
    } catch {
      setDetail(null)
    }
  }, [])

  useEffect(() => {
    void refreshList()
    void refreshOrphans()
    api
      .deliverGenres()
      .then((c) => {
        setCat(c)
        setGenre(c.default_genre)
        setAudience(c.default_audience)
      })
      .catch(() => {}) // 体裁拉不到就不显示"写一份"，页面照常
  }, [refreshList, refreshOrphans])

  // 深链 `?thread=<id>`（别处也能指进来）
  useEffect(() => {
    const id = Number(params.get('thread') || 0)
    if (!id) {
      setOpenId(null)
      setDetail(null)
      return
    }
    setOpenId(id)
    void loadDetail(id)
  }, [params, loadDetail])

  // 活性（2026-09-26）：这一页回答「这件事我到哪了」——而事情是**在跑的**：
  // 工作流的成品落进时间线、卡点停住等人，都发生在你盯着这一页的时候，
  // 原来只在挂载时拉一次，屏幕上的时间线停在过去。可见时每 15 秒跟一拍
  // （与工作流页同一口径），页面切走不打。
  // 详情只在**没在改事名**时跟：轮询会把输入框打回原值，改了一半的名字
  // 不能被一次后台刷新吃掉（nameDraft 与详情名不一致 = 正在改，跳过）。
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.hidden) return
      void refreshList()
      void refreshOrphans()
      if (openId != null && nameDraft === (detail?.name ?? '')) void loadDetail(openId)
    }, 15000)
    return () => window.clearInterval(t)
  }, [refreshList, refreshOrphans, loadDetail, openId, nameDraft, detail])

  // 页头那颗「＋ 新的一件事」→ 展开新建面板（`newSignal` 初值不推，挂载时不会自己弹开）
  useEffect(() => {
    if (newSignal) setCreating(true)
  }, [newSignal])

  function open(id: number) {
    setParams({ thread: String(id) })
  }

  async function afterChange(threadId: number) {
    await Promise.all([refreshList(), refreshOrphans(), loadDetail(threadId)])
  }

  /** 新建一件事。**只建**——挂上去那一步现在归 `AttachToThread`（它自己会建、也会挂），
   *  这里再留一个「建完顺便挂」的参数就是同一个动作的第二份实现。 */
  async function create(name: string) {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    try {
      const t = await api.createThread(n)
      setDraft('')
      await refreshList()
      open(t.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 把「可能也属于这件事」里的一条挂到**当前这件事**上。

   *  这条留在这儿、不走 `AttachToThread`：那个组件解决的问题是「**挂到哪一件**」，
   *  而这里目标早就定了（右边这一件）。反过来用它反而要多问一次「挂到哪」——
   *  答案明摆着的问题不该问。 */
  async function attach(threadId: number, kind: string, ref: string) {
    try {
      await api.attachThreadItem(threadId, kind as ThreadKind, ref)
      await afterChange(threadId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function detach(threadId: number, kind: string, ref: string) {
    try {
      await api.detachThreadItem(threadId, kind as ThreadKind, ref)
      await afterChange(threadId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function rename(threadId: number) {
    const n = nameDraft.trim()
    if (!n || n === detail?.name) return
    try {
      await api.updateThread(threadId, { name: n })
      await afterChange(threadId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function setArchived(threadId: number, archived: boolean) {
    try {
      await api.updateThread(threadId, { archived })
      await refreshList()
      if (archived) setParams({})
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  /** 状态机（方案 §8.4）：进行中 ↔ 完成。**「停滞」不在这里**——它是算出来的，
   *  你能设的只有这两个，因为只有这两个是「你的判断」而不是「事实」。 */
  async function setStatus(threadId: number, status: 'open' | 'done') {
    try {
      await api.updateThread(threadId, { status })
      await afterChange(threadId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  /** 截止日。空串 = 清掉（`clear_deadline`）——`undefined` 表示「这次不改它」。 */
  async function setDeadline(threadId: number, value: string) {
    try {
      await api.updateThread(threadId, value ? { deadline: value } : { clear_deadline: true })
      await afterChange(threadId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove(threadId: number) {
    try {
      await api.deleteThread(threadId)
      setParams({})
      await Promise.all([refreshList(), refreshOrphans()])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  /** 收件箱的「忽略」（§8.4）：**不是删掉**，只是从这一份候选里划掉。
   *  它回来过（`unignore`），所以这里只刷新候选，别的什么都不动。 */
  async function ignoreCandidate(c: ThreadCandidate) {
    try {
      await api.ignoreInboxItem(c.kind, c.ref)
      await refreshOrphans()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  /** 就这件事写一份交付：产出挂上来，这一路的账也记在这件事头上（§4-16）。
   *
   *  **「停止」在这条路上是真的停**：`deliver_into` 里那次成文是一次 await，而仓里的
   *  LLM 层在请求被取消时会 `finally` 关掉上游流（`core/llm.py` 那条注释写着
   *  「页面 abort / 断连 / 会话切换」三种都算）。所以这里不写「不等了」。 */
  async function writeForThread(threadId: number) {
    if (!genre || !audience || writing) return
    writeAbort.current?.abort()
    const ctl = new AbortController()
    writeAbort.current = ctl
    setWriting(true)
    setErr('')
    try {
      await api.deliverIntoThread(threadId, genre, audience, ctl.signal)
      if (ctl.signal.aborted) return
      await afterChange(threadId)
    } catch (e) {
      if (ctl.signal.aborted) return // 自己点的不写了，不当成失败
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (writeAbort.current === ctl) writeAbort.current = null
      setWriting(false)
    }
  }

  /** 左栏按状态筛过的清单（方案 §8.4：列表可按状态过滤）。 */
  const shownThreads = statusFilter
    ? threads.filter((t) => statusOf(t) === statusFilter)
    : threads
  const statusCount = (k: StatusKey | '') =>
    k ? threads.filter((t) => statusOf(t) === k).length : threads.length
  /** 详情的时间线：产出/运行/卡点/材料同一条线，**时间倒序**（方案 §8.4）。 */
  const timeline = detail
    ? [...detail.items].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    : []

  const body = (
    <>
      {err ? (
        <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {err}
        </p>
      ) : null}

      <div className="space-y-4">
        {/* 新建（方案 §8.4：页头那颗「＋ 新的一件事」展开的就是它）。 */}
        {creating ? (
          <section data-thread-create className="wb-card-hero flex flex-wrap items-center gap-2 rounded-lg p-5">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim()) {
                  void create(draft).then(() => setCreating(false))
                }
              }}
              placeholder="新的一件事，例：RAG 评测方案"
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              onClick={() => void create(draft).then(() => setCreating(false))}
              disabled={!draft.trim() || busy}
              className="shrink-0 rounded-lg wb-btn-primary px-3 py-1.5 text-sm disabled:opacity-40"
            >
              建
            </button>
            <button
              onClick={() => {
                setCreating(false)
                setDraft('')
              }}
              className="shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-700 dark:border-neutral-700 dark:text-neutral-400"
            >
              收起
            </button>
          </section>
        ) : null}

        {/* 收件箱（方案 §8.4）：**目标 = 清空**。空的时候整块不渲染，不占首屏。
            原来它是页面底部常驻的一节——常驻就变成「又一堆欠账」，而不是「待归类」。 */}
        {orphans.length > 0 ? (
          <section
            data-inbox
            className="wb-card border-l-2 border-l-amber-400 px-4 py-3"
          >
            <div className="flex items-baseline justify-between pb-2">
              <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                收件箱 · {orphans.length} 条待归类
              </h2>
              <span className="text-xs text-neutral-400">挂到某件事上，或忽略</span>
              <button
                data-inbox-ignore-all
                disabled={busy}
                title="收件箱里所有条目都忽略——东西一件不动，随时可从忽略清单捞回"
                onClick={async () => {
                  if (!ignoreAllArm) {
                    setIgnoreAllArm(true)
                    return
                  }
                  setIgnoreAllArm(false)
                  let failed = 0
                  for (const c of orphans) {
                    try {
                      await api.ignoreInboxItem(c.kind, c.ref)
                    } catch {
                      failed += 1 // 单条失败不拦其余——最后把没忽略成的条数说出来
                    }
                  }
                  if (failed > 0) setErr(`${failed} 条没忽略成功——稍后重试或逐条处理`)
                  await refreshOrphans()
                }}
                className="shrink-0 rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-400 transition-colors hover:border-rose-300 hover:text-rose-500 disabled:opacity-40 dark:border-neutral-700"
              >
                {ignoreAllArm ? `确认忽略 ${orphans.length} 条？` : '忽略全部'}
              </button>
            </div>
            {/* 分隔线**通栏**（方案 §七「照 RoomPane 现例」）：容器自己带 `px-4`，
                所以列表用 `-mx-4` 把它拉回卡片边，行再加回 `px-4`。不这么做的话，
                分隔线会短两头——卡片里每一条都缩进 16px。 */}
            <ul className="-mx-4 divide-y divide-neutral-100 dark:divide-neutral-800/70">
              {orphans.map((c) => (
                <li key={key(c.kind, c.ref)} className="flex items-center gap-2 px-4 py-2">
                  <span className="shrink-0 text-xs">{KIND_ICON[c.kind]}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-600 dark:text-neutral-300">
                    {c.title || c.ref}
                  </span>
                  {/* 「挂到…」用**公共那个组件**（方案 §五-2：删掉这一页自建的那套 picker）。
                      自建那套与它做的是同一件事（派生候选 + 用条目自己的名字新建），却少了两样
                      它已经有的东西：失败时**说出来**（`onError`），以及「已挂到 X」那句回执。
                      同一个交互两份实现，迟早只有一份是对的。 */}
                  <AttachToThread
                    kind={c.kind}
                    ref={c.ref}
                    className="shrink-0"
                    onAttached={() => void refreshOrphans()}
                    onError={setErr}
                    onCreated={(t) => open(t.id)}
                  />
                  <button
                    onClick={() => void ignoreCandidate(c)}
                    title="不再出现在收件箱里。东西一件都不动——它还在原处，也还能挂到别处"
                    className="shrink-0 rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-400 transition-colors hover:border-neutral-400 hover:text-neutral-600 dark:border-neutral-700 dark:text-neutral-500"
                  >
                    忽略
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
          {/* 左栏：事列表 */}
          <section className="wb-card">
            <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-100 px-4 py-2.5 dark:border-neutral-800/70">
              {FILTERS.map((f) => (
                <button
                  key={f.key || 'all'}
                  onClick={() => setStatusFilter(f.key)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                    statusFilter === f.key
                      ? 'border-neutral-400 text-neutral-700 dark:border-neutral-500 dark:text-neutral-200'
                      : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
                  }`}
                >
                  {f.label} {statusCount(f.key)}
                </button>
              ))}
            </div>

            {threads.length === 0 ? (
              <div className="p-4">
                <EmptyHint
                  title="还没有一件事"
                  hint="点右上「＋ 新的一件事」建一个；收件箱里的材料也能一键挂成一件事。"
                />
              </div>
            ) : shownThreads.length === 0 ? (
              <div className="p-4">
                <EmptyHint title="这一类没有" hint="换个筛选看看。" />
              </div>
            ) : (
              <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
                {shownThreads.map((t) => {
                  const st = STATUS[statusOf(t)]
                  return (
                    <li key={t.id}>
                      <button
                        onClick={() => open(t.id)}
                        className={`flex w-full items-start gap-2 px-4 py-2.5 text-left ${
                          openId === t.id ? 'bg-neutral-50 dark:bg-neutral-800/50' : ''
                        }`}
                      >
                        <span
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${st.dot}`}
                          title={st.label}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-neutral-700 dark:text-neutral-200">
                            {t.name}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-neutral-400">
                            <span className={st.text}>{st.label}</span>
                            {' · '}
                            {idleText(t.idle_days)}
                            {t.total > 0 ? ` · 挂着 ${t.total} 份` : ' · 还是空的'}
                            {t.deadline
                      ? ` · 截止 ${t.deadline.slice(5)}${
                          t.deadline < new Date().toISOString().slice(0, 10) ? '（已逾期）' : ''
                        }`
                      : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* 右栏：详情（时间线） */}
          <section>
            {detail ? (
              <div className="wb-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={() => void rename(detail.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void rename(detail.id)
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium text-neutral-800 outline-none hover:border-neutral-200 focus:border-violet-400 dark:text-neutral-100 dark:hover:border-neutral-700"
                  />
                  {/* 状态切换（方案 §8.4）。**只有两个**——「停滞」是算出来的，不是选的。 */}
                  <div className="flex shrink-0 items-center gap-1">
                    {(['open', 'done'] as const).map((s) => (
                      <button
                        key={s}
                        data-thread-status={s}
                        onClick={() => void setStatus(detail.id, s)}
                        className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                          detail.status === s
                            ? 'border-neutral-400 text-neutral-700 dark:border-neutral-500 dark:text-neutral-200'
                            : 'border-neutral-200 text-neutral-400 hover:border-neutral-300 dark:border-neutral-700'
                        }`}
                      >
                        {STATUS[s].label}
                      </button>
                    ))}
                  </div>
                  <label className="flex shrink-0 items-center gap-1 text-xs text-neutral-400">
                    截止
                    <input
                      type="date"
                      data-thread-deadline
                      value={detail.deadline ?? ''}
                      onChange={(e) => void setDeadline(detail.id, e.target.value)}
                      className="rounded-md border border-neutral-200 bg-white px-1 py-0.5 text-xs outline-none dark:border-neutral-700 dark:bg-neutral-900"
                    />
                  </label>
                  <button
                    onClick={() => void setArchived(detail.id, !detail.archived)}
                    className="shrink-0 text-xs text-neutral-400 hover:text-violet-600"
                  >
                    {detail.archived ? '取消归档' : '归档'}
                  </button>
                  <button
                    onClick={() => void remove(detail.id)}
                    title="只删这层索引，东西一件都不动"
                    className="shrink-0 text-xs text-neutral-400 hover:text-rose-600"
                  >
                    删除
                  </button>
                </div>

                {detail.items.length === 0 ? (
                  <div className="pt-3">
                    <EmptyHint
                      title="这件事还什么都没挂"
                      hint="「可能也属于这件事」里点一下就行，或者去收件箱把材料挂上来。"
                    />
                  </div>
                ) : (
                  /* 时间线（方案 §8.4）：左竖线 + 节点，**时间倒序**。
                     产出/运行/卡点/材料同一条线——「我到哪了」是时间问题，不是分类问题。 */
                  <ol
                    data-thread-timeline
                    className="mt-3 space-y-2 border-l border-neutral-200 pl-3 dark:border-neutral-800"
                  >
                    {timeline.map((it) => (
                      <li key={key(it.kind, it.ref)} className="relative flex items-center gap-2">
                        <span
                          className={`absolute -left-[17px] h-1.5 w-1.5 rounded-full ${
                            KIND_DOT[it.kind] ?? 'bg-neutral-300 dark:bg-neutral-600'
                          }`}
                        />
                        <span className="shrink-0 text-xs">{KIND_ICON[it.kind]}</span>
                        {it.exists ? (
                          <button
                            onClick={() => navigate(it.href)}
                            title={it.ref}
                            className="min-w-0 flex-1 truncate text-left text-xs text-neutral-700 hover:text-violet-600 dark:text-neutral-200"
                          >
                            {it.title}
                          </button>
                        ) : (
                          <span
                            className="min-w-0 flex-1 truncate text-xs text-neutral-400"
                            title={`引用还在，但 ${it.ref} 已经不在了`}
                          >
                            {it.title}
                          </span>
                        )}
                        {it.created_at ? (
                          <span className="shrink-0 text-xs text-neutral-400">
                            {ago(Date.parse(it.created_at) / 1000)}
                          </span>
                        ) : null}
                        <button
                          onClick={() => void detach(detail.id, it.kind, it.ref)}
                          title="摘下（东西不动）"
                          className="shrink-0 text-xs text-neutral-300 hover:text-rose-500"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ol>
                )}

                {detail.suggestions.length > 0 ? (
                  <div className="mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                    <p className="text-xs text-neutral-400">这些可能也属于这件事</p>
                    <ul className="mt-1 space-y-1">
                      {detail.suggestions.map((c) => (
                        <li key={key(c.kind, c.ref)} className="flex items-center gap-2">
                          <span className="shrink-0 text-xs">{KIND_ICON[c.kind]}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-neutral-600 dark:text-neutral-300">
                            {c.title}
                          </span>
                          <button
                            onClick={() => void attach(detail.id, c.kind, c.ref)}
                            className="shrink-0 rounded-full wb-btn-ghost px-2 py-0.5 text-xs"
                          >
                            挂上
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {cat ? (
                  <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                    <span className="text-xs text-neutral-400">就这件事</span>
                    <select
                      value={genre}
                      onChange={(e) => setGenre(e.target.value)}
                      className="rounded-lg border border-neutral-300 bg-white px-1.5 py-0.5 text-xs outline-none dark:border-neutral-700 dark:bg-neutral-900"
                    >
                      {cat.genres.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.label}
                        </option>
                      ))}
                    </select>
                    <select
                      value={audience}
                      onChange={(e) => setAudience(e.target.value)}
                      className="rounded-lg border border-neutral-300 bg-white px-1.5 py-0.5 text-xs outline-none dark:border-neutral-700 dark:bg-neutral-900"
                    >
                      {cat.audiences.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => void writeForThread(detail.id)}
                      disabled={writing}
                      className="rounded-full border border-teal-300 px-2.5 py-0.5 text-xs text-teal-700 hover:bg-teal-50 disabled:opacity-40 dark:border-teal-600 dark:text-teal-300 dark:hover:bg-teal-500/10"
                    >
                      {writing ? '写着…' : '写一份'}
                    </button>
                    {/* 这件事头上的账（§4-16）：花的钱、调用的次数、用过的模型 */}
                    <span
                      className="ml-auto text-xs text-neutral-400"
                      title="只算「就这件事」做的那些调用——别处烧的钱不摊过来"
                    >
                      {detail.cost.calls === 0
                        ? '这件事还没花过模型钱'
                        : `${fmtTokens(detail.cost.total)} tokens · ${detail.cost.calls} 次调用${
                            Object.keys(detail.cost.by_model).length
                              ? ` · ${Object.keys(detail.cost.by_model).join('、')}`
                              : ''
                          }`}
                    </span>
                  </div>
                ) : null}

                {/* 长任务走 RunPanel 六态（方案 §六「四页同守」）。
                    原来只有一个按钮文案「写着…」——而这是一次完整交付（取材 + 成文），
                    分钟级、花钱、还会落一份文件。**这里的停止是真停**（见 `writeForThread`）。 */}
                {writing ? (
                  <div className="mt-2">
                    <RunPanel
                      phase="progress"
                      tone="teal"
                      icon="✍️"
                      title="就这件事写一份"
                      status="正在取材、成文——可能要几分钟"
                      onCancel={() => writeAbort.current?.abort()}
                    />
                  </div>
                ) : null}

                {/* 就地起链 / 去写报告（方案 §8.4 详情头部的两个次按钮）。
                    **放在 `cat` 之外**：这两件事都不依赖体裁目录——目录拉不到时
                    「起一个工作链」照样该能用。 */}
                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                  {onStartWork ? (
                    <button
                      data-start-work
                      onClick={() => onStartWork(detail.name)}
                      title="把这件事的名字带过去当题目，在工作流页起一条链"
                      className="rounded-full wb-btn-ghost px-2.5 py-0.5 text-xs"
                    >
                      起一个工作链
                    </button>
                  ) : null}
                  <Link
                    to="/work?tab=report"
                    className="rounded-full border border-teal-300 px-2.5 py-0.5 text-xs text-teal-700 transition-colors hover:bg-teal-50 dark:border-teal-600 dark:text-teal-300 dark:hover:bg-teal-500/10"
                  >
                    写一份报告
                  </Link>
                </div>
              </div>
            ) : (
              <div className="wb-card p-4">
                <EmptyHint title="左边选一件事" hint="或在收件箱里把材料挂成一件事。" />
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  )

  if (chromeless) return <div className="space-y-4">{body}</div>
  return (
    <PageShell
      title="事"
      description="把材料、笔记、卡片、卡点、成品、判断挂到同一件事上——“这件事我到哪了”才答得出来。删掉一件事只少一层索引，东西一件都不动。"
    >
      {body}
    </PageShell>
  )
}
