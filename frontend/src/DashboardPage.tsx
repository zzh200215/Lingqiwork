import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import EChart from './EChart'
import { SkeletonRows } from './Skeleton'
import FeedbackButtons from './FeedbackButtons'
import {
  api,
  type AgentEvalBoard,
  type BeliefThread,
  type CardCalibration,
  type CardGapRate,
  type DashboardStats,
  type EngineEvalLatest,
  type JournalRecent,
  type NorthStar,
  type PrereqAdoption,
  type ProcessMetrics,
  type PromptEvalBoard,
  type SkillLoop,
  type SessionCalibration,
  type TurnSummary,
  type TutorStats,
  type UsageFeatureRow,
} from './api'
import DashboardDecisions from './DashboardDecisions'
import {
  monthOf,
  NarrativeCard,
  UsageFeaturesCard,
  NorthStarCard,
  CalibrationCard,
  ProcessCard,
  SkillLoopCard,
  GapRateCard,
} from './dashboardCards'
import { GroundedCard, TurnSummaryCard, SourceUsageCard, PromptEvalCard, AgentEvalCard } from './dashboardEvalCards'
import { streamRecap, type RecapReport, type RecapSaved, type ReportDraft } from './stream'
import { useVoiceInput } from './voice'

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

  // 北极星（PLAN §7）：周内「重讲作答 ≥1 且 消化材料 ≥1」的天数 / 7。
  // **只画曲线**——不设目标、不排名、不进零柒嘴里（红线在 `core/metrics.py` 开篇）；
  // 读不到就照实说读不到，不给一条全零的曲线充数。
  const [north, setNorth] = useState<NorthStar | null>(null)

  // 功能真实用量（CTO review #6）：账本按操作名聚合——「30 天自用窗口」的读数。
  // 同一条红线：只摆事实，不设目标、不排名、不催。
  const [usageFeatures, setUsageFeatures] = useState<UsageFeatureRow[] | null>(null)
  // 方向 4 的第二只读：各页打开过的天数——只读面不跑模型，没这个信号就是盲区
  const [pageOpens, setPageOpens] = useState<Record<string, number> | null>(null)

  // 过程指标（PLAN §7.2）：半懂率按周。与北极星同一张红线的另一条曲线——
  // 那条说「这周动没动」，这条说「动的那部分有没有落下」。
  const [process, setProcess] = useState<ProcessMetrics | null>(null)

  // 校准曲线（PLAN2 T2）：自评的档位分布 vs 判分器判的档位分布。与北极星同一条红线——
  // **只进仪表盘**，不设目标、不排名、不进零柒嘴里（口径与三条须知在后端 `cards.calibration`，
  // 界面照抄）。它量的是「你 vs 这台判分器」的相对差：判分器本身还没有基线。
  const [calib, setCalib] = useState<CardCalibration | null>(null)

  // 双轨矛盾率（PLAN2 §6）：已掌握的概念里，名下的卡这些天还在重来的占多少。
  // 同一张红线的第三条：**只进仪表盘**。它降说明桥通了——所以它尤其不能变成目标。
  const [gap, setGap] = useState<CardGapRate | null>(null)
  // 回指采纳（PLAN2 §6 第三条）：搁置卡的候选有没有人看。挂在「双轨」那张卡的下半部分。
  const [adoption, setAdoption] = useState<PrereqAdoption | null>(null)
  // PLAN3 §6：技能闭环那两条（试用期漏斗 + 注入命中率）——与别的曲线同一条红线，只画不动嘴
  const [skillLoop, setSkillLoop] = useState<SkillLoop | null>(null)

  // R1（PLAN5 §3）：九条尺子补齐到这一页。接地分是**唯一一条分数**（不是曲线），
  // 回合读数是 W5 那个诊断账本的聚合——两者与别的曲线同一条红线：只进仪表盘，不进零柒嘴里。
  const [grounded, setGrounded] = useState<EngineEvalLatest | null>(null)
  const [turnSummary, setTurnSummary] = useState<TurnSummary | null>(null)
  // R1 补齐（PLAN5 §2-2 点名的九条之一）：提示词评测——登记的那些提示词里量过几条。
  // 它是**资产指标**（尺子自己准不准），所以与接地分摆在一起。
  const [promptBoard, setPromptBoard] = useState<PromptEvalBoard | null>(null)
  // A0 任务级基线：读的是「跑分当时」那份报告（`.at` / `tasks_sha` 会写在卡片上）
  const [agentBoard, setAgentBoard] = useState<AgentEvalBoard | null>(null)

  // 会话侧校准（PLAN2 P2-3）：自己标的 vs 让它判的。挂在同一张「校准」卡的下半部分。
  const [sessionCalib, setSessionCalib] = useState<SessionCalibration | null>(null)


  // 语音日记：麦克风→转写→可编辑→落盘 vault/journal（复用聊天页的录制链路）
  const [journalView, setJournalView] = useState<JournalRecent | null>(null)
  const [journalText, setJournalText] = useState('')
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
  // 录音 → 转写：实现搬去了 `voice.ts`，三处共用。拆出两个名字是为了 JSX 不用改。
  const voice = useVoiceInput(
    (t) => setJournalText((prev) => (prev ? `${prev} ${t}` : t)),
    setJournalMsg
  )
  const { recording, transcribing } = voice

  const refreshJournal = useCallback(() => {
    api.journalRecent().then(setJournalView).catch(() => {})
  }, [])

  useEffect(() => {
    api.dashboard().then(setStats).catch((e) => setError(String(e)))
    // swallowed on purpose: the dashboard must never blank out over one endpoint
    api.tutorStats().then(setTutor).catch(() => {})
    api.beliefThreads().then((r) => setBeliefs(r.threads)).catch(() => {})
    api.northStar().then(setNorth).catch(() => setNorth(null))
    api.usageFeatures()
      .then((r) => {
        setUsageFeatures(r.features)
        setPageOpens(r.page_opens ?? {})
      })
      .catch(() => setUsageFeatures(null))
    api.process().then(setProcess).catch(() => setProcess(null))
    api.cardCalibration().then(setCalib).catch(() => setCalib(null))
    api.cardGapRate().then(setGap).catch(() => setGap(null))
    api.prereqAdoption().then(setAdoption).catch(() => setAdoption(null))
    api.skillLoop().then(setSkillLoop).catch(() => setSkillLoop(null))
    // R1 补的两条：与其他读数一样，**一条挂掉不许拖垮整页**（增强不挡路，§4-9）
    api.engineEvalLatest().then(setGrounded).catch(() => setGrounded(null))
    api.turnSummary().then(setTurnSummary).catch(() => setTurnSummary(null))
    // R1 补齐的第三条（PLAN5 §2-2 点名的九条里最后补上的一格）：同一个规矩
    api.promptEvalBoard().then(setPromptBoard).catch(() => setPromptBoard(null))
    api.agentEvalBoard().then(setAgentBoard).catch(() => setAgentBoard(null))
    api.tutorCalibration().then(setSessionCalib).catch(() => setSessionCalib(null))
    refreshJournal()
    void refreshBriefing()
  }, [refreshBriefing, refreshJournal])

  function toggleJournalMic() {
    voice.toggle()
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

  // 近 7 天的 token 消耗：`/api/dashboard` 一直在返回 `daily_tokens`，此前从来没有
  // 一处把它画出来（页面上只有一个累计总数）——补上这条曲线，花钱的节奏才看得见。
  const tokenDays: { label: string; tokens: number }[] = []
  if (stats?.daily_tokens?.length) {
    const byDate = new Map(stats.daily_tokens.map((d) => [d.date, d.tokens]))
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const utc = d.toISOString().slice(0, 10)
      tokenDays.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, tokens: byDate.get(utc) ?? 0 })
    }
  }

  const totalModel = stats?.top_models.reduce((s, x) => s + x.count, 0) || 1

  const tokTotal = stats?.tokens_total ?? 0
  const tokTotalText =
    tokTotal >= 1_000_000 ? `${(tokTotal / 1_000_000).toFixed(1)}M` : tokTotal >= 1000 ? `${(tokTotal / 1000).toFixed(1)}K` : `${tokTotal}`

  const ts = stats?.task_stats
  const taskRate = ts?.rate != null ? Math.round(ts.rate * 100) : null

  return (
    <>
      <div className="mx-auto max-w-[1600px] px-6 py-6">
        <section className="wb-card-hero relative overflow-hidden rounded-lg p-6">
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
                  <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-xs dark:bg-violet-900/60">缓存</span>
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
                  className="rounded-full wb-btn-ghost px-2.5 py-0.5"
                >
                  {rcBusy ? '复盘中…' : rc || rcMsg ? '收起' : '📋 复盘一下'}
                </button>
                {rcMsg && <span className="text-neutral-500">{rcMsg}</span>}
              </div>
            </div>
          </div>
        </section>

        {(rc || rcDraft || rcSaved) && (
          <section className="mt-5 rounded-lg border border-violet-200/70 bg-white/70 p-5 dark:border-violet-500/20 dark:bg-neutral-900/50">
            <div className="mb-3 flex items-center gap-2">
              <span>📋</span>
              <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                {(rc ?? rcDraft)?.title || '复盘'}
              </h2>
              {rcSaved && (
                <span className="ml-auto text-xs text-neutral-400">
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

        {/* 读数那九条：**宽屏两列**（2026-09-18 版面改版）。
            以前是一条条竖着堆，1600px 的宽度里每张卡都只用到一半——留白不该用来撑版面。
            `items-start` 是必要的：不写的话同一行两张卡会被拉到一样高，内容少的那张
            底下就空一块（正是这次要治的毛病）。 */}
        <div className="grid items-start gap-5 xl:grid-cols-2">
          <NorthStarCard n={north} />

          <ProcessCard p={process} />

          <CalibrationCard c={calib} s={sessionCalib} />

          <GapRateCard g={gap} a={adoption} />

          <SkillLoopCard s={skillLoop} />

          {/* R1（PLAN5 §3）：九条尺子的最后两条落在「资产指标」这一段——它们量的是
              「这台机器的零件还准不准」（引擎接地分、聊天回合的毛病），
              上面那几条量的是「你这周走得怎么样」。顺序照 R1 的布局：北极星在顶，
              过程指标在中，资产指标在底。 */}
          <GroundedCard e={grounded} />

          {/* 提示词评测：与接地分同一族（尺子自己准不准），所以并排摆在这一段 */}
          <PromptEvalCard p={promptBoard} />

          {/* 任务级基线（A0）：与上面两张同一族——它量的是「事情交出去办成了没有」，
              所以也摆在「这台机器的零件还准不准」这一段（A0 进计量局那一笔）。 */}
          <AgentEvalCard p={agentBoard} />

          <TurnSummaryCard t={turnSummary} />

          {/* P3：材料使用率。与回合读数**同一份载荷**（`/api/dashboard/turns`），
              摆在一起是因为它们读的是同一批回合：上面那张说「哪几类毛病几例」，
              这张说「注入了多少材料、模型真用了几条」。 */}
          <SourceUsageCard t={turnSummary} />
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <section className="wb-card p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">最近 7 天</h2>
              <span className="text-xs text-neutral-400">消息数</span>
            </div>
            <div className="mt-5 flex h-32 items-end gap-2">
              {days.map((d) => {
                const h = Math.max(4, (d.count / maxCount) * 100)
                return (
                  <div key={d.date} className="group flex flex-1 flex-col items-center gap-1.5">
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
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
                      className={`text-xs ${d.isToday ? 'font-semibold text-violet-600 dark:text-violet-300' : 'text-neutral-400'}`}
                    >
                      {d.label}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>

          {tokenDays.length > 0 ? (
            <section className="wb-card p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">Token 近 7 天</h2>
                <span className="text-xs text-neutral-400">每天消耗</span>
              </div>
              <EChart
                height={128}
                className="mt-4"
                ariaLabel="近 7 天 Token 消耗"
                option={{
                  tooltip: { trigger: 'axis' },
                  grid: { left: 44, right: 8, top: 8, bottom: 22 },
                  xAxis: {
                    type: 'category',
                    data: tokenDays.map((d) => d.label),
                    axisTick: { show: false },
                  },
                  yAxis: {
                    type: 'value',
                    axisLabel: {
                      formatter: (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : `${v}`),
                    },
                  },
                  series: [
                    {
                      type: 'line',
                      data: tokenDays.map((d) => d.tokens),
                      smooth: true,
                      symbolSize: 6,
                      lineStyle: { width: 2.5 },
                      areaStyle: { opacity: 0.12 },
                    },
                  ],
                }}
              />
            </section>
          ) : null}

          <UsageFeaturesCard rows={usageFeatures} pageOpens={pageOpens} />

          <section className="wb-card p-5">
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
            ) : stats ? (
              <p className="mt-4 text-xs text-neutral-400">还没有对话记录</p>
            ) : (
              <SkeletonRows className="mt-4" rows={3} />
            )}
          </section>

          <section className="wb-card p-5">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">Token 总用量</h2>
            <p className="mt-3 bg-gradient-to-r from-sky-600 to-cyan-500 bg-clip-text text-3xl font-bold text-transparent dark:from-sky-400 dark:to-cyan-300">
              {tokTotalText}
            </p>
            <p className="mt-2 text-xs text-neutral-400">累计消耗 · 不含本地 embedding</p>
          </section>
        </div>

        {beliefs && beliefs.length > 0 && (
          <section className="wb-card p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">信念时间线</h2>
              <span className="text-xs text-neutral-400">零柒记下的事，聚出来的「你怎么变」</span>
            </div>
            <ul className="mt-4 space-y-4">
              {beliefs.map((t) => (
                <li key={t.items[0].id} className="rounded-md border border-neutral-100 p-3 dark:border-neutral-800">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">{t.label}</span>
                    <span className="shrink-0 text-xs text-neutral-400">
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

        <DashboardDecisions />

        <section className="wb-card p-5">
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
            className="mt-3 w-full resize-y rounded-md border border-neutral-200 bg-transparent px-3 py-2 text-sm leading-relaxed text-neutral-800 placeholder:text-neutral-400 focus:border-violet-400 focus:outline-none dark:border-neutral-700 dark:text-neutral-100"
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
                  <span className="shrink-0 font-mono text-xs text-neutral-400">
                    {e.date.slice(5)} {e.time}
                  </span>
                  <span className="min-w-0 truncate text-neutral-600 dark:text-neutral-300">{e.excerpt}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="wb-card p-5">
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
                    <span className="ml-3 shrink-0 truncate font-mono text-xs text-neutral-400">
                      {c.model_id} · {new Date(c.updated_at).toLocaleDateString()}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-neutral-400">
              {stats ? (
                '还没有对话，去发第一条消息吧'
              ) : (
                <SkeletonRows className="mt-3" rows={2} />
              )}
            </p>
          )}
        </section>

        <section className="wb-card p-5">
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
                      <span className="shrink-0 rounded-full bg-rose-50 px-2 py-0.5 text-xs text-rose-600 dark:bg-rose-950/60 dark:text-rose-300">
                        上次失败
                      </span>
                    )}
                  </span>
                  <span className="ml-3 shrink-0 font-mono text-xs text-neutral-400">
                    {t.trigger_kind === 'watch'
                      ? `📁 ${t.watch_path || 'vault'}`
                      : `${t.cron} · 下次 ${t.next_run ? t.next_run.slice(5, 16).replace('T', ' ') : '—'}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-neutral-400">
              {stats ? (
                '还没有启用的定时任务，可在设置页创建'
              ) : (
                <SkeletonRows className="mt-3" rows={2} />
              )}
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

// 方向 6 第五刀（2026-09-29）：指标卡与评估卡拆到 dashboardCards / dashboardEvalCards，
// 决策日志节拆到 DashboardDecisions（自含状态与取数）。
// 下面这些名字从本文件导出是给测试用的（DashboardPage.test.tsx 只测卡），路径不变。
export { UsageFeaturesCard, NorthStarCard, CalibrationCard, ProcessCard, SkillLoopCard, GapRateCard } from './dashboardCards'
export { GroundedCard, TurnSummaryCard, SourceUsageCard, PromptEvalCard, AgentEvalCard } from './dashboardEvalCards'