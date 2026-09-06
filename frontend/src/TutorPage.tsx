import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import CodeBlock from './CodeBlock'
import Layout from './Layout'
import {
  api,
  type TutorEndResult,
  type TutorSessionRow,
  type TutorStats,
  type TutorTurn,
} from './api'
import {
  streamTutorSay,
  type TutorMaterialSource,
  type TutorRecallHit,
} from './stream'

// 对话式教学 (PLAN.md 第 6 节 第一步). You name something to understand, it asks
// before it explains, and a session ends as 概念 / 自评 / 卡点.
//
// What is deliberately absent is the point: no due dates, no queue, no streak, no
// daily count. 第 2 节 makes that the single test — the moment a widget here
// produces the feeling of owing something, this is the Anki page again under a
// new name. The history rail is history, never a to-do list.

const VERDICTS = [
  { v: 'got' as const, label: '搞懂了', cls: 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-500/10' },
  { v: 'half' as const, label: '半懂', cls: 'border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-500/10' },
  { v: 'useless' as const, label: '没用', cls: 'border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-400 dark:hover:bg-neutral-800' },
]

const VERDICT_LABEL: Record<string, string> = {
  got: '搞懂了',
  half: '半懂',
  useless: '没用',
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{ pre: CodeBlock }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

/** The one thing that makes this more than a chat wrapper, so it is shown, not
 * hidden: 验收 asks whether recall fired AND whether it was right, and only the
 * user can judge the second half. */
function RecallChip({ hits }: { hits: TutorRecallHit[] }) {
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-sm dark:border-violet-500/30 dark:bg-violet-500/10">
      <p className="pb-1 text-[11px] font-medium uppercase tracking-wider text-violet-500 dark:text-violet-300">
        接上了以前的记录
      </p>
      {hits.map((h) => (
        <p key={h.concept + h.date} className="text-neutral-700 dark:text-neutral-300">
          ↳ <span className="font-medium">{h.concept}</span>（
          {h.verdict === 'half' ? '半懂' : '说通了'}，{h.date}）
          {h.stuck ? <span className="text-neutral-500">，当时卡在：{h.stuck}</span> : null}
        </p>
      ))}
    </div>
  )
}

/** Server turns carry role+content only; sources ride along on the reply the
 * turn was streamed for, so 取材来源 stays attached to the bubble that used it. */
type Turn = TutorTurn & { sources?: TutorMaterialSource[] }

function MaterialLine({ sources }: { sources: TutorMaterialSource[] }) {
  return (
    <p className="text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
      取材：
      {sources.map((s, i) => (
        <span key={i} className="ml-1.5 rounded bg-neutral-200/70 px-1.5 py-0.5 dark:bg-neutral-700/60">
          {s.source}
        </span>
      ))}
    </p>
  )
}

function Bubble({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-violet-600 px-4 py-2.5 text-sm text-white">
          {turn.content}
        </div>
      </div>
    )
  }
  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-neutral-100 px-4 py-3 dark:bg-neutral-800/70">
      <Markdown>{turn.content}</Markdown>
      {turn.sources && turn.sources.length > 0 ? (
        <div className="mt-2 border-t border-neutral-200/70 pt-1.5 dark:border-neutral-700/70">
          <MaterialLine sources={turn.sources} />
        </div>
      ) : null}
    </div>
  )
}

export default function TutorPage() {
  const [sid, setSid] = useState<number | null>(null)
  const [topic, setTopic] = useState('')
  const [modelOk, setModelOk] = useState(true)
  const [turns, setTurns] = useState<Turn[]>([])
  const [hits, setHits] = useState<TutorRecallHit[]>([])
  const [streaming, setStreaming] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [verdict, setVerdict] = useState<'' | 'got' | 'half' | 'useless'>('')
  const [ended, setEnded] = useState<{ concept: string; stuck: string; nearby: TutorEndResult['material_nearby'] } | null>(null)
  const [rows, setRows] = useState<TutorSessionRow[]>([])
  const [stats, setStats] = useState<TutorStats | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  // 卡过的点直接从历史行里来：stuck 非空就是一条。它跟着 rail 一起刷新。
  const stuckRows = rows.filter((r) => r.stuck)

  const refreshRail = useCallback(() => {
    // best-effort: the rail is context, never a precondition for teaching
    api.tutorSessions().then((r) => setRows(r.sessions)).catch(() => {})
    api.tutorStats().then(setStats).catch(() => {})
  }, [])

  useEffect(() => refreshRail(), [refreshRail])

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns.length, streaming])

  const send = useCallback(async (sessionId: number, text: string) => {
    setErr('')
    setBusy(true)
    setTurns((t) => [...t, { role: 'user', content: text }])
    let acc = ''
    let srcs: TutorMaterialSource[] | undefined
    try {
      const done = await streamTutorSay(
        { session_id: sessionId, text },
        {
          onDelta: (d) => {
            acc += d
            setStreaming(acc)
          },
          onRecall: setHits,
          onSources: (s) => {
            srcs = s
          },
        }
      )
      if (!done.ok) setErr(done.error ?? '出错了')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setStreaming('')
      // a partial reply is stored server-side too, so keeping it here matches
      if (acc) setTurns((t) => [...t, { role: 'assistant', content: acc, sources: srcs }])
      setBusy(false)
    }
  }, [])

  const begin = useCallback(async () => {
    const t = topic.trim()
    if (!t || busy) return
    setErr('')
    try {
      const s = await api.tutorStart(t)
      setSid(s.id)
      setModelOk(s.model_ok)
      setTurns([])
      setHits([])
      setVerdict('')
      setEnded(null)
      await send(s.id, t) // the topic IS the first turn — no special first-reply path
      refreshRail()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [topic, busy, send, refreshRail])

  const submit = useCallback(async () => {
    const t = draft.trim()
    if (!t || sid === null || busy) return
    setDraft('')
    await send(sid, t)
  }, [draft, sid, busy, send])

  const mark = useCallback(
    async (v: 'got' | 'half' | 'useless') => {
      if (sid === null || busy) return
      setBusy(true)
      try {
        const got = await api.tutorEnd(sid, v)
        setVerdict(v)
        setEnded({ concept: got.concept, stuck: got.stuck, nearby: got.material_nearby ?? [] })
        refreshRail()
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [sid, busy, refreshRail]
  )

  const open = useCallback(async (id: number) => {
    setErr('')
    try {
      const d = await api.tutorSession(id)
      setSid(d.id)
      setTopic(d.topic)
      setTurns(d.turns)
      setHits([])
      setVerdict(d.verdict)
      setEnded(d.verdict ? { concept: d.concept, stuck: d.stuck, nearby: [] } : null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const reset = useCallback(() => {
    setSid(null)
    setTopic('')
    setTurns([])
    setHits([])
    setDraft('')
    setErr('')
    setVerdict('')
    setEnded(null)
  }, [])

  return (
    <Layout page="tutor">
      <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {sid === null ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6">
              <div className="w-full max-w-xl">
                <h1 className="pb-1 text-2xl font-semibold tracking-tight">你想搞懂什么？</h1>
                <p className="pb-4 text-sm text-neutral-500">
                  说一个具体的东西。它会先问你现在怎么理解，再讲。
                </p>
                <div className="flex gap-2">
                  <input
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void begin()
                    }}
                    autoFocus
                    placeholder="例如：asyncio 里 await 到底把控制权交给了谁"
                    className="min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                  <button
                    onClick={() => void begin()}
                    disabled={!topic.trim() || busy}
                    className="shrink-0 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-violet-300 transition-all hover:brightness-110 disabled:opacity-40 disabled:shadow-none dark:shadow-violet-900/60"
                  >
                    开始
                  </button>
                </div>
                {err ? <p className="pt-3 text-sm text-rose-600 dark:text-rose-400">{err}</p> : null}
              </div>
            </div>
          ) : (
            <>
              <header className="flex items-center gap-3 border-b border-neutral-200/80 px-6 py-3 dark:border-neutral-800/80">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{topic || '这次'}</p>
                  {ended?.concept ? (
                    <p className="truncate text-[11px] text-neutral-500">
                      {ended.concept}
                      {ended.stuck ? ` · 卡点：${ended.stuck}` : ''}
                    </p>
                  ) : null}
                </div>
                <button
                  onClick={reset}
                  className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  再学一个
                </button>
              </header>

              {modelOk ? null : (
                <p className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  当前默认模型最近失败过，回答可能出不来。去
                  <a href="/settings.html" className="underline">
                    设置
                  </a>
                  换一个。
                </p>
              )}

              <div className="flex-1 overflow-y-auto px-6 py-4">
                <div className="mx-auto flex max-w-3xl flex-col gap-4">
                  {hits.length > 0 ? <RecallChip hits={hits} /> : null}
                  {turns.map((t, i) => (
                    <Bubble key={i} turn={t} />
                  ))}
                  {streaming ? <Bubble turn={{ role: 'assistant', content: streaming }} /> : null}
                  {busy && !streaming ? (
                    <p className="text-sm text-neutral-400">在想…</p>
                  ) : null}
                  {err ? <p className="text-sm text-rose-600 dark:text-rose-400">{err}</p> : null}
                  <div ref={bottom} />
                </div>
              </div>

              <div className="border-t border-neutral-200/80 px-6 py-3 dark:border-neutral-800/80">
                <div className="mx-auto max-w-3xl">
                  {/* 自评在输入框上方，不在会话末尾：标完还能继续问，半懂改成搞懂了
                      也只是再点一次。它是记录这次的结果，不是「交作业」的按钮。 */}
                  <div className="flex flex-wrap items-center gap-2 pb-2">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                      这次
                    </span>
                    {VERDICTS.map((v) => (
                      <button
                        key={v.v}
                        onClick={() => void mark(v.v)}
                        disabled={busy || turns.length === 0}
                        className={`rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
                          verdict === v.v ? 'ring-2 ring-violet-300 dark:ring-violet-500/50 ' : ''
                        }${v.cls}`}
                      >
                        {v.label}
                      </button>
                    ))}
                    {verdict ? (
                      <span className="text-[11px] text-neutral-400">
                        {verdict === 'useless'
                          ? '记下了，不会再翻出来'
                          : ended?.concept
                            ? `记下了：${ended.concept}`
                            : '记下了'}
                      </span>
                    ) : null}
                    {ended && ended.nearby.length > 0 ? (
                      <span className="text-[11px] text-neutral-400">
                        材料里还有：
                        {ended.nearby.map((n) => (
                          <span key={n.source} className="ml-1 rounded bg-neutral-200/70 px-1.5 py-0.5 dark:bg-neutral-700/60">
                            {n.title || n.source}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-end gap-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          void submit()
                        }
                      }}
                      rows={2}
                      placeholder="先按你自己的理解答一遍（Enter 发送，Shift+Enter 换行）"
                      className="min-w-0 flex-1 resize-none rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                    />
                    <button
                      onClick={() => void submit()}
                      disabled={!draft.trim() || busy}
                      className="shrink-0 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
                    >
                      发送
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* 右栏是历史，不是待办：只写已经发生过的事，没有到期、没有未完成计数。 */}
        <aside className="hidden w-64 shrink-0 flex-col border-l border-neutral-200/80 lg:flex dark:border-neutral-800/80">
          <div className="px-4 pb-2 pt-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              学过的
            </p>
            {stats && stats.sessions > 0 ? (
              <p className="pt-1 text-xs leading-relaxed text-neutral-500">
                近 {stats.days} 天 {stats.sessions} 次，{stats.got} 次说通了
                {stats.got_with_recall > 0 ? `，其中 ${stats.got_with_recall} 次接上了以前卡的点` : ''}
              </p>
            ) : null}
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-4">
            {/* 卡过的点是记录，不是清单：不计数、不打勾、不催。你想看的时候它在那里。 */}
            {stuckRows.length > 0 ? (
              <div className="px-3 pb-3">
                <p className="pb-1.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                  卡过的点
                </p>
                {stuckRows.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => void open(r.id)}
                    className="block w-full rounded-lg py-1.5 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800/70"
                  >
                    <span className="block truncate text-xs text-neutral-600 dark:text-neutral-300">
                      {r.concept || r.topic}
                      <span className="ml-1.5 text-[10px] text-neutral-400">
                        {(r.created_at || '').slice(5, 10)}
                        {r.verdict === 'half' ? ' · 半懂' : ''}
                      </span>
                    </span>
                    <span className="block truncate text-[11px] text-neutral-400">
                      ↳ {r.stuck}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            {rows.length === 0 ? (
              <p className="px-3 py-2 text-xs text-neutral-400">还没有记录</p>
            ) : (
              rows.map((r) => (
                <button
                  key={r.id}
                  onClick={() => void open(r.id)}
                  className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                    r.id === sid
                      ? 'bg-violet-100 dark:bg-violet-500/15'
                      : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/70'
                  }`}
                >
                  <span className="block truncate text-sm text-neutral-700 dark:text-neutral-200">
                    {r.concept || r.topic}
                  </span>
                  <span className="block truncate text-[11px] text-neutral-400">
                    {r.verdict ? VERDICT_LABEL[r.verdict] : '没标'}
                    {r.recalled ? ' · 接上过' : ''}
                    {r.stuck ? ` · ${r.stuck}` : ''}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>
      </div>
    </Layout>
  )
}




