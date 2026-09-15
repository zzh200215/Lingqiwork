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
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import PageShell from './PageShell'
import {
  api,
  type DeliverCatalogue,
  type ThreadCandidate,
  type ThreadDetail,
  type ThreadKind,
  type ThreadRow,
  type ThreadStep,
} from './api'

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

/** 一件事在这一步上有几条。 */
function stepCount(t: ThreadRow, kinds: string[]): number {
  return kinds.reduce((n, k) => n + (t.counts[k as keyof typeof t.counts] ?? 0), 0)
}

/** `chromeless`：不带 PageShell 页头地渲染——整页搬进工作页「跟进」标签时用，
    那里已经有「工作」的页头，再来一个「事」就是两层标题。 */
export default function ThreadsPage({ chromeless }: { chromeless?: boolean }) {
  const [threads, setThreads] = useState<ThreadRow[]>([])
  const [steps, setSteps] = useState<ThreadStep[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<ThreadDetail | null>(null)
  const [orphans, setOrphans] = useState<ThreadCandidate[]>([])
  const [draft, setDraft] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // 「挂到…」：给未归类的一条派生候选（不用打字）
  const [picker, setPicker] = useState<string | null>(null)
  const [picks, setPicks] = useState<ThreadRow[]>([])
  const [pickLabel, setPickLabel] = useState('')
  // 「就这件事写一份交付」——这一路的模型用量会记在这件事头上（§4-16）
  const [cat, setCat] = useState<DeliverCatalogue | null>(null)
  const [genre, setGenre] = useState('')
  const [audience, setAudience] = useState('')
  const [writing, setWriting] = useState(false)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const refreshList = useCallback(async () => {
    try {
      const r = await api.listThreads()
      setThreads(r.threads)
      setSteps(r.steps)
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

  function open(id: number) {
    setParams({ thread: String(id) })
  }

  async function afterChange(threadId: number) {
    await Promise.all([refreshList(), refreshOrphans(), loadDetail(threadId)])
  }

  async function create(name: string, attachTo?: ThreadCandidate) {
    const n = name.trim()
    if (!n || busy) return null
    setBusy(true)
    try {
      const t = await api.createThread(n)
      setDraft('')
      if (attachTo) {
        await api.attachThreadItem(t.id, attachTo.kind, attachTo.ref)
        await afterChange(t.id)
      } else {
        await refreshList()
        open(t.id)
      }
      return t
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setBusy(false)
    }
  }

  async function attach(threadId: number, kind: string, ref: string) {
    try {
      await api.attachThreadItem(threadId, kind as ThreadKind, ref)
      setPicker(null)
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

  async function remove(threadId: number) {
    try {
      await api.deleteThread(threadId)
      setParams({})
      await Promise.all([refreshList(), refreshOrphans()])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  /** 「挂到…」：拿这条的标签去派生候选，一个字都不用打。 */
  async function openPicker(c: ThreadCandidate) {
    const k = key(c.kind, c.ref)
    setPicker(k)
    setPicks([])
    setPickLabel(c.label)
    try {
      const r = await api.suggestThreads(c.kind, c.ref)
      setPicks(r.threads)
      if (r.label) setPickLabel(r.label)
    } catch {
      /* 建议拉不到，就只剩「用它的名字新建」那条路 */
    }
  }

  /** 就这件事写一份交付：产出挂上来，这一路的账也记在这件事头上（§4-16）。 */
  async function writeForThread(threadId: number) {
    if (!genre || !audience || writing) return
    setWriting(true)
    setErr('')
    try {
      await api.deliverIntoThread(threadId, genre, audience)
      await afterChange(threadId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setWriting(false)
    }
  }

  const body = (
    <>
      {err ? (
        <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {err}
        </p>
      ) : null}

      <div className="mb-5 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create(draft)
          }}
          placeholder="新的一件事，例：RAG 评测方案"
          className="min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          onClick={() => void create(draft)}
          disabled={!draft.trim() || busy}
          className="shrink-0 rounded-xl bg-violet-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-40"
        >
          建
        </button>
      </div>

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section>
          {threads.length === 0 ? (
            <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
              还没有一件事。上面建一个，或者在下面「还没归类」里点「挂到…」。
            </p>
          ) : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => open(t.id)}
                    className={`w-full py-2.5 text-left ${
                      openId === t.id ? 'text-violet-700 dark:text-violet-300' : ''
                    }`}
                  >
                    <span className="block truncate text-sm text-neutral-700 dark:text-neutral-200">
                      {t.name}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-neutral-400">
                      {steps.map((s) => {
                        const n = stepCount(t, s.kinds)
                        return n > 0 ? (
                          <span key={s.key}>
                            {s.label} {n}
                          </span>
                        ) : null
                      })}
                      {t.total === 0 ? <span>还是空的</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          {detail ? (
            <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
              <div className="flex items-center gap-2">
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => void rename(detail.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void rename(detail.id)
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium text-neutral-800 outline-none hover:border-neutral-200 focus:border-violet-400 dark:text-neutral-100 dark:hover:border-neutral-700"
                />
                <button
                  onClick={() => void setArchived(detail.id, !detail.archived)}
                  className="shrink-0 text-[11px] text-neutral-400 hover:text-violet-600"
                >
                  {detail.archived ? '取消归档' : '归档'}
                </button>
                <button
                  onClick={() => void remove(detail.id)}
                  title="只删这层索引，东西一件都不动"
                  className="shrink-0 text-[11px] text-neutral-400 hover:text-rose-600"
                >
                  删除
                </button>
              </div>

              {detail.items.length === 0 ? (
                <p className="py-4 text-center text-xs text-neutral-400">
                  这件事还什么都没挂。下面「可能也属于这件事」里点一下就行。
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {detail.steps.map((s) => {
                    const items = detail.by_step[s.key] ?? []
                    if (items.length === 0) return null
                    return (
                      <div key={s.key}>
                        <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                          {s.label}
                        </p>
                        <ul className="mt-1 space-y-1">
                          {items.map((it) => (
                            <li key={key(it.kind, it.ref)} className="flex items-center gap-2">
                              <span className="shrink-0 text-[11px]">{KIND_ICON[it.kind]}</span>
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
                              <button
                                onClick={() => void detach(detail.id, it.kind, it.ref)}
                                title="摘下（东西不动）"
                                className="shrink-0 text-[11px] text-neutral-300 hover:text-rose-500"
                              >
                                ✕
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )
                  })}
                </div>
              )}

              {detail.suggestions.length > 0 ? (
                <div className="mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                  <p className="text-[11px] text-neutral-400">这些可能也属于这件事</p>
                  <ul className="mt-1 space-y-1">
                    {detail.suggestions.map((c) => (
                      <li key={key(c.kind, c.ref)} className="flex items-center gap-2">
                        <span className="shrink-0 text-[11px]">{KIND_ICON[c.kind]}</span>
                        <span className="min-w-0 flex-1 truncate text-xs text-neutral-600 dark:text-neutral-300">
                          {c.title}
                        </span>
                        <button
                          onClick={() => void attach(detail.id, c.kind, c.ref)}
                          className="shrink-0 rounded-full border border-violet-300 px-2 py-0.5 text-[11px] text-violet-700 hover:bg-violet-50 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-500/10"
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
                  <span className="text-[11px] text-neutral-400">就这件事</span>
                  <select
                    value={genre}
                    onChange={(e) => setGenre(e.target.value)}
                    className="rounded-lg border border-neutral-300 bg-white px-1.5 py-0.5 text-[11px] outline-none dark:border-neutral-700 dark:bg-neutral-900"
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
                    className="rounded-lg border border-neutral-300 bg-white px-1.5 py-0.5 text-[11px] outline-none dark:border-neutral-700 dark:bg-neutral-900"
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
                    className="rounded-full border border-teal-300 px-2.5 py-0.5 text-[11px] text-teal-700 hover:bg-teal-50 disabled:opacity-40 dark:border-teal-600 dark:text-teal-300 dark:hover:bg-teal-500/10"
                  >
                    {writing ? '写着…' : '写一份'}
                  </button>
                  {/* 这件事头上的账（§4-16）：花的钱、调用的次数、用过的模型 */}
                  <span
                    className="ml-auto text-[11px] text-neutral-400"
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
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-400 dark:border-neutral-700">
              左边选一件事，这里看它到哪了。
            </p>
          )}
        </section>
      </div>

      <section className="mt-8">
        <div className="flex items-baseline justify-between pb-1">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">还没归类</h2>
          <span className="text-xs text-neutral-400">常驻是常态，不是欠账</span>
        </div>
        {orphans.length === 0 ? (
          <p className="text-xs text-neutral-400">空的——最近这些东西都挂上了。</p>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {orphans.map((c) => (
              <li key={key(c.kind, c.ref)} className="py-2">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-[11px]">{KIND_ICON[c.kind]}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-600 dark:text-neutral-300">
                    {c.title || c.ref}
                  </span>
                  <button
                    onClick={() => void openPicker(c)}
                    className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-500 hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
                  >
                    挂到…
                  </button>
                </div>
                {picker === key(c.kind, c.ref) ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-5">
                    {picks.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => void attach(t.id, c.kind, c.ref)}
                        className="rounded-full border border-violet-300 px-2 py-0.5 text-[11px] text-violet-700 hover:bg-violet-50 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-500/10"
                      >
                        {t.name}
                      </button>
                    ))}
                    <button
                      disabled={busy}
                      onClick={() => void create(pickLabel || c.title, c)}
                      title="用这条自己的名字建一件事，并把它挂上去"
                      className="rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-500 hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400"
                    >
                      ＋ 新建「{(pickLabel || c.title).slice(0, 12)}」
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )

  if (chromeless) return <div className="space-y-4">{body}</div>
  return (
    <PageShell
      title="事"
      description="把材料、笔记、卡片、卡点、成品、判断挂到同一件事上——“这件事我到哪了”才答得出来。删掉一件事只少一层索引，东西一件都不动。"
      maxWidth="5xl"
    >
      {body}
    </PageShell>
  )
}
