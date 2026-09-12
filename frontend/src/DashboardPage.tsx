import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import AttachToThread from './AttachToThread'
import FeedbackButtons from './FeedbackButtons'
import {
  api,
  type BeliefThread,
  type DashboardStats,
  type DecisionLogView,
  type DecisionOutcome,
  type JournalRecent,
  type TutorStats,
} from './api'
import { streamRecap, type RecapReport, type RecapSaved, type ReportDraft } from './stream'

// 仪表盘 — 零柒视角
// 顶部 banner 用零柒 sprite + LLM 生成的今日一句话；
// 5 张叙事卡片把裸数字包成"本周你聊了 N 次 / 比上周 +X"这种说法；
// 其余图表与列表保留。
//
// 第二张卡原来是「今天到期 N 张 · 连续 N 天 · 习惯 x/y」，封存后换掉了：
// 到期数是那一版唯一还留在导航页上的债，判断标准就是它。换成「学」的记录 ——
// 已经发生过的事，没有到期，也没有未完成计数。
//
// 「📋 复盘一下」收的是：信念线 / 学习画像 / 卡点 / 日记 / 最近动过的
// 文件各管一摊，从没有一处把它们读成人话。复盘就是那一层——成文后自己落 vault/recap/
// 进索引，所以它也是知识底座的一部分（下次教学取材能捞到）。

/** 复盘正文 → markdown。刻意不引 CodeBlock：复盘是散文，仪表盘不该为它背上那 300KB。 */
function RecapMarkdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  )
}

function recapMarkdown(r: { sections: { heading: string; body: string }[] }): string {
  return r.sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n')
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [tutor, setTutor] = useState<TutorStats | null>(null)
  const [briefing, setBriefing] = useState<{ text: string; cached: boolean } | null>(null)
  const [briefingLoading, setBriefingLoading] = useState(true)
  const [error, setError] = useState('')

  const refreshBriefing = useCallback(async () => {
    setBriefingLoading(true)
    try {
      const b = await api.dashboardBriefing()
      setBriefing({ text: b.text, cached: b.cached })
    } catch {
      setBriefing({ text: '今天挺安静的，适合写点东西。', cached: false })
    } finally {
      setBriefingLoading(false)
    }
  }, [])

  // 信念演化时间线（记忆时间轴主题）：纯拉取式的自我观察，没有就整块不渲染
  const [beliefs, setBeliefs] = useState<BeliefThread[] | null>(null)

  // 决策日志 + 校准分：把「判断 + 依据 + 当时的把握」在**当时**钉下来，
  // 几个月后回看才谈得上校准。拉取式——没有到期、没有队列、没有提醒；
  // `outcome` 空着就是还没回看，没有任何东西会催它。
  const [decisions, setDecisions] = useState<DecisionLogView | null>(null)
  const [dText, setDText] = useState('')
  const [dBasis, setDBasis] = useState('')
  const [dTopic, setDTopic] = useState('')
  const [dConf, setDConf] = useState(70)
  const [dBusy, setDBusy] = useState(false)
  const [dMsg, setDMsg] = useState('')

  const reloadDecisions = useCallback(() => {
    api.listDecisions().then(setDecisions).catch(() => {})
  }, [])

  const addDecision = useCallback(async () => {
    const t = dText.trim()
    if (!t || dBusy) return
    setDBusy(true)
    setDMsg('')
    try {
      await api.addDecision({ text: t, basis: dBasis, topic: dTopic, confidence: dConf })
      setDText('')
      setDBasis('')
      setDTopic('')
      setDConf(70)
      reloadDecisions()
    } catch (e) {
      setDMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDBusy(false)
    }
  }, [dText, dBasis, dTopic, dConf, dBusy, reloadDecisions])

  const reviewDecision = useCallback(
    async (id: number, outcome: DecisionOutcome) => {
      setDMsg('')
      try {
        await api.reviewDecision(id, outcome)
        reloadDecisions()
      } catch (e) {
        setDMsg(e instanceof Error ? e.message : String(e))
      }
    },
    [reloadDecisions]
  )

  const dropDecision = useCallback(
    async (id: number) => {
      try {
        await api.deleteDecision(id)
        reloadDecisions()
      } catch (e) {
        setDMsg(e instanceof Error ? e.message : String(e))
      }
    },
    [reloadDecisions]
  )

  // 语音日记：麦克风→转写→可编辑→落盘 vault/journal（复用聊天页的录制链路）
  const [journalView, setJournalView] = useState<JournalRecent | null>(null)
  const [journalText, setJournalText] = useState('')
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [journalMsg, setJournalMsg] = useState('')

  // 复盘：pull-based——点它才跑，跑完自己落 vault/recap/ 并进索引
  const [rcBusy, setRcBusy] = useState(false)
  const [rc, setRc] = useState<RecapReport | null>(null)
  // 成文是流式的：draft 一帧帧来，正文边生成边渲染，`rc` 到了才算数
  const [rcDraft, setRcDraft] = useState<ReportDraft | null>(null)
  const [rcSaved, setRcSaved] = useState<RecapSaved | null>(null)
  const [rcMsg, setRcMsg] = useState('')
  const rcAbortRef = useRef<AbortController | null>(null)

  const runRecap = useCallback(async () => {
    if (rcBusy) return
    rcAbortRef.current?.abort()
    const ctl = new AbortController()
    rcAbortRef.current = ctl
    setRcBusy(true)
    setRc(null)
    setRcDraft(null)
    setRcSaved(null)
    setRcMsg('在翻你的记录…')
    try {
      const r = await streamRecap((event, data) => {
        if (event === 'sources') setRcMsg(`取到 ${(data.n as number) ?? 0} 条记录，成文中…`)
        else if (event === 'writing') setRcMsg('成文中…')
        else if (event === 'draft') {
          setRcDraft(data as unknown as ReportDraft)
          setRcMsg('')
        }
      }, ctl.signal)
      if (!r.ok || !r.report) {
        setRcMsg(r.error ?? '复盘失败')
        return
      }
      setRc(r.report)
      setRcSaved(r.saved ?? null)
      setRcMsg('')
    } catch (e) {
      setRcMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setRcBusy(false)
    }
  }, [rcBusy])

  useEffect(() => () => rcAbortRef.current?.abort(), [])

  const clearRecap = useCallback(() => {
    rcAbortRef.current?.abort()
    setRc(null)
    setRcDraft(null)
    setRcSaved(null)
    setRcMsg('')
    setRcBusy(false)
  }, [])
  const recorderRef = useRef<MediaRecorder | null>(null)
  const micChunksRef = useRef<Blob[]>([])

  const refreshJournal = useCallback(() => {
    api.journalRecent().then(setJournalView).catch(() => {})
  }, [])

  useEffect(() => {
    api.dashboard().then(setStats).catch((e) => setError(String(e)))
    // swallowed on purpose: the dashboard must never blank out over one endpoint
    api.tutorStats().then(setTutor).catch(() => {})
    api.beliefThreads().then((r) => setBeliefs(r.threads)).catch(() => {})
    reloadDecisions()
    refreshJournal()
    void refreshBriefing()
  }, [refreshBriefing, refreshJournal])

  function toggleJournalMic() {
    if (recording) {
      recorderRef.current?.stop()
      return
    }
    if (transcribing) return
    setJournalMsg('')
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        const rec = new MediaRecorder(stream)
        micChunksRef.current = []
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) micChunksRef.current.push(e.data)
        }
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop())
          setRecording(false)
          const blob = new Blob(micChunksRef.current, { type: rec.mimeType || 'audio/webm' })
          if (blob.size < 800) return // accidental tap — nothing audible
          setTranscribing(true)
          try {
            const r = await api.transcribeAudio(blob)
            if (r.text) setJournalText((prev) => (prev ? `${prev} ${r.text}` : r.text))
            else setJournalMsg('没有识别到语音内容')
          } catch (e) {
            setJournalMsg(`语音识别失败：${String(e)}`)
          } finally {
            setTranscribing(false)
          }
        }
        rec.start()
        recorderRef.current = rec
        setRecording(true)
      })
      .catch(() => setJournalMsg('无法访问麦克风 — 请检查系统/浏览器权限'))
  }

  async function saveJournal() {
    const text = journalText.trim()
    if (!text || saving) return
    setSaving(true)
    setJournalMsg('')
    try {
      const r = await api.journalAdd(text)
      setJournalText('')
      setJournalMsg(`已记下 · 今天第 ${r.count} 条`)
      refreshJournal()
    } catch (e) {
      setJournalMsg(`保存失败：${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const nar = stats?.narrative
  const thisWeek = nar?.this_week_messages ?? 0
  const prevWeek = nar?.prev_week_messages ?? 0
  const chatDelta = thisWeek - prevWeek
  const chatDeltaText =
    prevWeek === 0
      ? thisWeek > 0
        ? '本周全新'
        : '还在等第一句'
      : chatDelta > 0
        ? `比上周 +${chatDelta}`
        : chatDelta === 0
          ? '和上周持平'
          : `比上周 −${Math.abs(chatDelta)}`

  const days: { date: string; count: number; label: string; isToday: boolean }[] = []
  if (stats) {
    const byDate = new Map(stats.daily_messages.map((d) => [d.date, d.count]))
    const todayKey = new Date().toISOString().slice(0, 10)
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const utc = d.toISOString().slice(0, 10)
      days.push({ date: utc, count: byDate.get(utc) ?? 0, label: `${d.getMonth() + 1}/${d.getDate()}`, isToday: utc === todayKey })
    }
  }
  const maxCount = Math.max(1, ...days.map((d) => d.count))

  const totalModel = stats?.top_models.reduce((s, x) => s + x.count, 0) || 1

  const tokTotal = stats?.tokens_total ?? 0
  const tokTotalText =
    tokTotal >= 1_000_000 ? `${(tokTotal / 1_000_000).toFixed(1)}M` : tokTotal >= 1000 ? `${(tokTotal / 1000).toFixed(1)}K` : `${tokTotal}`

  const ts = stats?.task_stats
  const taskRate = ts?.rate != null ? Math.round(ts.rate * 100) : null

  return (
    <>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <section className="relative overflow-hidden rounded-3xl border border-neutral-200 bg-gradient-to-br from-violet-50 via-white to-fuchsia-50 p-6 shadow-sm dark:border-neutral-800 dark:from-violet-950/40 dark:via-neutral-900 dark:to-fuchsia-950/30">
          <div className="flex items-start gap-5">
            <div className="shrink-0">
              <img
                src="/pet/idle.webp"
                alt="零柒"
                className="h-20 w-20 object-contain drop-shadow"
                onError={(e) => {
                  e.currentTarget.src = '/pet-avatar.png'
                }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs font-medium text-violet-700 dark:text-violet-300">
                <span>零柒 · 今日要点</span>
                {briefing?.cached && (
                  <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] dark:bg-violet-900/60">缓存</span>
                )}
              </div>
              <p className="mt-2 text-lg font-medium leading-relaxed text-neutral-800 dark:text-neutral-100">
                {briefingLoading ? '正在看你的近况…' : briefing?.text}
              </p>
              <div className="mt-3 flex items-center gap-3 text-xs text-neutral-400">
                <span>
                  {new Date().toLocaleString('zh-CN', {
                    month: 'long',
                    day: 'numeric',
                    weekday: 'long',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <button
                  onClick={() => void refreshBriefing()}
                  className="rounded-full border border-neutral-200 px-2.5 py-0.5 transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:hover:border-violet-500 dark:hover:text-violet-300"
                >
                  换一句
                </button>
                <button
                  onClick={() => (rc || rcMsg ? clearRecap() : void runRecap())}
                  disabled={rcBusy}
                  title="把信念线 / 学习画像 / 卡点 / 日记 / 最近动过的文件读成一篇「最近」"
                  className="rounded-full border border-violet-300 px-2.5 py-0.5 text-violet-700 transition-colors hover:bg-violet-50 disabled:opacity-60 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10"
                >
                  {rcBusy ? '复盘中…' : rc || rcMsg ? '收起' : '📋 复盘一下'}
                </button>
                {rcMsg && <span className="text-neutral-500">{rcMsg}</span>}
              </div>
            </div>
          </div>
        </section>

        {(rc || rcDraft || rcSaved) && (
          <section className="mt-5 rounded-2xl border border-violet-200/70 bg-white/70 p-5 dark:border-violet-500/20 dark:bg-neutral-900/50">
            <div className="mb-3 flex items-center gap-2">
              <span>📋</span>
              <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                {(rc ?? rcDraft)?.title || '复盘'}
              </h2>
              {rcSaved && (
                <span className="ml-auto text-[11px] text-neutral-400">
                  已存到 {rcSaved.filename}（{rcSaved.chunks} 段进索引）
                </span>
              )}
            </div>
            {/* draft 先渲染（边生成边看）；来源清单与评价等 `rc` 到了再现 */}
            {rc || rcDraft ? (
              <RecapMarkdown>{recapMarkdown(rc ?? rcDraft!)}</RecapMarkdown>
            ) : null}
            {rc?.sources?.length ? (
              <details className="mt-3 text-xs text-neutral-500">
                <summary className="cursor-pointer select-none">
                  看了 {rc.sources.length} 条记录
                </summary>
                <ul className="mt-2 space-y-0.5">
                  {rc.sources.map((s) => (
                    <li key={s.n}>
                      [{s.n}] {s.title}
                      {rc.used.includes(s.n) ? ' ✓' : ''}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {rc && (
              <div className="mt-3 border-t border-violet-200/60 pt-2 dark:border-violet-500/20">
                <FeedbackButtons
                  kind="recap"
                  promptSha={rc.prompt_sha}
                  modelId={rc.model_id}
                  artifactRef={rcSaved?.filename ?? ''}
                />
              </div>
            )}
          </section>
        )}

        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
          <NarrativeCard
            tone="violet"
            eyebrow="聊天"
            headline={`${thisWeek}`}
            label="本周消息"
            sub={chatDeltaText}
            href="/"
          />
          <NarrativeCard
            tone="sky"
            eyebrow="学"
            headline={`${tutor?.sessions ?? 0}`}
            label={`近 ${tutor?.days ?? 14} 天搞懂过`}
            sub={
              tutor && tutor.sessions > 0
                ? [
                    `${tutor.got} 次说通了`,
                    tutor.got_with_recall > 0 ? `${tutor.got_with_recall} 次接上以前卡的点` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : '还没开过口'
            }
            href="/tutor"
          />
          <NarrativeCard
            tone="fuchsia"
            eyebrow="记忆"
            headline={`${stats?.memories ?? 0}`}
            label="零柒记下的事"
            sub={nar && nar.today_messages > 0 ? `今天聊了 ${nar.today_messages} 条` : '还在观察'}
            href="/settings"
          />
          <NarrativeCard
            tone="emerald"
            eyebrow="笔记"
            headline={nar ? `+${nar.today_vault_files}` : '0'}
            label="vault 今天新增"
            sub={stats ? `共 ${stats.vault_files} 篇笔记` : '加载中…'}
            href="/kb"
          />
          <NarrativeCard
            tone={ts && (ts.error ?? 0) > 0 ? 'rose' : 'sky'}
            eyebrow="任务"
            headline={taskRate != null ? `${taskRate}%` : '—'}
            label="30 天成功率"
            sub={ts ? `${ts.ok}/${ts.runs_30d} 完成` : '还没有任务记录'}
            href="/settings"
          />
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/60">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">最近 7 天</h2>
              <span className="text-xs text-neutral-400">消息数</span>
            </div>
            <div className="mt-5 flex h-32 items-end gap-2">
              {days.map((d) => {
                const h = Math.max(4, (d.count / maxCount) * 100)
                return (
                  <div key={d.date} className="group flex flex-1 flex-col items-center gap-1.5">
                    <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
                      {d.count > 0 ? d.count : ''}
                    </span>
                    <div className="w-full" style={{ height: '100%' }}>
                      <div
                        className={`w-full rounded-t-md bg-gradient-to-t transition-all ${
                          d.isToday ? 'from-violet-600 to-fuchsia-500' : 'from-violet-400/70 to-fuchsia-300/70'
                        } ${d.count ? '' : 'opacity-25'}`}
                        style={{ height: `${h}%`, minHeight: '4px', marginTop: 'auto' }}
                        title={`${d.label}: ${d.count}`}
                      />
                    </div>
                    <span
                      className={`text-[10px] ${d.isToday ? 'font-semibold text-violet-600 dark:text-violet-300' : 'text-neutral-400'}`}
                    >
                      {d.label}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/60">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">常用模型</h2>
            {stats && stats.top_models.length > 0 ? (
              <ul className="mt-4 space-y-2.5">
                {stats.top_models.map((m) => (
                  <li key={m.model_id}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate font-mono text-neutral-600 dark:text-neutral-300">{m.model_id}</span>
                      <span className="ml-2 shrink-0 text-neutral-400">{m.count}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all"
                        style={{ width: `${(m.count / totalModel) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-xs text-neutral-400">{stats ? '还没有对话记录' : '加载中…'}</p>
            )}
          </section>

          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/60">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">Token 总用量</h2>
            <p className="mt-3 bg-gradient-to-r from-sky-600 to-cyan-500 bg-clip-text text-3xl font-bold text-transparent dark:from-sky-400 dark:to-cyan-300">
              {tokTotalText}
            </p>
            <p className="mt-2 text-xs text-neutral-400">累计消耗 · 不含本地 embedding</p>
          </section>
        </div>

        {beliefs && beliefs.length > 0 && (
          <section className="mt-5 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/60">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">信念时间线</h2>
              <span className="text-xs text-neutral-400">零柒记下的事，聚出来的「你怎么变」</span>
            </div>
            <ul className="mt-4 space-y-4">
              {beliefs.map((t) => (
                <li key={t.items[0].id} className="rounded-xl border border-neutral-100 p-3 dark:border-neutral-800">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">{t.label}</span>
                    <span className="shrink-0 text-[11px] text-neutral-400">
                      {monthOf(t.first_at)} → {monthOf(t.last_at)}
                    </span>
                  </div>
                  <ol className="mt-2 space-y-1.5 border-l border-neutral-200 pl-3 dark:border-neutral-700">
                    {t.items.map((it) => (
                      <li key={it.id} className="relative text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                        <span className="absolute -left-[15px] top-[5px] h-1.5 w-1.5 rounded-full bg-violet-400" />
                        {it.content}
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 决策日志 + 校准分：判断要**在做出的时候**连把握一起钉下来，否则回头只会记得
            蒙对的那几次。拉取式、无提醒——回看是你自己决定何时。 */}
        {decisions && (
          <section className="mt-5 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/60">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">决策日志 · 校准分</h2>
              <span className="text-xs text-neutral-400">记下判断和当时的把握，回看才算得出准不准</span>
            </div>

            <div className="mt-3 space-y-2">
              <input
                value={dText}
                onChange={(e) => setDText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addDecision()
                }}
                placeholder="一条判断，例：先用 Chroma 就够了"
                className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
              />
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={dBasis}
                  onChange={(e) => setDBasis(e.target.value)}
                  placeholder="依据（当时凭什么这么判断）"
                  className="min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-3 py-1.5 text-xs outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                />
                <input
                  value={dTopic}
                  onChange={(e) => setDTopic(e.target.value)}
                  placeholder="领域"
                  className="w-24 rounded-xl border border-neutral-300 bg-white px-3 py-1.5 text-xs outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                />
                <label className="flex items-center gap-1 text-xs text-neutral-500">
                  把握
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={5}
                    value={dConf}
                    onChange={(e) => setDConf(Number(e.target.value))}
                    className="w-16 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                  %
                </label>
                <button
                  onClick={() => void addDecision()}
                  disabled={!dText.trim() || dBusy}
                  className="rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-xs font-medium text-white shadow-sm transition-all hover:brightness-110 disabled:opacity-40 disabled:shadow-none"
                >
                  记下
                </button>
              </div>
              {dMsg ? <p className="text-xs text-rose-600 dark:text-rose-400">{dMsg}</p> : null}
            </div>

            {/* 待回看：老的在前——它们最该已经见分晓 */}
            {decisions.entries.filter((e) => !e.outcome).length > 0 ? (
              <ul className="mt-4 space-y-2">
                {decisions.entries
                  .filter((e) => !e.outcome)
                  .map((e) => (
                    <li key={e.id} className="rounded-xl border border-neutral-100 p-3 dark:border-neutral-800">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm text-neutral-800 dark:text-neutral-100">{e.text}</span>
                        <span className="shrink-0 text-[11px] text-neutral-400">
                          {dayOf(e.created_at)} · 把握 {e.confidence}%
                        </span>
                      </div>
                      {e.basis ? <p className="mt-1 text-[11px] text-neutral-500">依据：{e.basis}</p> : null}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {e.topic ? (
                          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800">
                            {e.topic}
                          </span>
                        ) : null}
                        <button
                          onClick={() => void reviewDecision(e.id, 'hit')}
                          className="rounded-full border border-emerald-300 px-2 py-0.5 text-[10px] text-emerald-700 transition-colors hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
                        >
                          应验
                        </button>
                        <button
                          onClick={() => void reviewDecision(e.id, 'miss')}
                          className="rounded-full border border-rose-300 px-2 py-0.5 text-[10px] text-rose-700 transition-colors hover:bg-rose-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-500/10"
                        >
                          没应验
                        </button>
                        <button
                          onClick={() => void reviewDecision(e.id, 'unclear')}
                          title="还看不出——不作数，也不进命中率的分母"
                          className="rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                        >
                          还说不好
                        </button>
                        <AttachToThread kind="decision" ref={String(e.id)} className="ml-auto" />
                        <button
                          onClick={() => void dropDecision(e.id)}
                          title="删掉这条"
                          className="text-[10px] text-neutral-400 transition-colors hover:text-rose-600"
                        >
                          删除
                        </button>
                      </div>
                    </li>
                  ))}
              </ul>
            ) : null}

            {decisions.entries.filter((e) => e.outcome).length > 0 ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-[11px] text-neutral-500">
                  已回看 {decisions.entries.filter((e) => e.outcome).length} 条
                </summary>
                <ul className="mt-2 space-y-1.5">
                  {decisions.entries
                    .filter((e) => e.outcome)
                    .map((e) => (
                      <li key={e.id} className="flex items-baseline gap-2 text-xs">
                        <span
                          className={`shrink-0 ${
                            e.outcome === 'hit'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : e.outcome === 'miss'
                                ? 'text-rose-600 dark:text-rose-400'
                                : 'text-neutral-400'
                          }`}
                        >
                          {e.outcome === 'hit' ? '✓ 应验' : e.outcome === 'miss' ? '✗ 没应验' : '— 还说不好'}
                        </span>
                        <span className="text-neutral-600 dark:text-neutral-300">{e.text}</span>
                        <button
                          onClick={() => void reviewDecision(e.id, '')}
                          title="撤销回看，退回未回看"
                          className="ml-auto shrink-0 text-[10px] text-neutral-400 transition-colors hover:text-violet-600"
                        >
                          撤销
                        </button>
                      </li>
                    ))}
                </ul>
              </details>
            ) : null}

            <div className="mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-500">校准</span>
                <span className="text-[11px] text-neutral-400">
                  {decisions.calibration.overall.rate == null
                    ? `已回看 ${decisions.calibration.reviewed} 条 · 满 ${decisions.calibration.overall.min_sample} 条才给命中率`
                    : `全局 ${decisions.calibration.overall.hits}/${decisions.calibration.overall.hits + decisions.calibration.overall.misses}（${pct(decisions.calibration.overall.rate)}）`}
                </span>
              </div>
              {decisions.calibration.by_topic.length > 0 ? (
                <ul className="mt-1 space-y-0.5">
                  {decisions.calibration.by_topic.map((t) => (
                    <li key={t.topic} className="text-[11px] text-neutral-500">
                      {t.topic} {t.hits}/{t.hits + t.misses}（{pct(t.rate)}）
                    </li>
                  ))}
                </ul>
              ) : null}
              {/* 按信心分档才是「校准」本身：你说的把握准不准 */}
              {decisions.calibration.by_confidence.filter((b) => b.sample > 0).length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {decisions.calibration.by_confidence
                    .filter((b) => b.sample > 0)
                    .map((b) => (
                      <span key={b.bucket} className="text-[11px] text-neutral-500">
                        把握 {b.bucket}：{b.rate == null ? `样本 ${b.sample} 条` : `${b.hits}/${b.sample}（${pct(b.rate)}）`}
                      </span>
                    ))}
                </div>
              ) : null}
              {decisions.calibration.reviewed === 0 ? (
                <p className="mt-1 text-[11px] text-neutral-400">
                  还没有回看过的判断。攒够几条再来算——一两条算不出命中率。
                </p>
              ) : null}
            </div>
          </section>
        )}

        <section className="mt-5 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/60">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">语音日记</h2>
            <span className="text-xs text-neutral-400">
              说给未来的自己 · 落在 vault/journal · 今天 {journalView?.today ?? 0} 条
            </span>
          </div>
          <textarea
            value={journalText}
            onChange={(e) => setJournalText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void saveJournal()
            }}
            placeholder='点麦克风说话，或直接打字。Ctrl+Enter 保存。'
            rows={3}
            className="mt-3 w-full resize-y rounded-xl border border-neutral-200 bg-transparent px-3 py-2 text-sm leading-relaxed text-neutral-800 placeholder:text-neutral-400 focus:border-violet-400 focus:outline-none dark:border-neutral-700 dark:text-neutral-100"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={toggleJournalMic}
              disabled={transcribing}
              title={recording ? '停止录音' : '按下说话'}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-base transition-colors disabled:opacity-50 ${
                recording
                  ? 'animate-pulse border-rose-300 bg-rose-50 text-rose-600 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-300'
                  : 'border-neutral-200 text-neutral-500 hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:hover:border-violet-500 dark:hover:text-violet-300'
              }`}
            >
              {transcribing ? '…' : recording ? '⏹' : '🎤'}
            </button>
            <button
              onClick={() => void saveJournal()}
              disabled={saving || !journalText.trim()}
              className="rounded-full bg-violet-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-40"
            >
              {saving ? '保存中…' : '记下来'}
            </button>
            {journalMsg && <span className="text-xs text-neutral-500">{journalMsg}</span>}
          </div>
          {journalView && journalView.entries.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t border-neutral-100 pt-3 dark:border-neutral-800">
              {journalView.entries.slice(0, 5).map((e, i) => (
                <li key={`${e.date}-${e.time}-${i}`} className="flex items-baseline gap-2 text-xs">
                  <span className="shrink-0 font-mono text-[11px] text-neutral-400">
                    {e.date.slice(5)} {e.time}
                  </span>
                  <span className="min-w-0 truncate text-neutral-600 dark:text-neutral-300">{e.excerpt}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-5 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/60">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">最近对话</h2>
            <a href="/" className="text-xs text-violet-600 hover:underline dark:text-violet-400">
              打开对话页 →
            </a>
          </div>
          {stats && stats.recent_conversations.length > 0 ? (
            <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-800">
              {stats.recent_conversations.map((c) => (
                <li key={c.id}>
                  <a
                    href={`/?conv=${c.id}`}
                    className="group flex items-center justify-between rounded-lg px-2 py-2.5 transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                  >
                    <span className="truncate text-sm text-neutral-700 group-hover:text-violet-700 dark:text-neutral-200 dark:group-hover:text-violet-300">
                      {c.title}
                    </span>
                    <span className="ml-3 shrink-0 truncate font-mono text-[11px] text-neutral-400">
                      {c.model_id} · {new Date(c.updated_at).toLocaleDateString()}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-neutral-400">{stats ? '还没有对话，去发第一条消息吧' : '加载中…'}</p>
          )}
        </section>

        <section className="mt-5 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900/60">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              定时任务{stats && stats.tasks_total ? ` · ${stats.tasks_total} 个启用中` : ''}
            </h2>
            <Link to="/settings" className="text-xs text-violet-600 hover:underline dark:text-violet-400">
              管理任务 →
            </Link>
          </div>
          {stats && stats.tasks.length > 0 ? (
            <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-800">
              {stats.tasks.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-2 py-2.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm text-neutral-700 dark:text-neutral-200">
                      {t.mode === 'agent' ? '🤖' : t.trigger_kind === 'watch' ? '📁' : '⏰'} {t.name}
                    </span>
                    {t.last_status === 'error' && (
                      <span className="shrink-0 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] text-rose-600 dark:bg-rose-950/60 dark:text-rose-300">
                        上次失败
                      </span>
                    )}
                  </span>
                  <span className="ml-3 shrink-0 font-mono text-[11px] text-neutral-400">
                    {t.trigger_kind === 'watch'
                      ? `📁 ${t.watch_path || 'vault'}`
                      : `${t.cron} · 下次 ${t.next_run ? t.next_run.slice(5, 16).replace('T', ' ') : '—'}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-neutral-400">
              {stats ? '还没有启用的定时任务，可在设置页创建' : '加载中…'}
            </p>
          )}
        </section>

        {error && (
          <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:bg-rose-950/40 dark:text-rose-400">
            {error}
          </p>
        )}
      </div>
    </>
  )
}

// 信念时间线的月份标签：ISO 时间 → 「3月」
function monthOf(iso: string | null): string {
  if (!iso) return '?'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '?' : `${d.getMonth() + 1}月`
}

/** 0-1 → 百分比整数（校准分显示用） */
function pct(r: number): string {
  return `${Math.round(r * 100)}%`
}

/** ISO → M/D（决策日志里按天看就够） */
function dayOf(iso: string | null): string {
  if (!iso) return '?'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '?' : `${d.getMonth() + 1}/${d.getDate()}`
}

function NarrativeCard({
  tone,
  eyebrow,
  headline,
  label,
  sub,
  href,
}: {
  tone: 'violet' | 'fuchsia' | 'emerald' | 'sky' | 'rose'
  eyebrow: string
  headline: string
  label: string
  sub: string
  href: string
}) {
  const toneClasses: Record<typeof tone, string> = {
    violet: 'from-violet-600 to-fuchsia-600',
    fuchsia: 'from-fuchsia-600 to-pink-500',
    emerald: 'from-emerald-600 to-teal-500',
    sky: 'from-sky-600 to-cyan-500',
    rose: 'from-rose-600 to-orange-500',
  }
  return (
    <Link
      to={href}
      className="group block rounded-2xl border border-neutral-200 bg-white p-5 transition-all hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-md hover:shadow-violet-100/60 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-violet-500/40"
    >
      <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">{eyebrow}</p>
      <p className={`mt-2 bg-gradient-to-r bg-clip-text text-3xl font-bold text-transparent ${toneClasses[tone]}`}>
        {headline}
      </p>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className="mt-2 text-[11px] font-medium text-violet-600 dark:text-violet-400">{sub}</p>
    </Link>
  )
}