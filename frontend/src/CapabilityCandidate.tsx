/** 能力候选（环一：学习 → 工作）。一份材料 → 一份 SKILL.md 草稿。
 *
 *  **P4 从 WorkPage.tsx 拆出来的。** 它原来和整页挤在一个文件里（那个文件两千行），
 *  而它与页面**只通过两个小函数相连**（`fmtWhen` / `failedResult`，都在 `workShared`）。
 *  拆的依据是「尺寸大到该拆」，不是「结构上本来就该分开」——这一点如实记下。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { api, type SkillCandidateResult, type SkillCandidateRow, type SkillEvalReport, type SkillTrials } from './api'
import { ago } from './reltime'
import EmptyHint from './EmptyHint'
import RunPanel from './RunPanel'
import { failedResult, fmtWhen } from './workShared'

export default function CapabilityCandidate() {
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
  /** 已经点了「停止」、但当前那条还没跑完（合作式取消的中间态）。 */
  const [stoppingName, setStoppingName] = useState('')
  /** 「读一读」那一次的 AbortController。**它只是「不等了」，不是真停**——
   *  `/api/skills/candidate` 是一次性 POST，断开连接服务端照样跑完那份调用。
   *  所以 RunPanel 上的字是「不等了」。 */
  const readAbort = useRef<AbortController | null>(null)
  const [evalRes, setEvalRes] = useState<SkillEvalReport | null>(null)
  const [evalErr, setEvalErr] = useState('')
  // 用例编辑器：**尺子得由人给**（模型自己出题自己考，考的是它会不会出题）。
  // 打开哪一份、草稿是什么、存完给一句什么话，都在这一小块里。
  const [editName, setEditName] = useState('')
  const [caseDraft, setCaseDraft] = useState<{ id: string; intent: string; ask: string; checks: string[] }[]>([])
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
      setStoppingName('')
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
        setStoppingName('')
      }
    },
    [refresh]
  )

  /** 请这次「量一遍」停下。**真停**：后端在每条用例之间查一次（合作式），
   *  所以当前那条会跑完才停——按钮旁边写的就是这句。 */
  const stopMeasure = useCallback(async (name: string) => {
    setStoppingName(name)
    try {
      const r = await api.cancelSkillEval(name)
      if (!r.stopped) setStoppingName('')
    } catch (e) {
      setStoppingName('')
      setEvalErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  /** 把盘上那份用例读进编辑器（断言清单与默认断言**由后端给**，前端不抄一份）。 */
  const loadCases = useCallback(async (name: string) => {
    setCasesMsg('')
    try {
      const p = await api.skillCases(name)
      setChecks(p.checks)
      setDefaultChecks(p.default_checks)
      setCaseDraft(
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
      setCaseDraft([])
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
        setCaseDraft([])
        const p = await loadCases(name)
        if (!p) return
        defaults = p.default_checks
      }
      setCaseDraft((d) => [
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
        caseDraft
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
  }, [editName, caseDraft, refresh])

  const make = useCallback(
    async (overwrite: boolean) => {
      if (!path.trim() && !text.trim()) return
      readAbort.current?.abort()
      const ctl = new AbortController()
      readAbort.current = ctl
      setBusy(true)
      setRes(null)
      try {
        const r = await api.makeCandidate(path.trim(), text.trim(), overwrite, ctl.signal)
        if (ctl.signal.aborted) return
        setRes(r)
        if (r.written) refresh()
      } catch (e) {
        if (ctl.signal.aborted) return // 自己点的不等了，不当成失败
        setRes(failedResult(e instanceof Error ? e.message : String(e)))
      } finally {
        if (readAbort.current === ctl) readAbort.current = null
        setBusy(false)
      }
    },
    [path, text, refresh]
  )

  return (
    <section className="mb-6 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
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

      {/* 长任务走 RunPanel 六态（方案 §六）。
          **这一条的「不等了」不是「停止」**：`/api/skills/candidate` 是一次性 POST，
          断开连接之后服务端照样跑完那份模型调用。按钮上写「停止」就是撒谎。 */}
      {busy ? (
        <div className="pt-2">
          <RunPanel
            phase="progress"
            tone="violet"
            icon="📖"
            title="读一份材料"
            status="正在读——这一段可能要几十秒"
            onCancel={() => readAbort.current?.abort()}
            cancelLabel="不等了"
          />
        </div>
      ) : null}

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
                  res.failed
                    ? 'text-rose-600 dark:text-rose-400'
                    : res.usable
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-neutral-500 dark:text-neutral-400'
                }
              >
                {res.failed ? '没读成：' : res.usable ? '没落盘：' : '没出能力：'}
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
          <span className="text-xs text-neutral-400">
            {measured ? '量过的显示成绩' : '都还没有基线 —— 没量过的不算数'}
          </span>
        </div>
        {rows.length === 0 ? (
          // 空态一律 EmptyHint（方案 §七：虚线框 + 标题 + 一句引导 + 动作按钮），**禁裸文本**。
          <EmptyHint
            title="一份都没有。"
            hint="读一份材料试试——上面那两格，路径或正文二选一。有工序才出草稿，没有就直说。"
          />
        ) : (
          <ul className="space-y-1.5">
            {rows.map((s) => (
              <li key={s.name} className="text-xs">
                <div className="flex items-baseline gap-2">
                  <span className="text-neutral-600 dark:text-neutral-300">{s.name}</span>
                  <span className="min-w-0 flex-1 truncate text-neutral-400">{s.description}</span>
                  <span className="shrink-0 text-neutral-400">{s.cases} 条用例</span>
                  <button
                    onClick={() => void editCases(s.name)}
                    title="尺子得由人给：它会收到什么 + 它当时应该怎样"
                    className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
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
                    className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400"
                  >
                    {busyName === s.name ? '量着…' : '量一遍'}
                  </button>
                </div>
                <div className="pt-0.5 text-xs text-neutral-400">
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
                  <div data-trials-line className="pt-0.5 text-xs text-neutral-400">
                    最近 {trialWindow} 次运行内被用过{' '}
                    <b className="text-neutral-600 dark:text-neutral-300">{s.trials.n}</b> 次
                    {s.trials.last_ts ? ` · 最近一次 ${ago(s.trials.last_ts)}` : ''}
                    <button
                      onClick={() => void openTrials(s.name)}
                      title="看这几次真实工作里它被用在哪、效果如何——挑几次当用例，就能量一遍了"
                      className="ml-1.5 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
                    >
                      {trialName === s.name ? '收起试用记录' : '看试用记录'}
                    </button>
                  </div>
                ) : null}
                {trialName === s.name ? (
                  <div className="mt-1.5 rounded-lg border border-neutral-200 p-2 dark:border-neutral-800">
                    {trialsBusy ? (
                      <p className="text-xs text-neutral-400">读着…</p>
                    ) : !trials || trials.n === 0 ? (
                      <p className="text-xs text-neutral-400">还没在真实工作里被用过。</p>
                    ) : (
                      <>
                        <p className="pb-1 text-xs text-neutral-400">
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
                                <span className="shrink-0 text-xs text-neutral-400">
                                  运行 #{t.run_id} · {fmtWhen(t.started_at)}
                                  {t.grounded == null ? ' · 未打分' : ` · 接地 ${t.grounded}/5`}
                                </span>
                                <button
                                  onClick={() => void addTrialAsCase(s.name, t.topic)}
                                  title="把这次试用的题目填进用例（intent 留给你写）"
                                  className="shrink-0 rounded-full border border-violet-200 px-2 py-0.5 text-xs text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-500/30 dark:text-violet-300 dark:hover:bg-violet-500/10"
                                >
                                  把这次当用例
                                </button>
                              </div>
                              {t.answer ? (
                                <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-neutral-400">
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
                    <p className="pb-1 text-xs text-neutral-400">
                      尺子得由人给 —— 模型自己出题自己考，考的是它会不会出题。
                      「它会收到什么」是真会问它的那句话；「它当时应该怎样」写清这条用例凭什么在集合里。
                    </p>
                    {caseDraft.map((c, i) => (
                      <div key={i} className="pb-1.5">
                        <div className="flex items-start gap-1">
                          <textarea
                            value={c.ask}
                            onChange={(e) =>
                              setCaseDraft((d) =>
                                d.map((x, j) => (j === i ? { ...x, ask: e.target.value } : x))
                              )
                            }
                            rows={2}
                            placeholder="它会收到什么（例：照着这篇论文复现它的评测口径）"
                            className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                          />
                          <button
                            onClick={() => setCaseDraft((d) => d.filter((_, j) => j !== i))}
                            title="删掉这条用例"
                            className="shrink-0 rounded border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-400 hover:text-rose-600 dark:border-neutral-700"
                          >
                            ✕
                          </button>
                        </div>
                        <input
                          value={c.intent}
                          onChange={(e) =>
                            setCaseDraft((d) =>
                              d.map((x, j) => (j === i ? { ...x, intent: e.target.value } : x))
                            )
                          }
                          placeholder="它当时应该怎样（一句话）"
                          className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                        />
                        <div className="flex flex-wrap gap-1 pt-1">
                          {checks.map((k) => {
                            const on = c.checks.includes(k.name)
                            return (
                              <button
                                key={k.name}
                                title={k.why}
                                onClick={() =>
                                  setCaseDraft((d) =>
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
                                className={`rounded-full border px-1.5 py-0.5 text-xs ${
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
                            <span className="text-xs text-neutral-400">
                              不勾就用默认那条：{defaultChecks.join('、')}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() =>
                          setCaseDraft((d) => [
                            ...d,
                            { id: '', intent: '', ask: '', checks: defaultChecks },
                          ])
                        }
                        className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
                      >
                        ＋ 再加一条
                      </button>
                      <button
                        onClick={() => void saveCases()}
                        disabled={casesBusy || caseDraft.every((c) => !c.ask.trim())}
                        className="rounded bg-violet-600 px-2 py-0.5 text-xs text-white hover:bg-violet-500 disabled:opacity-40"
                      >
                        {casesBusy ? '存着…' : '存进金标集'}
                      </button>
                      {casesMsg ? <span className="text-xs text-neutral-500">{casesMsg}</span> : null}
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {/* 长任务走 RunPanel 六态（方案 §六）。**这一条的停止是真的**：
            后端在每条用例之间查一次取消标记（合作式），所以当前那条会跑完才停。 */}
        {busyName ? (
          <div className="mt-2">
            <RunPanel
              phase="progress"
              tone="violet"
              icon="📏"
              title={`量一遍 · ${busyName}`}
              status={
                stoppingName === busyName
                  ? '正在停…（这一条跑完就停）'
                  : '正在跑——每条用例问两次（没它 / 有它）+ 判分，可能要几分钟'
              }
              onCancel={() => void stopMeasure(busyName)}
            />
          </div>
        ) : null}

        {evalRes ? (
          <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs dark:bg-neutral-900/50">
            {/* 半趟：**这不是一次跑分**。不写「失败」——它没失败，是被人停下的。 */}
            {evalRes.stopped ? (
              <p
                data-eval-stopped
                className="pb-1 text-amber-700 dark:text-amber-400"
              >
                停在第 {evalRes.total}/{evalRes.planned ?? evalRes.total} 条——**这不算一次跑分**：
                跑了一半的 k/n 会被读成「这份技能变差了」，所以既没写基线、也没有区间。
                <button
                  onClick={() => void measure({ name: evalRes.skill } as SkillCandidateRow)}
                  className="ml-2 rounded-full border border-amber-300 px-2 py-0.5 transition-colors hover:bg-amber-100 dark:border-amber-600 dark:hover:bg-amber-500/20"
                >
                  重跑
                </button>
              </p>
            ) : null}
            <p className="text-neutral-600 dark:text-neutral-300">
              「{evalRes.skill}」跑了 {evalRes.calls} 次调用（{evalRes.seconds}s）：过了{' '}
              {evalRes.with_passed}/{evalRes.total}
              {/* `ci` 为 null = 半趟（上面那句解释了为什么） */}
              {evalRes.ci
                ? `，区间 ${(evalRes.ci[0] * 100).toFixed(0)}–${(evalRes.ci[1] * 100).toFixed(0)}%`
                : ''}
            </p>
            <p className="text-neutral-500 dark:text-neutral-400">
              有它多过 {evalRes.deltas.helped} 条、少过 {evalRes.deltas.hurt} 条、一样{' '}
              {evalRes.deltas.same} 条
              {evalRes.follows_method != null ? ` · 跟着工序做 ${evalRes.follows_method}/5` : ''}
            </p>
            {!evalRes.stopped && !evalRes.tell ? (
              <p className="pt-1 text-amber-700 dark:text-amber-400">
                这个 n 下不了结论{evalRes.cases_needed > 0 ? `（还差 ${evalRes.cases_needed} 条用例才到能开口的量）` : ''}
                ：区间太宽，别拿它当好坏的证据。
              </p>
            ) : null}
          </div>
        ) : null}
        {evalErr ? <p className="pt-1 text-xs text-rose-600 dark:text-rose-400">{evalErr}</p> : null}
      </div>
    </section>
  )
}