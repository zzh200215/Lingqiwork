/** 实验室 —— 系统提示词的**对照台**（Q1 的界面）。
 *
 *  这一页刻意**不能改提示词**。内容活在源码里（`core/prompts.py` 的登记表 + 各自的模块），
 *  那是它唯一的事实来源；在这里改会立刻长出第二个真值。这一页能做的是**让它可测**：
 *  选一条 → 按 golden set 重放 → 看 `k/n`、Wilson 区间、每一条用例的成败与原文。
 *
 *  两个词的区别写在界面上，因为很容易混：
 *  - **登记表**（这一页）= 驱动系统行为的那些系统提示词（`core/prompts.py::_SPECS`），有 sha 指纹；
 *  - 设置页那个「提示词」= 你自己的片段库（存起来备用的一段文本，不带行为）。
 *  上一轮定的技能卡绑的是**前者**。
 *
 *  golden set 有两种形状，这一页按形状显示（判据是断言还是人工档位）：
 *  - **聊天型**：一句真实输入 + 它必须满足的断言 → 报告说「断言 x/y 过」；
 *  - **判分型**（重讲判分，PLAN2 P2-1）：卡三样 + 重讲原文 + **人工档位** → 报告说
 *    「档位一致 k/n」「差一档内」「高判/低判」，有争议的条目不进 k/n。
 *
 *  语气上的三条，与宠物那条线一致：
 *  - **不摆进度条**：没有「还差 3 条用例才能上线」，只有事实（几条、过没过、区间多宽）；
 *  - **区间宽就说宽**：n 小的时候明说「这个样本量下不了结论」，不给一个好看的比例；
 *  - **候选只是候选**：跑出来的变体永远不改登记表，要采纳得去改代码（改完 sha 会变）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import {
  api,
  type PromptCheckReport,
  type PromptRegistryEntry,
  type PromptRegistryEntryDetail,
} from './api'
import EmptyHint from './EmptyHint'
import RunPanel from './RunPanel'

/** 判分型金标集（P2-1）的四档 + 一个「不判」。**0 不是一档**：它是「人工也认为
 *  这时候该判不了」（卡上没有答案）——与 `retell.read_card` 里那个 `grade: 0` 同义。 */
const GRADE_LABEL: Record<number, string> = { 0: '不判', 1: '重来', 2: '困难', 3: '良好', 4: '简单' }

/** 区间宽度这件事要摆在明面上——宽到没法下结论时说清楚，而不是给个数字让它自己看。 */
function ciText(lo: number, hi: number): string {
  return `${Math.round(lo * 100)}%–${Math.round(hi * 100)}%`
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

function when(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ')
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`
}

/** 一条提示词在列表里的状态徽章——只有三种事实，没有第四种「加油」。 */
function Status({ p }: { p: PromptRegistryEntry }) {
  if (p.drifted) {
    return <span className="rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-600 dark:bg-rose-950/50 dark:text-rose-300">登记漂移</span>
  }
  if (!p.cases) {
    return <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">没有用例</span>
  }
  if (!p.baseline) {
    return <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">没有基线</span>
  }
  if (p.baseline.stale) {
    return <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">基线过期</span>
  }
  return (
    <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
      {p.baseline.passed}/{p.baseline.cases} · {pct(p.baseline.rate)}
    </span>
  )
}

export default function PromptLab() {
  const [list, setList] = useState<PromptRegistryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [key, setKey] = useState<string>('')
  const [detail, setDetail] = useState<PromptRegistryEntryDetail | null>(null)
  const [report, setReport] = useState<PromptCheckReport | null>(null)
  const [busy, setBusy] = useState(false)
  /** 已经点了「停止」、但这一条还没跑完（合作式取消的中间态）。 */
  const [stopping, setStopping] = useState(false)
  const [variant, setVariant] = useState('')
  const [label, setLabel] = useState('')
  const [showContent, setShowContent] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 喂食：把小屋技能卡 / 别的页面指过来的那一条直接打开（`/work?tab=prompt&prompt=FEYNMAN_PROMPT`）
  const [params] = useSearchParams()
  const wantKey = params.get('prompt') ?? ''
  // 喂食表单：从哪来（报告里那一条的输入原样带过来）+ 意图 + 勾的断言
  const [feed, setFeed] = useState<{ open: boolean; user: string; intent: string; checks: string[] }>(
    { open: false, user: '', intent: '', checks: [] }
  )
  const [feedMsg, setFeedMsg] = useState('')
  // 领域（Q3 形态）：这套用例测的是哪个领域。写进 golden set 文件（跟着进 git），
  // 技能卡按它进对应的枝——所以这里是**唯一**给技能那一边标领域的地方。
  const [domain, setDomain] = useState('')
  const [domainMsg, setDomainMsg] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await api.promptRegistry()
      setList(r.prompts)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openKey = useCallback(async (k: string) => {
    setKey(k)
    setDetail(null)
    setReport(null)
    setErr(null)
    setShowContent(false)
    setFeed({ open: false, user: '', intent: '', checks: [] })
    setFeedMsg('')
    try {
      setDetail(await api.promptEntry(k))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // 深链：`?prompt=` 指过来的那一条直接打开（技能卡「去实验室」就是这么跳的）
  useEffect(() => {
    if (wantKey && list && !key) void openKey(wantKey)
  }, [wantKey, list, key, openKey])

  // 换一条提示词 / 重跑之后，领域框跟着那套 golden set 走
  useEffect(() => {
    setDomain(detail?.domain ?? '')
    setDomainMsg('')
  }, [detail])

  /** 给这套 golden set 标领域（写的是用例文件，提示词一个字节都不动）。 */
  const saveDomain = useCallback(async () => {
    if (!key) return
    setErr(null)
    try {
      const r = await api.setPromptDomain(key, domain)
      setDomainMsg(r.domain ? `领域：${r.domain}` : '已清掉领域')
      setDetail(await api.promptEntry(key))
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [key, domain, load])

  /** 喂一条用例：改动落在 `backend/evals/prompts/*.json` 里，所以界面明说要提交。 */
  const submitFeed = useCallback(async () => {
    if (!key) return
    setErr(null)
    try {
      const made = await api.addPromptCase(key, {
        user: feed.user,
        intent: feed.intent,
        checks: feed.checks,
      })
      setFeed({ open: false, user: '', intent: '', checks: [] })
      setFeedMsg(`已喂进金标集：${made.id}（写进了 ${detail?.fixture || 'golden set'}，记得提交）`)
      setDetail(await api.promptEntry(key))
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [key, feed, detail, load])

  const dropCase = useCallback(
    async (caseId: string) => {
      if (!key) return
      if (!window.confirm(`把用例「${caseId}」从金标集里删掉？（写进 golden set 文件，git 里看得见）`))
        return
      setErr(null)
      try {
        await api.removePromptCase(key, caseId)
        setFeedMsg(`已删掉用例 ${caseId}`)
        setDetail(await api.promptEntry(key))
        await load()
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    },
    [key, load]
  )

  const run = useCallback(async () => {
    if (!key || busy) return
    setBusy(true)
    setStopping(false)
    setErr(null)
    try {
      const body: { variant?: string; variant_label?: string } = {}
      if (variant.trim()) {
        body.variant = variant
        body.variant_label = label.trim() || '候选变体'
      }
      setReport(await api.checkPrompt(key, body))
      // 跑完顺手刷新列表：基线与状态徽章都变了
      await load()
      setDetail(await api.promptEntry(key))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setStopping(false)
    }
  }, [key, busy, variant, label, load])

  /** 请这一趟停下。**合作式**：后端在每条用例之间查一次，所以当前那条会跑完才停
   *  ——按钮上写的因此是「正在停…（这一条跑完就停）」，不是「已停止」。
   *
   *  `stopped: false` = 后端那边没有在跑的（比如刚好已经跑完了）。那时什么都不用改：
   *  原来那一趟的响应马上就到。 */
  const cancel = useCallback(async () => {
    if (!key) return
    setStopping(true)
    try {
      const r = await api.cancelPromptCheck(key)
      if (!r.stopped) setStopping(false)
    } catch (e) {
      setStopping(false)
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [key])

  const grouped = useMemo(() => {
    const out = new Map<string, PromptRegistryEntry[]>()
    for (const p of list ?? []) {
      const arr = out.get(p.module) ?? []
      arr.push(p)
      out.set(p.module, arr)
    }
    return [...out.entries()]
  }, [list])

  if (error) {
    return <div className="text-sm text-red-600 dark:text-red-300">读登记表出错了：{error}</div>
  }
  if (!list) return <div className="text-sm text-neutral-400">正在读登记表…</div>

  const withCases = list.filter((p) => p.cases > 0)

  return (
    <div data-lab-root className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      {/* 左：32 条登记提示词 */}
      <div className="rounded-md border border-neutral-200 dark:border-neutral-800">
        <div className="flex items-baseline gap-2 border-b border-neutral-100 px-3 py-2 dark:border-neutral-800">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
            登记表 {list.length} 条
          </span>
          <div className="flex-1" />
          <span className="text-xs text-neutral-400">
            有用例的 {withCases.length}
          </span>
        </div>
        <div className="max-h-[560px] overflow-y-auto p-1.5">
          {grouped.map(([mod, items]) => (
            <div key={mod} className="mb-1">
              <div className="px-2 py-1 text-xs text-neutral-400">{mod}</div>
              {items.map((p) => (
                <button
                  key={p.name}
                  data-lab-item={p.name}
                  onClick={() => void openKey(p.name)}
                  className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                    p.name === key
                      ? 'bg-neutral-200/70 dark:bg-neutral-700/60'
                      : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/60'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs text-neutral-700 dark:text-neutral-200">
                      {p.name}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <Status p={p} />
                      <span className="truncate text-xs text-neutral-400">{p.sha}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* 右：选中那条的全貌 + 对照报告 */}
      <div className="min-w-0">
        {!key ? (
          <EmptyHint
            title="选左边一条，看它的 golden set 与跑分。"
            hint="这一页不能改提示词——内容活在源码里。它只做一件事：让「改了以后变好还是变坏」有证据。"
          />
        ) : !detail ? (
          <div className="text-sm text-neutral-400">正在读这一条…</div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-sm text-neutral-800 dark:text-neutral-100">
                  {detail.name}
                </span>
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  {detail.kind}
                </span>
                <span className="font-mono text-xs text-neutral-400">{detail.sha}</span>
                <div className="flex-1" />
                <button
                  onClick={() => setShowContent((v) => !v)}
                  className="text-xs text-neutral-400 hover:text-violet-500"
                >
                  {showContent ? '收起内容' : '看内容（只读）'}
                </button>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                {detail.purpose}
              </p>
              <div className="mt-1 text-xs text-neutral-400">{detail.module}</div>
              {showContent && (
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-2 text-xs leading-relaxed text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
                  {detail.content}
                </pre>
              )}
            </div>

            {/* golden set：用例 + 断言（每条断言引提示词的原句） */}
            <div className="rounded-md border border-neutral-200 dark:border-neutral-800">
              <div className="flex items-baseline gap-2 border-b border-neutral-100 px-3 py-2 dark:border-neutral-800">
                <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                  golden set {detail.cases.length} 条
                </span>
                <input
                  data-lab-domain
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveDomain()
                  }}
                  onBlur={() => {
                    if (domain !== (detail.domain ?? '')) void saveDomain()
                  }}
                  placeholder="领域"
                  title="这套用例测的是哪个领域。形态（工作页「形态」标签）按它把这套用例算进对应的枝——空 = 还没归类。同一个领域要写同一个词。"
                  className="w-20 rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-xs text-neutral-600 outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                />
                {domainMsg ? (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400">
                    {domainMsg}
                  </span>
                ) : null}
                <div className="flex-1" />
                <span className="text-xs text-neutral-400">{detail.fixture}</span>
                {/* 判分型的金标集不从界面喂：它的用例是「卡三样 + 重讲 + 人工档位」，
                    没有断言可勾（后端也当场拒绝）。要加一条就去改那个 JSON。 */}
                {detail.case_kind === 'grade' ? null : (
                  <button
                    data-lab-feed-open
                    onClick={() =>
                      setFeed({ open: !feed.open, user: '', intent: '', checks: [] })
                    }
                    className="text-xs text-violet-500 hover:underline"
                  >
                    {feed.open ? '收起' : '喂一条进来'}
                  </button>
                )}
              </div>

              {/* 喂食表单：这一整套的入口只有一句话——把真实踩到的那句抄进来 */}
              {feed.open && (
                <div
                  data-lab-feed
                  className="space-y-2 border-b border-neutral-100 bg-violet-50/40 px-3 py-2.5 dark:border-neutral-800 dark:bg-violet-500/5"
                >
                  <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                    喂的是用例：一次真实输入 + 一句「它当时应该怎样」+ 它必须满足的断言。
                    改动写进 <span className="font-mono">{detail.fixture}</span>（进 git，可审可回滚）
                    ——提示词本身一个字节都不动。
                  </p>
                  <textarea
                    data-lab-feed-user
                    value={feed.user}
                    onChange={(e) => setFeed((f) => ({ ...f, user: e.target.value }))}
                    placeholder="那次的真实输入（把它原样抄进来）"
                    className="h-16 w-full rounded-lg border border-neutral-300 bg-white p-2 text-xs text-neutral-700 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                  />
                  <input
                    data-lab-feed-intent
                    value={feed.intent}
                    onChange={(e) => setFeed((f) => ({ ...f, intent: e.target.value }))}
                    placeholder="它当时应该怎样（一句话——没有这句的用例日后没人看得懂）"
                    className="w-full rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-700 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {detail.checks.map((c) => {
                      const on = feed.checks.includes(c.name)
                      return (
                        <button
                          key={c.name}
                          data-lab-feed-check={c.name}
                          title={c.why}
                          onClick={() =>
                            setFeed((f) => ({
                              ...f,
                              checks: on
                                ? f.checks.filter((x) => x !== c.name)
                                : [...f.checks, c.name],
                            }))
                          }
                          className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                            on
                              ? 'border-violet-400 bg-violet-100 text-violet-700 dark:border-violet-500/60 dark:bg-violet-500/20 dark:text-violet-200'
                              : 'border-neutral-300 text-neutral-500 hover:border-violet-300 dark:border-neutral-700 dark:text-neutral-400'
                          }`}
                        >
                          {c.name}
                        </button>
                      )
                    })}
                  </div>
                  <button
                    data-lab-feed-save
                    onClick={() => void submitFeed()}
                    disabled={!feed.user.trim() || !feed.intent.trim() || feed.checks.length === 0}
                    className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
                  >
                    喂进金标集
                  </button>
                </div>
              )}

              {feedMsg && (
                <div
                  data-lab-feed-msg
                  className="border-b border-neutral-100 bg-emerald-50/60 px-3 py-1.5 text-xs text-emerald-700 dark:border-neutral-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                >
                  {feedMsg}
                </div>
              )}

              <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {detail.cases.map((c) => (
                  <li key={c.id} data-lab-case={c.id} className="px-3 py-2 text-xs">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
                        {c.id}
                      </span>
                      <span className="text-neutral-400 dark:text-neutral-500">{c.intent}</span>
                      <div className="flex-1" />
                      {c.grade != null ? (
                        <span
                          data-lab-case-grade={c.id}
                          className={`shrink-0 rounded px-1 py-0.5 text-xs ${
                            c.contested
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300'
                              : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
                          }`}
                          title={
                            c.contested
                              ? c.why || '这条的档位有争议：不计进 k/n'
                              : '人工档位（这套金标集的基准）'
                          }
                        >
                          人工 {GRADE_LABEL[c.grade] ?? c.grade}
                          {c.contested ? ' · 有争议' : ''}
                        </span>
                      ) : null}
                      {/* 判分型的用例不从界面删：它的条数有下限（30 条），一条条删很容易在
                          不知情的情况下把整套跑到跑不动。出口在文件里（后端也会拒）。 */}
                      {detail.case_kind === 'grade' ? null : (
                        <button
                          data-lab-case-drop={c.id}
                          onClick={() => void dropCase(c.id)}
                          title="从金标集里删掉这条（坏用例会污染指标）"
                          className="shrink-0 text-xs text-neutral-400 hover:text-rose-500"
                        >
                          删
                        </button>
                      )}
                    </div>
                    {c.grade != null ? (
                      <>
                        <div className="mt-1 text-neutral-600 dark:text-neutral-300">
                          题面：{c.front || '（空）'}
                        </div>
                        <div className="mt-0.5 text-neutral-500 dark:text-neutral-400">
                          答案：{c.back || '（这张卡没写答案——这时唯一正确的动作是「判不了」）'}
                        </div>
                        <div className="mt-0.5 text-neutral-600 dark:text-neutral-300">
                          重讲：「{c.retell}」
                        </div>
                      </>
                    ) : (
                      <div className="mt-1 text-neutral-600 dark:text-neutral-300">「{c.user}」</div>
                    )}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.checks.map((n) => (
                        <span
                          key={n}
                          title={detail.checks.find((x) => x.name === n)?.why ?? ''}
                          className="rounded bg-neutral-100 px-1 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="border-t border-neutral-100 px-3 py-2 text-xs leading-relaxed text-neutral-400 dark:border-neutral-800">
                {detail.case_kind === 'grade'
                  ? '判分型的用例：卡三样 + 重讲原文 + 人工档位。判据是人工档位（这套集合的基准，不是真理）——每条 intent 写着为什么是这一档，人要能审。'
                  : '每条断言都对应提示词自己的一句话（鼠标停在断言上看是哪句）。断言写错名字会**当场算不过**，不会静默放过。'}
              </p>
            </div>

            {/* 跑一次 */}
            <div className="rounded-md border border-violet-200 bg-violet-50/40 p-3 dark:border-violet-500/40 dark:bg-violet-500/5">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  data-lab-run
                  onClick={() => void run()}
                  disabled={busy || detail.cases.length === 0}
                  className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
                >
                  {busy ? '正在跑…' : variant.trim() ? '跑候选变体' : '跑一次对照（已登记内容）'}
                </button>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {detail.cases.length} 条用例 = {detail.cases.length} 次模型调用
                </span>
              </div>

              {/* 长任务走 RunPanel 六态（方案 §六）。
                  **这条不是流式的**：只有 progress → done/error 三个态是真的，
                  planning/streaming 编不出来，也不该编。停止是真停（后端合作式取消）。 */}
              {busy ? (
                <div className="mt-2">
                  <RunPanel
                    phase="progress"
                    tone="violet"
                    icon="🧪"
                    title="跑一次对照"
                    status={
                      stopping
                        ? '正在停…（这一条跑完就停）'
                        : `正在跑 ${detail.cases.length} 条用例——每条一次模型调用，可能要几分钟`
                    }
                    onCancel={() => void cancel()}
                  />
                </div>
              ) : null}

              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-neutral-500 hover:text-violet-500 dark:text-neutral-400">
                  拿一段候选变体比一比（它不会进登记表）
                </summary>
                <textarea
                  value={variant}
                  onChange={(e) => setVariant(e.target.value)}
                  placeholder="把想试的那版提示词贴在这里。跑完报告会告诉你比基线好还是坏——要采纳仍然得去改代码。"
                  className="mt-2 h-28 w-full rounded-lg border border-neutral-300 bg-white p-2 text-xs text-neutral-700 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                />
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="给它起个名字（例如：试·加一句别用术语）"
                  className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                />
              </details>
            </div>

            {err && (
              <div className="rounded-lg bg-red-100 px-3 py-2 text-xs text-red-600 dark:bg-red-950/60 dark:text-red-300">
                {err}
              </div>
            )}

            {/* 报告 */}
            {report && (
              <div data-lab-report className="space-y-3">
                {/* 半趟：**这不是一次跑分**。说清「没落库、没区间」，并且给一颗重跑。
                    不写「失败」——它没失败，是被人停下的。 */}
                {report.stopped ? (
                  <div
                    data-lab-stopped
                    className="rounded-md border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                  >
                    停在第 {report.total}/{report.planned ?? report.total} 条——**这不算一次跑分**：
                    跑了一半的 k/n 会被读成「变差了」，所以既没落库、也没有区间。
                    <button
                      onClick={() => void run()}
                      className="ml-2 rounded-full border border-amber-300 px-2 py-0.5 transition-colors hover:bg-amber-100 dark:border-amber-600 dark:hover:bg-amber-500/20"
                    >
                      重跑
                    </button>
                  </div>
                ) : null}
                <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-2xl font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
                      {report.passed}/{report.total}
                    </span>
                    {/* `ci` 为 null = 半趟（上面那条横幅解释了为什么） */}
                    {report.ci ? (
                      <span className="text-sm text-neutral-500 dark:text-neutral-400">
                        Wilson {ciText(report.ci[0], report.ci[1])}
                      </span>
                    ) : null}
                    {report.variant_sha ? (
                      <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">
                        候选 {report.variant_label}
                      </span>
                    ) : (
                      <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                        已登记内容
                      </span>
                    )}
                    <div className="flex-1" />
                    <span className="text-xs tabular-nums text-neutral-400">
                      {report.calls} 次调用 · {report.seconds}s
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-neutral-400">
                    {report.report_kind === 'grade' ? (
                      <>
                        档位一致 {report.passed}/{report.total}
                        {report.near != null && (
                          <>
                            {' · '}差一档内{' '}
                            <span title="有序档位上的第二个数：判低一档与判反了不是一件事">
                              {report.near}/{report.total}（{report.near_rate != null ? pct(report.near_rate) : '—'}）
                            </span>
                          </>
                        )}
                        {report.over != null && (
                          <>
                            {' · '}高判 {report.over} / 低判 {report.under}
                            <span className="text-neutral-300 dark:text-neutral-600">
                              （它承诺「宁可低判不高判」）
                            </span>
                          </>
                        )}
                        {report.fallback ? <> · 说判不了 {report.fallback}</> : null}
                      </>
                    ) : (
                      <>
                        断言 {report.assertions.total - report.assertions.failed}/
                        {report.assertions.total} 过
                      </>
                    )}
                    {report.baseline
                      ? ` · 基线 ${report.baseline.passed}/${report.baseline.total}`
                      : ' · 没有基线可比（这是第一次）'}
                    {report.tell ? ' · 样本量够分辨' : ' · ⚠️ 区间太宽，这个 n 下不了结论'}
                  </div>
                  {report.report_kind === 'grade' && report.matrix && (
                    <div className="mt-1.5 text-xs tabular-nums text-neutral-400">
                      <span title="行 = 人工档位，列 = 它判的档位">
                        矩阵（行=人工，列=它判 0–4）：
                      </span>
                      {Object.entries(report.matrix).map(([exp, row]) => (
                        <span key={exp} className="ml-1.5 font-mono">
                          {GRADE_LABEL[Number(exp)] ?? exp}
                          {['0', '1', '2', '3', '4'].map((g) => row[g] ?? 0).join('/')}
                        </span>
                      ))}
                    </div>
                  )}
                  {report.report_kind === 'grade' && (report.contested?.length ?? 0) > 0 && (
                    <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                      有争议、不计分：
                      {report.contested?.map((c) => (
                        <span key={c.id} className="ml-1 font-mono" title={c.why}>
                          {c.id}
                        </span>
                      ))}
                      <span className="text-neutral-400">
                        （人工档位有争议的用例不进 k/n——拿犹豫冒充一个数更糟）
                      </span>
                    </div>
                  )}
                  {report.flips.length > 0 && (
                    <div className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                      翻面：
                      {report.flips.map((f) => (
                        <span key={f.id} className="ml-1 font-mono">
                          {f.id}
                          {f.now ? '↑' : '↓'}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-1 text-xs text-neutral-400">{report.context}</div>
                </div>

                <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                  {report.cases.map((c) => (
                    <li key={c.id} data-lab-result={c.id} className="px-3 py-2 text-xs">
                      <div className="flex items-baseline gap-2">
                        <span
                          className={
                            c.passed
                              ? 'text-emerald-500'
                              : c.contested || c.near
                                ? 'text-amber-500'
                                : 'text-rose-500'
                          }
                        >
                          {c.passed ? '✓' : c.contested ? '~' : c.near ? '≈' : '✗'}
                        </span>
                        <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
                          {c.id}
                        </span>
                        {c.expect != null ? (
                          <span className="shrink-0 text-xs text-neutral-400">
                            人工 {GRADE_LABEL[c.expect] ?? c.expect} · 它判{' '}
                            {c.fallback ? '不判' : (GRADE_LABEL[c.got ?? 0] ?? c.got)}
                          </span>
                        ) : null}
                        <div className="flex-1" />
                        {/* 判分型的用例不进「喂一条」那个表单：它的判据是人工档位，不是断言 */}
                        {detail.case_kind === 'grade' ? null : (
                        <button
                          data-lab-feed-from={c.id}
                          onClick={() => {
                            // 把这一条的**输入原样**带进表单：喂的是「它当时该怎样」，
                            // 不是重新编一个输入
                            setFeed({
                              open: true,
                              user: c.user,
                              intent: '',
                              checks: [
                                ...new Set([
                                  ...c.failed.map((f) => f.name),
                                  ...c.checks.filter((n) =>
                                    detail.checks.some((x) => x.name === n)
                                  ),
                                ]),
                              ].filter((n) => detail.checks.some((x) => x.name === n)),
                            })
                            setFeedMsg('')
                          }}
                          title="把它喂进金标集（写一句「它当时应该怎样」）"
                          className="shrink-0 text-xs text-violet-500 hover:underline"
                        >
                          喂进金标集
                        </button>
                        )}
                        <span className="text-xs tabular-nums text-neutral-400">
                          {c.chars ? `${c.chars} 字 · ` : ''}
                          {c.seconds}s
                        </span>
                      </div>
                      {c.failed.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {c.failed.map((f) => (
                            <li key={f.name} className="text-xs text-rose-500">
                              {f.name}：{f.why}
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="mt-1 whitespace-pre-wrap rounded-lg bg-neutral-50 px-2 py-1 text-xs leading-relaxed text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
                        {c.error ? `调用出错：${c.error}` : c.reply || '（空回复）'}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 历史 */}
            {detail.runs.length > 0 && (
              <div className="rounded-md border border-neutral-200 dark:border-neutral-800">
                <div className="border-b border-neutral-100 px-3 py-2 text-xs font-medium text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
                  跑分历史
                </div>
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {detail.runs.map((r) => (
                    <li key={r.id} className="flex items-baseline gap-2 px-3 py-1.5 text-xs">
                      <span className="tabular-nums text-neutral-400">{when(r.at)}</span>
                      <span className="tabular-nums text-neutral-600 dark:text-neutral-300">
                        {r.passed}/{r.cases}
                      </span>
                      <span className="text-neutral-400">
                        {ciText(r.ci_low, r.ci_high)}
                      </span>
                      <span className="truncate font-mono text-xs text-neutral-400">
                        {r.variant_sha ? r.variant_sha : r.prompt_sha}
                      </span>
                      {r.variant_label && (
                        <span className="truncate text-xs text-violet-500">
                          {r.variant_label}
                        </span>
                      )}
                      <div className="flex-1" />
                      <span className="text-neutral-400">{r.model_id}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
