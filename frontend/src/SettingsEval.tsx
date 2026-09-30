// agents 页的观测与记忆面（方向 6 第十三刀，2026-09-30 自 SettingsPage 拆出）：
// 体检报告 / MCP 能力开放 / 模型竞技场 / 生成质量 + 自动标尺 + 回合台账 /
// 教学画像 / 长期记忆（编辑、整理、开放给外部 MCP 客户端）六张卡。
// 状态与处理器整体住在这里，挂载时并发自拉（沿用「进 agents 页才取」的语义，
// 改为每次进页取一次），失败逐项 failLoad 汇总到页级错误条。
import { Fragment, useEffect, useState } from 'react'
import { Brain, GraduationCap, HeartPulse, Plug, Star, Trophy } from 'lucide-react'
import {
  api,
  type ArenaResult,
  type EngineEvalLatest,
  type HealthReport,
  type MemoryExpose,
  type MemoryItem,
  type MemoryTidyReport,
  type QualityGroup,
  type QualitySummary,
  type TutorProfile,
} from './api'
import { fmtTime, inputCls } from './settingsShared'
import TurnLedger from './TurnLedger'

/** 四个成文引擎的展示顺序（与 core/engine_eval.ENGINES 一致）。 */
const ENGINE_ORDER = ['research', 'compose', 'recap', 'decide', 'conflict'] as const

/** S1（PLAN3 §9.2 决策4）：同一份成绩里「有注入 / 没注入 / 不知道」分开摆。
 *
 *  注入**不改变** `prompt_sha`（它是模块级常量的指纹），所以不加这一行，吃着技能和没吃
 *  技能的 👍/👎 会混成一份成绩；而聚合的 key 一个没动——表格上面那几个数还是原来那几个数。
 *
 *  **只摆非零**：一次注入都没有的那些组，这一行根本不出现（同「样本不够就不给率」的规矩）。
 *  `不知道` 与 `没注入` 是两件事：从产出清单事后点的评价落在「不知道」。
 */
export function injectSplit(g: QualityGroup): string {
  const cell = (k: 'injected' | 'plain' | 'unknown') => g.split?.[k] ?? { good: 0, bad: 0 }
  const bits: string[] = []
  for (const [key, label] of [
    ['injected', '有注入'],
    ['plain', '没注入'],
    ['unknown', '不知道'],
  ] as const) {
    const c = cell(key)
    if (c.good + c.bad > 0) bits.push(`${label} ${c.good}👍/${c.bad}👎`)
  }
  return bits.length ? `这份产出吃着技能生成的没有 —— ${bits.join(' · ')}` : ''
}

export default function SettingsEval({ failLoad }: { failLoad: (what: string, e: unknown) => void }) {
  // 体检报告 + MCP 开放复制态 + 模型竞技场
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [mcpSharedCopied, setMcpSharedCopied] = useState(false)
  const [arenaPrompt, setArenaPrompt] = useState('用三句话解释什么是闭包')
  const [arenaBusy, setArenaBusy] = useState(false)
  const [arenaResults, setArenaResults] = useState<ArenaResult[] | null>(null)
  const [arenaError, setArenaError] = useState('')
  const [quality, setQuality] = useState<QualitySummary | null>(null)

  // 自动标尺：四个引擎的 golden set 得分。它和上面的满意率共用同一个 prompt_sha，
  // 所以能回答「这版提示词是真变好了，还是只是我手滑点了赞」。
  const [engineEval, setEngineEval] = useState<EngineEvalLatest | null>(null)
  const [engineEvalBusy, setEngineEvalBusy] = useState(false)
  const [engineEvalMsg, setEngineEvalMsg] = useState('')

  // 长期记忆族（原在 refresh() 里并发拉、各自坏——这里保持同样的取数语义）
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [tutorProfile, setTutorProfile] = useState<TutorProfile | null>(null)
  const [memInput, setMemInput] = useState('')
  const [memEditId, setMemEditId] = useState<number | null>(null)
  const [memEditContent, setMemEditContent] = useState('')
  const [memMsg, setMemMsg] = useState('')
  const [memExpose, setMemExpose] = useState<MemoryExpose | null>(null)
  const [tidyBusy, setTidyBusy] = useState(false)
  const [tidyReport, setTidyReport] = useState<MemoryTidyReport | null>(null)

  useEffect(() => {
    api.healthReport().then(setHealth).catch((e) => failLoad('体检报告', e))
    api.qualitySummary().then(setQuality).catch((e) => failLoad('质量统计', e))
    api.engineEvalLatest().then(setEngineEval).catch((e) => failLoad('引擎评测', e))
    api.listMemories().then(setMemories).catch((e) => failLoad('记忆', e))
    api.tutorProfile().then(setTutorProfile).catch((e) => failLoad('教学画像', e))
    api.getMemoryTidy().then((s) => setTidyReport(s.report)).catch((e) => failLoad('记忆整理', e))
  }, [])

  // ---- persistent memory ----

  async function addMemory() {
    const content = memInput.trim()
    if (!content) return
    await api.addMemory(content)
    setMemInput('')
    setMemories(await api.listMemories())
  }

  async function removeMemory(id: number) {
    await api.deleteMemory(id)
    setMemories(await api.listMemories())
  }

  async function saveMemoryEdit() {
    if (memEditId == null) return
    const content = memEditContent.trim()
    if (!content) return
    try {
      await api.updateMemory(memEditId, content)
      setMemEditId(null)
      setMemMsg('')
      setMemories(await api.listMemories())
    } catch (e) {
      setMemMsg(`✗ ${String(e)}`)
    }
  }

  async function clearAllMemories() {
    if (!confirm('清空全部长期记忆？')) return
    await api.clearMemories()
    setMemories(await api.listMemories())
  }

  async function runTidy() {
    if (tidyBusy) return
    setTidyBusy(true)
    try {
      const report = await api.runMemoryTidy()
      setTidyReport(report)
      setMemories(await api.listMemories())
    } catch (e) {
      setTidyReport({ ok: false, error: String(e) })
    } finally {
      setTidyBusy(false)
    }
  }

  async function runEngineEval() {
    if (engineEvalBusy) return
    setEngineEvalBusy(true)
    const done: string[] = []
    let judged = true
    try {
      // 按引擎逐个跑：单个引擎几十秒到一两分钟，一次请求跑完四个既顶着超时上限，
      // 中间又没有任何进度可看。
      for (let i = 0; i < ENGINE_ORDER.length; i++) {
        const e = ENGINE_ORDER[i]
        setEngineEvalMsg(`正在跑 ${e}…（${i + 1}/${ENGINE_ORDER.length}）`)
        const r = await api.engineEvalRun(e)
        judged = judged && r.judged
        const run = r.runs[0]
        done.push(run ? `${e} 结构 ${Math.round(run.structural * 100)}%` : `${e} 跳过`)
      }
      setEngineEvalMsg(
        `跑完：${done.join(' · ')}${judged ? '' : '（没有可用模型，只跑了结构判分）'}`
      )
      setEngineEval(await api.engineEvalLatest())
    } catch (e) {
      setEngineEvalMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setEngineEvalBusy(false)
    }
  }

  async function runArena() {
    if (arenaBusy || !arenaPrompt.trim()) return
    setArenaBusy(true)
    setArenaError('')
    try {
      const r = await api.arenaRun(arenaPrompt)
      setArenaResults(r.results)
    } catch (e) {
      setArenaError(e instanceof Error ? e.message : String(e))
    } finally {
      setArenaBusy(false)
    }
  }

  return (
    <>
      {/* 体检报告：自检 + 备份 + 索引 + 任务失败 + 整理员，一页看全 */}
      <section className="mb-6 flex flex-col gap-3 wb-card p-5">
        <h2 className="flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-rose-100 text-rose-600 dark:bg-rose-400/15 dark:text-rose-300"><HeartPulse className="h-3.5 w-3.5" /></span></h2>
        {!health ? (
          <p className="text-xs text-neutral-400">正在体检…</p>
        ) : (
          <ul className="space-y-1.5 text-xs leading-relaxed">
            <li>
              {health.self.default_model_broken
                ? <span className="text-rose-600 dark:text-rose-400">⚠️ 默认模型不可用：{health.self.default_model}</span>
                : <span className="text-emerald-600 dark:text-emerald-400">✅ 默认模型 {health.self.default_model || '（未配置）'}</span>}
              {health.self.models_broken.length > 0 && (
                <span className="text-amber-600 dark:text-amber-400">
                  {' '}· 另有 {health.self.models_broken.length} 个模型探测失败
                </span>
              )}
            </li>
            <li>
              {health.self.jobs_failing.length > 0
                ? <span className="text-amber-600 dark:text-amber-400">⚠️ 后台作业连续失败：{health.self.jobs_failing.map((j) => `${j.job_id}×${j.fails}`).join('、')}</span>
                : <span className="text-emerald-600 dark:text-emerald-400">✅ 后台作业全部正常（{health.self.jobs_live}/{health.self.jobs_total} 在跑）</span>}
            </li>
            <li>
              {health.backups.count > 0
                ? <span className="text-emerald-600 dark:text-emerald-400">✅ 最近备份 {fmtTime(health.backups.latest_at)}（共 {health.backups.count} 份）</span>
                : <span className="text-amber-600 dark:text-amber-400">⚠️ 还没有备份——备份是唯一不可重建资产的安全网</span>}
            </li>
            <li>
              <span className="text-neutral-500">📚 索引：{health.kb.indexer?.chunks ?? 0} 块 / {health.kb.indexer?.files ?? 0} 个来源</span>
            </li>
            <li>
              {health.tasks_failing.length > 0
                ? <span className="text-amber-600 dark:text-amber-400">⚠️ 定时任务上次失败：{health.tasks_failing.map((t) => t.name).join('、')}</span>
                : <span className="text-emerald-600 dark:text-emerald-400">✅ 定时任务没有失败记录</span>}
            </li>
            <li>
              <span className="text-neutral-500">
                🧹 记忆整理员：{health.tidy && (health.tidy as { ran_at?: string }).ran_at
                  ? `上次整理 ${(health.tidy as { ran_at?: string }).ran_at?.slice(0, 16).replace('T', ' ')}`
                  : '还没跑过（夜间自动或手动触发）'}
              </span>
            </li>
          </ul>
        )}
      </section>

      {/* MCP server（能力开放）：把工作台的读状态开放给外部 MCP 客户端 */}
      <section className="mb-6 flex flex-col gap-3 wb-card p-5">
        <h2 className="flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"><Plug className="h-3.5 w-3.5" /></span></h2>
        <p className="text-xs leading-relaxed text-neutral-500">
          外部 MCP 客户端（Claude Desktop 等）可以连进来查你的知识库、对话/教学历史、长期记忆、学习画像和今日建议。
          端点只绑本机（127.0.0.1），且全部是<strong>读</strong>操作——外部工具看工作台，改动仍走工作台自己的界面。
        </p>
        <div className="flex items-center gap-2 text-xs">
          <code className="rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-800">{window.location.origin}/mcp</code>
          <button
            onClick={() => {
              const cfg = JSON.stringify(
                { mcpServers: { 'ai-workbench': { type: 'http', url: `${window.location.origin}/mcp` } } },
                null,
                2,
              )
              void navigator.clipboard.writeText(cfg).then(() => {
                setMcpSharedCopied(true)
                setTimeout(() => setMcpSharedCopied(false), 2000)
              })
            }}
            className="rounded-full border border-neutral-300 px-2.5 py-0.5 transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:hover:border-violet-500 dark:hover:text-violet-300"
          >
            {mcpSharedCopied ? '✓ 已复制' : '复制客户端配置'}
          </button>
        </div>
        <p className="text-xs text-neutral-400">
          工具：search_knowledge · search_history · get_user_memory · get_learning_profile · get_today_briefing
        </p>
      </section>

      {/* 模型竞技场：同一段 prompt 打到所有已启用 provider 并排对比 */}
      <section className="mb-6 flex flex-col gap-3 wb-card p-5">
        <h2 className="flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300"><Trophy className="h-3.5 w-3.5" /></span></h2>
        <p className="text-xs text-neutral-500">
          同一段话并行发给每个已启用的 provider，并排看回答、耗时和错误——也是降级链候选的检阅台。
        </p>
        <textarea
          value={arenaPrompt}
          onChange={(e) => setArenaPrompt(e.target.value)}
          rows={2}
          className="w-full resize-y rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <div>
          <button
            onClick={() => void runArena()}
            disabled={arenaBusy || !arenaPrompt.trim()}
            className="rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
          >
            {arenaBusy ? '各家思考中…' : '开始对比'}
          </button>
        </div>
        {arenaError && <p className="text-xs text-rose-600 dark:text-rose-400">{arenaError}</p>}
        {arenaResults && arenaResults.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {arenaResults.map((r) => (
              <div key={r.label} className={`rounded-lg border p-3 text-xs leading-relaxed ${
                r.ok
                  ? 'border-neutral-200 dark:border-neutral-800'
                  : 'border-rose-300 bg-rose-50 dark:border-rose-500/40 dark:bg-rose-500/10'
              }`}>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="font-mono font-medium text-neutral-700 dark:text-neutral-200">{r.label}</span>
                  <span className={r.ok ? 'text-neutral-400' : 'text-rose-600 dark:text-rose-400'}>
                    {r.ok ? `${r.seconds}s` : `失败 · ${r.seconds}s`}
                  </span>
                </div>
                <p className={`whitespace-pre-wrap ${r.ok ? 'text-neutral-600 dark:text-neutral-300' : 'text-rose-600 dark:text-rose-300'}`}>
                  {r.ok ? r.text : r.error}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 生成质量闭环：研究/产出/复盘/方案 每次成文后都能评一次，按「哪版提示词 + 哪个模型」聚合 */}
      <section className="mb-6 flex flex-col gap-3 wb-card p-5">
        <h2 className="flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300"><Star className="h-3.5 w-3.5" /></span></h2>
        <p className="text-xs text-neutral-500">
          研究 / 产出 / 复盘 / 方案 每次成文后，各自的卡片底部都有一次 👍/👎。评价按「哪版提示词 + 哪个模型」聚合——
          改过提示词或换过 provider 之后，前后两版会分开统计，不用靠感觉判断。
        </p>
        {!quality ? (
          <p className="text-xs text-neutral-400">正在统计…</p>
        ) : quality.total === 0 ? (
          <p className="text-xs text-neutral-400">还没有评价。生成一篇东西之后，卡片底部会有 👍/👎。</p>
        ) : (
          <>
            <p className="text-xs text-neutral-600 dark:text-neutral-300">
              近 {quality.days} 天评了 <b>{quality.total}</b> 次，满意率{' '}
              <b className={quality.rate >= 0.7 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                {Math.round(quality.rate * 100)}%
              </b>
              （👍 {quality.good} / 👎 {quality.bad}）
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-neutral-400">
                  <tr>
                    <th className="py-1 pr-3 font-normal">环节</th>
                    <th className="py-1 pr-3 font-normal">提示词</th>
                    <th className="py-1 pr-3 font-normal">模型</th>
                    <th className="py-1 pr-3 font-normal">满意率</th>
                    <th className="py-1 font-normal">样本</th>
                  </tr>
                </thead>
                <tbody className="text-neutral-600 dark:text-neutral-300">
                  {quality.groups.map((g) => (
                    <Fragment key={`${g.kind}-${g.prompt_sha}-${g.model_id}`}>
                      <tr className="border-t border-neutral-100 dark:border-neutral-800">
                        <td className="py-1 pr-3">{g.kind}</td>
                        <td className="py-1 pr-3 font-mono text-xs text-neutral-400">{g.prompt_sha || '—'}</td>
                        <td className="max-w-[14rem] truncate py-1 pr-3" title={g.model_id}>{g.model_id || '—'}</td>
                        <td className={`py-1 pr-3 ${g.rate >= 0.7 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                          {Math.round(g.rate * 100)}%
                        </td>
                        <td className="py-1 text-neutral-400">{g.total}</td>
                      </tr>
                      {injectSplit(g) ? (
                        // S1：**单独一行**摆「有注入 / 没注入 / 不知道」——上面那几个数一个没动
                        <tr className="border-t border-dashed border-neutral-100 dark:border-neutral-800">
                          <td colSpan={5} data-inject-split className="pb-1.5 text-xs leading-relaxed text-neutral-400">
                            {injectSplit(g)}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {quality.recent_bad.length > 0 && (
              <details className="text-xs text-neutral-500">
                <summary className="cursor-pointer select-none">
                  最近 {quality.recent_bad.length} 条差评的原因
                </summary>
                <ul className="mt-1.5 space-y-0.5">
                  {quality.recent_bad.map((b, i) => (
                    <li key={i}>
                      <span className="text-neutral-400">[{b.kind}]</span> {b.reason || '（没写原因）'}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}

        {/* 自动标尺：同一个 prompt_sha 上，除了人点的满意率，还有一份客观分。
            结构判分是确定性的（不花模型钱，秒级），接地判分要模型。 */}
        <div className="mt-1 border-t border-neutral-100 pt-3 dark:border-neutral-800">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">
              自动标尺（golden set）
            </p>
            <button
              onClick={() => void runEngineEval()}
              disabled={engineEvalBusy}
              title="在真模型上跑一遍四个引擎的 golden set：结构判分 + 接地判分"
              className="rounded-full border border-neutral-200 px-2.5 py-0.5 text-xs text-neutral-600 transition-colors hover:border-violet-400 hover:text-violet-600 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-violet-500 dark:hover:text-violet-300"
            >
              {engineEvalBusy ? '跑着…' : '跑一遍'}
            </button>
          </div>
          <p className="mt-1 text-xs text-neutral-400">
            四个引擎共用一条脊梁，提示词一改同时打穿四个——这是接住回归的那张网。结构判分不花模型钱。
          </p>
          {engineEvalMsg ? <p className="mt-1 text-xs text-neutral-500">{engineEvalMsg}</p> : null}
          {engineEval ? (
            <table className="mt-2 w-full text-left text-xs">
              <thead className="text-neutral-400">
                <tr>
                  <th className="py-1 pr-3 font-normal">引擎</th>
                  <th className="py-1 pr-3 font-normal">用例</th>
                  <th className="py-1 pr-3 font-normal">结构</th>
                  <th className="py-1 pr-3 font-normal">接地</th>
                  <th className="py-1 font-normal">提示词</th>
                </tr>
              </thead>
              <tbody className="text-neutral-600 dark:text-neutral-300">
                {ENGINE_ORDER.map((e) => {
                  const r = engineEval.by_engine[e]
                  return (
                    <tr key={e} className="border-t border-neutral-100 dark:border-neutral-800">
                      <td className="py-1 pr-3">{e}</td>
                      <td className="py-1 pr-3 text-neutral-400">{engineEval.coverage[e] ?? 0}</td>
                      <td
                        className={`py-1 pr-3 ${
                          !r ? 'text-neutral-400' : r.structural >= 1 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
                        }`}
                      >
                        {r ? `${Math.round(r.structural * 100)}%` : '未跑'}
                      </td>
                      <td
                        className={`py-1 pr-3 ${
                          r?.grounded == null ? 'text-neutral-400' : r.grounded >= 4 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
                        }`}
                      >
                        {r?.grounded == null ? '—' : `${r.grounded.toFixed(1)}/5`}
                      </td>
                      <td className="py-1 font-mono text-xs text-neutral-400">
                        {r?.prompt_sha || '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : null}
          {engineEval?.warnings?.length ? (
            <ul className="mt-1.5 space-y-0.5">
              {engineEval.warnings.map((w, i) => (
                <li key={i} className="text-xs text-amber-600 dark:text-amber-400">
                  {w}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {/* 最近回合（W5）：聊天那条路上每一轮的轮数/工具/耗时/token/落盘。
            放在满意率与自动标尺下面，因为它们是同一个问题的三个面：
            人点的、机器判的、以及**这一轮到底发生了什么**。 */}
        <TurnLedger />
      </section>

      {tutorProfile && (tutorProfile.known.length > 0 || tutorProfile.half.length > 0 || tutorProfile.preferences.length > 0) ? (
        <section className="mb-6 flex flex-col gap-2 wb-card p-5">
          <h2 className="flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"><GraduationCap className="h-3.5 w-3.5" /></span></h2>
          <p className="text-xs text-neutral-500">
            自动汇总自教学记录，注入教学提示词校准讲解深度。是派生的记录，不能手改；教学页里它会自己更新。
          </p>
          {tutorProfile.known.length > 0 ? (
            <p className="text-sm text-neutral-700 dark:text-neutral-200">
              <span className="text-neutral-400">已说通（{tutorProfile.known.length}）：</span>
              {tutorProfile.known.join('、')}
            </p>
          ) : null}
          {tutorProfile.half.length > 0 ? (
            <p className="text-sm text-neutral-700 dark:text-neutral-200">
              <span className="text-neutral-400">半懂（{tutorProfile.half.length}）：</span>
              {tutorProfile.half.join('、')}
            </p>
          ) : null}
          {tutorProfile.preferences.length > 0 ? (
            <p className="text-sm text-neutral-700 dark:text-neutral-200">
              <span className="text-neutral-400">偏好与习惯：</span>
              {tutorProfile.preferences.map((p) => p.content).join('；')}
            </p>
          ) : null}
        </section>
      ) : null}
      <section className="mb-6 flex flex-col gap-3 wb-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-pink-100 text-pink-600 dark:bg-pink-400/15 dark:text-pink-300"><Brain className="h-3.5 w-3.5" /></span></h2>
          {memories.length > 0 && (
            <button onClick={clearAllMemories} className="text-xs text-red-400 hover:text-red-600">
              清空全部
            </button>
          )}
        </div>
        <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
          模型在对话中可通过 memory_save 自动记住你的偏好与背景；开启「自动记忆」后每轮对话结束还会自主判断是否值得记住（带 🤖
          徽标）。注入对话时，记忆条数多会按当前问题相关性选取；保存时相似内容自动去重。「整理重复记忆」会把跨会话积累的近似表述交给模型合并成一条（合并前先经模型确认确为同一事实）。可编辑。
        </p>
        {memories.map((m) => (
          <Fragment key={m.id}>
            <div
              className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 px-4 py-2.5 dark:border-neutral-800"
            >
            {memEditId === m.id ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  value={memEditContent}
                  onChange={(e) => setMemEditContent(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void saveMemoryEdit()
                    } else if (e.key === 'Escape') {
                      setMemEditId(null)
                    }
                  }}
                  autoFocus
                  className={`${inputCls} flex-1`}
                />
                <button onClick={saveMemoryEdit} className="shrink-0 text-sm text-violet-600 hover:underline dark:text-violet-300">
                  保存
                </button>
                <button onClick={() => setMemEditId(null)} className="shrink-0 text-sm text-neutral-400">
                  取消
                </button>
              </div>
            ) : (
              <>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                  {m.kind && m.kind !== 'fact' && (
                    <span
                      title={
                        m.kind === 'preference'
                          ? '稳定偏好：决定口吻与推荐'
                          : m.kind === 'habit'
                            ? '周期性习惯：决定何时别打扰'
                            : '夜间反思合成的跨条目观察'
                      }
                      className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                        m.kind === 'insight'
                          ? 'bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-300'
                          : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                      }`}
                    >
                      {m.kind === 'preference' ? '偏好' : m.kind === 'habit' ? '习惯' : '洞察'}
                    </span>
                  )}
                  {m.source === 'auto' && (
                    <span
                      title="由自动记忆从对话中提取"
                      className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-600 dark:bg-violet-950 dark:text-violet-300"
                    >
                      🤖 自动
                    </span>
                  )}
                  <span className="min-w-0 truncate">{m.content}</span>
                </span>
                <div className="flex shrink-0 gap-2 text-sm">
                  <button
                    onClick={() => {
                      setMemEditId(m.id)
                      setMemEditContent(m.content)
                      setMemMsg('')
                    }}
                    className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                  >
                    编辑
                  </button>
                  <button onClick={() => removeMemory(m.id)} className="text-red-400 hover:text-red-600">
                    删除
                  </button>
                </div>
              </>
            )}
            </div>
            {/* 证据链（DeepTutor 参考项）：洞察/合并行不是凭空的——原句依据就地展开 */}
            {m.evidence && m.evidence.length > 0 ? (
              <p className="-mt-1.5 px-4 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                依据 {m.evidence.length} 条：
                {m.evidence.slice(0, 3).map((ev) => ev.text).join(' · ')}
                {m.evidence.length > 3 ? ` 等 ${m.evidence.length} 条` : ''}
              </p>
            ) : null}
          </Fragment>
        ))}
        {memMsg && <div className="text-xs text-red-500">{memMsg}</div>}
        {!memories.length && <p className="text-sm text-neutral-400">还没有记忆 — 对话中告诉模型「记住我喜欢…」试试</p>}
        <div className="flex gap-2">
          <input
            value={memInput}
            onChange={(e) => setMemInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addMemory()}
            placeholder="手动添加一条记忆，如：我常用 Python 写脚本"
            className={`${inputCls} flex-1`}
          />
          <button
            onClick={addMemory}
            disabled={!memInput.trim()}
            className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
          >
            添加
          </button>
        </div>
        {/* tidy: sleep-time consolidation */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={runTidy}
            disabled={tidyBusy || memories.length < 2}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-neutral-700"
          >
            {tidyBusy ? '整理中…' : '整理重复记忆'}
          </button>
          {tidyReport && (
            <span className="text-xs text-neutral-400">
              {tidyReport.ok
                ? tidyReport.merged
                  ? `上次整理：合并 ${tidyReport.merged} 组重复（${tidyReport.before} → ${tidyReport.after} 条）`
                  : tidyReport.message || '上次整理：没有发现可合并的重复'
                : `整理失败：${tidyReport.error || '未知错误'}`}
            </span>
          )}
        </div>
        {tidyReport?.details?.length ? (
          <details className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <summary className="cursor-pointer text-xs text-neutral-500">查看合并明细</summary>
            <ul className="mt-2 space-y-1.5">
              {tidyReport.details.map((d, i) => (
                <li key={i} className="text-xs leading-relaxed text-neutral-400">
                  {d.from.map((f, j) => (
                    <span key={j}>
                      {j > 0 && <span className="text-neutral-300 dark:text-neutral-600"> ＋ </span>}
                      {f}
                    </span>
                  ))}
                  <span className="text-violet-500"> → {d.into}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <details
          className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
          onToggle={(e) => {
            if ((e.target as HTMLDetailsElement).open && !memExpose) {
              api.getMemoryExpose().then(setMemExpose).catch((e) => failLoad('记忆开放', e))
            }
          }}
        >
          <summary className="cursor-pointer select-none text-xs font-medium text-neutral-600 dark:text-neutral-300">
            开放给其他 AI 工具（MCP）— 让 Claude Desktop / Cursor 共享这份记忆
          </summary>
          {memExpose ? (
            <div className="mt-2">
              <p className="text-xs leading-relaxed text-neutral-400">
                把下面这段加进对应客户端的 MCP 配置（如 Claude Desktop 的 claude_desktop_config.json）。走 stdio，数据全程本机。
              </p>
              <pre className="mt-2 overflow-auto rounded-md bg-neutral-50 p-3 text-xs leading-relaxed dark:bg-neutral-900">
                {memExpose.snippet_json}
              </pre>
              <button
                onClick={() => navigator.clipboard.writeText(memExpose.snippet_json)}
                className="mt-2 rounded-md border border-neutral-300 px-2.5 py-1 text-xs dark:border-neutral-700"
              >
                复制配置
              </button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-neutral-400">展开时加载…</p>
          )}
        </details>
      </section>
    </>
  )
}
