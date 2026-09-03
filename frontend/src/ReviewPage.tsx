import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import CardMaker from './CardMaker'
import CodeBlock from './CodeBlock'
import Layout from './Layout'
import { api, type CardGrade, type CardItem, type CardStats } from './api'

// Keyboard-first review. Every action has a key because a 20-card session done
// with the mouse feels like a chore and one done with the keyboard takes 40
// seconds — that difference is the whole retention story.

type Phase = 'loading' | 'empty' | 'question' | 'answer' | 'summary'

const GRADES: { g: CardGrade; key: string; label: string; cls: string }[] = [
  { g: 1, key: '1', label: '重来', cls: 'border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-500/10' },
  { g: 2, key: '2', label: '困难', cls: 'border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-500/10' },
  { g: 3, key: '3', label: '良好', cls: 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-500/10' },
  { g: 4, key: '4', label: '简单', cls: 'border-sky-300 text-sky-700 hover:bg-sky-50 dark:border-sky-700 dark:text-sky-300 dark:hover:bg-sky-500/10' },
]

const KIND_LABEL: Record<string, string> = {
  scenario: '情境',
  debug: '排错',
  cloze: '填空',
  concept: '概念',
}

const MAX_REQUEUE = 3
const UNDO_WINDOW_MS = 5000

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

export default function ReviewPage() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [queue, setQueue] = useState<CardItem[]>([])
  const [idx, setIdx] = useState(0)
  const [dueTotal, setDueTotal] = useState(0)
  const [cap, setCap] = useState(0)
  const [stats, setStats] = useState<CardStats | null>(null)
  const [showHint, setShowHint] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [session, setSession] = useState({ again: 0, hard: 0, good: 0, easy: 0, ms: 0 })
  const [lastAnswer, setLastAnswer] = useState<{ id: number; at: number } | null>(null)
  const [editing, setEditing] = useState<{ front: string; back: string } | null>(null)
  const [makerOpen, setMakerOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  const shownAt = useRef(0)
  const requeued = useRef<Record<number, number>>({})

  const card = queue[idx] ?? null
  const total = queue.length
  const remaining = Math.max(0, total - idx)

  const load = useCallback(async () => {
    setError('')
    try {
      const [q, s] = await Promise.all([api.cardQueue(), api.cardStats()])
      const cards = [...q.due, ...q.fresh]
      setQueue(cards)
      setDueTotal(q.due_total)
      setCap(q.caps.review_per_day)
      setStats(s)
      setIdx(0)
      requeued.current = {}
      setSession({ again: 0, hard: 0, good: 0, easy: 0, ms: 0 })
      setPhase(cards.length ? 'question' : 'empty')
      shownAt.current = performance.now()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('empty')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const finish = useCallback(async () => {
    setPhase('summary')
    try {
      setStats(await api.cardStats())
    } catch {
      /* summary still renders from session counters */
    }
  }, [])

  const grade = useCallback(
    async (g: CardGrade) => {
      if (!card || busy) return
      setBusy(true)
      const ms = Math.round(performance.now() - shownAt.current)
      try {
        const r = await api.reviewCard(card.id, g, ms / 1000)
        setSession((s) => ({
          again: s.again + (g === 1 ? 1 : 0),
          hard: s.hard + (g === 2 ? 1 : 0),
          good: s.good + (g === 3 ? 1 : 0),
          easy: s.easy + (g === 4 ? 1 : 0),
          ms: s.ms + ms,
        }))
        setLastAnswer({ id: card.id, at: Date.now() })

        const seen = requeued.current[card.id] ?? 0
        const again = r.requeue && seen < MAX_REQUEUE
        if (again) requeued.current[card.id] = seen + 1

        setShowHint(false)
        setEditing(null)
        if (idx + 1 >= queue.length && !again) {
          void finish()
          setBusy(false)
          return
        }
        setQueue((q) => {
          if (!again) return q
          const next = [...q]
          const at = idx + 1 + Math.max(3, Math.floor((next.length - idx) / 2))
          next.splice(Math.min(at, next.length), 0, { ...card })
          return next
        })
        setIdx((i) => i + 1)
        setPhase('question')
        shownAt.current = performance.now()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [card, busy, idx, queue.length, finish]
  )

  const undo = useCallback(async () => {
    if (!lastAnswer || Date.now() - lastAnswer.at > UNDO_WINDOW_MS) return
    try {
      const r = await api.undoCardReview(lastAnswer.id)
      if (!r.ok || !r.card) return
      const restored = r.card
      setQueue((q) => {
        const next = q.filter((c, i) => !(c.id === restored.id && i > idx))
        const back = Math.max(0, idx - 1)
        next[back] = restored
        return next
      })
      setIdx((i) => Math.max(0, i - 1))
      setPhase('answer')
      setLastAnswer(null)
      setSession((s) => ({ ...s }))
    } catch {
      /* undo is a convenience; failing silently is fine */
    }
  }, [lastAnswer, idx])

  const skip = useCallback(() => {
    if (!card) return
    setShowHint(false)
    setEditing(null)
    if (idx + 1 >= queue.length) {
      void finish()
      return
    }
    setIdx((i) => i + 1)
    setPhase('question')
    shownAt.current = performance.now()
  }, [card, idx, queue.length, finish])

  const saveEdit = useCallback(async () => {
    if (!card || !editing) return
    if (!editing.front.trim() || !editing.back.trim()) return
    try {
      const updated = await api.updateCard(card.id, {
        front: editing.front.trim(),
        back: editing.back.trim(),
      })
      setQueue((q) => q.map((c, i) => (i === idx ? updated : c)))
      setEditing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [card, editing, idx])

  const suspend = useCallback(async () => {
    if (!card) return
    try {
      await api.updateCard(card.id, { suspended: true })
    } catch {
      /* shelving is best-effort; move on either way */
    }
    skip()
  }, [card, skip])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // never steal keys while typing — otherwise "3" grades the card mid-edit
      const t = e.target
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) {
        if (e.key === 'Escape') setEditing(null)
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void saveEdit()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return

      if (e.key === '?') {
        e.preventDefault()
        setHelpOpen((v) => !v)
        return
      }
      if (e.key === 'Escape') {
        if (helpOpen) setHelpOpen(false)
        else if (makerOpen) setMakerOpen(false)
        else if (phase === 'answer' || phase === 'question') void finish()
        return
      }
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        setMakerOpen((v) => !v)
        return
      }
      if (e.key === 'u' || e.key === 'U') {
        e.preventDefault()
        void undo()
        return
      }
      if (!card || (phase !== 'question' && phase !== 'answer')) return

      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        if (phase === 'question') setPhase('answer')
        else void grade(3)
        return
      }
      if (phase === 'question' && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault()
        setShowHint(true)
        return
      }
      if (phase === 'answer' && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault()
        void grade(Number(e.key) as CardGrade)
        return
      }
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        void suspend()
        return
      }
      if (phase === 'answer' && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault()
        setEditing({ front: card.front, back: card.back })
        return
      }
      if ((e.key === 'o' || e.key === 'O') && card.source) {
        e.preventDefault()
        window.open('/notes.html?path=' + encodeURIComponent(card.source), '_blank')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, phase, helpOpen, makerOpen, grade, undo, skip, suspend, saveEdit, finish])

  const answered = session.again + session.hard + session.good + session.easy
  const accuracy = useMemo(
    () => (answered ? Math.round(((session.good + session.easy) / answered) * 100) : null),
    [answered, session.good, session.easy]
  )
  const truncated = dueTotal > 0 && cap > 0 && dueTotal > total

  return (
    <Layout page="review">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <header className="mb-5 flex flex-wrap items-center gap-3">
          <h1 className="bg-gradient-to-r from-violet-600 to-fuchsia-600 bg-clip-text text-xl font-semibold text-transparent">
            复习
          </h1>
          {stats && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {stats.total} 张 · 今天已过 {stats.today_reviewed}
              {stats.streak > 0 ? ` · 连续 ${stats.streak} 天` : ''}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2 text-xs">
            <button
              onClick={() => setMakerOpen((v) => !v)}
              className="rounded-lg border border-neutral-200 px-2.5 py-1 text-neutral-600 transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-violet-500"
            >
              📋 粘贴出卡
              <kbd className="ml-1 text-[10px] text-neutral-400">N</kbd>
            </button>
            <button
              onClick={() => setHelpOpen((v) => !v)}
              className="rounded-lg border border-neutral-200 px-2 py-1 text-neutral-500 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
              title="快捷键"
            >
              ?
            </button>
          </div>
        </header>

        {error && (
          <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">
            {error}
          </p>
        )}

        {makerOpen && (
          <section className="mb-5 rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
            <h2 className="mb-2.5 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              从文本出卡
            </h2>
            <CardMaker
              onSaved={(n) => {
                if (n > 0) void load()
              }}
            />
          </section>
        )}

        {helpOpen && (
          <section className="mb-5 rounded-2xl border border-neutral-200 bg-neutral-50/60 p-4 text-xs dark:border-neutral-800 dark:bg-neutral-900/40">
            <div className="grid gap-1.5 sm:grid-cols-2">
              {[
                ['空格 / Enter', '翻面；已翻面则按「良好」'],
                ['1 / 2 / 3 / 4', '重来 / 困难 / 良好 / 简单'],
                ['H', '看提示'],
                ['E', '就地编辑（Ctrl+Enter 保存）'],
                ['O', '打开来源笔记'],
                ['S', '搁置这张'],
                ['U', '撤销上一次评分（5 秒内）'],
                ['N', '粘贴文本出卡'],
                ['Esc', '结束本轮 / 关闭面板'],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <kbd className="min-w-[104px] rounded bg-white px-1.5 py-0.5 text-[10px] text-neutral-600 shadow-sm dark:bg-neutral-800 dark:text-neutral-300">
                    {k}
                  </kbd>
                  <span className="text-neutral-500 dark:text-neutral-400">{v}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {phase === 'loading' && (
          <p className="text-sm text-neutral-400">加载队列…</p>
        )}

        {phase === 'empty' && (
          <section className="rounded-2xl border border-dashed border-neutral-300 p-10 text-center dark:border-neutral-700">
            <p className="text-3xl">🎴</p>
            <p className="mt-3 text-sm font-medium">
              {stats && stats.total > 0 ? '今天没有到期的卡' : '还没有卡片'}
            </p>
            <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
              {stats && stats.total > 0
                ? stats.next_due
                  ? `下一张 ${new Date(stats.next_due).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 到期`
                  : '全部过完了'
                : '粘一段踩坑记录或 changelog 进来，AI 会把它变成卡片'}
            </p>
            <button
              onClick={() => setMakerOpen(true)}
              className="mt-4 rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110"
            >
              📋 粘贴文本出卡
            </button>
          </section>
        )}

        {(phase === 'question' || phase === 'answer') && card && (
          <>
            <div className="mb-3 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                {KIND_LABEL[card.kind] ?? card.kind}
              </span>
              {card.topic && <span>#{card.topic}</span>}
              {card.reps === 0 && <span className="text-violet-500">新卡</span>}
              {card.lapses > 0 && <span className="text-rose-500">错过 {card.lapses} 次</span>}
              <span className="ml-auto">
                剩 {remaining} / {total}
                {truncated && `（共 ${dueTotal} 张到期，今天先过 ${cap}）`}
              </span>
            </div>
            <div className="mb-4 h-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all"
                style={{ width: `${total ? (idx / total) * 100 : 0}%` }}
              />
            </div>

            <section className="rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900/60">
              {editing ? (
                <div className="space-y-2">
                  <textarea
                    value={editing.front}
                    onChange={(e) => setEditing({ ...editing, front: e.target.value })}
                    className="w-full resize-none rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-900"
                    rows={4}
                    autoFocus
                  />
                  <textarea
                    value={editing.back}
                    onChange={(e) => setEditing({ ...editing, back: e.target.value })}
                    className="w-full resize-none rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-900"
                    rows={6}
                  />
                  <div className="flex gap-2 text-xs">
                    <button
                      onClick={() => void saveEdit()}
                      className="rounded-lg bg-violet-600 px-3 py-1.5 font-medium text-white hover:brightness-110"
                    >
                      保存 <kbd className="text-[10px] opacity-70">Ctrl+Enter</kbd>
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="rounded-lg border border-neutral-300 px-3 py-1.5 dark:border-neutral-700"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <Markdown>{card.front}</Markdown>
                  {showHint && card.hint && (
                    <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                      💡 {card.hint}
                    </p>
                  )}
                  {phase === 'answer' && (
                    <div className="mt-5 border-t border-neutral-200 pt-4 dark:border-neutral-800">
                      <Markdown>{card.back}</Markdown>
                    </div>
                  )}
                </>
              )}
            </section>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {phase === 'question' ? (
                <button
                  onClick={() => setPhase('answer')}
                  className="rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110"
                >
                  显示答案 <kbd className="ml-1 text-[10px] opacity-70">空格</kbd>
                </button>
              ) : (
                GRADES.map((g) => (
                  <button
                    key={g.g}
                    onClick={() => void grade(g.g)}
                    disabled={busy}
                    className={`rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${g.cls}`}
                  >
                    {g.label} <kbd className="ml-0.5 text-[10px] opacity-60">{g.key}</kbd>
                  </button>
                ))
              )}
              <div className="ml-auto flex items-center gap-2 text-xs text-neutral-400">
                {card.source && (
                  <button
                    onClick={() =>
                      window.open('/notes.html?path=' + encodeURIComponent(card.source), '_blank')
                    }
                    className="hover:text-violet-600 dark:hover:text-violet-300"
                    title={card.source}
                  >
                    ↗ 原文 <kbd className="text-[10px]">O</kbd>
                  </button>
                )}
                {lastAnswer && Date.now() - lastAnswer.at < UNDO_WINDOW_MS && (
                  <button
                    onClick={() => void undo()}
                    className="hover:text-violet-600 dark:hover:text-violet-300"
                  >
                    ↩ 撤销 <kbd className="text-[10px]">U</kbd>
                  </button>
                )}
                <button
                  onClick={() => void suspend()}
                  className="hover:text-rose-600 dark:hover:text-rose-300"
                >
                  搁置 <kbd className="text-[10px]">S</kbd>
                </button>
              </div>
            </div>
          </>
        )}

        {phase === 'summary' && (
          <section className="rounded-2xl border border-neutral-200 bg-white p-8 dark:border-neutral-800 dark:bg-neutral-900/60">
            <p className="text-3xl">✅</p>
            <h2 className="mt-3 text-lg font-semibold">
              过完 {answered} 张{stats && stats.streak > 0 ? ` · 连续 ${stats.streak} 天` : ''}
            </h2>
            <div className="mt-4 flex flex-wrap gap-4 text-sm">
              {[
                ['重来', session.again, 'text-rose-600 dark:text-rose-400'],
                ['困难', session.hard, 'text-amber-600 dark:text-amber-400'],
                ['良好', session.good, 'text-emerald-600 dark:text-emerald-400'],
                ['简单', session.easy, 'text-sky-600 dark:text-sky-400'],
              ].map(([label, n, cls]) => (
                <span key={String(label)} className={cls as string}>
                  {label} {n as number}
                </span>
              ))}
              {accuracy != null && (
                <span className="text-neutral-500 dark:text-neutral-400">正确率 {accuracy}%</span>
              )}
              {session.ms > 0 && (
                <span className="text-neutral-500 dark:text-neutral-400">
                  用时 {Math.round(session.ms / 1000)}s
                </span>
              )}
            </div>
            {stats?.next_due && (
              <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
                下一批 {new Date(stats.next_due).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 到期
              </p>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                onClick={() => void load()}
                className="rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110"
              >
                再来一轮
              </button>
              {session.again > 0 && (
                <button
                  onClick={() => setMakerOpen(true)}
                  className="rounded-lg border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
                >
                  就答错的内容再出几张
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </Layout>
  )
}


