import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarCheck, FilePlus2, MessageSquare, RotateCw } from 'lucide-react'

import CardList from './CardList'
import CardMaker from './CardMaker'
import EChart from './EChart'
import HabitStrip, { type HabitStripHandle } from './HabitStrip'
import { Markdown } from './markdown'
import PageShell from './PageShell'
import SelfCheckLine from './SelfCheckLine'
import StatTile from './StatTile'
import { api, type CardCrosscheck, type CardGrade, type CardItem, type CardStats, type Conversation, type DashboardStats, type PetEvent, type TodaySummaryRow } from './api'
import { ago } from './reltime'
import { useVoiceInput } from './voice'

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

/** `repo:` / `dir:` cards live outside the vault, where the /notes route cannot reach. */
const isVaultSource = (s: string) => !!s && !s.startsWith('repo:') && !s.startsWith('dir:')

/** 这一页的「最近」那一栏（2026-09-18 内容太少那一轮加的）。
 *
 *  三块**各自独立取、各自独立坏**：零柒的账本、最近的对话、这周的足迹。
 *  三块都读不到时整块不渲染——不摆一排 0（§4-8），也不假装这里本来就没东西。
 *
 *  **不催**：这些是「已经发生过什么」，不是「你还欠什么」（§4-1 镜子不是掌柜）。
 */
function RecentPulse() {
  const [lines, setLines] = useState<PetEvent[] | null>(null)
  const [convs, setConvs] = useState<Conversation[] | null>(null)
  const [week, setWeek] = useState<DashboardStats | null>(null)

  useEffect(() => {
    api.petFeed(6).then((r) => setLines(r.events)).catch(() => {})
    api.listConversations().then(setConvs).catch(() => {})
    api.dashboard().then(setWeek).catch(() => {})
  }, [])

  const recentConvs = (convs ?? []).slice(0, 4)
  const nar = week?.narrative
  const hasWeek = week !== null
  if (!lines?.length && !recentConvs.length && !hasWeek) return null

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1.4fr_1fr]" data-recent-pulse>
      <section className="flex flex-col gap-4">
        {lines && lines.length > 0 ? (
          <div>
            <h2 className="pb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              零柒最近说的
            </h2>
            <ul className="wb-card divide-y divide-neutral-100 px-3 dark:divide-neutral-800/70">
              {lines.map((e) => (
                <li key={e.id} className="flex items-baseline gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-600 dark:text-neutral-300">
                    {e.text}
                  </span>
                  <span className="shrink-0 text-[10px] text-neutral-400">
                    {ago(Date.parse(e.created_at) / 1000)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {recentConvs.length > 0 ? (
          <div>
            <div className="flex items-baseline justify-between pb-2">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                最近聊过
              </h2>
              <Link to="/" className="text-xs text-violet-500 hover:underline">
                去对话 →
              </Link>
            </div>
            <ul className="wb-card divide-y divide-neutral-100 px-3 dark:divide-neutral-800/70">
              {recentConvs.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/?conv=${c.id}`}
                    className="flex items-baseline gap-2 py-2 text-xs text-neutral-600 transition-colors hover:text-violet-600 dark:text-neutral-300 dark:hover:text-violet-300"
                  >
                    <span className="min-w-0 flex-1 truncate">{c.title || '（没起名）'}</span>
                    <span className="shrink-0 text-[10px] text-neutral-400">
                      {c.updated_at ? ago(Date.parse(c.updated_at) / 1000) : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {hasWeek ? (
        <section>
          <h2 className="pb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
            这一周
          </h2>
          <div className="grid grid-cols-3 gap-3">
            <StatTile
              icon={<CalendarCheck className="h-3.5 w-3.5" />}
              accent="bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"
              label="打开过"
              value={`${week.open_days_7d} 天`}
            />
            <StatTile
              icon={<MessageSquare className="h-3.5 w-3.5" />}
              accent="bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300"
              label="消息"
              value={nar?.this_week_messages ?? 0}
            />
            <StatTile
              icon={<FilePlus2 className="h-3.5 w-3.5" />}
              accent="bg-emerald-100 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300"
              label="vault 新增"
              value={nar?.today_vault_files ?? 0}
              sub="今天"
            />
          </div>
        </section>
      ) : null}
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
  // M1「讲给它听」：第二作答方式。**与 1–4 自评同一条账**（判分结果落同一条复习记录），
  // 所以它走完之后的一切（计数、出队、撤销窗口）与按一个数字没有区别。
  const [retellOpen, setRetellOpen] = useState(false)
  const [retell, setRetell] = useState('')
  const [retellBusy, setRetellBusy] = useState(false)
  // 上一条的判词：判完就翻到下一张，所以结果得**留在屏幕上**（含没跑成时的那句话）。
  const [verdict, setVerdict] = useState<{
    ok: boolean
    label: string
    missed: string[]
    hint: string
    note: string
  } | null>(null)
  const [editing, setEditing] = useState<{ front: string; back: string } | null>(null)
  const [makerOpen, setMakerOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [habitSummary, setHabitSummary] = useState({ done: 0, total: 0 })
  const [summary, setSummary] = useState<TodaySummaryRow[]>([])

  const shownAt = useRef(0)
  const requeued = useRef<Record<number, number>>({})
  const habits = useRef<HabitStripHandle>(null)

  // 录音 → 转写：与零柒面板、今日日记共用同一份实现。转写落进那个文本框，
  // **不自动提交**——判分要花钱，得让你看一眼转写对不对再按「判一下」。
  const voice = useVoiceInput(
    (t) => setRetell((prev) => (prev ? `${prev} ${t}` : t)),
    setError
  )

  const card = queue[idx] ?? null
  const total = queue.length
  const remaining = Math.max(0, total - idx)

  // PLAN2 T1：这张卡与它对应概念的对照事实。**逐张拉取**（一次本地往返 <5ms），
  // 因为它是「递到这一张的时候」才该说的一句：概念说通 ×2、可它的卡这周反复重来。
  // 与零柒气泡那句话**同一个后端函数**（`cross.py`）——真值只有一份，说法有两个落点：
  // 气泡里是它开口问「再讲一遍？」，这里是这一页提醒你「讲给它听」这个按钮就在手边。
  // 关联不上、没有落差、后端挂了 → 一律不显示（`null`），不占地方、不报错。
  const [crosscheck, setCrosscheck] = useState<CardCrosscheck | null>(null)
  const cardId = card?.id ?? 0
  useEffect(() => {
    setCrosscheck(null)
    if (!cardId) return
    let live = true
    api
      .cardCrosscheck(cardId)
      .then((x) => {
        if (live) setCrosscheck(x.contradiction ? x : null)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [cardId])

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
      api.todaySummary().then((r) => setSummary(r.rows)).catch(() => setSummary([]))
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

  /** 一次作答之后的全部收尾：计数、出队、撤销窗口、下一张。
   *
   *  **自评与重讲共用这一段**——两条入口、一条账（M1 的「双入口单账本」在前端这一侧
   *  指的也是这件事：按一个数字和讲一遍，落下来的东西与之后的动作完全一样）。
   *  定义在 `grade` 之前是必需的：两个回调的依赖数组在**渲染时**求值。 */
  const settle = useCallback(
    (g: CardGrade, ms: number, requeue: boolean) => {
      if (!card) return
      setSession((s) => ({
        again: s.again + (g === 1 ? 1 : 0),
        hard: s.hard + (g === 2 ? 1 : 0),
        good: s.good + (g === 3 ? 1 : 0),
        easy: s.easy + (g === 4 ? 1 : 0),
        ms: s.ms + ms,
      }))
      setLastAnswer({ id: card.id, at: Date.now() })

      const seen = requeued.current[card.id] ?? 0
      const again = requeue && seen < MAX_REQUEUE
      if (again) requeued.current[card.id] = seen + 1

      setShowHint(false)
      setEditing(null)
      setRetellOpen(false)
      if (idx + 1 >= queue.length && !again) {
        void finish()
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
    },
    [card, idx, queue.length, finish]
  )

  const grade = useCallback(
    async (g: CardGrade) => {
      if (!card || busy) return
      setBusy(true)
      // 自己定档了，上一条的判词就该让位（包括「判分没跑成」那句——现在有结论了）
      setVerdict(null)
      const ms = Math.round(performance.now() - shownAt.current)
      try {
        // 判分挂了退回自评时，把重讲原文带上：那一天你确实重讲了（北星指标读这一列）
        const r = await api.reviewCard(card.id, g, ms / 1000, retell.trim())
        settle(g, ms, r.requeue)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [card, busy, retell, settle]
  )

  /** 「讲给它听」→ 判一下。**判分自己落账**（服务端写的是同一条复习记录），
   *  所以这里不再调 `reviewCard`——照它回带的档位与 `requeue` 往下走就行。 */
  const judgeRetell = useCallback(async () => {
    const text = retell.trim()
    if (!card || busy || retellBusy || !text) return
    setRetellBusy(true)
    setVerdict(null)
    const ms = Math.round(performance.now() - shownAt.current)
    try {
      const r = await api.retellCard(card.id, text, ms / 1000)
      if (!r.ok) {
        // 判分没跑成 ≠ 差评：**一个字节都没写**，退回自评；原文留着，自评那次会带上它
        setVerdict({ ok: false, label: '', missed: [], hint: '', note: r.reason || '判分没跑成' })
        return
      }
      setVerdict({
        ok: true,
        label: r.label,
        missed: r.missed_points ?? [],
        hint: r.hint ?? '',
        note: '',
      })
      setRetell('')
      setRetellOpen(false)
      settle(r.grade as CardGrade, ms, !!r.card?.requeue)
    } catch (e) {
      setVerdict({
        ok: false,
        label: '',
        missed: [],
        hint: '',
        note: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setRetellBusy(false)
    }
  }, [card, busy, retellBusy, retell, settle])

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
        // the /notes route only serves vault paths; repo:/dir: cards get their path copied
        if (isVaultSource(card.source)) {
          window.open('/notes?path=' + encodeURIComponent(card.source), '_blank')
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
    <>
      <PageShell
        title="今日"
        description="复习队列 + 习惯打卡。键盘优先：每一步都有快捷键。"
        bodyClassName="space-y-4"
        stats={
          stats ? (
            <span>
              {stats.total} 张 · 今天已过 {stats.today_reviewed}
              {stats.streak > 0 ? ` · 连续 ${stats.streak} 天` : ''}
              {habitSummary.total > 0 ? ` · 习惯 ${habitSummary.done}/${habitSummary.total}` : ''}
            </span>
          ) : undefined
        }
        actions={
          <>
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
          </>
        }
      >

        {error && (
          <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">
            {error}
          </p>
        )}

        {makerOpen && (
          <section className="mb-5 wb-card p-4">
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
            {/* bento 第一行：复习 hero（7 列）+ 近 7 天柱状图（5 列）并排；
                daily 没数据时 hero 独占整行，不留一块空洞。 */}
            <div className="grid grid-cols-1 items-stretch gap-4 xl:grid-cols-12">
              <section
                className={`wb-card-hero rounded-2xl p-4 ${
                  stats && stats.daily?.length > 0 ? 'xl:col-span-7' : 'xl:col-span-12'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="wb-chip h-9 w-9 bg-white/70 text-violet-600 dark:bg-neutral-800/60 dark:text-violet-300">
                    <RotateCw className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-medium">复习</span>
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
                {stats && stats.total > 0 ? (
                  <p className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 pl-12 text-xs text-neutral-400 dark:text-neutral-500">
                    <span>今天已过 {stats.today_reviewed}</span>
                    <span>还剩 {stats.remaining_today}</span>
                    {stats.streak > 0 ? <span>连续 {stats.streak} 天</span> : null}
                    {stats.accuracy_7d != null ? <span>7 天正确率 {stats.accuracy_7d}%</span> : null}
                  </p>
                ) : null}
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
                      <Link
                        to="/notes"
                        className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-300"
                      >
                        去笔记页划词
                      </Link>
                    </div>
                  </div>
                )}
              </section>

              {/* 近 7 天的复习量：`/api/cards/stats` 的 `daily` 后端一直在算、此前一直没画——
                  这里把它摆出来。空天画 0，节奏的空白也是信息。 */}
              {stats && stats.daily?.length > 0 ? (
                <section className="wb-card p-4 xl:col-span-5">
                  <h2 className="pb-1 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                    近 7 天复习
                  </h2>
                  <p className="pb-2 text-[11px] text-neutral-400">
                    每天过的卡数 · 7 天正确率 {stats.accuracy_7d != null ? `${stats.accuracy_7d}%` : '—'}
                  </p>
                  <EChart
                    height={160}
                    ariaLabel="近 7 天复习量"
                    option={{
                      tooltip: { trigger: 'axis' },
                      grid: { left: 30, right: 8, top: 10, bottom: 24 },
                      xAxis: {
                        type: 'category',
                        data: stats.daily.map((d) => d.date.slice(5)),
                        axisTick: { show: false },
                      },
                      yAxis: { type: 'value', minInterval: 1 },
                      series: [
                        {
                          type: 'bar',
                          data: stats.daily.map((d) => d.count),
                          barMaxWidth: 22,
                          itemStyle: { borderRadius: [5, 5, 0, 0] },
                        },
                      ],
                    }}
                  />
                </section>
              ) : null}
            </div>

            {/* bento 第二行：五档概览（7 列）+ 习惯条（5 列）；概览空档时习惯条独占整行 */}
            <div className="grid grid-cols-1 items-stretch gap-4 xl:grid-cols-12">
              {summary.length > 0 && (
                <section className="wb-card px-4 py-2.5 xl:col-span-7">
                  {/* 五档概览：失败任务 > 未消化 > 到期卡 > 卡点 > 进行中产出，每行带直达。
                      空档后端就不返回，所以这里没有 0 行。和 `next_suggestion` 那句建议不同：
                      那是「说一句」，这是「有几件、在哪」——计数是让你一眼看完全局。
                      2026-09-19：计数后面补一条同色的比例条——最大的那档撑满，其余按份量排。 */}
                  <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
                    {summary.map((r) => {
                      const max = Math.max(...summary.map((x) => x.count), 1)
                      return (
                        <li key={r.key} className="flex items-center gap-3 py-2">
                          <span
                            className={`w-20 shrink-0 text-[11px] font-medium ${
                              r.tone === 'bad'
                                ? 'text-rose-600 dark:text-rose-400'
                                : r.tone === 'warn'
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-neutral-500 dark:text-neutral-400'
                            }`}
                          >
                            {r.label}
                          </span>
                          <span className="w-6 shrink-0 text-sm font-semibold tabular-nums text-neutral-700 dark:text-neutral-200">
                            {r.count}
                          </span>
                          <span className="hidden h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-100 sm:block dark:bg-neutral-800">
                            <span
                              className={`block h-full rounded-full ${
                                r.tone === 'bad'
                                  ? 'bg-rose-400'
                                  : r.tone === 'warn'
                                    ? 'bg-amber-400'
                                    : 'bg-violet-400'
                              }`}
                              style={{ width: `${Math.max((r.count / max) * 100, 4)}%` }}
                            />
                          </span>
                          <Link
                            to={r.href}
                            className="ml-auto shrink-0 rounded-lg border border-neutral-300 px-2.5 py-0.5 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800 sm:ml-3"
                          >
                            去处理 →
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )}

              <div className={summary.length > 0 ? 'xl:col-span-5' : 'xl:col-span-12'}>
                <HabitStrip
                  ref={habits}
                  onSummary={(done, total_) => setHabitSummary({ done, total: total_ })}
                />
              </div>
            </div>

            {/* 2026-09-18「内容太少」那一轮加的：这一页原来只有复习 + 习惯 + 自检三块，
                量下来整页 205 字（仪表盘是 2905 字）。补的都是**同一台机器上已经存在的
                事实**，只是以前没有一处把它们摆出来：
                  · 零柒最近说过什么（`pet_events`，与挂件那个气泡同一张表）
                  · 最近聊过什么（`/api/conversations`，与侧栏那份同一来源）
                  · 这周的足迹（打开过几天 / 消息数 / vault 新增，`/api/dashboard`）
                **每一块各自 catch**：读不到就不摆（§4-9），不摆一排 0（§4-8）。 */}
            <RecentPulse />

            <SelfCheckLine />

            {/* 卡片的清单界面（此前没有）——「事」上要能挂卡片，就得先能看见它们 */}
            <CardList />
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

            <section className="wb-card p-6">
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

            {/* PLAN2 T1：递到这一张时说破那道落差。**只陈述两边的事实**——
                不说「你其实没懂」，也不替你改任何判定（§8.2：镜子只把落差说给人听）。 */}
            {crosscheck ? (
              <p
                data-crosscheck
                title="两边的事实摆在一起，它不判谁对：哪个算数、要不要改判定，是你的事。"
                className="mt-3 text-[11px] leading-relaxed text-violet-600 dark:text-violet-300"
              >
                「{crosscheck.concept}」你说通过 {crosscheck.said_n} 次，可它的卡这周重来{' '}
                {crosscheck.again_7d} 回——讲一遍试试？
              </p>
            ) : null}

            {/* 上一条的判词。判完就翻到下一张，所以它得**留在屏幕上**——
                包括「判分没跑成」那句：那时它一个字节都没写，等你自己定档。 */}
            {verdict && (
              <div
                data-retell-verdict
                className={`mt-3 rounded-xl border px-3 py-2 text-xs leading-relaxed ${
                  verdict.ok
                    ? 'border-violet-200 bg-violet-50/60 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200'
                    : 'border-amber-200 bg-amber-50/60 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
                }`}
              >
                {verdict.ok ? (
                  <>
                    <span className="font-medium">它判：{verdict.label}</span>
                    {verdict.missed.length > 0 ? (
                      <span> · 差在「{verdict.missed.join('」「')}」</span>
                    ) : null}
                    {verdict.hint ? (
                      <span className="block pt-0.5 text-neutral-500 dark:text-neutral-400">
                        💡 {verdict.hint}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <>判分没跑成：{verdict.note} —— 你自己定一档，这段重讲照记进复习记录。</>
                )}
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {phase === 'question' ? (
                <>
                  <button
                    onClick={() => setPhase('answer')}
                    className="rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110"
                  >
                    显示答案 <kbd className="ml-1 text-[10px] opacity-70">空格</kbd>
                  </button>
                  {/* M1：第二作答方式。**在揭示答案之前**——讲得出来才算数，
                      链到的是同一条复习记录（判分自己写，界面不再调 reviewCard）。 */}
                  <button
                    data-retell-open
                    onClick={() => setRetellOpen((v) => !v)}
                    disabled={busy}
                    title="用你自己的话把它讲一遍，它对照卡片答案判一档（一次模型调用，成本就是这一次）"
                    className={`rounded-xl border px-4 py-2.5 text-sm transition-colors disabled:opacity-50 ${
                      retellOpen
                        ? 'border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500 dark:bg-violet-500/10 dark:text-violet-200'
                        : 'border-neutral-300 text-neutral-600 hover:border-violet-300 hover:text-violet-600 dark:border-neutral-600 dark:text-neutral-300 dark:hover:border-violet-500/50 dark:hover:text-violet-300'
                    }`}
                  >
                    🎤 讲给它听
                  </button>
                </>
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
                        window.open('/notes?path=' + encodeURIComponent(card.source), '_blank')
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

            {/* M1「讲给它听」：说或打字都行，判一次就走（落的是同一条复习记录）。
                录音→转写与零柒面板、今日日记共用 `voice.ts` 那一份。 */}
            {phase === 'question' && retellOpen && (
              <div
                data-retell-panel
                className="mt-3 rounded-xl border border-violet-200 bg-violet-50/40 p-3 dark:border-violet-500/30 dark:bg-violet-500/5"
              >
                <textarea
                  data-retell-text
                  value={retell}
                  onChange={(e) => setRetell(e.target.value)}
                  rows={3}
                  placeholder="用你自己的话讲一遍这张卡的答案…（说或打字都行，讲完不用自己打分）"
                  className="w-full resize-y rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    data-retell-mic
                    onClick={voice.toggle}
                    disabled={voice.transcribing || retellBusy}
                    title={voice.recording ? '停止并转写' : '说出来（faster-whisper 转写）'}
                    className="rounded-lg border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-600 transition-colors disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300"
                  >
                    {voice.transcribing ? '转写中…' : voice.recording ? '● 停止' : '🎤 说'}
                  </button>
                  <button
                    data-retell-judge
                    onClick={() => void judgeRetell()}
                    disabled={retellBusy || busy || !retell.trim()}
                    title="一次模型调用：判完它自己落同一条复习记录（成本就是这一次）"
                    className="rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3.5 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
                  >
                    {retellBusy ? '判中…' : '判一下'}
                  </button>
                  <button
                    onClick={() => setRetellOpen(false)}
                    className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                  >
                    收起
                  </button>
                  <span className="text-[11px] text-neutral-400">
                    判完就走，和按一个数字一样；判不了会退回来让你自己定
                  </span>
                </div>
              </div>
            )}
          </>
        )}

        {phase === 'summary' && (
          <section className="wb-card p-8">
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
      </PageShell>
    </>
  )
}


