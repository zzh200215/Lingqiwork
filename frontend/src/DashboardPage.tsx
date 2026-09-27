import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import AttachToThread from './AttachToThread'
import EChart from './EChart'
import { SkeletonRows } from './Skeleton'
import FeedbackButtons from './FeedbackButtons'
import MetricCard from './MetricCard'
import { useDeepLink } from './deeplink'
import {
  api,
  type AgentEvalBoard,
  type BeliefThread,
  type CalibrationBucket,
  type CardCalibration,
  type CardGapRate,
  type DashboardStats,
  type DecisionLogView,
  type DecisionOutcome,
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

  // 决策日志 + 校准分：把「判断 + 依据 + 当时的把握」在**当时**钉下来，
  // 几个月后回看才谈得上校准。这一页仍然是**拉取式**的：没有到期列表、没有队列、
  // 页面上不摆「你还欠几条」。M4 唯一的例外在别处——到点之后由零柒的气泡提**一句**
  // （`/api/decisions/witness`，一天一条、只念当时的事实），理由写在
  // `app/core/decision_log.py` 开篇：纯拉取式在 90 天这个尺度上会让这张表变成死数据。
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

  // 从「一件事」点一条判断过来（`?decision=7`）：滚到它那一条并亮一下
  useDeepLink('decision', decisions !== null)

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
    api.usageFeatures().then((r) => setUsageFeatures(r.features)).catch(() => setUsageFeatures(null))
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
    reloadDecisions()
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

          <UsageFeaturesCard rows={usageFeatures} />

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

        {/* 决策日志 + 校准分：判断要**在做出的时候**连把握一起钉下来，否则回头只会记得
            蒙对的那几次。拉取式、无提醒——回看是你自己决定何时。 */}
        {decisions && (
          <section className="wb-card p-5">
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
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
              />
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={dBasis}
                  onChange={(e) => setDBasis(e.target.value)}
                  placeholder="依据（当时凭什么这么判断）"
                  className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                />
                <input
                  value={dTopic}
                  onChange={(e) => setDTopic(e.target.value)}
                  placeholder="领域"
                  className="w-24 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
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
                  className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-xs font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
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
                    <li key={e.id} id={`decision-${e.id}`} className="rounded-md border border-neutral-100 p-3 dark:border-neutral-800">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm text-neutral-800 dark:text-neutral-100">{e.text}</span>
                        <span className="shrink-0 text-xs text-neutral-400">
                          {dayOf(e.created_at)} · 把握 {e.confidence}%
                        </span>
                      </div>
                      {e.basis ? <p className="mt-1 text-xs text-neutral-500">依据：{e.basis}</p> : null}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {e.topic ? (
                          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                            {e.topic}
                          </span>
                        ) : null}
                        <button
                          onClick={() => void reviewDecision(e.id, 'hit')}
                          className="rounded-full border border-emerald-300 px-2 py-0.5 text-xs text-emerald-700 transition-colors hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
                        >
                          应验
                        </button>
                        <button
                          onClick={() => void reviewDecision(e.id, 'miss')}
                          className="rounded-full border border-rose-300 px-2 py-0.5 text-xs text-rose-700 transition-colors hover:bg-rose-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-500/10"
                        >
                          没应验
                        </button>
                        <button
                          onClick={() => void reviewDecision(e.id, 'unclear')}
                          title="还看不出——不作数，也不进命中率的分母"
                          className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                        >
                          还说不好
                        </button>
                        <AttachToThread kind="decision" ref={String(e.id)} className="ml-auto" />
                        <button
                          onClick={() => void dropDecision(e.id)}
                          title="删掉这条"
                          className="text-xs text-neutral-400 transition-colors hover:text-rose-600"
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
                <summary className="cursor-pointer text-xs text-neutral-500">
                  已回看 {decisions.entries.filter((e) => e.outcome).length} 条
                </summary>
                <ul className="mt-2 space-y-1.5">
                  {decisions.entries
                    .filter((e) => e.outcome)
                    .map((e) => (
                      <li key={e.id} id={`decision-${e.id}`} className="flex items-baseline gap-2 text-xs">
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
                          className="ml-auto shrink-0 text-xs text-neutral-400 transition-colors hover:text-violet-600"
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
                <span className="text-xs text-neutral-400">
                  {decisions.calibration.overall.rate == null
                    ? `已回看 ${decisions.calibration.reviewed} 条 · 满 ${decisions.calibration.overall.min_sample} 条才给命中率`
                    : `全局 ${decisions.calibration.overall.hits}/${decisions.calibration.overall.hits + decisions.calibration.overall.misses}（${pct(decisions.calibration.overall.rate)}）`}
                </span>
              </div>
              {decisions.calibration.by_topic.length > 0 ? (
                <ul className="mt-1 space-y-0.5">
                  {decisions.calibration.by_topic.map((t) => (
                    <li key={t.topic} className="text-xs text-neutral-500">
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
                      <span key={b.bucket} className="text-xs text-neutral-500">
                        把握 {b.bucket}：{b.rate == null ? `样本 ${b.sample} 条` : `${b.hits}/${b.sample}（${pct(b.rate)}）`}
                      </span>
                    ))}
                </div>
              ) : null}
              {/* 可靠性曲线（2026-09-19）：≥2 档给过分时才画——一条点构成不了「曲线」，
                  也构成不了「你说的把握到底准不准」这个读法。y 轴是命中率本身，
                  对角线不画（那是「完美校准」的参考线，一画就变成考核）。 */}
              {(() => {
                const rated = decisions.calibration.by_confidence.filter(
                  (b): b is CalibrationBucket & { rate: number } => b.sample > 0 && b.rate != null
                )
                if (rated.length < 2) return null
                return (
                  <EChart
                    height={140}
                    ariaLabel="决策把握与命中率对照"
                    option={{
                      tooltip: {
                        trigger: 'axis',
                        formatter: (ps: unknown) => {
                          const p = Array.isArray(ps) ? (ps[0] as { name: string; value: number; dataIndex: number }) : null
                          if (!p) return ''
                          const b = rated[p.dataIndex]
                          return `${p.name} 把握 → ${b.hits}/${b.sample}（${pct(b.rate)}）`
                        },
                      },
                      grid: { left: 36, right: 12, top: 12, bottom: 24 },
                      xAxis: {
                        type: 'category',
                        data: rated.map((b) => b.bucket),
                        axisTick: { show: false },
                      },
                      yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
                      series: [
                        {
                          type: 'line',
                          data: rated.map((b) => Math.round((b.rate as number) * 100)),
                          symbolSize: 7,
                          lineStyle: { width: 2.5 },
                        },
                      ],
                    }}
                  />
                )
              })()}
              {decisions.calibration.reviewed === 0 ? (
                <p className="mt-1 text-xs text-neutral-400">
                  还没有回看过的判断。攒够几条再来算——一两条算不出命中率。
                </p>
              ) : null}
            </div>
          </section>
        )}

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
      className="group block rounded-lg border border-neutral-200 bg-white p-5 transition-all hover:border-violet-300 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-violet-500/40"
    >
      <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">{eyebrow}</p>
      <p className={`mt-2 bg-gradient-to-r bg-clip-text text-3xl font-bold text-transparent ${toneClasses[tone]}`}>
        {headline}
      </p>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className="mt-2 text-xs font-medium text-violet-600 dark:text-violet-400">{sub}</p>
    </Link>
  )
}

/** 北极星（PLAN §7）：周内「重讲作答 ≥1 且 消化材料 ≥1」的天数 / 7。
 *
 *  三条刻意的选择，都写在这里免得下一个人"顺手优化"掉：
 *  1. **只画曲线**：没有目标线、没有百分比、没有排名——口径原文从后端来（`rules`），
 *     界面上照抄，同一个词在两处必须是一个意思；
 *  2. **读不到就说读不到**：不给一条全零的曲线充数（零是"什么都没发生"）；
 *  3. **一句话都不催**：0 天的时候也不写「还差 N 天」「加油」——那正是这个仓库封存过的机制。
 *
 *  （导出是给测试用的：这一格的规矩都在这张卡里，见 `DashboardPage.test.tsx`。）
 */
/** 功能真实用量（CTO review #6）：账本按操作名聚合——「30 天自用窗口」的读数。
 *
 *  只摆事实：哪个功能发生过几次、烧了多少 token。零记录 ≠ 不存在——是还没被用过，
 *  裁决（留/删）等窗口结束拿数据说话。读不到（接口挂了）整卡不摆，不占位。
 */
export function UsageFeaturesCard({ rows }: { rows: UsageFeatureRow[] | null }) {
  if (rows === null) return null
  const total = rows.reduce((n, r) => n + r.spans, 0)
  return (
    <section className="wb-card p-5" data-usage-features>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">功能真实用量</h2>
        <span className="text-xs text-neutral-400">账本实测 · 全部历史</span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-xs text-neutral-400">还没有任何模型调用记录。</p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {rows.map((r) => (
            <li key={r.kind}>
              <div className="flex items-center justify-between text-xs">
                <span className="truncate font-mono text-neutral-600 dark:text-neutral-300">{r.kind}</span>
                <span className="ml-2 shrink-0 text-neutral-400">
                  {r.spans} 次 · {r.calls} 调用 · {r.tokens} tok
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all"
                  style={{ width: `${total > 0 ? Math.round((r.spans / total) * 100) : 0}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs leading-relaxed text-neutral-400">
        「30 天自用窗口」的读数：零记录的功能不是不存在，是还没被用过——裁决等数据说话。
      </p>
    </section>
  )
}

export function NorthStarCard({ n }: { n: NorthStar | null }) {
  if (!n) return null
  const today = n.days[n.days.length - 1]?.date
  return (
    <section
      data-north-star
      className="wb-card p-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">北极星</h2>
        <span data-north-star-count className="text-2xl font-bold tabular-nums text-violet-600 dark:text-violet-300">
          {/* 读不到时**不摆 0/0**：那个数会读成「七天里一天都没有」，与「没读到」是两回事 */}
          {n.readable ? `${n.counted}/${n.denominator}` : '—'}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          天：同一天里「讲了一遍」和「消化了一份」都发生过
        </span>
        <div className="flex-1" />
        <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
          {n.window.start.slice(5)} – {n.window.end.slice(5)}
        </span>
      </div>

      {!n.readable ? (
        <p data-north-star-error className="mt-2 text-xs text-rose-500">
          这条曲线现在读不出来（{n.error}）。零是「什么都没发生」，读不到是另一回事——不拿零充数。
        </p>
      ) : (
        <>
          <div className="mt-4 flex items-end gap-2">
            {n.days.map((d) => (
              <div
                key={d.date}
                data-north-star-day={d.date}
                data-counted={d.counted ? '1' : '0'}
                className="flex flex-1 flex-col items-center gap-1"
              >
                <div className="flex h-16 w-full flex-col justify-end gap-0.5">
                  <div
                    data-north-star-retell={d.retell}
                    title={`重讲作答 ${d.retell} 次`}
                    className={`w-full rounded-t ${
                      d.retell ? 'bg-violet-500' : 'bg-neutral-200 dark:bg-neutral-800'
                    }`}
                    style={{ height: d.retell ? '50%' : '6px' }}
                  />
                  <div
                    data-north-star-digested={d.digested}
                    title={`拆出 ${d.digested} 个点`}
                    className={`w-full rounded-b ${
                      d.digested ? 'bg-fuchsia-400' : 'bg-neutral-200 dark:bg-neutral-800'
                    }`}
                    style={{ height: d.digested ? '50%' : '6px' }}
                  />
                </div>
                <span
                  className={`text-xs tabular-nums ${
                    d.date === today
                      ? 'font-semibold text-violet-600 dark:text-violet-300'
                      : 'text-neutral-400 dark:text-neutral-500'
                  }`}
                >
                  {d.date.slice(5)}
                </span>
                <span className="text-xs text-violet-500">{d.counted ? '✓' : ''}</span>
              </div>
            ))}
          </div>
          {n.counted === 0 ? (
            <p data-north-star-empty className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
              这 7 天里还没有一天两件事都发生过。上面每一格的两条柱子，就是那天的两件事。
            </p>
          ) : null}
        </>
      )}

      {/* 口径与已知偏差：直接来自后端（`rules`），界面不自己编一份说法 */}
      <p data-north-star-rule className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
        「重讲」= {n.rules.retell}；「消化」= {n.rules.digested}。{n.rules.bias}
      </p>
    </section>
  )
}

const GRADE_ROWS: { g: number; label: string }[] = [
  { g: 1, label: '重来' },
  { g: 2, label: '困难' },
  { g: 3, label: '良好' },
  { g: 4, label: '简单' },
]

/** 校准曲线（PLAN2 T2 · N1）。三件事与北极星同一条纪律：
 *
 *  1. **只画分布**：不设目标线、不给百分比、不排名——差值那一格写的是「自评 − 判分 = x 档」，
 *     一个事实，不是「你高估了自己」那句判决（PLAN2 §8.5：那句话永远不说出口）；
 *  2. **读不到就说读不到**：不给两条全零的分布充数（零是「一条都没有」）；
 *  3. **一处都不催**：`n_self`/`n_judged` 是事实，不是「快去重讲几张凑样本」。
 *
 *  页脚那几行**原文来自后端**（`notes`）：历史行是未知 / 账本没存提示词版本。
 *  **第一条（判分器的基线）单独提成一行**——它说的是「这把尺子准不准」，
 *  而不是「这条曲线怎么读」：没跑过金标集时，这条曲线的**绝对值根本不成立**。
 *  最后一行把**当前判分器的指纹**摆出来——曲线是按那一版判分器算的，这一格必须看得见。
 *
 *  （导出是给测试用的，同 `NorthStarCard`：这一格的规矩都在这张卡里。）
 */
export function CalibrationCard({
  c,
  s,
}: {
  c: CardCalibration | null
  /** 会话侧那半（P2-3）：**自己标的** vs **让它判的**。没有就不显示这一段。 */
  s?: SessionCalibration | null
}) {
  if (!c) return null
  const selfMax = Math.max(1, ...Object.values(c.self_dist || {}))
  const judgedMax = Math.max(1, ...Object.values(c.judged_dist || {}))
  const empty = c.n_self === 0 && c.n_judged === 0
  // 后端把「基线」摆在 `notes[0]`（`cards.calibration` 的 `[_baseline_note(), *CALIB_NOTES]`），
  // 另外两条是常年不变的口径。这里按位置拆开：**基线单独提一行**（它说的是「这把尺子准不准」），
  // 剩下两条留在页脚。位置约定写在这里，是因为契约就在后端那一行的顺序上。
  const baseline = c.notes?.[0] ?? ''
  const notes = c.notes?.slice(1) ?? []
  return (
    <section
      data-calibration
      className="wb-card p-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">校准</h2>
        <span
          data-calibration-delta
          className="text-2xl font-bold tabular-nums text-sky-600 dark:text-sky-300"
        >
          {/* 没有对过账时不摆 0：0 读作「你和它判得一样准」，那是另一件事 */}
          {c.delta === null ? '—' : `${c.delta > 0 ? '+' : ''}${c.delta}`}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          档：自评 − 判分（正数 = 给自己打的档更高）
        </span>
        <div className="flex-1" />
        <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
          滚动 {c.days} 天 · 自评 {c.n_self} · 判分 {c.n_judged}
        </span>
      </div>

      {/* **判分器的基线**（PLAN2 P2-1）单独摆一行，不混进页脚那三条须知里。
          理由：这条曲线的 y 轴是「这台判分器判得比你严还是松」，而那句话成立与否，
          取决于它跟人对得上多少——**没跑过金标集时，这条曲线的绝对值根本不成立**。
          这是读这张卡之前必须先知道的一件事，埋在页脚第一条小字里等于没说。
          三种状态（跑过 / 跑过但是旧版 / 没跑过）全部由后端决定，这里照抄。 */}
      {baseline ? (
        <p
          data-calibration-baseline
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200"
        >
          <span className="font-medium">判分器基线</span>：{baseline}
        </p>
      ) : null}

      {!c.readable ? (
        <p data-calibration-error className="mt-2 text-xs text-rose-500">
          这条曲线现在读不出来（{c.error}）。零是「一条都没有」，读不到是另一回事——不拿零充数。
        </p>
      ) : empty ? (
        <p data-calibration-empty className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
          这 {c.days} 天里还没有可对账的行：复习一次（自评或重讲都算）就会落在这里。
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          {GRADE_ROWS.map(({ g, label }) => (
            <div key={g} className="flex items-center gap-2 text-xs">
              <span className="w-8 shrink-0 text-neutral-500 dark:text-neutral-400">{label}</span>
              <div className="h-3 flex-1 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
                <div
                  data-calibration-self={g}
                  className="h-full rounded-r bg-violet-500"
                  style={{
                    width: `${(((c.self_dist?.[g] ?? 0) / selfMax) * 100).toFixed(1)}%`,
                  }}
                  title={`自评「${label}」${c.self_dist?.[g] ?? 0} 次`}
                />
              </div>
              <span className="w-6 shrink-0 text-right tabular-nums text-neutral-400">
                {c.self_dist?.[g] ?? 0}
              </span>
              <div className="h-3 flex-1 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
                <div
                  data-calibration-judged={g}
                  className="h-full rounded-r bg-sky-500"
                  style={{
                    width: `${(((c.judged_dist?.[g] ?? 0) / judgedMax) * 100).toFixed(1)}%`,
                  }}
                  title={`判分器判「${label}」${c.judged_dist?.[g] ?? 0} 次`}
                />
              </div>
              <span className="w-6 shrink-0 text-right tabular-nums text-neutral-400">
                {c.judged_dist?.[g] ?? 0}
              </span>
            </div>
          ))}
          <p className="flex gap-3 pl-10 text-xs text-neutral-400 dark:text-neutral-500">
            <span className="text-violet-500">■ 你自评</span>
            <span className="text-sky-500">■ 判分器判</span>
          </p>
        </div>
      )}

      {/* 三条须知里剩下的两条 + 判分器指纹：原文来自后端，界面不自己编一份说法。
          第一条（基线）已经单独提到上面那一行去了，所以这里从第二条开始摆。 */}
      {notes.map((n) => (
        <p
          key={n}
          data-calibration-note
          className="mt-2 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500"
        >
          {n}
        </p>
      ))}
      {c.judge_sha ? (
        <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
          判分器指纹 <span data-calibration-sha className="font-mono">{c.judge_sha}</span>
          ——曲线是按这一版判分器算的。
        </p>
      ) : null}
      {/* 按版本分段（PLAN2 §9.4）：换过版之后这条曲线上就不是一把尺子了。
          混版那句警告由后端插在 `notes` 里（这里照抄），这一段只补**每一版各判了什么**。 */}
      {c.segments.length > 0 ? (
        <p
          data-calibration-segments
          className="mt-1 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500"
        >
          分段：
          {c.segments.map((s, i) => (
            <span key={s.sha || 'unknown'} data-calibration-segment={s.sha || ''}>
              {i > 0 ? ' · ' : ''}
              {s.current ? '本版 ' : s.sha ? `${s.sha.slice(0, 6)} ` : '版本未知 '}
              {s.n} 条
              {s.mean != null ? `（均值 ${s.mean}）` : ''}
            </span>
          ))}
        </p>
      ) : null}

      {/* 会话侧（PLAN2 P2-3）：同一张卡上的另一半——那里比的是**两个总体**（自己标的 vs
          让它判的），而不是同一批会话的对照。所以摆的是两个计数和一个差，**不摆百分比**；
          两边的样本不是同一批、样本又小，这两件事都写在下面那行口径里（后端给的原文）。 */}
      {s ? (
        <div
          data-session-calibration
          className="mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">会话侧</h3>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">说通 /（说通+半懂）</span>
            <span
              data-session-self
              className="text-lg font-bold tabular-nums text-violet-600 dark:text-violet-300"
            >
              {s.self.n ? `${s.self.dist.got}/${s.self.n}` : '—'}
            </span>
            <span className="text-xs text-neutral-400">自己标的</span>
            <span
              data-session-judged
              className="text-lg font-bold tabular-nums text-sky-600 dark:text-sky-300"
            >
              {s.judged.n ? `${s.judged.dist.got}/${s.judged.n}` : '—'}
            </span>
            <span className="text-xs text-neutral-400">让它判的</span>
            <div className="flex-1" />
            <span
              data-session-gap
              className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400"
            >
              {s.gap === null ? '差 —' : `差 ${s.gap > 0 ? '+' : ''}${s.gap}`}
            </span>
          </div>
          {!s.readable ? (
            <p data-session-error className="mt-2 text-xs text-rose-500">
              这半边现在读不出来（{s.error}）。
            </p>
          ) : null}
          <p
            data-session-rule
            className="mt-2 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500"
          >
            {s.rules.rate}。{s.rules.confound}
            {s.rules.mixed ? ` ${s.rules.mixed}` : ''}
            {s.rules.sample ? ` ${s.rules.sample}` : ''}
          </p>
        </div>
      ) : null}
    </section>
  )
}

/** 过程指标（PLAN §7.2 · 半懂率按周）。与北极星同一条红线的第二条曲线：
 *  那条说「这周动没动」，这条说「动的那部分有没有落下」。
 *
 *  三条纪律：
 *  1. **不摆百分比**（沿 §7.1 的先例）：写的是「半懂 12 / 共 27 场」，比率只在柱子高度里。
 *     一旦写成「44% 半懂」，它会立刻变成一个要压低的考核数——而压低它最省事的办法
 *     就是少标「半懂」，那正好把这个数变成假的；
 *  2. **空的一周是空的**：`rate` 为 `null` 的那一格画成一条浅灰底线、标 `—`——
 *     「这周没开过教学」与「这周全都说通了」不是一件事，也不该长得一样；
 *  3. **一处都不催**：没有目标线、没有「还差几周」，也没有「这周比上周好」的评语。
 *
 *  （导出是给测试用的，同 `NorthStarCard` / `CalibrationCard`。）
 */
export function ProcessCard({ p }: { p: ProcessMetrics | null }) {
  if (!p) return null
  const t = p.totals
  return (
    <section
      data-process
      className="wb-card p-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">半懂</h2>
        <span
          data-process-total
          className="text-2xl font-bold tabular-nums text-violet-600 dark:text-violet-300"
        >
          {/* 摆的是**两个计数**，不是百分比（见上面第 1 条） */}
          {p.readable ? `${t.half} / ${t.n}` : '—'}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          场：这 {p.window.weeks} 个自然周里标了「半懂」的 / 说通或半懂的总场次
        </span>
        <div className="flex-1" />
        <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
          {p.window.start.slice(5)} – {p.window.end.slice(5)}
        </span>
      </div>

      {!p.readable ? (
        <p data-process-error className="mt-2 text-xs text-rose-500">
          这条曲线现在读不出来（{p.error}）。零是「这周没开过教学」，读不到是另一回事——不拿零充数。
        </p>
      ) : t.n === 0 ? (
        <p data-process-empty className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
          这 {p.window.weeks} 个自然周里还没有开过教学：讲完一场、标一次「懂了 / 半懂」，这里就有格子了。
        </p>
      ) : (
        <div className="mt-4 flex items-end gap-2">
          {p.weeks.map((w) => (
            <div
              key={w.start}
              data-process-week={w.start}
              data-rate={w.rate === null ? '' : String(w.rate)}
              className="flex flex-1 flex-col items-center gap-1"
            >
              <span className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
                {w.n === 0 ? '—' : `${w.half}/${w.n}`}
              </span>
              <div className="flex h-16 w-full flex-col justify-end">
                <div
                  data-process-bar
                  title={
                    w.n === 0
                      ? '这一周没开过教学'
                      : `半懂 ${w.half} · 说通 ${w.got}（共 ${w.n} 场）`
                  }
                  className={`w-full rounded-t ${
                    w.rate === null
                      ? 'bg-neutral-200 dark:bg-neutral-800'
                      : w.is_current
                        ? 'bg-violet-500'
                        : 'bg-violet-400/70'
                  }`}
                  style={{ height: w.rate === null ? '6px' : `${Math.max(6, w.rate * 100)}%` }}
                />
              </div>
              <span
                className={`text-xs tabular-nums ${
                  w.is_current
                    ? 'font-semibold text-violet-600 dark:text-violet-300'
                    : 'text-neutral-400 dark:text-neutral-500'
                }`}
              >
                {w.start.slice(5)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 口径原文来自后端，界面不自己编一份说法 */}
      <p data-process-rule className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
        {p.rules.half}。{p.rules.useless}。{p.rules.week}
      </p>
    </section>
  )
}

/** 技能闭环（PLAN3 §6）：**试用期漏斗** + **注入命中率**。
 *
 *  与这一页别的曲线同一条红线：只摆事实——没有目标、没有排名、没有一句「继续努力」，
 *  也不进零柒嘴里。三条口径都由后端给（`rules`），界面照抄，不自己编一份说法：
 *
 *  - 漏斗三段数的是**不同单位**（被注入的次数 / 用例的条数 / 升格技能的份数），所以摆的是
 *    三个计数与一根箭头，**不摆转化率**——比率会把「一份技能被用 10 次」与「10 份各被用 1 次」
 *    读成同一件事；
 *  - 被用过那一段是**窗口内**的（每个任务只留最近 20 条运行），所以它只会变小、不会变大；
 *  - 注入那一格是**观察性差异、不是对照**（技能是因为话题相关才被注入的），而且接地分只在
 *    「开了检索 + 命中材料 + 有产出」时才有——读不到就写读不到，不补 0。
 */
export function SkillLoopCard({ s }: { s: SkillLoop | null }) {
  if (!s) return null
  const f = s.funnel
  const hit = s.injection
  const inj = hit.grounded.injected
  const plain = hit.grounded.plain
  return (
    <section
      data-skill-loop
      className="wb-card p-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">技能闭环</h2>
        <span
          data-skill-funnel-total
          className="text-2xl font-bold tabular-nums text-teal-600 dark:text-teal-300"
        >
          {f.readable ? `${f.totals.used} → ${f.totals.cases} → ${f.totals.registered}` : '—'}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          被用过（次） → 用例（条） → 升格（份）
        </span>
      </div>

      {!f.readable ? (
        <p data-skill-funnel-error className="mt-2 text-xs text-rose-500">
          这张表现在读不出来（{f.error}）。
        </p>
      ) : f.totals.skills === 0 ? (
        <p data-skill-funnel-empty className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
          还没有一份草稿：读一份材料、或在运行记录上点「读成技能」，这里就有第一行。
        </p>
      ) : (
        <ul data-skill-funnel-rows className="mt-3 space-y-1">
          {f.skills.map((r) => (
            <li
              key={r.name}
              data-skill-row={r.name}
              className="flex flex-wrap items-baseline gap-x-2 text-xs text-neutral-500 dark:text-neutral-400"
            >
              <span className="text-neutral-700 dark:text-neutral-200">{r.name}</span>
              <span className="tabular-nums">{r.used} 次</span>
              <span className="text-neutral-300 dark:text-neutral-600">·</span>
              <span className="tabular-nums">{r.cases} 条用例</span>
              <span className="text-neutral-300 dark:text-neutral-600">·</span>
              <span>
                {r.registered ? '已升格' : r.stale ? '改过、得重新量' : '还没量过'}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">带技能跑的运行</span>
          <span
            data-skill-inject-total
            className="text-lg font-bold tabular-nums text-teal-600 dark:text-teal-300"
          >
            {hit.readable ? `${hit.runs.injected} / ${hit.runs.total}` : '—'}
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            （近 {hit.days} 天，只数引擎运行）
          </span>
        </div>

        {!hit.readable ? (
          <p data-skill-inject-error className="mt-1 text-xs text-rose-500">
            这一格现在读不出来（{hit.error}）。
          </p>
        ) : hit.runs.total === 0 ? (
          <p data-skill-inject-empty className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
            近 {hit.days} 天还没有引擎运行跑过——这里暂时没有可看的对照。
          </p>
        ) : (
          <p data-skill-inject-grounded className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            接地分：带技能{' '}
            {inj.mean === null ? '读不到' : `${inj.mean}（${inj.n} 次有分）`} · 没带{' '}
            {plain.mean === null ? '读不到' : `${plain.mean}（${plain.n} 次有分）`}
          </p>
        )}

        {/* 口径原文来自后端，界面不自己编一份说法 */}
        <p data-skill-loop-rule className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
          {s.funnel_rules.window}。{s.injection_rules.bias}。{s.injection_rules.grounded}。
        </p>
      </div>
    </section>
  )
}

/** 双轨矛盾率（PLAN2 §6 · T1 的对面）。这条数是**本规划要消灭的东西**，所以这张卡的
 *  写法与别的卡正好相反：它越接近 0 越好，而这一页**绝对不许这么说**——
 *  没有目标线、没有「还差多少」、没有一句「继续努力」。只摆三个事实：分子、分母、窗口，
 *  以及「这条数在量什么」。分母为 0 时说「还没有已掌握的概念」，不摆 0%。
 *
 *  （导出是给测试用的，同 `NorthStarCard`。）
 */
export function GapRateCard({ g, a }: { g: CardGapRate | null; a?: PrereqAdoption | null }) {
  if (!g) return null
  return (
    <section
      data-gap-rate
      className="wb-card p-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">双轨</h2>
        <span
          data-gap-rate-count
          className="text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-300"
        >
          {/* 分母为 0 时不摆 0/0：那是「还没有数据」，不是「一条矛盾都没有」 */}
          {g.readable && g.denominator > 0 ? `${g.n}/${g.denominator}` : '—'}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          个已掌握的概念，名下的卡这 {g.days} 天还在重来
        </span>
        <div className="flex-1" />
        <Link
          to="/tutor"
          className="text-xs text-neutral-400 transition-colors hover:text-violet-600 dark:text-neutral-500"
        >
          去地图看每个概念 →
        </Link>
      </div>

      {!g.readable ? (
        <p data-gap-rate-error className="mt-2 text-xs text-rose-500">
          这条数现在读不出来（{g.error}）。读不到就说读不到——不拿 0 充数。
        </p>
      ) : g.denominator === 0 ? (
        <p data-gap-rate-empty className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
          还没有已掌握的概念，所以这条数现在没有分母。
        </p>
      ) : null}

      {/* 口径原文来自后端，界面不自己编一份说法；**也一个字都不催** */}
      <p
        data-gap-rate-rule
        className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500"
      >
        {g.rule}
      </p>

      {/* 回指采纳（PLAN2 §6 第三条 · T3 的对面）：拉取式功能「有没有人看」是它唯一的
          生死指标。这张卡放它是因为它和上面那条同属「两条轨之间的桥」——那条量桥通没通，
          这条量桥有没有人走。**尤其不能变成目标**：它的用途是「没人看就撤」。 */}
      {a ? (
        <div data-adoption className="mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">回指</h3>
            <span
              data-adoption-count
              className="text-lg font-bold tabular-nums text-violet-600 dark:text-violet-300"
            >
              {a.readable ? `${a.n}/${a.denominator}` : '—'}
            </span>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              张：翻过「可能缺前置」的搁置卡里，真从候选开了课的
            </span>
            <div className="flex-1" />
            <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
              近 {a.days} 天
            </span>
          </div>
          {!a.readable ? (
            <p data-adoption-error className="mt-2 text-xs text-rose-500">
              这条数现在读不出来（{a.error}）。读不到就说读不到——不拿 0 充数。
            </p>
          ) : a.denominator === 0 ? (
            <p data-adoption-empty className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
              这 {a.days} 天里还没有人翻过搁置卡的候选——所以这条数现在没有分母。
            </p>
          ) : null}
          <p
            data-adoption-rule
            className="mt-2 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500"
          >
            {a.rule} {a.bias}
          </p>
        </div>
      ) : null}
    </section>
  )
}

/** 引擎接地分（R1 · PLAN5 §3）——九条尺子里**唯一一条不是曲线而是分数**的读数。
 *
 *  它量的是「成文引擎有没有在材料之外编造」：0-5，只在「开了检索 + 命中材料 + 有产出」
 *  时才有分（`task_runs.grounded` 同一个口径）。所以**空着不是 0 分**——把两者画成一样，
 *  这张卡就会替没量过的那几次报喜（§4-8）。
 *
 *  **画成柱子，不是印一个数。** 0-5 是一个**有刻度的量**，而一个孤零零的数字
 *  ("4.25") 读不出它在刻度上的哪儿——四个引擎并排时更读不出彼此的差别。
 *  所以每一行是「名字 · 数 · **0-5 的轨道**」，柱子按 `score/5` 落位，
 *  轨道两端钉住 0 和 5（`data-grounded-scale`）。
 *
 *  **轨道上不许有目标线。** 这条最容易被下一个人"顺手加上"（画一条 4.0 的虚线
 *  看着多专业）——那会让这面墙从计量变成考核（§4-2）。柱子只回答"量到哪儿了"。
 *
 *  **警告那一格是这张卡的一半。** `engine_eval.health()` 会说「接地分全在 4.5 以上，
 *  分档压在顶部、区分度低」——一个永远读「满分」的标尺和没有标尺是一回事。
 *  所以**柱子顶到头不是好消息**：那正是「区分度低」的形状。摆它，是因为
 *  它回答的正是这张卡自己的问题：**这把尺子现在还信不信得过**。
 *
 *  红线：不设目标、不排名、不给百分比。四个引擎各摆各的分与条数，**不排座次**。
 */
export function GroundedCard({ e }: { e: EngineEvalLatest | null }) {
  // 还没读到就整块不渲染（与页面上另外五张卡同一个写法）：壳里分不清「还没读到」
  // 和「读到了但读不出来」——后者是 `readable=false` 的载荷，那才是要说出来的那一句。
  if (!e) return null
  const runs = Object.entries(e?.by_engine || {})
  const scored = runs.filter(([, r]) => r && r.grounded !== null)
  return (
    <MetricCard
      title="接地分"
      marker="data-grounded"
      headline={`${scored.length}/${runs.length}`}
      headlineNote="个引擎量到了分"
      scope="每个引擎最近一次自动分"
      readable={!!e}
      rules={e ? GROUNDED_RULES : undefined}
      // 「空」= **一个引擎都没量到分**（四个都还没跑过、或都只跑了结构判分）——
      // 这时摆一句陈述，而不是一张四行全是 `—` 的假表
      empty={scored.length === 0}
      emptyHint="还没有引擎跑过分——先在设置页跑一遍 golden set，之后才有得比。"
    >
      <ul className="mt-4 space-y-2.5">
        {runs.map(([engine, r]) => {
          const score = r && r.grounded !== null ? r.grounded : null
          return (
            <li key={engine} data-grounded-row={engine}>
              <div className="flex items-baseline gap-2">
                <span className="w-16 shrink-0 truncate text-xs font-medium text-neutral-700 dark:text-neutral-200">
                  {engine}
                </span>
                {/* 没跑过 / 这次只跑了结构判分 → 摆 —，**不补一个 0 分** */}
                <span
                  data-grounded-score={engine}
                  className={`w-12 shrink-0 text-right text-sm font-semibold tabular-nums ${
                    score === null
                      ? 'text-neutral-300 dark:text-neutral-600'
                      : 'text-neutral-800 dark:text-neutral-100'
                  }`}
                >
                  {score === null ? '—' : score.toFixed(2)}
                </span>
                {/* 0-5 的轨道：柱子按 score/5 落位。轨道**故意画得比柱子淡**，
                    它是刻度不是数据；没量到分时整条轨道是空的（不是半格） */}
                <div
                  data-grounded-scale={engine}
                  className="relative h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800"
                >
                  {score === null ? null : (
                    <div
                      className="h-full rounded-full bg-violet-500 dark:bg-violet-400"
                      style={{ width: `${Math.max(0, Math.min(100, (score / 5) * 100)).toFixed(1)}%` }}
                    />
                  )}
                </div>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                  {r
                    ? `用例 ${r.total}${
                        e?.coverage?.[engine] != null ? ` · 集 ${e.coverage[engine]}` : ''
                      }`
                    : '还没跑过'}
                </span>
              </div>
            </li>
          )
        })}
      </ul>

      {/* 刻度说明：**只标两端**（0 与 5），中间不画线、不设目标值。
          这句话是这张卡的关键——柱子顶到头意味着「区分度低」，不是「满分」。 */}
      <div className="mt-3 flex items-center gap-2">
        <span className="w-16 shrink-0" />
        <span className="w-12 shrink-0" />
        <div className="flex min-w-0 flex-1 justify-between text-xs tabular-nums text-neutral-300 dark:text-neutral-600">
          <span>0</span>
          <span>5</span>
        </div>
        <span className="w-24 shrink-0" />
      </div>

      {/* 标尺自己的健康度：**原文照抄后端**，界面不自己判「这算不算顶格」。
          与校准卡的基线同一套琥珀色（都是「这条读数有个前提要知道」），
          但这里不叫「基线」——它说的是这把尺子现在**量不出差别**。 */}
      {e && e.warnings.length > 0 ? (
        <ul
          data-grounded-warnings
          className="mt-3 space-y-1 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/20"
        >
          {e.warnings.map((w) => (
            <li key={w} className="text-xs leading-relaxed text-amber-800 dark:text-amber-200">
              {w}
            </li>
          ))}
        </ul>
      ) : null}
    </MetricCard>
  )
}

/** 接地分那张卡的口径。**不是从后端来的**（`engine_eval` 没有 rules 字段），
 *  所以只有这一处能写——它必须与 `core/engine_eval.py` 开篇那两句一致，改那边就改这里。 */
const GROUNDED_RULES: Record<string, string> = {
  score: '0-5，量的是「有没有在材料之外编造」：材料之外的编造扣分，「材料里没有」**明说出来的算有据**',
  empty:
    '只在「开了检索 + 命中材料 + 有产出」时才有分——空着不是 0 分（那是「这次没量」，不是「这次编了」）',
  selfcheck:
    '柱子顶到头不是好消息：一个永远读满分的标尺和没有标尺是一回事，所以上面那几句是标尺自己的体检结论',
}

/** 回合读数（R1 · PLAN5 §3）——聊天那条路上跑过的回合，各毛病几例。
 *
 *  **它接的是「为什么不落盘」那个缺口**（W5 的诊断工具）。上墙时只做一件事：
 *  把**计数**摆出来。**没有成功率、没有趋势箭头**——`turn_trace` 是诊断工具，
 *  不是考核仪表；一列数一旦有了分母，下一个人就会去算比率、去追。所以：
 *  `turns` 摆出来只是让那些计数有个参照，**不是让人除的**。
 *
 *  **柱子量的是「这一类占了多少轮」，不是「有多严重」。** 四类毛病之间没有可比性
 *  （「慢」和「声称存了没存」不是一回事），所以这里**不排序、不加权、不给分**——
 *  柱子只让你一眼看出「哪一类是主要的」，剩下的判断留给人。
 *
 *  只摆**有过的**毛病：一屏十二格全是 0 读起来像「什么都没发生」，
 *  而这里要回答的是「最近有没有出毛病」。
 */
export function TurnSummaryCard({ t }: { t: TurnSummary | null }) {
  if (!t) return null // 还没读到就整块不渲染（见 `GroundedCard` 那条注）
  const counts = t?.counts || {}
  const labels = new Map((t?.filters || []).map((f) => [f.key, f]))
  const hits = Object.entries(counts).filter(([, n]) => n > 0)
  // 柱子的分母是**窗口里的回合数**：这样柱长读作「这类毛病占了这些轮里的多少」
  const span = Math.max(1, t?.turns ?? 1)
  return (
    <MetricCard
      title="回合读数"
      marker="data-turn-summary"
      headline={`${t?.turns ?? 0}`}
      headlineNote="个回合里，有这些毛病"
      scope={t ? `近 ${t.days} 天` : ''}
      // **判可读性要读 `t.readable`，不是 `!!t`**：读不到时后端照样回一个对象
      // （`readable=false` + 一排 0 + 那句错误），`!!t` 于是是 true——
      // 于是这张卡会把「读不出来」渲染成一屏 0，正好是它该防的那件事。
      readable={t?.readable ?? false}
      // 错误原话要**原样带出去**：不带的话壳只会说「原因没给出来」，
      // 而读不到时那句话就是唯一的线索（与 `calibration` / `north-star` 同一个规矩）
      error={t?.error}
      rules={t?.rules}
      // 「空」只在**读到了、但这个窗口里一轮都没有**时成立。读不到是另一回事：
      // 那种情况由壳摆那句「读不出来」，不是摆「还没有聊过天」——
      // 后者会把「读不到」说成一个具体的事实（§4-8 的同一个道理，换了个方向）。
      empty={!!t && t.readable && t.turns === 0}
      emptyHint={t ? `这 ${t.days} 天里还没有聊过天——所以这条路上一轮都没有。` : ''}
    >
      {hits.length === 0 ? (
        <p data-turn-summary-clean className="mt-3 text-xs text-neutral-400 dark:text-neutral-500">
          这 {t?.turns} 轮里，上面那几类毛病一例都没有。
        </p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {hits.map(([key, n]) => (
            <li key={key} data-turn-count={key}>
              <div className="flex items-baseline gap-2">
                <span className="w-32 shrink-0 truncate text-xs text-neutral-700 dark:text-neutral-200">
                  {labels.get(key)?.label ?? key}
                </span>
                <span
                  data-turn-count-n={key}
                  className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100"
                >
                  {n}
                </span>
                <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                  <div
                    className="h-full rounded-full bg-rose-400 dark:bg-rose-500/80"
                    style={{ width: `${Math.min(100, (n / span) * 100).toFixed(1)}%` }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                  /{t?.turns}
                </span>
              </div>
              {/* 每一类的判据就是它自己的 hint（与筛选按钮同一份文案），不另立说法 */}
              <p className="mt-0.5 pl-0 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                {labels.get(key)?.hint ?? ''}
              </p>
            </li>
          ))}
        </ul>
      )}

      {t && t.truncated ? (
        <p data-turn-summary-truncated className="mt-3 text-xs text-amber-700 dark:text-amber-300">
          只数到最近 {t.turns} 轮（窗口里其实有 {t.total} 轮）——这个数是窗口的**下界**，
          不是全量。
        </p>
      ) : null}
    </MetricCard>
  )
}

/** 材料使用率（P3 · 接地闭环）——「这一轮注入了 5 条、模型真用了几条」。
 *
 *  **为什么值得上墙**：它是线上唯一一条**最便宜**的检索质量反馈。离线那一套
 *  （golden set / hit@k / MRR）要人专门跑一轮；而这两个数每一轮聊天都在落账本，连续几轮
 *  「注入了 N 条、一条没引用」就是检索质量往下走最早的那个信号（答案还在说人话，
 *  只是不再引材料了）。
 *
 *  **为什么摆两个计数、不摆一个使用率**（与 `TurnSummaryCard` 同一条红线）：一列数一旦有了
 *  分母，下一个人就会去算比率、去比较、去追——而这个模块是诊断工具，不是考核仪表。
 *  更硬的一条理由是**分母本身选不出来**：没检索的回合（闲聊跳过、RAG 关）注入就是 0，
 *  把它算进分母等于拿「没检索」当「检索了没人用」。所以后端给的是
 *  `turns_with_material / injected / cited / uncited_turns` 四个事实，比率要读的人自己心算。
 */
export function SourceUsageCard({ t }: { t: TurnSummary | null }) {
  if (!t) return null // 还没读到就整块不渲染（见 `GroundedCard` 那条注）
  const src = t?.sources
  const turns = src?.turns_with_material ?? 0
  return (
    <MetricCard
      title="材料使用率"
      marker="data-source-usage"
      headline={`${src?.cited ?? 0}/${src?.injected ?? 0}`}
      headlineNote="条材料被正文引用到（引用 / 注入）"
      // 判可读性读 `t.readable`，不是 `!!t`：读不到时后端照样回一个对象
      // （`readable=false` + 一排 0 + 那句错误）——`!!t` 会把「读不出来」渲染成一屏 0，
      // 正好是它该防的那件事。
      readable={t?.readable ?? false}
      error={t?.error}
      rules={t?.rules}
      // 「空」只在**读到了、但窗口里没有一轮注入过材料**时成立（读不到由壳摆「读不出来」）
      empty={!!t && t.readable && turns === 0}
      emptyHint={t ? `这 ${t.days} 天里没有一轮注入过材料（要么没检索，要么检索没命中）。` : ''}
    >
      <ul className="mt-4 space-y-2.5">
        <li data-source-count="turns" className="flex items-baseline gap-2">
          <span className="w-32 shrink-0 text-xs text-neutral-700 dark:text-neutral-200">
            注入过材料的回合
          </span>
          <span className="text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
            {turns}
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            / 这 {t?.days} 天共 {t?.turns ?? 0} 轮
          </span>
        </li>
        <li data-source-count="injected" className="flex items-baseline gap-2">
          <span className="w-32 shrink-0 text-xs text-neutral-700 dark:text-neutral-200">
            一共注入
          </span>
          <span className="text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
            {src?.injected ?? 0}
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">条材料</span>
        </li>
        <li data-source-count="cited" className="flex items-baseline gap-2">
          <span className="w-32 shrink-0 text-xs text-neutral-700 dark:text-neutral-200">
            被正文引用到
          </span>
          <span className="text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
            {src?.cited ?? 0}
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            条（同一份引用两次只算一次）
          </span>
        </li>
        {/* 这一行是这一格真正的用处：**毛病的个数，不是一个比率**。
            给 0 也不涂绿——它只是一条事实（红了就成了 KPI）。 */}
        <li data-source-count="uncited" className="flex items-baseline gap-2">
          <span className="w-32 shrink-0 text-xs text-neutral-700 dark:text-neutral-200">
            一条都没引用的
          </span>
          <span
            data-source-uncited
            className="text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100"
          >
            {src?.uncited_turns ?? 0}
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            轮（有材料却一次没引——检索质量下滑最早的那个信号）
          </span>
        </li>
      </ul>
      {/* 口径从后端原文照抄（与筛选按钮、与逐条清单同一份说法），不自己编一份 */}
      <p className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
        {t?.rules?.sources ?? ''}
      </p>
    </MetricCard>
  )
}

/** 提示词评测（R1 补齐 · PLAN5 §2-2 点名的九条之一）——九条里最后补上的一格。
 *
 *  **它量的是「尺子本身有没有被量过」，不是「哪条提示词更好」。** 与接地分同族
 *  （资产指标）：登记表里那些提示词，跑过 golden set 的有几条、量出来的结论站得住的
 *  又有几条——回答的是「提示词这一层到底有没有基线」。
 *
 *  **这一格最容易变成排行榜**（后端 `prompt_eval.cards()` 本来就是按分数倒序排的，
 *  那是给小屋的技能卡用的），所以三层都堵住：
 *  1. 后端载荷里**没有一条提示词的名字或分数**（`board()` 只给计数）；
 *  2. 这里只摆计数——**不排序、不给条形图**：条形一比长短，它立刻就成了排名；
 *  3. 空态说的是「一条都还没跑过，去哪跑」，不是「你还差 N 条」。
 */
export function PromptEvalCard({ p }: { p: PromptEvalBoard | null }) {
  if (!p) return null // 还没读到就整块不渲染（见 `GroundedCard` 那条注）
  const rows = [
    {
      key: 'decidable',
      label: '下得了结论',
      n: p?.decidable ?? 0,
      hint: 'Wilson 区间够窄的那些——样本小的时候区间很宽，那是真相不是 bug',
    },
    {
      key: 'stale',
      label: '分数已过期',
      n: p?.stale ?? 0,
      hint: '基线跑完之后内容又改过（sha 变了）：那个分数不是现在这一版的',
    },
    {
      key: 'cases',
      label: '跑过的用例',
      n: p?.cases ?? 0,
      hint: '有成绩的那些提示词一共跑过多少条 golden set 用例',
    },
  ]
  return (
    <MetricCard
      title="提示词评测"
      marker="data-prompt-eval"
      headline={`${p?.measured ?? 0}/${p?.registered ?? 0}`}
      headlineNote="条量过（跑过 golden set）"
      // 判可读性读 `p.readable`，不是 `!!p`：读不到时后端照样回一个对象（同一个坑，
      // 回合读数那张卡踩过一次——见它上面那段注释）
      readable={p?.readable ?? false}
      error={p?.error}
      rules={p?.rules}
      bias={p?.bias}
      // 「空」只在读到了、但一条都没跑过时成立；读不到是另一回事（§4-8）
      empty={!!p && p.readable && p.measured === 0}
      emptyHint={
        p
          ? `登记表里 ${p.registered} 条提示词，一条都还没跑过 golden set——去提示词实验室跑一遍，这里就有数了。`
          : ''
      }
    >
      <ul className="mt-4 space-y-2.5">
        {rows.map((r) => (
          <li key={r.key} className="flex items-baseline gap-3" data-prompt-eval-row={r.key}>
            <span className="w-24 shrink-0 text-xs text-neutral-700 dark:text-neutral-200">
              {r.label}
            </span>
            <span
              {...{ [`data-prompt-eval-${r.key}`]: '' }}
              className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100"
            >
              {r.n}
            </span>
            <span className="min-w-0 flex-1 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
              {r.hint}
            </span>
          </li>
        ))}
      </ul>
      {/* 这一句是这一格的**结论**：没有它，那三个数会被读成「还有多少没做」 */}
      <p className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
        这一格数的是「尺子有没有被量过」，不是「哪条提示词更好」——所以这里不摆任何一条的名字或分数。
      </p>
    </MetricCard>
  )
}

/**
 * 任务级基线（A0 · `Agent升级.md` §5 点名的「进计量局」那一笔）。
 *
 * **这一格读的是「跑分当时」的成绩**，所以标题行必须带两样东西：什么时候跑的（`at`）、
 * 跑的是哪一版金标（`tasks_sha`）。金标改过（A4 就加了一条任务）之后指纹会变，
 * 那时这格里的数**仍然是真的，只是旧了**——`--compare` 会如实报「不可比」，
 * 界面不替它下结论（红线：运行时不许碰金标，指纹归尺子算）。
 */
export function AgentEvalCard({ p }: { p: AgentEvalBoard | null }) {
  if (!p) return null // 还没读到就整块不渲染（见 `GroundedCard` 那条注）
  const rounds = p.rounds
  const rows = [
    {
      key: 'done',
      label: '办成',
      value: p.done != null ? `${p.done}/${p.tasks ?? 0}` : '—',
      hint: '该落盘的落了、该拒的拒了（完成率不含轮数——轮数是成本，完成是结果）',
    },
    {
      key: 'clean',
      label: '干净',
      value: p.clean != null ? `${p.clean}/${p.tasks ?? 0}` : '—',
      hint: '办成了、而且一条规矩都没破（含工具越界与超预算）',
    },
    {
      key: 'floor',
      label: '底线失守',
      value: `${p.floor_failures ?? 0}`,
      hint: '谎报 / 编造路径 / 伪引用——这三条之外的不算底线（长文没落盘单列）',
    },
    {
      key: 'tool',
      label: '工具越界',
      value: `${p.tool_not_allowed ?? 0} · 该用的没用 ${p.tool_not_used ?? 0}`,
      hint: '用了白名单外的工具 · 该查材料却一次都没查',
    },
    {
      key: 'rounds',
      label: '轮数',
      value: rounds ? `中位 ${rounds.median} · p90 ${rounds.p90} · 均值 ${rounds.mean}` : '—',
      hint: '成本基线：A1 的 delegate 要压的就是它',
    },
    {
      key: 'delegate',
      label: '该委托而没委托',
      value: `${p.delegate_missed ?? 0}/${p.delegate_expected ?? 0}`,
      hint: '委托名额用了几个——**能力有没有被用上**，不是失败',
    },
  ]
  return (
    <MetricCard
      title="任务级基线"
      marker="data-agent-eval"
      headline={p.done_rate != null ? `${Math.round(p.done_rate * 100)}%` : '—'}
      headlineNote={`办成率（${p.tasks ?? 0} 条任务）`}
      // 判可读性读 `p.readable`，不是 `!!p`：读不到时后端照样回一个对象（同一个坑）
      readable={p.readable}
      error={p.error}
      rules={p.rules}
      empty={p.readable && (p.tasks ?? 0) === 0}
      emptyHint="报告在，但里面一条任务都没有——那多半是跑分那一轮没跑成，重跑一次。"
    >
      <ul className="mt-4 space-y-2.5">
        {rows.map((r) => (
          <li key={r.key} className="flex items-baseline gap-3" data-agent-eval-row={r.key}>
            <span className="w-28 shrink-0 text-xs text-neutral-700 dark:text-neutral-200">
              {r.label}
            </span>
            <span
              {...{ [`data-agent-eval-${r.key}`]: '' }}
              className="w-40 shrink-0 text-right text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100"
            >
              {r.value}
            </span>
            <span className="min-w-0 flex-1 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
              {r.hint}
            </span>
          </li>
        ))}
      </ul>
      {/* **这一行是这一格最重要的东西**：它读的是哪一版、什么时候跑的那一版 */}
      <p
        data-agent-eval-stamp
        className="mt-3 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500"
      >
        {p.at ? `跑于 ${p.at}` : '报告里没写时间'}
        {p.model_id ? ` · 模型 ${p.model_id}` : ''}
        {p.tasks_sha ? ` · 金标指纹 ${p.tasks_sha}` : ''}
        {p.sha_missing ? '（报告里没有指纹，这一格比不了）' : ''}
        {'——金标改过之后要重跑才有新数；拿它跟新报告比，尺子会如实说「不可比」。'}
      </p>
    </MetricCard>
  )
}