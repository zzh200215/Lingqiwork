// 决策日志 + 校准分（方向 6 第五刀，2026-09-29 自 DashboardPage 拆出）：
// 判断要**在做出的时候**连把握一起钉下来，否则回头只会记得蒙对的那几次。
// 拉取式、无提醒——回看是你自己决定何时。状态与取数自含；深链 ?decision=7 也在这里接。
import { useCallback, useState } from 'react'
import AttachToThread from './AttachToThread'
import EChart from './EChart'
import {
  api,
  type CalibrationBucket,
  type DecisionLogView,
  type DecisionOutcome,
} from './api'
import { useDeepLink } from './deeplink'
import { pct, dayOf } from './dashboardCards'

export default function DashboardDecisions() {
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

  if (!decisions) return null

  return (
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
            className="wb-btn-primary px-4 py-1.5 text-xs"
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
  )
}
