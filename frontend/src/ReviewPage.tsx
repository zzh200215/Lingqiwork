import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import CardMaker from './CardMaker'
import CodeBlock from './CodeBlock'
import HabitStrip, { type HabitStripHandle } from './HabitStrip'
import Layout from './Layout'
import SelfCheckLine from './SelfCheckLine'
import { api, type CardGrade, type CardItem, type CardStats } from './api'

// Keyboard-first 今日 page: the review queue plus the habit grid. Every action
// has a key because a 20-card session done with the mouse feels like a chore and
// one done with the keyboard takes 40 seconds — that difference is the whole
// retention story.

// 'empty' was removed rather than 'overview' added: deleting a member makes
// `tsc -b` point at every stale branch, where adding one lets a missed branch
// render a blank page.
type Phase = 'loading' | 'overview' | 'question' | 'answer' | 'summary'

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

/** `repo:` / `dir:` cards live outside the vault, where /notes.html cannot reach. */
const isVaultSource = (s: string) => !!s && !s.startsWith('repo:') && !s.startsWith('dir:')

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
  const [habitSummary, setHabitSummary] = useState({ done: 0, total: 0 })

  const shownAt = useRef(0)
  const requeued = useRef<Record<number, number>>({})
  const habits = useRef<HabitStripHandle>(null)

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
      setPhase('overview')
      shownAt.current = performance.now()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('overview')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const start = useCallback(() => {
    setIdx(0)
    setPhase('question')
    shownAt.current = performance.now()
  }, [])

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
      if (phase === 'overview') {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          if (queue.length) start()
          return
        }
        if (e.key >= '1' && e.key <= '9') {
          e.preventDefault()
          habits.current?.toggleNth(Number(e.key))
          return
        }
        if (e.key === 'a' || e.key === 'A') {
          e.preventDefault()
          habits.current?.openAdd()
          return
        }
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
      if (e.key === 'o' || e.key === 'O') {
        if (!card.source) return
        e.preventDefault()
        // /notes.html only serves vault paths; repo:/dir: cards get their path copied
        if (isVaultSource(card.source)) {
          window.open('/notes.html?path=' + encodeURIComponent(card.source), '_blank')
        } else {
          void navigator.clipboard?.writeText(card.source)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, phase, helpOpen, makerOpen, grade, undo, skip, suspend, saveEdit, finish, start, queue.length])

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
            今日
          </h1>
          {stats && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {stats.total} 张 · 今天已过 {stats.today_reviewed}
              {stats.streak > 0 ? ` · 连续 ${stats.streak} 天` : ''}
              {habitSummary.total > 0 ? ` · 习惯 ${habitSummary.done}/${habitSummary.total}` : ''}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2 text-xs">
            <button
              onClick={() => setMakerOpen((v) => !v)}
              className="rounded-lg border border-neutral-200 px-2.5 py-1 text-neutral-600 transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-violet-500"
            >
              🎴 建卡
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
              建卡
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
                ['⏎ / 空格', '概览：开始复习；复习中：翻面 / 按「良好」'],
                ['1…9（概览）', '打勾第 N 个习惯'],
                ['A（概览）', '添加习惯'],
                ['1 / 2 / 3 / 4', '重来 / 困难 / 良好 / 简单'],
                ['H', '看提示'],
                ['E', '就地编辑（Ctrl+Enter 保存）'],
                ['O', '打开来源笔记（vault 外则复制路径）'],
                ['S', '搁置这张'],
                ['U', '撤销上一次评分（5 秒内）'],
                ['N', '建卡（AI / 手写 / 取材挖空）'],
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

        {phase === 'overview' && (
          <div className="space-y-4">
            <section className="rounded-2xl border border-neutral-200/80 bg-white p-4 dark:border-neutral-800/80 dark:bg-neutral-900/40">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">🎴 复习</span>
                {total > 0 ? (
                  <>
                    <span className="text-sm text-neutral-500 dark:text-neutral-400">
                      {total} 张到期
                      {truncated && `（共 ${dueTotal} 张，今天先过 ${cap}）`}
                    </span>
                    <button
                      onClick={start}
                      className="ml-auto rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110"
                    >
                      开始复习 <kbd className="ml-1 text-[10px] opacity-80">⏎</kbd>
                    </button>
                  </>
                ) : (
                  <span className="text-sm text-neutral-500 dark:text-neutral-400">
                    {stats && stats.total > 0
                      ? stats.next_due
                        ? `今天清完了 · 下一张 ${new Date(stats.next_due).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 到期`
                        : '今天清完了'
                      : '还没有卡片'}
                  </span>
                )}
              </div>
              {(!stats || stats.total === 0) && (
                <div className="mt-3 border-t border-neutral-200/80 pt-3 dark:border-neutral-800/80">
                  <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
                    最快的建卡方式：打开一篇笔记，选中一句话按「🎴 挖空」。不调模型，不花钱。
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setMakerOpen(true)}
                      className="rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110"
                    >
                      建第一张卡 <kbd className="ml-1 text-[10px] opacity-80">N</kbd>
                    </button>
                    <a
                      href="/notes.html"
                      className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-300"
                    >
                      去笔记页划词
                    </a>
                  </div>
                </div>
              )}
            </section>

            <HabitStrip
              ref={habits}
              onSummary={(done, total_) => setHabitSummary({ done, total: total_ })}
            />

            <SelfCheckLine />
          </div>
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
                {card.source ? (
                  isVaultSource(card.source) ? (
                    <button
                      onClick={() =>
                        window.open('/notes.html?path=' + encodeURIComponent(card.source), '_blank')
                      }
                      className="hover:text-violet-600 dark:hover:text-violet-300"
                      title={card.source}
                    >
                      ↗ 原文 <kbd className="text-[10px]">O</kbd>
                    </button>
                  ) : (
                    <button
                      onClick={() => void navigator.clipboard?.writeText(card.source)}
                      className="hover:text-violet-600 dark:hover:text-violet-300"
                      title={`${card.source}（vault 外，点击复制路径）`}
                    >
                      ⧉ {card.source.split('/').pop()} <kbd className="text-[10px]">O</kbd>
                    </button>
                  )
                ) : (
                  // pasted-text cards have nothing to re-open, but the provenance
                  // still matters when you are deciding whether to trust the card
                  card.source_label && (
                    <span className="truncate" title={card.source_label}>
                      来自 {card.source_label}
                    </span>
                  )
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
                回到今日
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


