/** 工作 — 干活的一条线，三个标签：**产出**（写一份交付 + 六个引擎的成品清单）、
 *  **引擎**（工作流 + 会议，定时任务从「设置」搬来当一等对象）、**跟进**（「事」，
 *  材料与成品挂到同一件事上，`?tab=follow`）。
 *
 *  **工作流**：这条流程长什么样 / 上次跑到哪 / 为什么失败，同屏可见。每条运行带
 *  接地分（§4-10）：它是无人值守时唯一会说话的东西，「跑成功但悄悄变差」没有别的信号。
 *
 *  **产出**：六个引擎的成品落在 vault 的几个目录里（成文在 notes/，靠日期前缀分辨），
 *  这里把它们列出来、能筛、能点开。
 *
 *  **生成**：交付是唯一在这里就地生成的——其余引擎仍从各自的入口跑，成品自动落到这里。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Activity, Briefcase, Cpu, HeartPulse } from 'lucide-react'

import {
  api,
  type DeliverCatalogue,
  type JobHealth,
  type MaterialHit,
  type ScheduledTask,
  type SkillCandidateResult,
  type SkillCandidateRow,
  type SkillEvalReport,
  type SkillTrials,
  type TaskRunItem,
  type WorkMeeting,
  type WorkOutput,
} from './api'
import AttachToThread from './AttachToThread'
import EmptyHint from './EmptyHint'
import FeedbackButtons from './FeedbackButtons'
import InjectedLine from './InjectedLine'
import DispatchPanel from './DispatchPanel'
import FormPane from './FormPane'
import { useDeepLink } from './deeplink'
import { Markdown, reportMarkdown, SourceList } from './markdown'
import { KIND_BADGE } from './OutputCard'
import OutputCard from './OutputCard'
import PageShell from './PageShell'
import PromptLab from './PromptLab'
import { ago } from './reltime'
import { WORK_TABS, type WorkTab } from './routes'
import StatRow from './StatRow'
import StatTile from './StatTile'
import { streamDeliver, type DeliverReport, type ReportDraft } from './stream'
import ThreadsPage from './ThreadsPage'

/** 能力候选（环一：学习 → 工作）。一份材料 → 一份 SKILL.md 草稿。
 *
 *  两条规矩写在界面上，而不只写在代码注释里：
 *  ① **不是每份材料都能出能力** —— 出不了就直说理由，不硬凑；
 *  ② **落盘 ≠ 登记** —— 草稿没跑过对照、没有基线，所以不在这里叫它「技能」。
 */
function CapabilityCandidate() {
  const [path, setPath] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<SkillCandidateResult | null>(null)
  const [rows, setRows] = useState<SkillCandidateRow[]>([])
  const [measured, setMeasured] = useState(false)
  // S3：试用计数的窗口（每个任务只留最近 N 条运行）。界面必须把它显示出来，
  // 不许把「最近 20 次运行内被用过 3 次」写成「共 3 次」。
  const [trialWindow, setTrialWindow] = useState(0)
  const [trialName, setTrialName] = useState('')
  const [trials, setTrials] = useState<SkillTrials | null>(null)
  const [trialsBusy, setTrialsBusy] = useState(false)
  // 「量一遍」：确定性的一条路，但**会花钱**，所以按钮上写清代价（tooltip），
  // 结果里连 `calls` 一起报出来。区间太宽时不许当结论用（`tell=false`）。
  const [busyName, setBusyName] = useState('')
  const [evalRes, setEvalRes] = useState<SkillEvalReport | null>(null)
  const [evalErr, setEvalErr] = useState('')
  // 用例编辑器：**尺子得由人给**（模型自己出题自己考，考的是它会不会出题）。
  // 打开哪一份、草稿是什么、存完给一句什么话，都在这一小块里。
  const [editName, setEditName] = useState('')
  const [draft, setDraft] = useState<{ id: string; intent: string; ask: string; checks: string[] }[]>([])
  const [checks, setChecks] = useState<{ name: string; why: string }[]>([])
  const [defaultChecks, setDefaultChecks] = useState<string[]>([])
  const [casesBusy, setCasesBusy] = useState(false)
  const [casesMsg, setCasesMsg] = useState('')

  const refresh = useCallback(() => {
    api
      .listCandidates()
      .then((r) => {
        setRows(r.skills)
        setMeasured(r.measured)
        setTrialWindow(r.trial_window)
      })
      .catch(() => setRows([]))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const measure = useCallback(
    async (s: SkillCandidateRow) => {
      setBusyName(s.name)
      setEvalRes(null)
      setEvalErr('')
      try {
        const r = await api.runSkillEval(s.name)
        setEvalRes(r)
        refresh()
      } catch (e) {
        setEvalErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyName('')
      }
    },
    [refresh]
  )

  /** 把盘上那份用例读进编辑器（断言清单与默认断言**由后端给**，前端不抄一份）。 */
  const loadCases = useCallback(async (name: string) => {
    setCasesMsg('')
    try {
      const p = await api.skillCases(name)
      setChecks(p.checks)
      setDefaultChecks(p.default_checks)
      setDraft(
        p.cases.length ? p.cases : [{ id: '', intent: '', ask: '', checks: p.default_checks }]
      )
      return p
    } catch (e) {
      setCasesMsg(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [])

  /** 打开/收起某一份技能的用例编辑器：打开时把盘上那份读进来。 */
  const editCases = useCallback(
    async (name: string) => {
      if (editName === name) {
        setEditName('')
        return
      }
      setEditName(name)
      setDraft([])
      await loadCases(name)
    },
    [editName, loadCases]
  )

  /** S3：展开一份草稿的**试用记录**（派生自运行日志；点了才拉）。 */
  const openTrials = useCallback(
    async (name: string) => {
      if (trialName === name) {
        setTrialName('')
        setTrials(null)
        return
      }
      setTrialName(name)
      setTrials(null)
      setTrialsBusy(true)
      try {
        setTrials(await api.skillTrials(name))
      } catch {
        setTrials(null) // 读不到就说读不到，不编一条空记录出来
      } finally {
        setTrialsBusy(false)
      }
    },
    [trialName]
  )

  /** 「把这次当用例」：**只预填 `ask`（那次的题目）**，`intent` 留空给人写。
   *
   *  这是 S3 那条红线（PLAN3 §9.3 决策6）：`skill_eval` 明文「不自动生成用例」——模型自己
   *  出题自己考，考的是它会不会出题。所以这里不生成 `intent`、也不挑断言（用后端给的那组
   *  默认值）；人改完、人按保存，才写 `evals/skills/*.json`。
   */
  const addTrialAsCase = useCallback(
    async (name: string, ask: string) => {
      let defaults = defaultChecks
      if (editName !== name) {
        setEditName(name)
        setDraft([])
        const p = await loadCases(name)
        if (!p) return
        defaults = p.default_checks
      }
      setDraft((d) => [
        // 顺手去掉还没写过的空行（那是「新开一份」的占位）
        ...d.filter((c) => c.ask.trim() || c.intent.trim()),
        { id: '', intent: '', ask, checks: defaults },
      ])
      setCasesMsg('这次的题目已经填进用例了 —— 「它当时应该怎样」留给你写，写完按「保存用例」。')
    },
    [defaultChecks, editName, loadCases]
  )

  const saveCases = useCallback(async () => {
    if (!editName) return
    setCasesBusy(true)
    setCasesMsg('')
    try {
      const r = await api.saveSkillCases(
        editName,
        draft
          .filter((c) => c.ask.trim())
          .map((c) => ({
            id: c.id.trim(),
            intent: c.intent.trim(),
            ask: c.ask.trim(),
            checks: c.checks,
          }))
      )
      setCasesMsg(`存好了：${r.cases} 条 → ${r.file}`)
      refresh()
    } catch (e) {
      setCasesMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setCasesBusy(false)
    }
  }, [editName, draft, refresh])

  const make = useCallback(
    async (overwrite: boolean) => {
      if (!path.trim() && !text.trim()) return
      setBusy(true)
      setRes(null)
      try {
        const r = await api.makeCandidate(path.trim(), text.trim(), overwrite)
        setRes(r)
        if (r.written) refresh()
      } catch (e) {
        setRes({
          ok: false,
          usable: false,
          name: '',
          description: '',
          instructions: '',
          reason: e instanceof Error ? e.message : String(e),
          existing: [],
          source: '',
          model_id: '',
          written: false,
          already: '',
        })
      } finally {
        setBusy(false)
      }
    },
    [path, text, refresh]
  )

  return (
    <section className="mb-6 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-baseline justify-between pb-2">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
          🧰 读成能力
        </h2>
        <span className="text-xs text-neutral-400">
          一份材料 → 一份 SKILL.md 草稿（有工序才出，没有就直说）
        </span>
      </div>

      <div className="space-y-2">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="材料在哪（vault 路径 / repo:名/路径 / dir:名/路径）"
          className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="…或者直接粘一段材料（与上面二选一）"
          className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => void make(false)}
            disabled={busy || (!path.trim() && !text.trim())}
            className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-violet-500 disabled:opacity-40"
          >
            {busy ? '读着…' : '读一读'}
          </button>
          {res && !res.written && res.already ? (
            <button
              onClick={() => void make(true)}
              disabled={busy}
              className="rounded-lg border border-amber-300 px-3 py-1.5 text-sm text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-40 dark:border-amber-700 dark:text-amber-300"
            >
              覆盖已有的「{res.already}」
            </button>
          ) : null}
        </div>
      </div>

      {res ? (
        <div className="mt-3 rounded-lg bg-neutral-50 p-3 text-xs dark:bg-neutral-900/50">
          {res.written ? (
            <>
              <p className="text-emerald-700 dark:text-emerald-400">
                出了一份草稿：<b>{res.name}</b>
              </p>
              <p className="pt-1 text-neutral-500 dark:text-neutral-400">{res.description}</p>
              <p className="pt-1 text-neutral-400">
                落在 <code>{res.path}</code>（{res.chars} 字）
                {res.existing.length ? ` · 与已有技能重名/重叠：${res.existing.join('、')}` : ''}
              </p>
              <p className="pt-1 text-amber-700 dark:text-amber-400">
                这是**草稿**：还没跑过对照、没有基线，所以不叫「技能卡」。要它算数，得先量一遍。
              </p>
            </>
          ) : (
            <>
              <p
                className={
                  res.usable
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-neutral-500 dark:text-neutral-400'
                }
              >
                {res.usable ? '没落盘：' : '没出能力：'}
                {res.reason}
              </p>
              {res.existing.length ? (
                <p className="pt-1 text-neutral-400">已有的：{res.existing.join('、')}</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div className="mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800/70">
        <div className="flex items-baseline justify-between pb-1">
          <h3 className="text-xs font-semibold text-neutral-600 dark:text-neutral-300">
            现有的能力包（{rows.length}）
          </h3>
          <span className="text-[11px] text-neutral-400">
            {measured ? '量过的显示成绩' : '都还没有基线 —— 没量过的不算数'}
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="text-[11px] text-neutral-400">一份都没有。读一份材料试试。</p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((s) => (
              <li key={s.name} className="text-[11px]">
                <div className="flex items-baseline gap-2">
                  <span className="text-neutral-600 dark:text-neutral-300">{s.name}</span>
                  <span className="min-w-0 flex-1 truncate text-neutral-400">{s.description}</span>
                  <span className="shrink-0 text-neutral-400">{s.cases} 条用例</span>
                  <button
                    onClick={() => void editCases(s.name)}
                    title="尺子得由人给：它会收到什么 + 它当时应该怎样"
                    className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
                  >
                    {editName === s.name ? '收起用例' : '写用例'}
                  </button>
                  <button
                    onClick={() => void measure(s)}
                    disabled={busyName === s.name}
                    title={
                      s.cases
                        ? `量一遍：每条用例问两次（没它 / 有它），共 ${s.cases * 2} 次生成 + 判分`
                        : '先写用例才能量：没有尺子的分数不算数'
                    }
                    className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400"
                  >
                    {busyName === s.name ? '量着…' : '量一遍'}
                  </button>
                </div>
                <div className="pt-0.5 text-[10px] text-neutral-400">
                  {s.baseline ? (
                    <>
                      过了 {s.baseline.with_passed}/{s.baseline.cases}（区间{' '}
                      {(s.baseline.ci_low * 100).toFixed(0)}–
                      {(s.baseline.ci_high * 100).toFixed(0)}%）
                      {' · '}有它多过 {s.baseline.helped} 条 / 少过 {s.baseline.hurt} 条
                      {s.baseline.follows_method != null
                        ? ` · 跟着工序做 ${s.baseline.follows_method}/5`
                        : ' · 工序判分没跑成'}
                      {s.stale ? ' · 内容改过了，这张分数是旧版的' : ''}
                    </>
                  ) : s.stale ? (
                    '内容改过了：旧成绩不作数，得重新量一遍'
                  ) : (
                    '还没量过 —— 草稿'
                  )}
                </div>
                {/* S3 草稿卡那一行事实：**不是等级**（没有熟练度、没有进度条）——只是
                    「真实工作里被用过几次」。只摆非零；而且窗口一定跟着数字一起说。 */}
                {s.trials.n > 0 ? (
                  <div data-trials-line className="pt-0.5 text-[10px] text-neutral-400">
                    最近 {trialWindow} 次运行内被用过{' '}
                    <b className="text-neutral-600 dark:text-neutral-300">{s.trials.n}</b> 次
                    {s.trials.last_ts ? ` · 最近一次 ${ago(s.trials.last_ts)}` : ''}
                    <button
                      onClick={() => void openTrials(s.name)}
                      title="看这几次真实工作里它被用在哪、效果如何——挑几次当用例，就能量一遍了"
                      className="ml-1.5 rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
                    >
                      {trialName === s.name ? '收起试用记录' : '看试用记录'}
                    </button>
                  </div>
                ) : null}
                {trialName === s.name ? (
                  <div className="mt-1.5 rounded-lg border border-neutral-200 p-2 dark:border-neutral-800">
                    {trialsBusy ? (
                      <p className="text-[10px] text-neutral-400">读着…</p>
                    ) : !trials || trials.n === 0 ? (
                      <p className="text-[10px] text-neutral-400">还没在真实工作里被用过。</p>
                    ) : (
                      <>
                        <p className="pb-1 text-[10px] text-neutral-400">
                          这些是真实工作里吃过这份草稿的运行。数字只算最近 {trials.window} 次运行
                          —— 更早的运行已经被删掉了，所以它只会变小、不会变大。
                          挑进用例只是省了手打一遍：<b>题目照抄，「它当时应该怎样」由你写</b>。
                        </p>
                        <ul className="space-y-1.5">
                          {trials.trials.map((t) => (
                            <li
                              key={t.run_id}
                              data-trial={t.run_id}
                              className="rounded border border-neutral-100 p-1.5 dark:border-neutral-800"
                            >
                              <div className="flex items-baseline gap-2">
                                <span
                                  className="min-w-0 flex-1 truncate text-neutral-700 dark:text-neutral-200"
                                  title={t.topic}
                                >
                                  {t.topic || '（这次没有题目）'}
                                </span>
                                <span className="shrink-0 text-[10px] text-neutral-400">
                                  运行 #{t.run_id} · {fmtWhen(t.started_at)}
                                  {t.grounded == null ? ' · 未打分' : ` · 接地 ${t.grounded}/5`}
                                </span>
                                <button
                                  onClick={() => void addTrialAsCase(s.name, t.topic)}
                                  title="把这次试用的题目填进用例（intent 留给你写）"
                                  className="shrink-0 rounded-full border border-violet-200 px-2 py-0.5 text-[10px] text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-500/30 dark:text-violet-300 dark:hover:bg-violet-500/10"
                                >
                                  把这次当用例
                                </button>
                              </div>
                              {t.answer ? (
                                <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[10px] text-neutral-400">
                                  {t.answer}
                                </p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                ) : null}
                {editName === s.name ? (
                  <div className="mt-1.5 rounded-lg border border-neutral-200 p-2 dark:border-neutral-800">
                    <p className="pb-1 text-[10px] text-neutral-400">
                      尺子得由人给 —— 模型自己出题自己考，考的是它会不会出题。
                      「它会收到什么」是真会问它的那句话；「它当时应该怎样」写清这条用例凭什么在集合里。
                    </p>
                    {draft.map((c, i) => (
                      <div key={i} className="pb-1.5">
                        <div className="flex items-start gap-1">
                          <textarea
                            value={c.ask}
                            onChange={(e) =>
                              setDraft((d) =>
                                d.map((x, j) => (j === i ? { ...x, ask: e.target.value } : x))
                              )
                            }
                            rows={2}
                            placeholder="它会收到什么（例：照着这篇论文复现它的评测口径）"
                            className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-[11px] outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                          />
                          <button
                            onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                            title="删掉这条用例"
                            className="shrink-0 rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:text-rose-600 dark:border-neutral-700"
                          >
                            ✕
                          </button>
                        </div>
                        <input
                          value={c.intent}
                          onChange={(e) =>
                            setDraft((d) =>
                              d.map((x, j) => (j === i ? { ...x, intent: e.target.value } : x))
                            )
                          }
                          placeholder="它当时应该怎样（一句话）"
                          className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-[11px] outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                        />
                        <div className="flex flex-wrap gap-1 pt-1">
                          {checks.map((k) => {
                            const on = c.checks.includes(k.name)
                            return (
                              <button
                                key={k.name}
                                title={k.why}
                                onClick={() =>
                                  setDraft((d) =>
                                    d.map((x, j) =>
                                      j === i
                                        ? {
                                            ...x,
                                            checks: on
                                              ? x.checks.filter((n) => n !== k.name)
                                              : [...x.checks, k.name],
                                          }
                                        : x
                                    )
                                  )
                                }
                                className={`rounded-full border px-1.5 py-0.5 text-[10px] ${
                                  on
                                    ? 'border-violet-300 text-violet-600 dark:border-violet-500/50 dark:text-violet-300'
                                    : 'border-neutral-300 text-neutral-400 dark:border-neutral-700'
                                }`}
                              >
                                {on ? '✓ ' : ''}
                                {k.name}
                              </button>
                            )
                          })}
                          {c.checks.length === 0 && defaultChecks.length > 0 ? (
                            <span className="text-[10px] text-neutral-400">
                              不勾就用默认那条：{defaultChecks.join('、')}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() =>
                          setDraft((d) => [
                            ...d,
                            { id: '', intent: '', ask: '', checks: defaultChecks },
                          ])
                        }
                        className="rounded border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-500 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
                      >
                        ＋ 再加一条
                      </button>
                      <button
                        onClick={() => void saveCases()}
                        disabled={casesBusy || draft.every((c) => !c.ask.trim())}
                        className="rounded bg-violet-600 px-2 py-0.5 text-[10px] text-white hover:bg-violet-500 disabled:opacity-40"
                      >
                        {casesBusy ? '存着…' : '存进金标集'}
                      </button>
                      {casesMsg ? <span className="text-[10px] text-neutral-500">{casesMsg}</span> : null}
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {evalRes ? (
          <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-[11px] dark:bg-neutral-900/50">
            <p className="text-neutral-600 dark:text-neutral-300">
              「{evalRes.skill}」跑了 {evalRes.calls} 次调用（{evalRes.seconds}s）：过了{' '}
              {evalRes.with_passed}/{evalRes.total}，区间 {(evalRes.ci[0] * 100).toFixed(0)}–
              {(evalRes.ci[1] * 100).toFixed(0)}%
            </p>
            <p className="text-neutral-500 dark:text-neutral-400">
              有它多过 {evalRes.deltas.helped} 条、少过 {evalRes.deltas.hurt} 条、一样{' '}
              {evalRes.deltas.same} 条
              {evalRes.follows_method != null ? ` · 跟着工序做 ${evalRes.follows_method}/5` : ''}
            </p>
            {!evalRes.tell ? (
              <p className="pt-1 text-amber-700 dark:text-amber-400">
                这个 n 下不了结论{evalRes.cases_needed > 0 ? `（还差 ${evalRes.cases_needed} 条用例才到能开口的量）` : ''}
                ：区间太宽，别拿它当好坏的证据。
              </p>
            ) : null}
          </div>
        ) : null}
        {evalErr ? <p className="pt-1 text-[11px] text-rose-600 dark:text-rose-400">{evalErr}</p> : null}
      </div>
    </section>
  )
}

/** 筛选条的固定顺序——和产出的种类一一对应，不随数据变。 */
const KINDS: { kind: WorkOutput['kind']; label: string }[] = [
  { kind: 'research', label: '研究' },
  { kind: 'compose', label: '成文' },
  { kind: 'recap', label: '复盘' },
  { kind: 'decide', label: '方案' },
  { kind: 'conflict', label: '对质' },
  { kind: 'deliver', label: '交付' },
  { kind: 'task', label: '工作流' },
]

/** 每一种产出的颜色在 OutputCard 里统一定义（产出清单 / 资产页 / 学页回执共用）。 */

const TRIGGER_LABEL: Record<string, string> = {
  cron: '定时',
  watch: '监听',
  chain: '链',
  manual: '手动',
}

/** ISO → "09-12 08:00"（工作流只看得到最近这些，年份没用）。 */
function fmtWhen(iso: string | null): string {
  return iso ? iso.slice(5, 16).replace('T', ' ') : ''
}

/** 这次运行怎么样。`running` / 待审优先——它们还没结束，谈不上成败。 */
function runTone(r: TaskRunItem): { tone: 'bad' | 'warn' | 'good' | 'info'; text: string } {
  if (r.status === 'running') return { tone: 'warn', text: '运行中' }
  if (r.status === 'awaiting_approval') return { tone: 'warn', text: '等你点头' }
  if (r.status === 'ok') return { tone: 'good', text: '✓' }
  if (r.status === 'rejected') return { tone: 'info', text: '已驳回' }
  return { tone: 'bad', text: '✗' }
}

/** S1（PLAN3 §2 S1 第 6 条）：这次运行吃到了哪份工序——从运行日志里读。
 *
 *  没注入就没有这一项，所以这里返回空数组、界面上**一个字都不摆**（不写「注入：无」：
 *  日志只记真发生过的事）。它是 S3 试用期的同一份真值，界面这边只是它的只读视图。
 */
function injectedSkills(run: TaskRunItem): string[] {
  const entry = (run.log ?? []).find((e) => e.tool === 'skill_inject')
  const names = entry?.args?.skills
  return Array.isArray(names) ? names.map(String) : []
}

/** S2（PLAN3 §2 S2）：这次运行的一行小结——成没成、落在哪、为什么。 */
function readAsSkillLine(res: SkillCandidateResult, run: TaskRunItem): { text: string; tone: string } {
  if (res.written) {
    const n = (res.runs ?? [run.id]).length
    return {
      text: `✓ 落了草稿「${res.name}」→ ${res.path}（按 ${n} 次运行判断 · 还是草稿：没基线不算能力）`,
      tone: 'text-emerald-700 dark:text-emerald-400',
    }
  }
  if (res.already) return { text: `没落盘：同名「${res.already}」已经在了，不覆盖`, tone: 'text-amber-700 dark:text-amber-400' }
  if (!res.usable && res.ok) return { text: `没出能力：${res.reason}`, tone: 'text-neutral-500 dark:text-neutral-400' }
  return { text: `✗ ${res.reason}`, tone: 'text-rose-600 dark:text-rose-400' }
}

function RunRow({ run }: { run: TaskRunItem }) {
  const tone = runTone(run)
  const injected = injectedSkills(run)
  // S2 的入口：**运行记录是唯一同时给得出「题目」与「产出」的地方**（成品页只有路径，
  // 拿不到那次的题目与注入痕迹）。点了才跑——拉取式，与 deliver 的护栏同一条。
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<SkillCandidateResult | null>(null)

  const readAsSkill = useCallback(
    async (overwrite: boolean) => {
      setBusy(true)
      try {
        setRes(await api.draftFromRun(run.id, overwrite))
      } catch (e) {
        setRes({
          ok: false,
          usable: false,
          name: '',
          description: '',
          instructions: '',
          reason: e instanceof Error ? e.message : String(e),
          existing: [],
          source: '',
          model_id: '',
          written: false,
          already: '',
        })
      } finally {
        setBusy(false)
      }
    },
    [run.id]
  )

  return (
    <li className="py-1">
      {/* 一次运行 = 一行事实。排布交给 StatRow，和今日概览同一套。 */}
      <StatRow
        items={[
          { label: tone.text, tone: tone.tone },
          { label: fmtWhen(run.started_at) },
          { label: TRIGGER_LABEL[run.trigger] ?? run.trigger },
          // 接地分：够不着材料的那几次没有分，直说「未打分」而不是显示 0
          {
            label: run.grounded == null ? '未打分' : `接地 ${run.grounded}/5`,
            title: run.judge_reason || '这次没有可判的材料',
          },
          // S1 的注入痕迹：**匹配出来的**工序，不是人指的
          ...(injected.length
            ? [{ label: `注入 ${injected.join('、')}`, title: '这次运行吃到的技能（按话题匹配出来的）' }]
            : []),
          ...(run.tool_calls > 0
            ? [{ label: `${run.rounds} 轮 · ${run.tool_calls} 次工具` }]
            : []),
        ]}
        trailing={
          run.error ? (
            <span className="min-w-0 basis-full truncate text-rose-600 dark:text-rose-400" title={run.error}>
              {run.error}
            </span>
          ) : undefined
        }
      />
      <div className="mt-0.5 flex flex-wrap items-center gap-2 pl-1">
        <button
          onClick={() => void readAsSkill(false)}
          disabled={busy}
          title="读这次运行的过程与产出，判断有没有一套下次还能照着做的工序（会调一次模型）"
          className="rounded-full border border-violet-200 px-2 py-0.5 text-[10px] text-violet-700 transition-colors hover:bg-violet-50 disabled:opacity-40 dark:border-violet-500/30 dark:text-violet-300 dark:hover:bg-violet-500/10"
        >
          {busy ? '读着…' : '读成技能 →'}
        </button>
        {res && !res.written && res.already ? (
          <button
            onClick={() => void readAsSkill(true)}
            disabled={busy}
            className="rounded-full border border-amber-300 px-2 py-0.5 text-[10px] text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-40 dark:border-amber-700 dark:text-amber-300"
          >
            覆盖已有的「{res.already}」
          </button>
        ) : null}
        {res ? (
          <span data-read-skill className={`text-[10px] ${readAsSkillLine(res, run).tone}`}>
            {readAsSkillLine(res, run).text}
          </span>
        ) : null}
      </div>
    </li>
  )
}

function WorkflowRow({
  task,
  nextName,
  open,
  runs,
  busy,
  reviewBusy,
  onToggle,
  onRerun,
  onReview,
}: {
  task: ScheduledTask
  nextName: string
  open: boolean
  runs: TaskRunItem[]
  busy: boolean
  reviewBusy: boolean
  onToggle: () => void
  onRerun: () => void
  onReview: (approve: boolean) => void
}) {
  const waiting = task.awaiting_run_id ?? null
  const tone = task.running
    ? { cls: 'text-amber-600 dark:text-amber-400', text: '运行中' }
    : waiting
      ? { cls: 'text-amber-600 dark:text-amber-400', text: '等你点头' }
      : task.last_status === 'ok'
        ? { cls: 'text-emerald-600 dark:text-emerald-400', text: '✓' }
        : task.last_status === 'error'
          ? { cls: 'text-rose-600 dark:text-rose-400', text: '✗' }
          : { cls: 'text-neutral-400', text: '—' }

  return (
    <li id={`task-${task.id}`} className="py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
            task.enabled
              ? 'border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400'
              : 'border-neutral-200 text-neutral-300 dark:border-neutral-800 dark:text-neutral-600'
          }`}
        >
          {task.trigger_kind === 'watch' ? '监听' : task.mode === 'agent' ? '自主' : '定时'}
        </span>
        <button onClick={onToggle} className="min-w-0 flex-1 text-left" title={task.prompt}>
          <span className="block truncate text-sm text-neutral-700 dark:text-neutral-200">
            {task.name}
            {task.require_approval ? (
              <span className="pl-1.5 text-[11px] text-neutral-400">卡点</span>
            ) : null}
            {!task.enabled ? <span className="pl-1.5 text-[11px] text-neutral-400">已停用</span> : null}
          </span>
          <span className="block truncate text-[11px] text-neutral-400">
            {task.trigger_kind === 'watch' ? `监听 ${task.watch_path || '（未设路径）'}` : task.cron}
            {nextName ? ` → ${nextName}` : ''}
            {task.last_run ? ` · 上次 ${fmtWhen(task.last_run)}` : ' · 还没跑过'}
          </span>
        </button>
        {/* M2：这条流程的成品挂在哪件「事」上——挂接是自动发生的，但得看得见，
            否则「产物去哪了」又变成一个要猜的问题。 */}
        {task.thread_id ? (
          <Link
            to={`/work?tab=follow&thread=${task.thread_id}`}
            title="这条流程的成品都挂在这件事上"
            className="shrink-0 rounded-full border border-violet-200 px-2 py-0.5 text-[11px] text-violet-600 transition-colors hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10"
          >
            🗂 这件事
          </Link>
        ) : null}
        <span className={`shrink-0 text-[11px] ${tone.cls}`}>{tone.text}</span>
        {/* 停在卡点上时，这里就该是放行/驳回——它才是此刻唯一该做的动作 */}
        {waiting ? (
          <>
            <button
              onClick={() => onReview(true)}
              disabled={reviewBusy}
              className="shrink-0 rounded-full border border-emerald-300 px-2 py-0.5 text-[11px] text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-40 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
            >
              通过
            </button>
            <button
              onClick={() => onReview(false)}
              disabled={reviewBusy}
              className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-500 transition-colors hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              驳回
            </button>
          </>
        ) : (
          <button
            onClick={onRerun}
            disabled={busy || task.running}
            className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400"
          >
            {busy ? '跑着…' : '重跑'}
          </button>
        )}
      </div>

      {/* 失败原因直接摊在行下——「为什么失败」不该要再点一次才看得到 */}
      {task.last_status === 'error' && task.last_result ? (
        <p className="mt-1 truncate text-[11px] text-rose-600 dark:text-rose-400" title={task.last_result}>
          {task.last_result}
        </p>
      ) : null}
      {waiting ? (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
          这一步跑完了，等你点头才交给下游{nextName ? `（${nextName}）` : ''}——展开可以看它的产出。
        </p>
      ) : null}

      {open ? (
        runs.length === 0 ? (
          <p className="mt-1 pl-1 text-[11px] text-neutral-400">还没有运行记录。</p>
        ) : (
          <ul className="mt-1 divide-y divide-neutral-100 border-l-2 border-neutral-100 pl-2 dark:divide-neutral-800/70 dark:border-neutral-800">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        )
      ) : null}
    </li>
  )
}

/** 引擎那一档的「这台机器现在什么状态」（2026-09-18 内容太少那一轮加的）。
 *
 *  2026-09-19 起顶部先摆一排**状态计数卡**（工作流 / 30 天成功率 / 后台作业），
 *  数据全部是现成接口的聚合：任务清单（`/api/tasks`）、30 天运行成败（`/api/dashboard`
 *  的 `task_stats`，这一页此前从没读过）、作业健康（`/api/health/jobs`）。
 *
 *  下面两块，各自取、各自坏：
 *   · **最近几次运行**：把每个任务最近一条运行摊出来（与工作流行里那份同一个接口），
 *     一行说清「谁 · 什么时候 · 成没成 · 用了什么模型 · 接地分」；
 *   · **后台作业**：八个常驻作业的注册/开关/下次跑/连续失败（`/api/health/jobs`）。
 *
 *  **只陈述**：不给成功率评级、不排名、不催（§4-2）。读不到就不摆这一块（§4-8/§4-9）。
 */
function EnginePulse() {
  const [jobs, setJobs] = useState<JobHealth[] | null>(null)
  const [recent, setRecent] = useState<{ task: ScheduledTask; run: TaskRunItem }[] | null>(null)
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null)
  const [stats, setStats] = useState<{ runs_30d: number; rate: number | null } | null>(null)

  /* 只跑一次：曾经依赖 `[tasks]`，而 effect 自己每次 `setTasks(新数组)` 改引用，
   * 造成无限重跑；且 dashboard 是三个请求里最慢的，其响应总落在下一轮 cleanup
   * 之后（live 已 false），`setStats` 永远执行不到——30 天成功率恒为「—」，
   * 后端被每秒上百次打 `/api/dashboard`。所以「最近运行」改用本次取到的 `t`
   * 直接算，不再绕 state。 */
  useEffect(() => {
    let live = true
    api
      .healthJobs()
      .then((r) => live && setJobs(r.jobs))
      .catch(() => {})
    api
      .listTasks()
      .then((t) => {
        if (!live) return
        setTasks(t)
        void (async () => {
          try {
            const rows = await Promise.all(
              t.slice(0, 8).map(async (task) => {
                const runs = await api.listTaskRuns(task.id)
                return runs[0] ? { task, run: runs[0] } : null
              })
            )
            if (live) setRecent(rows.filter((r): r is { task: ScheduledTask; run: TaskRunItem } => !!r))
          } catch {
            /* 读不到就不摆这一块 */
          }
        })()
      })
      .catch(() => {})
    api
      .dashboard()
      .then((d) => live && setStats(d.task_stats))
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const shownJobs = (jobs ?? []).filter((j) => j.registered)
  const normalJobs = shownJobs.filter((j) => !j.disabled && j.consecutive_failures === 0).length
  const failJobs = shownJobs.filter((j) => j.consecutive_failures > 0).length
  const waiting = (tasks ?? []).filter((t) => t.awaiting_run_id != null).length

  const pulseEmpty =
    !shownJobs.length && !(recent && recent.length > 0) && !(tasks && tasks.length > 0) && !stats
  if (pulseEmpty) return null

  return (
    <div className="mb-6 space-y-4" data-engine-pulse>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          icon={<Cpu className="h-3.5 w-3.5" />}
          accent="bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300"
          label="工作流"
          value={tasks ? tasks.length : null}
          sub={waiting > 0 ? `${waiting} 条在等点头` : undefined}
        />
        <StatTile
          icon={<Activity className="h-3.5 w-3.5" />}
          accent="bg-emerald-100 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300"
          label="30 天成功率"
          value={stats && stats.runs_30d > 0 && stats.rate != null ? `${Math.round(stats.rate * 100)}%` : null}
          sub={stats && stats.runs_30d > 0 ? `${stats.runs_30d} 次运行` : undefined}
        />
        <StatTile
          icon={<HeartPulse className="h-3.5 w-3.5" />}
          accent="bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"
          label="后台作业"
          value={jobs ? normalJobs : null}
          sub={jobs ? `共 ${shownJobs.length} 个${failJobs ? ` · 连挂 ${failJobs}` : ''}` : undefined}
        />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        {recent && recent.length > 0 ? (
          <section>
            <h2 className="pb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              最近几次运行
            </h2>
            <ul className="wb-card divide-y divide-neutral-100 px-3 dark:divide-neutral-800/70">
              {recent.map(({ task, run }) => (
                <li key={run.id} className="py-2">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        run.status === 'ok'
                          ? 'bg-emerald-500'
                          : run.status === 'running'
                            ? 'bg-sky-500 wb-node-running'
                            : run.status === 'awaiting_approval'
                              ? 'bg-amber-400'
                              : 'bg-rose-500'
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-neutral-200">
                      {task.name}
                    </span>
                    <span
                      className={`shrink-0 text-[11px] font-medium ${
                        run.status === 'ok'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : run.status === 'running'
                            ? 'text-sky-600 dark:text-sky-400'
                            : 'text-rose-600 dark:text-rose-400'
                      }`}
                    >
                      {run.status}
                    </span>
                    <span className="shrink-0 text-[10px] text-neutral-400">
                      {run.started_at ? ago(Date.parse(run.started_at) / 1000) : ''}
                    </span>
                  </div>
                  <StatRow
                    className="pt-0.5"
                    items={[
                      { label: run.trigger },
                      { label: '轮', value: run.rounds },
                      { label: run.model_id || '—' },
                      run.grounded === null
                        ? { label: '接地分', value: '—', title: '这次没量到分（没材料 / 判分没跑成）' }
                        : { label: '接地分', value: run.grounded.toFixed(2) },
                    ]}
                    trailing={
                      run.error ? (
                        <span className="min-w-0 truncate text-rose-500" title={run.error}>
                          {run.error}
                        </span>
                      ) : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {shownJobs.length > 0 ? (
          <section>
            <h2 className="pb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              后台作业
            </h2>
            <ul className="wb-card divide-y divide-neutral-100 px-3 dark:divide-neutral-800/70">
              {shownJobs.map((j) => (
                <li key={j.job_id} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-600 dark:text-neutral-300">
                    {j.job_id}
                  </span>
                  {j.disabled ? (
                    <span className="shrink-0 rounded-full border border-neutral-200 px-2 py-0.5 text-[10px] text-neutral-400 dark:border-neutral-700">
                      已关
                    </span>
                  ) : j.consecutive_failures > 0 ? (
                    <span className="shrink-0 rounded-full border border-rose-200 bg-rose-50/70 px-2 py-0.5 text-[10px] font-medium text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400">
                      连挂 {j.consecutive_failures} 次
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50/70 px-2 py-0.5 text-[10px] text-emerald-600 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
                      正常
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] text-neutral-400">
                    {j.last?.at ? `上次 ${ago(Date.parse(j.last.at) / 1000)}` : '还没跑过'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  )
}

export default function WorkPage() {
  const [outputs, setOutputs] = useState<WorkOutput[]>([])
  const [filter, setFilter] = useState<WorkOutput['kind'] | ''>('')
  const [err, setErr] = useState('')
  const navigate = useNavigate()

  // 标签挂在 ?tab= 上：/threads 的旧链接重定向过来带的就是 tab=follow；
  // 工作流深链 ?task=7 没写 tab，直接落「引擎」才对得上。
  // `lab`（Q1 的提示词对照台）、`form`（Q3 的形态）和 `dispatch`（Q4 的调度台）刻意放在
  // **工作模块**里：提示词工程、数据集、编排都是「非编程的那部分工作」，它们和产出、工作流
  // 是同一张桌子上的事。
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab')
  // 标签清单在 `routes.tsx`（侧栏与这一页**同一份**）：`?tab=` 是唯一入口，
  // 页面里那排标签按钮已经删掉（2026-09-18 导航改版）。
  const tab: WorkTab =
    (WORK_TABS.find((t) => t.key === tabParam)?.key as WorkTab | undefined) ??
    (params.get('task') ? 'engine' : 'output')
  const setTab = (t: WorkTab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        n.set('tab', t)
        return n
      },
      { replace: true }
    )

  // 工作流（§4-11）：定义、最近运行、失败原因同屏
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [openRuns, setOpenRuns] = useState<number | null>(null)
  const [runs, setRuns] = useState<TaskRunItem[]>([])
  const [wfBusy, setWfBusy] = useState<number | null>(null)
  const [wfrBusy, setWfrBusy] = useState<number | null>(null) // 正在放行/驳回的那次运行
  const [presetBusy, setPresetBusy] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  // 「处理一项工作」：题目 → 起链 → 三步各自停下等你点头（工作 preset）
  const [workTopic, setWorkTopic] = useState('')
  const [workOpen, setWorkOpen] = useState(false)
  const [workBusy, setWorkBusy] = useState(false)
  const [workMsg, setWorkMsg] = useState('')
  // M2：这一步/这条流程的产物挂到哪件「事」上。名字当场就有（起链的回执里带着），
  // 不必再拉一次详情——「挂到哪了」是运行期就知道的事，不该等下一次刷新。
  const [workThread, setWorkThread] = useState<{ id: number; name: string } | null>(null)

  // 从「一件事」点一条工作流过来（`?task=7`）：滚到那条流程并亮一下
  useDeepLink('task', tasks.length > 0)

  // 会议（§4-13）：一场一个文件夹，录音能回听
  const [meetings, setMeetings] = useState<WorkMeeting[]>([])

  // 交付：体裁 × 读者的定义来自后端（唯一真值），话题由你给。
  const [catalogue, setCatalogue] = useState<DeliverCatalogue | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [genre, setGenre] = useState('')
  const [audience, setAudience] = useState('')
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  // 「加进这次产出」（§4-14）：钉进来的材料排在取材结果最前
  const [pinned, setPinned] = useState<{ spec: string; title: string }[]>([])
  const [pinOpen, setPinOpen] = useState(false)
  const [pinQuery, setPinQuery] = useState('')
  const [pinHits, setPinHits] = useState<MaterialHit[]>([])
  const [pinBusy, setPinBusy] = useState(false)
  const [draft, setDraft] = useState<ReportDraft | null>(null)
  const [report, setReport] = useState<DeliverReport | null>(null)
  const [saved, setSaved] = useState('')
  // S1：这次生成吃到了哪份工序（引擎匹配出来的）。手动这条路没有运行记录，
  // 所以它是「看不见注入」的唯一补丁——不留它，用得最多的这条路人永远不知道自己吃到了什么。
  const [injected, setInjected] = useState<string[]>([])
  const abort = useRef<AbortController | null>(null)

  const refreshOutputs = useCallback(() => {
    // best-effort：列不出来时给一句实话，不把整页弄成错误页
    api
      .workOutputs()
      .then((r) => setOutputs(r.outputs))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  const refreshTasks = useCallback(() => {
    api.listTasks().then(setTasks).catch(() => {})
  }, [])

  const refreshMeetings = useCallback(() => {
    api.workMeetings().then((r) => setMeetings(r.meetings)).catch(() => {})
  }, [])

  useEffect(() => {
    refreshOutputs()
    refreshTasks()
    refreshMeetings()
    api
      .deliverGenres()
      .then((c) => {
        setCatalogue(c)
        setGenre(c.default_genre)
        setAudience(c.default_audience)
      })
      .catch(() => {}) // 体裁拉不到就不显示生成面板，清单照常用
  }, [refreshOutputs, refreshTasks, refreshMeetings])

  // 切页时掐断还在跑的生成（照 tutor 页）
  useEffect(() => () => abort.current?.abort(), [])

  const toggleRuns = useCallback(
    async (id: number) => {
      if (openRuns === id) {
        setOpenRuns(null)
        return
      }
      setOpenRuns(id)
      setRuns([])
      try {
        setRuns(await api.listTaskRuns(id))
      } catch {
        setRuns([])
      }
    },
    [openRuns]
  )

  const rerun = useCallback(
    async (id: number) => {
      setWfBusy(id)
      try {
        await api.runTask(id)
        refreshTasks()
        if (openRuns === id) setRuns(await api.listTaskRuns(id))
        refreshOutputs() // 任务可能落 vault——产出清单跟着刷新
      } catch {
        /* 失败原因会落在 run 记录里，下一次展开就看得见 */
      } finally {
        setWfBusy(null)
      }
    },
    [openRuns, refreshTasks, refreshOutputs]
  )

  /** 人工卡点（§4-12）：通过 / 驳回。冲突（已经审过了）不吵人——刷新出来的就是事实。 */
  const review = useCallback(
    async (taskId: number, runId: number, approve: boolean) => {
      setWfrBusy(runId)
      try {
        if (approve) await api.approveRun(runId)
        else await api.rejectRun(runId)
        refreshOutputs() // 放行后下游可能落 vault
      } catch {
        /* 见上：状态早就变了，刷新即可 */
      } finally {
        setWfrBusy(null)
        refreshTasks()
        if (openRuns === taskId) {
          try {
            setRuns(await api.listTaskRuns(taskId))
          } catch {
            /* 列表拉不到就保持原样 */
          }
        }
      }
    },
    [openRuns, refreshTasks, refreshOutputs]
  )

  /** 一键装会议闭环：装完工作流区就有四步链了（幂等，重复点不会装第二遍）。 */
  const installPreset = useCallback(async () => {
    setPresetBusy(true)
    try {
      await api.installMeetingPreset()
      refreshTasks()
    } catch {
      /* 装不上就什么都不变 */
    } finally {
      setPresetBusy(false)
    }
  }, [refreshTasks])

  /** 一键装语音进料（R2）：装完 `voice/inbox/` 就有个监听它的任务。
   *  与会议那条**故意分开**——会议要留着原声并往下走三步，这条只留文本（转完删录音）。 */
  const installVoice = useCallback(async () => {
    setVoiceBusy(true)
    try {
      await api.installVoicePreset()
      refreshTasks()
    } catch {
      /* 装不上就什么都不变 */
    } finally {
      setVoiceBusy(false)
    }
  }, [refreshTasks])

  /** 处理一项工作：装好（幂等）→ 找到第一步 → 用题目起链。之后三步在你的「通过」下
   *  逐步接手，产物自动落进产出清单。
   *  M2：题目同时是这件事的**名字**——后端按它复用或新建一条「事」，三步的成品都挂上去。
   *  所以这里不只是起一条流水线，是**开一件有名字的工作**：做完之后它自己收口。 */
  const startWork = useCallback(async () => {
    const t = workTopic.trim()
    if (!t) {
      setWorkMsg('先写一个题目。')
      return
    }
    setWorkBusy(true)
    setWorkMsg('')
    setWorkThread(null)
    try {
      const r = await api.installWorkPreset()
      const step1 = r.tasks.find((x) => x.name === '工作·调研')
      if (!step1) {
        setWorkMsg('装不出第一步，去「引擎」标签看看。')
        return
      }
      const ran = await api.runTask(step1.id, t, t)
      setWorkTopic('')
      setWorkOpen(false)
      setWorkThread(ran.thread ? { id: ran.thread.id, name: ran.thread.name } : null)
      setWorkMsg('调研跑起来了——跑完停下，去「引擎」标签通过。')
      refreshTasks()
    } catch (e) {
      setWorkMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setWorkBusy(false)
    }
  }, [workTopic, refreshTasks])

  /** 搜一条自己的材料钉进这次产出——检索命中的 `spec` 后端认（vault 路径 / repo: / dir:）。 */
  const searchPin = useCallback(async () => {
    const q = pinQuery.trim()
    if (!q) return
    setPinBusy(true)
    try {
      setPinHits((await api.searchMaterial(q)).hits)
    } catch {
      setPinHits([])
    } finally {
      setPinBusy(false)
    }
  }, [pinQuery])

  const addPin = useCallback((h: MaterialHit) => {
    if (!h.spec) return
    setPinned((cur) =>
      cur.some((p) => p.spec === h.spec) ? cur : [...cur, { spec: h.spec, title: h.title || h.spec }]
    )
    setPinOpen(false)
    setPinHits([])
    setPinQuery('')
  }, [])

  /** 改写成：拿一件产出当**钉住材料**，开交付流换个体裁重写（周报 / 短稿 / 一页纸提案）。
   *  J4 的缺口——产出别只躺在清单里，要能变成「交得出去的那一版」。 */
  const rewriteAs = useCallback((o: WorkOutput) => {
    setTab('output')
    setGenOpen(true)
    setTopic(`把《${o.title}》改写成`)
    setPinned([{ spec: o.path, title: o.title }])
    setReport(null)
    setDraft(null)
    setSaved('')
    setMsg('')
    window.scrollTo({ top: 0 })
  }, [])

  const run = useCallback(async () => {
    const t = topic.trim()
    if (!t || busy || !genre || !audience) return
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setBusy(true)
    setReport(null)
    setDraft(null)
    setSaved('')
    setInjected([])
    setMsg('取材中…')
    try {
      const r = await streamDeliver(
        t,
        genre,
        audience,
        (event, data) => {
          if (event === 'gathering') setMsg('在你自己的材料里找…')
          else if (event === 'sources') setMsg('材料到手，开始写…')
          else if (event === 'skills')
            // S1：命中即注入。只说事实——没命中这一帧根本不发
            setInjected(((data.skills ?? []) as unknown[]).map(String))
          else if (event === 'writing') setMsg('成文中…')
          else if (event === 'draft')
            // draft 一帧帧来，正文边生成边渲染；`report` 到了才算数
            setDraft({
              title: String(data.title ?? ''),
              sections: (data.sections ?? []) as ReportDraft['sections'],
            })
        },
        ctl.signal,
        pinned.map((p) => p.spec)
      )
      if (r.ok && r.report) {
        setReport(r.report)
        setMsg('')
      } else {
        setMsg(r.error || '成文失败')
      }
    } catch (e) {
      if (!ctl.signal.aborted) setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [topic, genre, audience, busy, pinned])

  const save = useCallback(async () => {
    if (!report || busy || saved) return
    setBusy(true)
    try {
      const r = await api.deliverSave({
        title: report.title,
        sections: report.sections,
        used: report.used,
        sources: report.sources,
        // M5：体裁与读者一起存进文件头——「这份是给谁写的」以前存完就丢了，
        // 而交付的事后见证（`deliverWitness`）要靠它说清「交给谁的那份」。
        genre,
        audience,
      })
      setSaved(r.filename)
      refreshOutputs()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [report, busy, saved, refreshOutputs])

  const shown = filter ? outputs.filter((o) => o.kind === filter) : outputs
  const present = KINDS.filter((k) => outputs.some((o) => o.kind === k.kind))
  const nameOf = (id: number | null) =>
    id == null ? '' : (tasks.find((t) => t.id === id)?.name ?? '')

  function openPath(rel: string) {
    navigate(`/notes?path=${encodeURIComponent(rel)}`)
  }

  return (
    <PageShell
      title="工作"
      description="写一份交付、跑后台流程、跟进一件事——干活这条线。"
      actions={
        catalogue ? (
          <button
            onClick={() => {
              if (tab !== 'output') setTab('output')
              setGenOpen((v) => !v)
            }}
            className="shrink-0 rounded-xl border border-teal-300 px-3 py-1.5 text-xs text-teal-700 transition-colors hover:bg-teal-50 dark:border-teal-700 dark:text-teal-300 dark:hover:bg-teal-500/10"
          >
            {genOpen && tab === 'output' ? '收起' : '写一份交付'}
          </button>
        ) : null
      }
    >
      {/* 那排标签（产出 / 引擎 / 实验室 / 形态 / 调度台 / 跟进）已经搬到**侧栏**
          （2026-09-18 导航改版）：同一件事不留两个入口，页面上只剩内容。
          切页仍然走 `?tab=`，所以旧书签、深链、`/threads` → `/work?tab=follow` 都不破。 */}
      {tab === 'output' && genOpen && catalogue ? (
        <section className="mb-6 rounded-xl border border-teal-200 bg-teal-50/40 p-4 dark:border-teal-500/30 dark:bg-teal-500/10">
          <div className="flex flex-wrap items-center gap-1.5">
            {catalogue.genres.map((g) => (
              <button
                key={g.id}
                onClick={() => setGenre(g.id)}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  genre === g.id
                    ? KIND_BADGE.deliver
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-neutral-400">读者</span>
            {catalogue.audiences.map((a) => (
              <button
                key={a.id}
                onClick={() => setAudience(a.id)}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  audience === a.id
                    ? 'border-teal-400 text-teal-700 dark:border-teal-600 dark:text-teal-300'
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run()
              }}
              placeholder="写什么？（例：这周的 RAG 调研）"
              className="min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              onClick={() => void run()}
              disabled={!topic.trim() || busy}
              className="shrink-0 rounded-xl bg-teal-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-teal-700 disabled:opacity-40"
            >
              {busy ? '生成中…' : '生成'}
            </button>
          </div>

          {/* 「加进这次产出」（§4-14）：钉进来的材料排在取材结果最前 */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {pinned.map((p) => (
              <span
                key={p.spec}
                title={p.spec}
                className="flex items-center gap-1 rounded-full border border-teal-300 px-2 py-0.5 text-[11px] text-teal-700 dark:border-teal-600 dark:text-teal-300"
              >
                {p.title}
                <button
                  onClick={() => setPinned((c) => c.filter((x) => x.spec !== p.spec))}
                  title="取消钉住"
                  className="text-teal-500 hover:text-rose-500"
                >
                  ✕
                </button>
              </span>
            ))}
            <button
              onClick={() => setPinOpen((v) => !v)}
              className="rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-500 transition-colors hover:border-teal-300 hover:text-teal-600 dark:border-neutral-700 dark:text-neutral-400"
            >
              {pinOpen ? '收起' : '＋ 钉一条材料'}
            </button>
          </div>
          {pinOpen ? (
            <div className="mt-2">
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={pinQuery}
                  onChange={(e) => setPinQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void searchPin()
                  }}
                  placeholder="在你自己的材料里搜一条…"
                  className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-[11px] outline-none placeholder:text-neutral-400 focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
                />
                <button
                  onClick={() => void searchPin()}
                  disabled={pinBusy || !pinQuery.trim()}
                  className="shrink-0 rounded-lg border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
                >
                  {pinBusy ? '搜…' : '搜'}
                </button>
              </div>
              {pinHits.length > 0 ? (
                <ul className="mt-1.5 space-y-0.5">
                  {pinHits.map((h) => (
                    <li key={h.spec || h.source}>
                      <button
                        onClick={() => addPin(h)}
                        title={h.text}
                        className="block w-full truncate rounded px-1.5 py-1 text-left text-[11px] text-neutral-600 transition-colors hover:bg-teal-50 hover:text-teal-700 dark:text-neutral-300 dark:hover:bg-teal-500/10"
                      >
                        {h.title || h.source}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {msg ? <p className="mt-2 text-[11px] text-neutral-500">{msg}</p> : null}

          {injected.length ? (
            <InjectedLine
              names={injected}
              className="mt-2 block text-[11px] text-teal-700 dark:text-teal-300"
            />
          ) : null}

          {report || draft ? (
            <div className="mt-3 rounded-lg border border-teal-200/70 bg-white p-3 dark:border-teal-500/20 dark:bg-neutral-900/60">
              <Markdown sources={report?.sources}>{reportMarkdown(report ?? draft!)}</Markdown>
              {report ? (
                <SourceList
                  sources={report.sources}
                  used={report.used}
                  className="border-teal-200/70 dark:border-teal-500/20"
                />
              ) : null}
            </div>
          ) : null}

          {report ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void save()}
                disabled={busy || !!saved}
                className="rounded-full border border-teal-300 px-2.5 py-0.5 text-[11px] text-teal-700 transition-colors hover:bg-teal-100 disabled:opacity-40 dark:border-teal-600 dark:text-teal-300 dark:hover:bg-teal-500/20"
              >
                {saved ? '已存进 vault' : busy ? '保存中…' : '存进 vault'}
              </button>
              {saved ? (
                <span className="text-[11px] text-emerald-600 dark:text-emerald-400">已存到 {saved}</span>
              ) : null}
              <FeedbackButtons
                kind="deliver"
                promptSha={report.prompt_sha}
                modelId={report.model_id}
                artifactRef={saved}
                // 这一页说得出「有没有注入」：流走完了，`injected` 就是那一次的答案
                injected={injected}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === 'engine' ? (
      <>
      {/* 处理一项工作：给一个题目，三步（调研 → 方案 → 汇报稿）各跑各的、各停下等点头。
          这是「工作」作为一条线的正面入口——不必先去设置里拼任务。 */}
      <section className="wb-card-hero mb-6 rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3 pb-2">
          <h2 className="flex items-center gap-2.5 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            <span className="wb-chip h-7 w-7 rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300">
              <Briefcase className="h-4 w-4" />
            </span>
            处理一项工作
          </h2>
          <span className="text-xs text-neutral-400">题目 → 调研 → 方案 → 汇报稿，每步停下等你点头</span>
        </div>
        {workOpen ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={workTopic}
              onChange={(e) => setWorkTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void startWork()
              }}
              autoFocus
              placeholder="一句话题目（例：要不要上向量库选型）"
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
            <button
              onClick={() => void startWork()}
              disabled={workBusy}
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-violet-500 disabled:opacity-40"
            >
              {workBusy ? '起链…' : '开始'}
            </button>
            <button
              onClick={() => {
                setWorkOpen(false)
                setWorkMsg('')
              }}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-700 dark:border-neutral-700 dark:text-neutral-400"
            >
              收起
            </button>
          </div>
        ) : (
          <button
            onClick={() => setWorkOpen(true)}
            className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-violet-500"
          >
            起一个题目
          </button>
        )}
        {workMsg ? <p className="pt-2 text-xs text-neutral-500">{workMsg}</p> : null}
        {/* M2：题目就是这件事的名字——三步的成品都会挂上去，所以当场给一个去处，
            不用等你想起来「这件事我给它起过名字」。 */}
        {workThread ? (
          <p className="pt-1 text-xs text-neutral-500">
            产物会挂到「
            <Link
              to={`/work?tab=follow&thread=${workThread.id}`}
              className="text-violet-600 hover:underline dark:text-violet-400"
            >
              {workThread.name}
            </Link>
            」这件事上 —— 调研 / 方案 / 汇报稿都会落在那里。
          </p>
        ) : null}
      </section>

      <section className="mb-6">
        <div className="flex items-baseline justify-between pb-1">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">工作流</h2>
          <span className="text-xs text-neutral-400">跑完带接地分 —— 「跑成功但变差」只有它看得见</span>
        </div>
        {tasks.length === 0 ? (
          <EmptyHint
            pad="sm"
            title="还没有工作流。"
            hint="在「设置 · 定时任务」里配一条，或者直接装一条现成的。会议那条：录音丢进 vault/meetings/inbox/ 就自己转写、出纪要与待办。语音备忘那条：录音丢进 vault/voice/inbox/ 就转成文本（vault/voice/ 里一份 md，原录音转完就删）。"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void installPreset()}
                  disabled={presetBusy}
                  className="rounded-xl border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
                >
                  {presetBusy ? '正在装…' : '装一条会议流程'}
                </button>
                {/* R2 · PLAN5 §3：语音进料。与会议那条分开摆，是因为**行为不一样**——
                    会议留着原声往下走三步，这条只留文本、转完就删掉录音。 */}
                <button
                  data-install-voice
                  onClick={() => void installVoice()}
                  disabled={voiceBusy}
                  className="rounded-xl border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
                >
                  {voiceBusy ? '正在装…' : '装一条语音备忘'}
                </button>
              </div>
            }
          />
        ) : (
          <ul className="wb-card divide-y divide-neutral-100 px-4 dark:divide-neutral-800/70">
            {tasks.map((t) => (
              <WorkflowRow
                key={t.id}
                task={t}
                nextName={nameOf(t.chain_next_id)}
                open={openRuns === t.id}
                runs={runs}
                busy={wfBusy === t.id}
                reviewBusy={wfrBusy === t.awaiting_run_id}
                onToggle={() => void toggleRuns(t.id)}
                onRerun={() => void rerun(t.id)}
                onReview={(approve) => {
                  if (t.awaiting_run_id != null) void review(t.id, t.awaiting_run_id, approve)
                }}
              />
            ))}
          </ul>
        )}
      </section>
      </>
      ) : null}

      {/* 2026-09-18「内容太少」那一轮：引擎这一档原来只有「交付 + 工作流清单」，
          量下来整页 175 字——全站最空的一页。补两块**这台机器上已经有的事实**：
          最近几次运行（`/api/tasks` 的运行记录，与工作流行里那份同一来源）、
          八个后台作业的健康（`/api/health/jobs`）。各自 catch，读不到就不摆。 */}
      {tab === 'engine' ? <EnginePulse /> : null}

      {tab === 'engine' && meetings.length > 0 ? (
        <section className="mb-6">
          <div className="flex items-baseline justify-between pb-1">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">会议</h2>
            <span className="text-xs text-neutral-400">一场一个文件夹，原声留着可回听</span>
          </div>
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {meetings.map((m) => (
              <li key={m.path} className="py-3">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-700 dark:text-neutral-200">
                    {m.title}
                  </span>
                  <span className="shrink-0 text-[11px] text-neutral-400">{m.date.slice(5)}</span>
                </div>
                {m.audio ? (
                  <audio
                    controls
                    preload="none"
                    src={api.audioUrl(m.audio)}
                    className="mt-1.5 h-8 w-full max-w-md"
                  />
                ) : null}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {m.files.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => openPath(f.path)}
                      title={f.path}
                      className="rounded-full border border-neutral-200 px-2.5 py-0.5 text-[11px] text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-300"
                    >
                      {f.title}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {tab === 'output' && err ? (
        <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          产出清单拉不出来：{err}
        </p>
      ) : null}

      {tab === 'output' ? (
      <section>
        <div className="flex items-baseline justify-between gap-3 pb-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">产出</h2>
          {/* 去哪做——这里的产出是**归宿**，不是起点。交付在上面就地写，
              其余三个引擎在学页、复盘在仪表盘。做成可点的，别只是句说明。 */}
          <span className="text-[11px] text-neutral-400">
            研究 / 方案 / 对质 在
            <Link to="/tutor" className="text-violet-500 hover:underline">
              学
            </Link>
            · 复盘在
            <Link to="/dashboard" className="text-violet-500 hover:underline">
              仪表盘
            </Link>
          </span>
        </div>

        {present.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 pb-4">
            <button
              onClick={() => setFilter('')}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                filter === ''
                  ? 'border-neutral-400 text-neutral-700 dark:border-neutral-500 dark:text-neutral-200'
                  : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
              }`}
            >
              全部 {outputs.length}
            </button>
            {present.map((k) => (
              <button
                key={k.kind}
                onClick={() => setFilter(k.kind)}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  filter === k.kind
                    ? KIND_BADGE[k.kind]
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
                }`}
              >
                {k.label} {outputs.filter((o) => o.kind === k.kind).length}
              </button>
            ))}
          </div>
        ) : null}

        {outputs.length === 0 ? (
          <EmptyHint
            pad="lg"
            title="还没有产出。"
            hint="在上面「写一份交付」，或去「学」「仪表盘」跑一轮；成品会自动落到这里。"
          />
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {shown.map((o) => (
              <li key={o.path}>
                <OutputCard
                  kind={o.kind}
                  label={o.label}
                  title={o.title}
                  meta={o.path}
                  onOpen={() => openPath(o.path)}
                  actions={
                    <>
                      <button
                        onClick={() => rewriteAs(o)}
                        title="拿它当材料，换个体裁重写（周报 / 短稿 / 一页纸提案）"
                        className="hidden shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 group-hover:block dark:border-neutral-700 dark:text-neutral-400"
                      >
                        改写成
                      </button>
                      <AttachToThread
                        kind="output"
                        ref={o.path}
                        className="hidden shrink-0 group-hover:block"
                      />
                      <span className="text-[11px] text-neutral-400">{o.date.slice(5)}</span>
                    </>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      ) : null}

      {tab === 'follow' ? <ThreadsPage chromeless /> : null}
      {tab === 'lab' ? <PromptLab /> : null}
      {tab === 'lab' ? <CapabilityCandidate /> : null}
      {tab === 'form' ? <FormPane /> : null}
      {tab === 'dispatch' ? <DispatchPanel /> : null}
    </PageShell>
  )
}
