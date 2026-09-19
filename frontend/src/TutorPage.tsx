import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import AttachToThread from './AttachToThread'
import { CONCEPT_STATE, CONCEPT_STATES, type ConceptState } from './conceptState'
import FeedbackButtons from './FeedbackButtons'
import InjectedLine from './InjectedLine'
import { Markdown, reportMarkdown, SourceList } from './markdown'
import OutputCard from './OutputCard'
import RunPanel from './RunPanel'
import { TUTOR_TABS, type TutorTab } from './routes'
import {
  api,
  type CardDraft,
  type CardSources,
  type InterviewBank,
  type InterviewReportResult,
  type InterviewReportSections,
  type RoundtableResult,
  type TutorConceptRow,
  type TutorDigestPoint,
  type TutorDigestResult,
  type TutorEndResult,
  type TutorLearningMap,
  type TutorMastery,
  type TutorNeighbor,
  type TutorSessionRow,
  type TutorStarter,
  type TutorStats,
  type TutorStuckRow,
  type TutorTurn,
} from './api'
import {
  streamCardsGenerate,
  streamConflict,
  streamDecide,
  streamResearch,
  streamTutorSay,
  type ConflictReport,
  type DecideFrame,
  type DecideReport,
  type ReportDraft,
  type ResearchReport,
  type TutorMaterialSource,
  type TutorRecallHit,
} from './stream'

// 对话式教学 (第一步). You name something to understand, it asks
// before it explains, and a session ends as 概念 / 自评 / 卡点.
//
// What is deliberately absent is the point: no due dates, no queue, no streak, no
// daily count. That is the single test — the moment a widget here
// produces the feeling of owing something, this is the Anki page again under a
// new name. The history rail is history, never a to-do list.

const VERDICTS = [
  { v: 'got' as const, label: '搞懂了', cls: 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-500/10' },
  { v: 'half' as const, label: '半懂', cls: 'border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-500/10' },
  { v: 'useless' as const, label: '没用', cls: 'border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-400 dark:hover:bg-neutral-800' },
]

const VERDICT_LABEL: Record<string, string> = {
  got: '搞懂了',
  half: '半懂',
  useless: '没用',
}

// 会话里的讲法快捷指令（ChatGPT Study Mode 参考）：一键发指令，不用自己组织措辞。
// 最后一条是反转——让它考你，等你答了再评，不是直接讲。
const QUICK_ASKS: [string, string][] = [
  ['更简单地讲', '我没完全跟上。用更简单、更基础的方式再讲一遍，少用术语。'],
  ['举个例子', '举一个具体的例子，最好是我熟悉领域里的。'],
  ['换个角度', '换个角度再讲一遍这个点。'],
  ['考我一题', '就这个话题考我一道题。先别给答案，等我答了你再点评。'],
]

/** 右栏「学到哪了」一屏列多少个概念；更多的靠会话历史翻（纯展示上限，不落库）。 */
const CONCEPT_RAIL_CAP = 12

/** 「按点出卡」一次出几张。一个点的卡面要窄——3 张足够覆盖它，再多就是重复。 */
const POINT_CARDS = 3

/** 按点出卡的请求体。**材料必须和当初拆点用的那份一模一样**：有来源文件就用文件，
 *  粘贴模式就用当初粘进去的那段（调用方一直存着它）。
 *
 *  **绝不能拿点标题当材料**：一个点是十几个字的一句话，而后端 `MIN_INPUT_CHARS = 80`
 *  会直接 400（"文本太短"）。这个坑是浏览器实测抓到的——单测覆盖不到前端这段。
 *  既然拆点本身走的就是同一个 80 字下限，能拆出点就说明这份材料一定够长。 */
export function pointCardBody(
  point: string,
  dg: { source: string } | null,
  pastedText: string
): { source_path: string; focus: string; count: number } | { text: string; focus: string; count: number } {
  const src = dg?.source || ''
  return src
    ? { source_path: src, focus: point, count: POINT_CARDS }
    : { text: pastedText, focus: point, count: POINT_CARDS }
}

/** The one thing that makes this more than a chat wrapper, so it is shown, not
 * hidden: 验收 asks whether recall fired AND whether it was right, and only the
 * user can judge the second half. */
export function RecallChip({ hits }: { hits: TutorRecallHit[] }) {
  if (hits.length === 0) return null // 自防护：空命中不该留下一个空壳标题
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-sm dark:border-violet-500/30 dark:bg-violet-500/10">
      <p className="pb-1 text-[11px] font-medium uppercase tracking-wider text-violet-500 dark:text-violet-300">
        接上了以前的记录
      </p>
      {hits.map((h) => (
        <p key={h.concept + h.date} className="text-neutral-700 dark:text-neutral-300">
          ↳ <span className="font-medium">{h.concept}</span>（
          {h.verdict === 'half' ? '半懂' : '说通了'}，{h.date}）
          {h.stuck ? <span className="text-neutral-500">，当时卡在：{h.stuck}</span> : null}
        </p>
      ))}
    </div>
  )
}

/** 「又卡住」的标：概念行上一个琥珀色小 chip。传 `null` 就不画。
 *
 *  **它为什么在这里、而不是新开一栏**：这个信号本来就是「卡住」那一档里更窄的一批
 *  （接住过卡在哪、最近一次还是半懂、就在这几天），另起一栏等于把同一批概念摆两遍。
 *  判据在后端一处（`tutor.is_recurring_mistake`），也是零柒那句「又卡住了」的同一判据——
 *  界面上的标与它嘴里的话因此**永远是同一批**。
 *
 *  title 里写的是事实（接住过几次），不是「你还欠几次」：这是标记，不是待办。 */
export function RepeatChip({ c }: { c: TutorConceptRow | null }) {
  if (!c) return null
  return (
    <span
      data-concept-repeat={c.concept}
      title={`接住过你卡在哪 ${c.recalled} 次，最近一次还是半懂——零柒那句「又卡住了」说的就是这一批`}
      className="shrink-0 rounded-full bg-amber-50 px-1.5 text-[10px] text-amber-600 dark:bg-amber-500/10 dark:text-amber-300"
    >
      又卡住
    </span>
  )
}

/** 报告的三栏（空的整栏不摆）。抽成纯函数是为了让 JSX 里那层索引别再猜类型。 */
export function reportGroups(
  s: InterviewReportSections
): { label: string; items: string[]; teachable: boolean }[] {
  return [
    { label: '答得稳的', items: s.solid ?? [], teachable: false },
    { label: '卡壳的', items: s.stuck ?? [], teachable: true },
    { label: '建议回头搞懂', items: s.teach_next ?? [], teachable: true },
  ].filter((g) => g.items.length > 0)
}

/** 面试陪练的收尾行（M3 · PLAN §3 G3）：进度 + 出复盘报告 + 报告本身。
 *
 *  三件事都在这里说清楚：
 *  - **进度是数出来的**（助手轮次），不是另一个计数器；
 *  - 报告落 `vault/reports/`（**不算"成品"**：不计成长值、不上小屋架子、没有那句
 *    「交出去了」——它是给你自己看的，界面上不吹成一件交付）；
 *  - 每一条卡壳/建议再讲都能**一键开一场教学**——那才是「进卡点清单」的现有路径
 *    （教学里记的卡点才进卡点清单；面试不是教学，不替它造记录）。
 */
export function InterviewRow({
  sid,
  turns,
  busy,
  onTeach,
}: {
  sid: number | null
  turns: number
  busy: boolean
  onTeach: (topic: string) => void
}) {
  const [busyReport, setBusyReport] = useState(false)
  const [rep, setRep] = useState<InterviewReportResult | null>(null)
  const [msg, setMsg] = useState('')

  const make = async () => {
    if (sid === null || busyReport) return
    setBusyReport(true)
    setMsg('')
    try {
      const r = await api.interviewReport(sid)
      if (!r.ok) {
        setMsg(r.reason || '报告没生成出来')
        return
      }
      setRep(r)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyReport(false)
    }
  }

  const asked = Math.max(0, turns - 1) // 第一轮是开场那句话，问过的题 = 助手轮次
  const s = rep?.sections

  return (
    <div data-interview-row className="space-y-2 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
          面试
        </span>
        <span className="text-[11px] text-neutral-400">
          问过 {asked} 题{asked > 0 && asked < 5 ? '（5–8 题一场）' : ''}
        </span>
        <button
          data-interview-report
          onClick={() => void make()}
          disabled={busy || busyReport || turns === 0}
          title="读完整场对话出一份复盘报告（一次模型调用），落到 vault/reports/"
          className="rounded-lg border border-violet-300 px-2.5 py-1 text-xs text-violet-600 transition-colors hover:bg-violet-50 disabled:opacity-40 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-500/10"
        >
          {busyReport ? '写报告中…' : rep ? '再出一份' : '出复盘报告'}
        </button>
        {msg ? <span className="text-[11px] text-amber-600 dark:text-amber-400">{msg}</span> : null}
      </div>

      {s ? (
        <div
          data-interview-report-body
          className="space-y-2 rounded-xl border border-violet-200 bg-violet-50/40 p-3 text-xs dark:border-violet-500/30 dark:bg-violet-500/5"
        >
          {s.summary ? (
            <p className="text-neutral-700 dark:text-neutral-200">{s.summary}</p>
          ) : null}
          {reportGroups(s).map((g) => (
            <div key={g.label}>
              <p className="pb-0.5 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                {g.label}
              </p>
              <ul className="space-y-0.5">
                {g.items.map((x) => (
                  <li key={x} className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 text-neutral-700 dark:text-neutral-200">
                      · {x}
                    </span>
                    {/* 卡壳的那两栏才有「去搞懂」：报告里点一下，**开一场教学**
                        （现有路径）——那条路记的卡点才进卡点清单 */}
                    {g.teachable ? (
                      <button
                        data-teach={x}
                        onClick={() => onTeach(x)}
                        title="开一场教学专门搞懂它（卡点会进卡点清单）"
                        className="shrink-0 text-[11px] text-violet-600 hover:underline dark:text-violet-300"
                      >
                        去搞懂 →
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {rep?.path ? (
            <p className="pt-0.5 text-[11px] text-neutral-400">
              报告已落{' '}
              <a
                href={`/notes?path=${encodeURIComponent(rep.path)}`}
                target="_blank"
                rel="noreferrer"
                className="text-violet-600 hover:underline dark:text-violet-300"
              >
                {rep.path}
              </a>
              （{rep.chars} 字）· 题库文件没有被改过
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Server turns carry role+content only; sources ride along on the reply the
 * turn was streamed for, so 取材来源 stays attached to the bubble that used it. */
type Turn = TutorTurn & { sources?: TutorMaterialSource[] }
/** chroma 元数据里的 title 是文件名去后缀（「index」），没有信息量；路径尾部两段才认得出位置 */
export function shortSource(source: string): string {
  const parts = source.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

export function MaterialLine({ sources }: { sources: TutorMaterialSource[] }) {
  return (
    <p className="text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
      取材：
      {sources.map((s, i) => (
        <span key={i} className="ml-1.5 rounded bg-neutral-200/70 px-1.5 py-0.5 dark:bg-neutral-700/60">
          {shortSource(s.source)}
        </span>
      ))}
    </p>
  )
}

function Bubble({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-violet-600 px-4 py-2.5 text-sm text-white">
          {turn.content}
        </div>
      </div>
    )
  }
  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-neutral-100 px-4 py-3 dark:bg-neutral-800/70">
      <Markdown>{turn.content}</Markdown>
      {turn.sources && turn.sources.length > 0 ? (
        <div className="mt-2 border-t border-neutral-200/70 pt-1.5 dark:border-neutral-700/70">
          <MaterialLine sources={turn.sources} />
        </div>
      ) : null}
    </div>
  )
}

/** 跑完了的一行回执：整篇正文收成一行，指到已存的产物（/notes 详情页）。
 *  流式 / 出错态不套这个——那时候正文正是要看的；「读全文」随时能把它展开回来。
 *  导出是为了单测——整页渲染设施这个仓库还没有。 */
export function ReceiptLine({ title, meta, saved }: { title: string; meta: string; saved: string }) {
  return (
    <OutputCard
      title={title}
      meta={saved ? `${meta} · 已存入` : meta}
      href={saved ? `/notes?path=${encodeURIComponent(saved)}` : undefined}
    />
  )
}

/** 「这一条其实是别的概念？并到…」（Q3.5 的人工归一出口）。
 *
 *  **为什么不是自动的。** 机器只在有量出来的余量的地方并（相似度 0.80）；同一个领域的
 *  相邻概念它**分不开** —— 实测里「SQLite WAL 模式」和「SQLite 锁机制」比某些该并的
 *  还近（尺子：`backend/smoke_concept.py` 的原始数据）。所以这里是指认，不是「再调调阈值」。
 *
 *  单独导出是为了能测：并错了会同时污染「搞懂过几个概念」和召回，这个交互值得有自己的测试。
 *  候选**只来自已有的概念名**（没有「新建一个」）——并到一个不存在的名字上不在这个交互里。
 */
export function ConceptMerge({
  concept,
  others,
  busy,
  onMerge,
}: {
  concept: string
  others: string[]
  busy: boolean
  onMerge: (source: string, into: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const candidates = others
    .filter((t) => t !== concept && (!q.trim() || t.includes(q.trim())))
    .slice(0, 8)

  if (!open) {
    return (
      <button
        data-merge-open={concept}
        onClick={() => {
          setOpen(true)
          setQ('')
        }}
        title="同一个领域的相邻概念，机器分不开（实测比某些该并的还近）——这一条得你来指认"
        className="pt-1 block text-[10px] text-neutral-400 transition-colors hover:text-violet-600 dark:hover:text-violet-300"
      >
        这一条其实是别的概念？并到…
      </button>
    )
  }
  return (
    <div className="pt-1">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          data-merge-q
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="并到哪个概念？"
          className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-[10px] outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          onClick={() => setOpen(false)}
          className="shrink-0 text-[10px] text-neutral-400 hover:text-neutral-600"
        >
          取消
        </button>
      </div>
      <div className="flex flex-wrap gap-1 pt-1">
        {candidates.map((t) => (
          <button
            key={t}
            data-merge-into={t}
            disabled={busy}
            onClick={() => onMerge(concept, t)}
            title={`把「${concept}」的历次记录并到「${t}」（留下来的是「${t}」这个名字）`}
            className="max-w-full truncate rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 transition-colors hover:bg-violet-100 hover:text-violet-700 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            {t}
          </button>
        ))}
        {candidates.length === 0 ? (
          <span className="text-[10px] text-neutral-400">
            没有别的概念可以并 —— 只有一条的时候，没得挑。
          </span>
        ) : null}
      </div>
    </div>
  )
}

export default function TutorPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [sid, setSid] = useState<number | null>(null)
  const [topic, setTopic] = useState('')
  const [mode, setMode] = useState<'socratic' | 'feynman' | 'future' | 'interview'>('socratic')
  const [modelOk, setModelOk] = useState(true)
  const [turns, setTurns] = useState<Turn[]>([])
  const [hits, setHits] = useState<TutorRecallHit[]>([])
  const [streaming, setStreaming] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [verdict, setVerdict] = useState<'' | 'got' | 'half' | 'useless'>('')
  const [ended, setEnded] = useState<{ concept: string; domain: string; stuck: string; transfer: string; nearby: TutorEndResult['material_nearby']; merged: TutorEndResult['merged'] } | null>(null)
  const [rows, setRows] = useState<TutorSessionRow[]>([])
  const [learnMap, setLearnMap] = useState<TutorLearningMap | null>(null)
  // 「又卡住」的那几个概念（近 7 天）。**界面上的标记与零柒那句话同一批**：
  // 判据在后端一处（`tutor.is_recurring_mistake`），这里只负责画一个标。
  const [recurring, setRecurring] = useState<TutorConceptRow[]>([])
  // 「我来讲 · 让它判」（M1）：判中 / 判完那句话。判不了时不静默——说一句退回来。
  const [judging, setJudging] = useState(false)
  const [judgeMsg, setJudgeMsg] = useState('')
  // 面试陪练的题库（只读）：选中那个模式时才拉一次
  const [bank, setBank] = useState<InterviewBank | null>(null)

  useEffect(() => {
    if (mode !== 'interview' || bank) return
    void api.interviewBank().then(setBank).catch(() => {})
  }, [mode, bank])
  // 展开中的概念（看它历次自评与卡点的演进）；一次只展开一个，右栏窄
  const [openConcept, setOpenConcept] = useState<string | null>(null)
  // 概念的「邻居」按需拉、按概念缓存——没展开就不该有这一次向量计算
  const [neighbors, setNeighbors] = useState<Record<string, TutorNeighbor[]>>({})
  const [stuckBusy, setStuckBusy] = useState(false)
  const [stuckMsg, setStuckMsg] = useState('')
  const [stuckAudio, setStuckAudio] = useState('')
  // 学习小组圆桌：拉取式——点「开圆桌」才跑，最近一次的纪要与播客就地展示
  const [rtBusy, setRtBusy] = useState(false)
  const [rt, setRt] = useState<RoundtableResult | null>(null)
  const [rtMsg, setRtMsg] = useState('')
  const [rtAudio, setRtAudio] = useState('')
  // 研究（学习闭环的中间两跳）：拉取式——点「深入研究」才跑，成品可存进知识库
  const [rsBusy, setRsBusy] = useState(false)
  const [rs, setRs] = useState<ResearchReport | null>(null)
  // 成文是流式的：draft 一帧帧来，正文边生成边渲染，`rs` 到了才算数
  const [rsDraft, setRsDraft] = useState<ReportDraft | null>(null)
  const [rsMsg, setRsMsg] = useState('')
  const [rsSaved, setRsSaved] = useState('')
  // S1：这三张卡跑的是引擎，所以它们也会吃到技能（按话题匹配出来的工序）。
  // 手动跑引擎没有运行记录，这一行就是那条路上唯一的窗口；顺带喂给这次的 👍/👎。
  const [rsInjected, setRsInjected] = useState<string[]>([])
  // 分析 / 方案（拿不准的事，理清楚再出方案）：拉取式——点「帮我理清」才跑。
  // 和研究的区别在于先出 `frame`（我理解你要决定什么），那是给人看的。
  const [dcBusy, setDcBusy] = useState(false)
  const [dc, setDc] = useState<DecideReport | null>(null)
  const [dcDraft, setDcDraft] = useState<ReportDraft | null>(null)
  const [dcFrame, setDcFrame] = useState<DecideFrame | null>(null)
  const [dcMsg, setDcMsg] = useState('')
  const [dcSaved, setDcSaved] = useState('')
  const [dcInjected, setDcInjected] = useState<string[]>([])
  // 对质（跨源冲突检测）：把你自己的说法和外部来源摆在一起，看哪两处对不上。同样是
  // 拉取式——点「对质」才跑；材料里没有对不上的时它会直说没有，那不是失败。
  const [cfBusy, setCfBusy] = useState(false)
  const [cf, setCf] = useState<ConflictReport | null>(null)
  const [cfDraft, setCfDraft] = useState<ReportDraft | null>(null)
  const [cfSubject, setCfSubject] = useState('')
  const [cfMsg, setCfMsg] = useState('')
  const [cfSaved, setCfSaved] = useState('')
  const [cfInjected, setCfInjected] = useState<string[]>([])
  // 三张成文卡跑完后默认收成一行回执（正文只活在 /notes 详情页），这三个开关把它展开回来
  const [rsOpen, setRsOpen] = useState(false)
  const [dcOpen, setDcOpen] = useState(false)
  const [cfOpen, setCfOpen] = useState(false)
  const [stats, setStats] = useState<TutorStats | null>(null)
  // 「最近搞懂」的时刻（成长事件的同源数据）：概念、时间、是否从半懂到懂
  const [mastery, setMastery] = useState<TutorMastery | null>(null)
  // 全部卡点清单（独立于右栏的 50 行窗口），待解的在这里集中看
  const [stuckRows, setStuckRows] = useState<TutorStuckRow[]>([])
  // 材料消化：一份材料 → 要搞懂的点。面板是拉取式的——你点它才跑。
  // 拆出的点写进 `digest_points`（建议日志，学习地图「未触及」的来源）；学习状态的真值
  // 仍然只有 tutor_sessions。
  const [dgOpen, setDgOpen] = useState(false)
  const [dgMode, setDgMode] = useState<'file' | 'text'>('file')
  const [dgQuery, setDgQuery] = useState('')
  const [dgSources, setDgSources] = useState<CardSources | null>(null)
  const [dgSource, setDgSource] = useState('')
  const [dgText, setDgText] = useState('')
  const [dgBusy, setDgBusy] = useState(false)
  const [dg, setDg] = useState<TutorDigestResult | null>(null)
  const [dgMsg, setDgMsg] = useState('')
  // 「按点出卡」：只围绕某一个点出几张卡，不离开学页。**一次只服务一个点**——同时铺开
  // 几张草稿面板，就没法一眼看清哪张卡属于哪个点了。
  const [pc, setPc] = useState<{
    pointId: number
    busy: boolean
    drafts: CardDraft[]
    picked: Set<number>
    msg: string
    meta: { source: string; source_label: string; model_id: string }
  } | null>(null)
  const [pcNotice, setPcNotice] = useState('') // 入库回执：正面的话，不和报错混在一起
  // 开场建议（DeepTutor 参考项）：从记录里派生的就近入口，挂了就静默没有
  const [starters, setStarters] = useState<TutorStarter[]>([])
  // 工具卡点开后的独立输入面板：每个工具自己收话题，不再逼你先去顶部输入框
  const [toolOpen, setToolOpen] = useState<'' | 'research' | 'decide' | 'conflict'>('')
  const [toolTopic, setToolTopic] = useState('')
  // 学习地图的档位筛选：点档位标签只看那一档，再点一次回到全部。
  // 档位名来自 `conceptState.ts`（与零柒小屋的概念卡共用那一份词与色）。
  const [mapFilter, setMapFilter] = useState<ConceptState | null>(null)
  // 开场屏的三个标签：学（开教学/研究等）、练（模拟测验）、记录（地图与历史）。
  // 一屏只做一类事，页面不再无限往下滚。
  //
  // 2026-09-18 导航改版：标签条搬到**侧栏**了，这一档改由 `?tab=` 驱动——
  // 页面里那排按钮删掉，但 `setTab` 还在（页内好几处「去练一练 / 回记录」的按钮要用它），
  // 而且**它写的是 URL**：于是页内跳转与侧栏跳转走的是同一条路，不会出现两套状态。
  const tabParam = searchParams.get('tab')
  const tab: TutorTab = (TUTOR_TABS.find((t) => t.key === tabParam)?.key as TutorTab) ?? 'learn'
  const setTab = (t: TutorTab) =>
    setSearchParams(
      (p) => {
        const n = new URLSearchParams(p)
        n.set('tab', t)
        return n
      },
      { replace: true }
    )
  // 模拟测验（Quizlet Test 模式）：一份材料 → 出几道题 → 逐题自判 →
  // 没答上的一键开教学补课。出题复用按材料出卡的通路，不落库。
  const [qzMode, setQzMode] = useState<'file' | 'text'>('text')
  const [qzQuery, setQzQuery] = useState('')
  const [qzSources, setQzSources] = useState<CardSources | null>(null)
  const [qzSource, setQzSource] = useState('')
  const [qzText, setQzText] = useState('')
  const [qzBusy, setQzBusy] = useState(false)
  const [qzMsg, setQzMsg] = useState('')
  const [qz, setQz] = useState<{
    cards: CardDraft[]
    idx: number
    revealed: boolean
    answer: string
    marks: (null | 'hit' | 'miss')[]
  } | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  // 正在流式回复的会话：再学一个 / 开新会话 / 离开页面时掐断它，
  // 否则 fetch 会读完整段回复、上游也把 token 烧完（中断传播的前端一半）
  const abortRef = useRef<AbortController | null>(null)
  // 研究同样要能掐断：换会话 / 离开页面时中止，否则换完会话还会弹出上一场的研究卡
  const rsAbortRef = useRef<AbortController | null>(null)
  // 方案同理
  const dcAbortRef = useRef<AbortController | null>(null)
  // 对质同理
  const cfAbortRef = useRef<AbortController | null>(null)

  const refreshRail = useCallback(() => {
    // best-effort: the rail is context, never a precondition for teaching
    api.tutorSessions().then((r) => setRows(r.sessions)).catch(() => {})
    api.tutorStats().then(setStats).catch(() => {})
    api.tutorMap().then(setLearnMap).catch(() => {})
    api.tutorMastery().then(setMastery).catch(() => {})
    api.tutorStuck().then((r) => setStuckRows(r.stuck)).catch(() => {})
    // 「我老卡的地方」：**与零柒那句「又卡住了」同一批**（同一个后端判据）。
    // 不在这儿另算一遍——界面上的标记与它嘴里的话必须是同一批，否则「它凭什么这么说」查不到。
    api.tutorRecurring().then((r) => setRecurring(r.recurring)).catch(() => {})
  }, [])

  // 卡点的手动出口：标已解 / 标回待解。右栏是上下文，失败静默。
  const resolveStuck = useCallback(
    async (sessionId: number, resolved: boolean) => {
      try {
        await api.tutorResolveStuck(sessionId, resolved)
        refreshRail()
      } catch {
        /* 静默：右栏不挡教学 */
      }
    },
    [refreshRail]
  )

  // 归一的人工出口（Q3.5）：机器只并在有余量的地方（相似度 0.80，尺子在
  // backend/smoke_concept.py 里量过：零误并、余量 +0.10、并上 12/15），**同领域的
  // 相邻概念它分不开** —— 那一类只能由人指认。所以这里没有「自动整理」按钮，只有指认。
  const [mergeBusy, setMergeBusy] = useState(false)
  const [mergeMsg, setMergeMsg] = useState('')

  /** 「又卡住」的那几个概念，按名字查。**传整行、不只传一个布尔**：标下面的 title
   *  要说「接住过几次」，那是这一行里的事实（`recalled`）——拿不到就不该编一个 0。
   *  与零柒那句话同一批（判据在后端一处），这里只做一次查找。 */
  const repeatMap = useMemo(
    () => new Map(recurring.map((c) => [c.concept, c])),
    [recurring]
  )

  /** 认识的概念名（四档 + 会话历史里出现过的），供「并到…」挑。 */
  const allConcepts = useMemo(() => {
    const out = new Set<string>()
    for (const bucket of [learnMap?.mastered, learnMap?.learning, learnMap?.stuck]) {
      for (const c of bucket ?? []) out.add(c.concept)
    }
    for (const r of rows) if (r.concept) out.add(r.concept)
    return [...out]
  }, [learnMap, rows])

  const doMerge = useCallback(
    async (source: string, into: string) => {
      setMergeBusy(true)
      setMergeMsg('')
      try {
        const r = await api.mergeConcepts(source, into)
        // 消息挂在面板上而不是那一行：并完之后 source 那一行就没了，挂在行上会跟着消失
        setMergeMsg(`「${r.from}」的 ${r.moved} 场并到了「${r.into}」`)
        setOpenConcept(into) // 并到哪条上就展开哪条——不然刚并完像什么都没发生
        refreshRail()
      } catch (e) {
        setMergeMsg(e instanceof Error ? e.message : String(e))
      } finally {
        setMergeBusy(false)
      }
    },
    [refreshRail]
  )

  // 消化的取材列表：服务端筛选（monorepo 上千个文件，一次全下就是几兆）
  useEffect(() => {
    if (!dgOpen) return
    const t = setTimeout(() => {
      api
        .cardSources(dgQuery)
        .then(setDgSources)
        .catch(() => setDgSources(null))
    }, dgQuery ? 250 : 0)
    return () => clearTimeout(t)
  }, [dgOpen, dgQuery])

  // 测验的取材列表：同一套服务端筛选
  useEffect(() => {
    if (tab !== 'practice') return
    const t = setTimeout(() => {
      api
        .cardSources(qzQuery)
        .then(setQzSources)
        .catch(() => setQzSources(null))
    }, qzQuery ? 250 : 0)
    return () => clearTimeout(t)
  }, [tab, qzQuery])

  const runDigest = useCallback(async () => {
    const body = dgMode === 'text' ? { text: dgText } : { source_path: dgSource }
    if (dgBusy || (dgMode === 'text' ? !dgText.trim() : !dgSource)) return
    setDgBusy(true)
    setDgMsg('')
    setDg(null)
    setPc(null) // 点换了一批，上一轮的出卡草稿就没有归属了
    setPcNotice('')
    try {
      const r = await api.tutorDigest(body)
      setDg(r)
      if (r.error) setDgMsg(r.error)
      refreshRail() // 拆出的点进了建议日志 → 「未触及」那一档得跟着更新
    } catch (e) {
      setDgMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDgBusy(false)
    }
  }, [dgMode, dgText, dgSource, dgBusy, refreshRail])

  // 按点出卡：只围绕这一点出，卡面只覆盖那一点。有来源文件就从材料取（准），粘贴文本
  // 拆的点没有来源文件，退化成**拿这个点本身当材料**——它本来就是一句话，够出卡了。
  const makePointCards = useCallback(
    async (p: TutorDigestPoint) => {
      if (pc?.busy) return
      // 来源是**整份材料**的（在 dg 结果层），不是点自己的——点只有标题与「为什么容易卡」
      const src = dg?.source || ''
      const srcLabel = dg?.source_label || src
      setPcNotice('')
      setPc({
        pointId: p.id,
        busy: true,
        drafts: [],
        picked: new Set(),
        msg: '',
        meta: { source: src, source_label: srcLabel, model_id: '' },
      })
      const body = pointCardBody(p.title, dg, dgText)
      try {
        const done = await streamCardsGenerate(body, () => {})
        if (!done.ok) {
          setPc((c) => (c ? { ...c, busy: false, msg: done.error || '出卡失败' } : c))
          return
        }
        const cards = (done.cards ?? []) as CardDraft[]
        setPc({
          pointId: p.id,
          busy: false,
          drafts: cards,
          // 重复的默认不勾但留着给你看——和 CardMaker 同一条规矩：你决定，不是模型
          picked: new Set(cards.map((_, i) => i).filter((i) => !cards[i].duplicate_of)),
          msg: cards.length ? '' : '这个点没出到卡，换个点试试',
          meta: {
            source: done.source || src,
            source_label: done.source_label || srcLabel,
            model_id: done.model_id ?? '',
          },
        })
      } catch (e) {
        setPc((c) =>
          c ? { ...c, busy: false, msg: e instanceof Error ? e.message : String(e) } : c
        )
      }
    },
    [pc?.busy, dg, dgText]
  )

  const savePointCards = useCallback(async () => {
    const cur = pc
    if (!cur || !cur.drafts.length) return
    const chosen = cur.drafts.filter((_, i) => cur.picked.has(i))
    if (!chosen.length) {
      setPc({ ...cur, msg: '至少勾一张' })
      return
    }
    setPc({ ...cur, busy: true, msg: '' })
    try {
      const r = await api.saveCards({ cards: chosen, ...cur.meta })
      setPc(null)
      setPcNotice(r.skipped ? `入库 ${r.added} 张，跳过 ${r.skipped} 张重复` : `入库 ${r.added} 张`)
      refreshRail()
    } catch (e) {
      setPc({ ...cur, busy: false, msg: e instanceof Error ? e.message : String(e) })
    }
  }, [pc, refreshRail])

  const closeDigest = useCallback(() => {
    setDgOpen(false)
    setDg(null)
    setDgMsg('')
    setDgBusy(false)
  }, [])

  // 模拟测验：出题（复用按材料出卡的通路，count=5，不落库）
  const runQuiz = useCallback(async () => {
    if (qzBusy) return
    const hasMaterial = qzMode === 'text' ? !!qzText.trim() : !!qzSource
    if (!hasMaterial) return
    setQzBusy(true)
    setQzMsg('')
    setQz(null)
    try {
      const body =
        qzMode === 'text' ? { text: qzText, count: 5 } : { source_path: qzSource, count: 5 }
      const done = await streamCardsGenerate(body, () => {})
      if (!done.ok) {
        setQzMsg(done.error || '出题失败')
        return
      }
      const cards = (done.cards ?? []) as CardDraft[]
      if (!cards.length) {
        setQzMsg('这份材料没出成题，换一份试试')
        return
      }
      setQz({ cards, idx: 0, revealed: false, answer: '', marks: cards.map(() => null) })
    } catch (e) {
      setQzMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setQzBusy(false)
    }
  }, [qzBusy, qzMode, qzText, qzSource])

  // 逐题自判：答上 / 没答上。判完翻到下一题；最后一题判完留在总结页
  const markQuiz = useCallback((m: 'hit' | 'miss') => {
    setQz((q) => {
      if (!q) return q
      const marks = [...q.marks]
      marks[q.idx] = m
      const next = q.idx + 1
      if (next >= q.cards.length) return { ...q, marks, revealed: false }
      return { ...q, marks, idx: next, revealed: false, answer: '' }
    })
  }, [])

  // 卡点讨论播客（对话播客 2.0）：拉取式——你点它才生成，生成完就地能听
  const makeStuckPodcast = useCallback(async () => {
    if (stuckBusy) return
    setStuckBusy(true)
    setStuckMsg('')
    try {
      const r = await api.podcastFromStuck()
      setStuckMsg(`已生成「${r.title}」，${Math.max(1, Math.round(r.duration_sec / 60))} 分钟：`)
      setStuckAudio(`/api/podcast/audio/${r.file}`)
    } catch (e) {
      setStuckMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setStuckBusy(false)
    }
  }, [stuckBusy])

  // 圆桌：topic 留空，后端回落到最近的卡点；纪要就地展开，想听再做成播客
  const runRoundtable = useCallback(async () => {
    if (rtBusy) return
    setRtBusy(true)
    setRtMsg('')
    setRtAudio('')
    try {
      setRt(await api.roundtableRun(''))
    } catch (e) {
      setRtMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setRtBusy(false)
    }
  }, [rtBusy])

  const makeRtPodcast = useCallback(async () => {
    if (!rt || rtBusy) return
    setRtBusy(true)
    setRtMsg('')
    try {
      const r = await api.roundtablePodcast(rt.file)
      setRtMsg(`播客已生成，${Math.max(1, Math.round(r.duration_sec / 60))} 分钟：`)
      setRtAudio(`/api/podcast/audio/${r.file}`)
    } catch (e) {
      setRtMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setRtBusy(false)
    }
  }, [rt, rtBusy])

  // 研究（学习闭环的中间两跳）：以本会话话题为输入拉取式跑一次「搜 → 读 → 成文」。
  // 进度走 rsMsg；结果卡出来后可以「存进知识库」——落 vault/research/ 并进索引，
  // 下一次相关话题的取材块就能捞到它（那一跳是现成的，这里不需要多做）。
  const runResearch = useCallback(async (override?: string) => {
    const t = (override ?? topic).trim()
    if (!t || rsBusy) return
    rsAbortRef.current?.abort()
    const ctl = new AbortController()
    rsAbortRef.current = ctl
    setRsBusy(true)
    setRs(null)
    setRsDraft(null)
    setRsSaved('')
    setRsInjected([])
    setRsMsg('规划检索式…')
    try {
      const r = await streamResearch(
        t,
        (event, data) => {
          if (event === 'skills')
            setRsInjected(((data.skills ?? []) as unknown[]).map(String))
          else if (event === 'plan')
            setRsMsg(`已规划 ${(data.queries as string[] | undefined)?.length ?? 0} 个检索式，检索中…`)
          else if (event === 'gathering') setRsMsg('检索知识库与网络…')
          else if (event === 'sources') {
            const n = (data.sources as unknown[] | undefined)?.length ?? 0
            const added = data.added as number | undefined
            // 第一轮没有 added；补搜那几轮带 added，说清「这一轮又添了几条」
            setRsMsg(
              added === undefined
                ? `取到 ${n} 条材料…`
                : `第 ${data.round as number} 轮又添 ${added} 条（共 ${n} 条）…`
            )
          } else if (event === 'round') {
            const missing = ((data.missing as string[] | undefined) ?? []).join('、')
            setRsMsg(`第 ${data.round as number} 轮：还缺${missing || '一些面'}，补搜中…`)
          } else if (event === 'writing') setRsMsg('成文中…')
          else if (event === 'draft') {
            // 正文开始出来了：把半截渲染上去，进度行让位
            setRsDraft(data as unknown as ReportDraft)
            setRsMsg('')
          }
        },
        ctl.signal
      )
      if (r.ok && r.report) {
        setRs(r.report)
        setRsMsg('')
      } else {
        setRsMsg(r.error ?? '研究失败')
      }
    } catch (e) {
      // 主动掐断不算错误：换会话时不该冒出一条红字
      if ((e as { name?: string })?.name !== 'AbortError') {
        setRsMsg(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setRsBusy(false)
    }
  }, [topic, rsBusy])

  const saveResearch = useCallback(async () => {
    if (!rs || rsBusy || rsSaved) return
    setRsBusy(true)
    setRsMsg('')
    try {
      const r = await api.researchSave({
        title: rs.title,
        sections: rs.sections,
        used: rs.used,
        sources: rs.sources,
      })
      setRsSaved(r.filename)
    } catch (e) {
      setRsMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setRsBusy(false)
    }
  }, [rs, rsBusy, rsSaved])

  /** 换会话 / 再学一个 / 离开：中止在跑的研究并清空卡，别让上一场的结果落到新会话上 */
  const clearResearch = useCallback(() => {
    rsAbortRef.current?.abort()
    setRs(null)
    setRsDraft(null)
    setRsMsg('')
    setRsSaved('')
    setRsBusy(false)
  }, [])

  // 方案（拿不准的事，理清楚再出方案）：以本会话话题为输入，先读题、再取材料。
  // `frame` 在取材料之前就渲染出来——读错题是这类功能第一位的失败模式，
  // 题没读懂，后面写得再顺也没用。
  const runDecide = useCallback(async (override?: string) => {
    const t = (override ?? topic).trim()
    if (!t || dcBusy) return
    dcAbortRef.current?.abort()
    const ctl = new AbortController()
    dcAbortRef.current = ctl
    setDcBusy(true)
    setDc(null)
    setDcDraft(null)
    setDcFrame(null)
    setDcSaved('')
    setDcInjected([])
    setDcMsg('读题中…')
    try {
      const r = await streamDecide(
        t,
        (event, data) => {
          if (event === 'skills')
            setDcInjected(((data.skills ?? []) as unknown[]).map(String))
          else if (event === 'frame') {
            setDcFrame(data as unknown as DecideFrame)
            setDcMsg('去取材料…')
          } else if (event === 'gathering') setDcMsg('检索知识库、长期记忆与网络…')
          else if (event === 'sources')
            setDcMsg(`取到 ${(data.sources as unknown[] | undefined)?.length ?? 0} 条材料，成文中…`)
          else if (event === 'writing') setDcMsg('成文中…')
          else if (event === 'draft') {
            setDcDraft(data as unknown as ReportDraft)
            setDcMsg('')
          }
        },
        ctl.signal
      )
      if (r.ok && r.report) {
        setDc(r.report)
        setDcFrame(r.report.frame ?? null)
        setDcMsg('')
      } else {
        setDcMsg(r.error ?? '理清失败')
      }
    } catch (e) {
      // 主动掐断不算错误：换会话时不该冒出一条红字
      if ((e as { name?: string })?.name !== 'AbortError') {
        setDcMsg(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setDcBusy(false)
    }
  }, [topic, dcBusy])

  const saveDecide = useCallback(async () => {
    if (!dc || dcBusy || dcSaved) return
    setDcBusy(true)
    setDcMsg('')
    try {
      const r = await api.decideSave({
        title: dc.title,
        sections: dc.sections,
        used: dc.used,
        sources: dc.sources,
      })
      setDcSaved(r.filename)
    } catch (e) {
      setDcMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDcBusy(false)
    }
  }, [dc, dcBusy, dcSaved])

  /** 换会话 / 再学一个 / 离开：同样的道理，别让上一场题的方案落到新会话上 */
  const clearDecide = useCallback(() => {
    dcAbortRef.current?.abort()
    setDc(null)
    setDcDraft(null)
    setDcFrame(null)
    setDcMsg('')
    setDcSaved('')
    setDcBusy(false)
  }, [])

  /** 换会话 / 再学一个 / 离开：同样的道理，别让上一场题的对质落到新会话上 */
  const clearConflict = useCallback(() => {
    cfAbortRef.current?.abort()
    setCf(null)
    setCfDraft(null)
    setCfSubject('')
    setCfMsg('')
    setCfSaved('')
    setCfBusy(false)
  }, [])

  // 对质：先出 `frame`（我理解要比的是什么），再取材，然后 `finding`
  // 把「哪两处对不上」扫出来——一处都没有就直接给结论，不再烧一次长篇成文。
  const runConflict = useCallback(async (override?: string) => {
    const t = (override ?? topic).trim()
    if (!t || cfBusy) return
    cfAbortRef.current?.abort()
    const ctl = new AbortController()
    cfAbortRef.current = ctl
    setCfBusy(true)
    setCf(null)
    setCfDraft(null)
    setCfSubject('')
    setCfSaved('')
    setCfInjected([])
    setCfMsg('读题中…')
    try {
      const r = await streamConflict(
        t,
        (event, data) => {
          if (event === 'skills')
            setCfInjected(((data.skills ?? []) as unknown[]).map(String))
          else if (event === 'frame') {
            setCfSubject(String((data as { subject?: string }).subject ?? ''))
            setCfMsg('去取材料…')
          } else if (event === 'gathering') setCfMsg('检索知识库、长期记忆与外部来源…')
          else if (event === 'sources')
            setCfMsg(`取到 ${(data.sources as unknown[] | undefined)?.length ?? 0} 条材料，比对中…`)
          else if (event === 'finding') setCfMsg('在比对哪两处对不上…')
          else if (event === 'writing') setCfMsg('成文中…')
          else if (event === 'draft') {
            setCfDraft(data as unknown as ReportDraft)
            setCfMsg('')
          }
        },
        ctl.signal
      )
      if (r.ok && r.report) {
        setCf(r.report)
        setCfSubject(r.report.subject ?? '')
        setCfMsg('')
      } else {
        setCfMsg(r.error ?? '对质失败')
      }
    } catch (e) {
      // 主动掐断不算错误：换会话时不该冒出一条红字
      if ((e as { name?: string })?.name !== 'AbortError') {
        setCfMsg(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setCfBusy(false)
    }
  }, [topic, cfBusy])

  const saveConflict = useCallback(async () => {
    if (!cf || cfBusy || cfSaved) return
    setCfBusy(true)
    setCfMsg('')
    try {
      const r = await api.conflictSave({
        title: cf.title,
        sections: cf.sections,
        used: cf.used,
        sources: cf.sources,
      })
      setCfSaved(r.filename)
    } catch (e) {
      setCfMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setCfBusy(false)
    }
  }, [cf, cfBusy, cfSaved])

  useEffect(() => refreshRail(), [refreshRail])

  // 开场建议只在开场屏有意义：挂载时拉一次，点一个就开会话，不轮询不催
  useEffect(() => {
    api.tutorStarters().then((r) => setStarters(r.starters)).catch(() => {})
  }, [])

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns.length, streaming])

  // 卸载（切到其他页面）时掐断还在流式的回复 / 在跑的研究 / 在跑的方案
  useEffect(
    () => () => {
      abortRef.current?.abort()
      rsAbortRef.current?.abort()
      dcAbortRef.current?.abort()
    },
    []
  )

  const send = useCallback(async (sessionId: number, text: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setErr('')
    setBusy(true)
    setTurns((t) => [...t, { role: 'user', content: text }])
    let acc = ''
    let srcs: TutorMaterialSource[] | undefined
    try {
      const done = await streamTutorSay(
        { session_id: sessionId, text },
        {
          onDelta: (d) => {
            acc += d
            setStreaming(acc)
          },
          onRecall: setHits,
          onSources: (s) => {
            srcs = s
          },
        },
        controller.signal
      )
      if (!done.ok) setErr(done.error ?? '出错了')
    } catch (e) {
      // 主动掐断不是错误：换会话/离开页面时的中断，安静收尾即可
      if (!controller.signal.aborted) setErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setStreaming('')
      // a partial reply is stored server-side too, so keeping it here matches
      if (acc) setTurns((t) => [...t, { role: 'assistant', content: acc, sources: srcs }])
      setBusy(false)
    }
  }, [])

  const beginWith = useCallback(
    async (
      topicText: string,
      repo = '',
      m: 'socratic' | 'feynman' | 'future' | 'interview' = 'socratic',
      // 从「材料拆出的点」开场时带上：后端据此把它标成已教，不再算「未触及」
      originPointId?: number,
      // 从搁置卡的前置候选点进来时带上（PLAN2 §6 回指采纳的分子）：
      // 后端只在会话行上记一个事实，不改那张卡、也不多说一个字
      prereqCardId?: number,
    ) => {
    const t = topicText.trim()
    if (!t || busy) return
    setTopic(t)
    setMode(m)
    setErr('')
    clearResearch()
    clearDecide()
    try {
      const s = await api.tutorStart(t, repo, m, originPointId, prereqCardId)
      setSid(s.id)
      setModelOk(s.model_ok)
      setTurns([])
      setHits([])
      setVerdict('')
      setEnded(null)
      await send(s.id, t) // the topic IS the first turn — no special first-reply path
      refreshRail()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [busy, send, refreshRail, clearResearch, clearDecide])

  // ⚠️ `mode` 必须传下去：它不只是界面上的高亮——**后端那一场是哪种声部由它决定**。
  // 之前这里漏了它（`beginWith(topic)`），于是选了「我来讲（费曼）」再按开始，
  // 开出来的是苏格拉底会话：页面按费曼摆 UI、模型按老师讲课，两边说的不是一件事。
  const begin = useCallback(() => beginWith(topic, '', mode), [beginWith, topic, mode])

  const submit = useCallback(async () => {
    const t = draft.trim()
    if (!t || sid === null || busy) return
    setDraft('')
    await send(sid, t)
  }, [draft, sid, busy, send])

  /** 自评落地的**唯一**出口：手动标一档、让它判一档，走的是同一段状态更新。
   *
   *  两条入口一条账——判出来的 verdict 与你自己标的没有任何区别（后端也是同一个 `end()`）。 */
  const applyEnd = useCallback(
    (v: 'got' | 'half' | 'useless', got: TutorEndResult) => {
      setVerdict(v)
      setEnded({
        concept: got.concept,
        domain: got.domain ?? '',
        stuck: got.stuck,
        transfer: got.transfer ?? '',
        nearby: got.material_nearby ?? [],
        merged: got.merged ?? null,
      })
      refreshRail()
    },
    [refreshRail]
  )

  const mark = useCallback(
    async (v: 'got' | 'half' | 'useless') => {
      if (sid === null || busy) return
      setBusy(true)
      try {
        applyEnd(v, await api.tutorEnd(sid, v))
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [sid, busy, applyEnd]
  )

  /** M1 场景 B：「我来讲 · 让它判」。它读完整场对话给一档，并在**服务端**走同一条
   *  `end()`（概念/卡点照常回写）——所以这里拿到 `ended` 之后**不再调 tutorEnd**，
   *  否则会白花第二次提取的钱。判不了就如实说一句，退回你自己标（不编分）。 */
  const judge = useCallback(async () => {
    if (sid === null || busy || judging || turns.length === 0) return
    setJudging(true)
    setJudgeMsg('')
    try {
      const r = await api.tutorJudge(sid)
      if (!r.judged || !r.ended || !r.verdict) {
        setJudgeMsg(r.reason || '判分没跑成，你自己标一档')
        return
      }
      applyEnd(r.verdict, r.ended)
      const gap = (r.missed_points ?? [])[0]
      setJudgeMsg(`它判：${VERDICT_LABEL[r.verdict]}${gap ? ` · ${gap}` : ''}`)
    } catch (e) {
      setJudgeMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setJudging(false)
    }
  }, [sid, busy, judging, turns.length, applyEnd])

  const open = useCallback(async (id: number) => {
    setErr('')
    clearResearch()
    clearDecide()
    try {
      const d = await api.tutorSession(id)
      setSid(d.id)
      setTopic(d.topic)
      setMode(d.mode || 'socratic')
      setTurns(d.turns)
      setHits([])
      setVerdict(d.verdict)
      setEnded(d.verdict ? { concept: d.concept, domain: d.domain ?? '', stuck: d.stuck, transfer: '', nearby: [], merged: null } : null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [clearResearch, clearDecide])

  // 全局搜索深链：`/tutor?session=ID` 直接打开那次会话（教学命中从聊天页跳过来）；
  // 知识库页「陪读」深链：`/tutor?new=<话题>&repo=<仓库名>` 直接开一场陪读会话。
  //
  // **必须 key 在 search 上**：SPA 里同路由换参数不会重挂这个组件，读
  // `window.location.search` 的一次性 effect 永远只认第一个值。
  // 而「只认一次」这个守卫是冲着另一件事去的——`beginWith` 的身份跟着 `busy` 变，
  // effect 会在每轮回答结束时重跑、又开一场新会话（原来就有这个问题，只是要带深链
  // 才碰得到）。所以守卫按**参数值**记，而不是布尔：换一个 session 要能重新触发。
  const sessionParam = searchParams.get('session')
  const newTopic = searchParams.get('new')
  const repoParam = searchParams.get('repo') ?? ''
  // 从搁置卡的前置候选点进来时带的那个 card id（PLAN2 §6 回指采纳的分子）。
  // 它只跟着这一次开场走：参数变了要能重新触发，所以守卫的 key 里也算上它。
  const prereqParam = searchParams.get('prereq') ?? ''
  const handledDeepLink = useRef<string | null>(null)
  useEffect(() => {
    const key = sessionParam
      ? `session:${sessionParam}`
      : newTopic
        ? `new:${newTopic}|${repoParam}|${prereqParam}`
        : null
    if (!key) {
      handledDeepLink.current = null
      return
    }
    if (handledDeepLink.current === key) return
    handledDeepLink.current = key
    const s = Number(sessionParam)
    const pid = Number(prereqParam)
    const prereqId = prereqParam && Number.isFinite(pid) && pid > 0 ? pid : undefined
    if (sessionParam && Number.isFinite(s) && s > 0) void open(s)
    else if (newTopic) void beginWith(newTopic, repoParam, 'socratic', undefined, prereqId)
  }, [sessionParam, newTopic, repoParam, prereqParam, open, beginWith])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setSid(null)
    setTopic('')
    setMode('socratic')
    setTurns([])
    setHits([])
    setDraft('')
    setErr('')
    setVerdict('')
    setEnded(null)
    clearResearch()
    clearDecide()
    clearConflict()
  }, [clearResearch, clearDecide, clearConflict])

  // 三张成文卡（研究 / 方案 / 对质）：**会话里和开场屏共用同一份**。
  // 以前它们只长在会话流里，于是「不先开一场教学就没法研究/理清/对质」成了界面上的
  // 硬约束——而这三件事本来就不需要一场教学当门票。
  const reportCards = (
    <>
      {/* 研究卡：RunPanel 统一壳——进度/停止/重试/成品动作都归框架，
          卡里只剩这个动作自己的内容。 */}
      {rs || rsDraft || rsBusy || rsMsg ? (
        <RunPanel
          phase={rs ? 'done' : rsDraft ? 'streaming' : rsBusy ? 'progress' : 'error'}
          tone="sky"
          icon="🔍"
          title={`研究${rs && rs.rounds && rs.rounds > 1 ? ` · 搜了 ${rs.rounds} 轮` : ''}`}
          status={rs || rsDraft ? undefined : rsMsg || undefined}
          error={!rs && !rsDraft && !rsBusy && rsMsg ? rsMsg : undefined}
          onCancel={() => rsAbortRef.current?.abort()}
          actions={
            <>
              {rs ? (
                <button
                  onClick={() => setRsOpen((v) => !v)}
                  className="rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
                >
                  {rsOpen ? '收起' : '读全文'}
                </button>
              ) : null}
              <button
                onClick={() => void saveResearch()}
                disabled={rsBusy || !!rsSaved}
                className="rounded-full border border-sky-300 px-2 py-0.5 text-[10px] text-sky-700 transition-colors hover:bg-sky-100 disabled:opacity-40 dark:border-sky-500/40 dark:text-sky-300 dark:hover:bg-sky-500/20"
              >
                {rsSaved ? '已存进知识库' : rsBusy ? '保存中…' : '存进知识库'}
              </button>
              <InjectedLine
                names={rsInjected}
                className="rounded-full border border-sky-200 px-2 py-0.5 text-[10px] text-sky-700 dark:border-sky-500/30 dark:text-sky-300"
              />
            </>
          }
          footer={
            rs ? (
              <FeedbackButtons
                kind="research"
                promptSha={rs.prompt_sha}
                modelId={rs.model_id}
                artifactRef={rsSaved}
                injected={rsInjected}
              />
            ) : undefined
          }
        >
          {/* 跑完了就收成一行回执：正文只活在 /notes 详情页，「读全文」能展开回来。
              draft 期间照旧边生成边看——那时候正文正是要看的。 */}
          {rs && !rsOpen ? (
            <ReceiptLine
              title={rs.title || '研究'}
              meta={`来源 ${rs.sources.length} 条 · 你的材料 ${
                rs.sources.filter((s) => s.kind === 'kb').length
              } 条`}
              saved={rsSaved}
            />
          ) : rs || rsDraft ? (
            <>
              <Markdown sources={rs?.sources}>{reportMarkdown(rs ?? rsDraft!)}</Markdown>
              {rs ? (
                <>
                  <SourceList
                    sources={rs.sources}
                    used={rs.used}
                    className="border-sky-200/70 dark:border-sky-500/20"
                    summary={
                      <>
                        来源 {rs.sources.length} 条（你自己的材料{' '}
                        {rs.sources.filter((s) => s.kind === 'kb').length} 条）
                      </>
                    }
                  />
                  {rsSaved ? (
                    <p className="mt-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                      已存到 {rsSaved}，已进索引——下次相关话题的取材会先捞到它
                    </p>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </RunPanel>
      ) : null}
      {/* 方案卡：先摆「我理解你要决定的是什么」再出正文——读错题是这类功能
          第一位的失败模式，题面必须在成文之前就看得见。同样是这一场会话的
          动作，不落右栏、不计数。 */}
      {dc || dcFrame || dcDraft || dcBusy || dcMsg ? (
        <RunPanel
          phase={dc ? 'done' : dcDraft ? 'streaming' : dcBusy ? 'progress' : 'error'}
          tone="violet"
          icon="🤔"
          title="方案"
          status={dc || dcDraft ? undefined : dcMsg || undefined}
          error={!dc && !dcDraft && !dcBusy && dcMsg ? dcMsg : undefined}
          onCancel={() => dcAbortRef.current?.abort()}
          actions={
            <>
              {dc ? (
                <button
                  onClick={() => setDcOpen((v) => !v)}
                  className="rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
                >
                  {dcOpen ? '收起' : '读全文'}
                </button>
              ) : null}
              {dc ? (
                <button
                  onClick={() => void saveDecide()}
                  disabled={dcBusy || !!dcSaved}
                  className="rounded-full border border-violet-300 px-2 py-0.5 text-[10px] text-violet-700 transition-colors hover:bg-violet-100 disabled:opacity-40 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/20"
                >
                  {dcSaved ? '已存进知识库' : dcBusy ? '保存中…' : '存进知识库'}
                </button>
              ) : null}
              <InjectedLine
                names={dcInjected}
                className="rounded-full border border-violet-200 px-2 py-0.5 text-[10px] text-violet-700 dark:border-violet-500/30 dark:text-violet-300"
              />
            </>
          }
          footer={
            dc ? (
              <FeedbackButtons
                kind="decide"
                promptSha={dc.prompt_sha}
                modelId={dc.model_id}
                artifactRef={dcSaved}
                injected={dcInjected}
              />
            ) : undefined
          }
        >
          {dc && !dcOpen ? (
            <>
              {dcFrame ? (
                <p className="mb-1.5 text-[11px] text-neutral-500">要决定的是：{dcFrame.decision}</p>
              ) : null}
              <ReceiptLine
                title={dc.title || '方案'}
                meta={`来源 ${dc.sources.length} 条 · 你的材料 ${
                  dc.sources.filter((s) => s.kind === 'kb').length
                } 条 · 记忆 ${dc.sources.filter((s) => s.kind === 'memory').length} 条`}
                saved={dcSaved}
              />
            </>
          ) : (
            <>
              {dcFrame ? (
            <div className="mb-2 rounded-lg border border-violet-200/70 bg-white/70 p-2.5 dark:border-violet-500/20 dark:bg-neutral-900/40">
              <p className="text-[11px] text-neutral-500">我理解你要决定的是</p>
              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                {dcFrame.decision}
              </p>
              {dcFrame.options.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {dcFrame.options.map((o) => (
                    <span
                      key={o}
                      className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
                    >
                      {o}
                    </span>
                  ))}
                </div>
              ) : null}
              {dcFrame.criteria.length > 0 ? (
                <p className="mt-1.5 text-[11px] text-neutral-500">
                  会比：{dcFrame.criteria.join(' · ')}
                </p>
              ) : null}
            </div>
          ) : null}

          {dc || dcDraft ? (
            <Markdown sources={dc?.sources}>{reportMarkdown(dc ?? dcDraft!)}</Markdown>
          ) : null}
          {dc ? (
            <>
              <SourceList
                sources={dc.sources}
                used={dc.used}
                className="border-violet-200/70 dark:border-violet-500/20"
                summary={
                  <>
                    来源 {dc.sources.length} 条（你的材料{' '}
                    {dc.sources.filter((s) => s.kind === 'kb').length} 条 · 记忆{' '}
                    {dc.sources.filter((s) => s.kind === 'memory').length} 条）
                  </>
                }
              />
              {dcSaved ? (
                <p className="mt-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                  已存到 {dcSaved}，已进索引——下次相关话题的取材会先捞到它
                </p>
              ) : null}
            </>
          ) : null}
            </>
          )}
        </RunPanel>
      ) : null}
      {/* 对质卡：先摆「这次比的是什么」，再出正文。零冲突时它直接给一句实话
          （标题就写着「没有对不上的」），那是正常结果不是失败。同一场会话的
          动作，不落右栏、不计数。 */}
      {cf || cfSubject || cfDraft || cfBusy || cfMsg ? (
        <RunPanel
          phase={cf ? 'done' : cfDraft ? 'streaming' : cfBusy ? 'progress' : 'error'}
          tone="teal"
          icon="⚔️"
          title="对质"
          status={cf || cfDraft ? undefined : cfMsg || undefined}
          error={!cf && !cfDraft && !cfBusy && cfMsg ? cfMsg : undefined}
          onCancel={() => cfAbortRef.current?.abort()}
          actions={
            <>
              {cf ? (
                <button
                  onClick={() => setCfOpen((v) => !v)}
                  className="rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
                >
                  {cfOpen ? '收起' : '读全文'}
                </button>
              ) : null}
              {cf ? (
                <button
                  onClick={() => void saveConflict()}
                  disabled={cfBusy || !!cfSaved}
                  className="rounded-full border border-teal-300 px-2 py-0.5 text-[10px] text-teal-700 transition-colors hover:bg-teal-100 disabled:opacity-40 dark:border-teal-500/40 dark:text-teal-300 dark:hover:bg-teal-500/20"
                >
                  {cfSaved ? '已存进知识库' : cfBusy ? '保存中…' : '存进知识库'}
                </button>
              ) : null}
              <InjectedLine
                names={cfInjected}
                className="rounded-full border border-teal-200 px-2 py-0.5 text-[10px] text-teal-700 dark:border-teal-500/30 dark:text-teal-300"
              />
            </>
          }
          footer={
            cf ? (
              <FeedbackButtons
                kind="conflict"
                promptSha={cf.prompt_sha}
                modelId={cf.model_id}
                artifactRef={cfSaved}
                injected={cfInjected}
              />
            ) : undefined
          }
        >
          {cf && !cfOpen ? (
            <>
              {cfSubject ? (
                <p className="mb-1.5 text-[11px] text-neutral-500">比的是：{cfSubject}</p>
              ) : null}
              <ReceiptLine
                title={cf.title || '对质'}
                meta={`来源 ${cf.sources.length} 条 · 你的材料 ${
                  cf.sources.filter((s) => s.kind === 'kb').length
                } 条 · 记忆 ${cf.sources.filter((s) => s.kind === 'memory').length} 条`}
                saved={cfSaved}
              />
            </>
          ) : (
            <>
              {cfSubject ? (
            <div className="mb-2 rounded-lg border border-teal-200/70 bg-white/70 p-2.5 dark:border-teal-500/20 dark:bg-neutral-900/40">
              <p className="text-[11px] text-neutral-500">这次比的是</p>
              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                {cfSubject}
              </p>
              {cf && cf.pairs && cf.pairs.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {cf.pairs.map((p) => (
                    <span
                      key={`${p.a_n}-${p.b_n}`}
                      title={p.basis}
                      className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] text-teal-700 dark:bg-teal-500/20 dark:text-teal-300"
                    >
                      [{p.a_n}] × [{p.b_n}]
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {cf || cfDraft ? (
            <Markdown sources={cf?.sources}>{reportMarkdown(cf ?? cfDraft!)}</Markdown>
          ) : null}
          {cf ? (
            <>
              <SourceList
                sources={cf.sources}
                used={cf.used}
                className="border-teal-200/70 dark:border-teal-500/20"
                summary={
                  <>
                    来源 {cf.sources.length} 条（你的材料{' '}
                    {cf.sources.filter((s) => s.kind === 'kb').length} 条 · 记忆{' '}
                    {cf.sources.filter((s) => s.kind === 'memory').length} 条）
                  </>
                }
              />
              {cfSaved ? (
                <p className="mt-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                  已存到 {cfSaved}，已进索引——下次相关话题的取材会先捞到它
                </p>
              ) : null}
            </>
          ) : null}
            </>
          )}
        </RunPanel>
      ) : null}

      {/* 材料消化卡：一份材料 → 要搞懂的点 → 逐点去搞懂。「逐点」走的是普通教学会话，
          所以点一下就从这张卡切换进会话视图，不需要另一套机制。 */}
      {dgOpen || dg || dgBusy || dgMsg ? (
        <div className="rounded-xl border border-teal-200 bg-teal-50/60 p-4 dark:border-teal-500/30 dark:bg-teal-500/10">
          <div className="flex items-center justify-between gap-2 pb-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-teal-700 dark:text-teal-300">
              🎒 材料消化
            </p>
            <button
              onClick={closeDigest}
              className="rounded-full border border-teal-300 px-2 py-0.5 text-[10px] text-teal-700 transition-colors hover:bg-teal-100 dark:border-teal-500/40 dark:text-teal-300 dark:hover:bg-teal-500/20"
            >
              收起
            </button>
          </div>

          <div className="mb-2 flex gap-1 text-xs">
            {(['file', 'text'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setDgMode(m)}
                className={`rounded-full border px-2.5 py-1 transition-colors ${
                  dgMode === m
                    ? 'border-teal-500 bg-teal-500/10 font-medium text-teal-700 dark:text-teal-300'
                    : 'border-neutral-300 text-neutral-500 hover:border-teal-300 dark:border-neutral-700'
                }`}
              >
                {m === 'file' ? '📄 选一份材料' : '✍️ 粘一段'}
              </button>
            ))}
          </div>

          {dgMode === 'file' ? (
            <div className="space-y-1">
              <input
                value={dgQuery}
                onChange={(e) => setDgQuery(e.target.value)}
                placeholder="筛选文件名…"
                className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
              />
              <select
                value={dgSource}
                onChange={(e) => setDgSource(e.target.value)}
                size={6}
                className="w-full rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
              >
                {(
                  [
                    ['vault 笔记', dgSources?.vault],
                    ['代码仓库', dgSources?.repos],
                    ['本地目录', dgSources?.dirs],
                  ] as const
                ).map(([label, items]) =>
                  items?.length ? (
                    <optgroup key={label} label={label}>
                      {items.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </optgroup>
                  ) : null
                )}
              </select>
            </div>
          ) : (
            <textarea
              value={dgText}
              onChange={(e) => setDgText(e.target.value)}
              rows={5}
              placeholder="把材料粘进来…"
              className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
          )}

          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => void runDigest()}
              disabled={dgBusy || (dgMode === 'text' ? !dgText.trim() : !dgSource)}
              className="shrink-0 rounded-lg bg-gradient-to-r from-teal-600 to-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
            >
              {dgBusy ? '拆点中…' : '拆成要搞懂的点'}
            </button>
            {dg?.source_label ? (
              <span className="min-w-0 truncate text-[11px] text-neutral-500">{dg.source_label}</span>
            ) : null}
          </div>

          {dgMsg ? <p className="pt-2 text-[11px] text-rose-600 dark:text-rose-400">{dgMsg}</p> : null}

          {pcNotice ? (
            <p className="pt-2 text-[11px] text-teal-700 dark:text-teal-400">{pcNotice}</p>
          ) : null}

          {dg && dg.points.length > 0 ? (
            <ol className="mt-3 space-y-1.5 border-t border-teal-200/70 pt-2 dark:border-teal-500/20">
              {dg.points.map((p, i) => (
                <li key={`${i}-${p.title}`}>
                  <div className="flex items-stretch gap-1">
                    <button
                      onClick={() => void beginWith(p.title, '', 'socratic', p.id)}
                      disabled={busy}
                      title="开一场教学，专门搞懂这个点"
                      className="block min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/70 disabled:opacity-40 dark:hover:bg-neutral-900/40"
                    >
                      <span className="block text-sm text-neutral-700 dark:text-neutral-200">{p.title}</span>
                      {p.why ? <span className="block text-[11px] text-neutral-400">{p.why}</span> : null}
                    </button>
                    {/* 「按点出卡」：卡面只覆盖这一点，不离开学页 */}
                    <button
                      onClick={() => void makePointCards(p)}
                      disabled={busy || pc?.busy}
                      title="只围绕这一点出几张卡，不离开学页"
                      className="shrink-0 rounded-lg border border-neutral-200 px-2 text-[11px] text-neutral-500 transition-colors hover:border-teal-400 hover:text-teal-600 disabled:opacity-40 dark:border-neutral-700 dark:hover:border-teal-500 dark:hover:text-teal-300"
                    >
                      {pc?.busy && pc.pointId === p.id ? '…' : '🃏'}
                    </button>
                  </div>
                  {pc?.pointId === p.id ? (
                    <div className="ml-2 mt-1 rounded-lg border border-teal-200/70 p-2 dark:border-teal-500/20">
                      {pc.busy ? (
                        <p className="text-[11px] text-neutral-400">出卡中…</p>
                      ) : pc.drafts.length > 0 ? (
                        <>
                          {pc.drafts.map((d, j) => (
                            <label key={j} className="flex cursor-pointer gap-1.5 py-1">
                              <input
                                type="checkbox"
                                checked={pc.picked.has(j)}
                                onChange={() =>
                                  setPc((c) => {
                                    if (!c) return c
                                    const next = new Set(c.picked)
                                    if (next.has(j)) next.delete(j)
                                    else next.add(j)
                                    return { ...c, picked: next, msg: '' }
                                  })
                                }
                                className="mt-0.5 shrink-0"
                              />
                              <span className="min-w-0">
                                <span className="block text-xs text-neutral-700 dark:text-neutral-200">
                                  {d.front}
                                </span>
                                <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">
                                  {d.back}
                                </span>
                                {d.duplicate_of ? (
                                  <span className="block text-[10px] text-amber-600 dark:text-amber-400">
                                    可能的重复
                                  </span>
                                ) : null}
                              </span>
                            </label>
                          ))}
                          <div className="mt-1 flex items-center gap-2">
                            <button
                              onClick={() => void savePointCards()}
                              className="rounded-full border border-teal-300 px-2 py-0.5 text-[10px] text-teal-700 transition-colors hover:bg-teal-50 dark:border-teal-600 dark:text-teal-300 dark:hover:bg-teal-950/40"
                            >
                              入库选中的
                            </button>
                            <button
                              onClick={() => setPc(null)}
                              className="text-[10px] text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
                            >
                              收起
                            </button>
                          </div>
                        </>
                      ) : null}
                      {pc.msg ? (
                        <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">{pc.msg}</p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </>
  )

  // 「学习地图」四档：已掌握 / 在学 / 卡住 / 未触及。**闲置时在开场屏右栏，开了会话
  // 回到会话右栏**——同一份，两处不同时出现（所以不是重复）。前三档纯派生自教学记录，
  // 第四档是 digest 拆出来、还没开成教学的点。是记录，不是待办：不催、不排期。
  // 展开一个概念：顺带把它的「邻居」拉回来（一次向量计算，按概念缓存，不重复请求）。
  const openConceptRow = (concept: string) => {
    const next = openConcept === concept ? null : concept
    setOpenConcept(next)
    if (next && neighbors[concept] === undefined) {
      void api
        .tutorNeighbors(concept)
        .then((r) => setNeighbors((m) => ({ ...m, [concept]: r.neighbors })))
        .catch(() => {})
    }
  }

  const conceptRow = (c: TutorConceptRow) => {
    const evo = rows.filter((r) => r.concept === c.concept)
    const expanded = openConcept === c.concept
    const nebs = neighbors[c.concept]
    return (
              <div key={c.concept} className="group/c relative">
                <button
                  data-concept-row={c.concept}
                  onClick={() => openConceptRow(c.concept)}
                  title={expanded ? '收起' : '展开这个概念的历次记录'}
                  className="block w-full rounded-lg py-1.5 pr-5 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800/70"
                >
                  <span className="flex items-baseline gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-neutral-200">
                      {c.concept}
                    </span>
                    <RepeatChip c={repeatMap.get(c.concept) ?? null} />
                    <span
                      className={`shrink-0 text-[10px] ${
                        c.verdict === 'got'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {c.verdict === 'got' ? '搞懂了' : '半懂'}
                    </span>
                    <span className="shrink-0 text-[10px] text-neutral-400">
                      {(c.last_at || '').slice(5, 10)}
                    </span>
                  </span>
                  {c.stuck ? (
                    <span className="block truncate text-[11px] text-neutral-400">
                      <span
                        className={
                          c.stuck_resolved
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-amber-600 dark:text-amber-400'
                        }
                      >
                        {c.stuck_resolved ? '已解' : '待解'}
                      </span>{' '}
                      ↳ {c.stuck}
                    </span>
                  ) : null}
                  <span className="block truncate text-[10px] text-neutral-400">
                    {c.sessions} 场{c.recalled > 0 ? ` · 接上过 ${c.recalled} 次` : ''}
                  </span>
                </button>
                {/* PLAN2 T1 场景 B：卡片轨的现状就在这一行里——**在概念按钮外面**，
                    因为按钮点的是「展开历次记录」，这一行点的是「去看这些卡」，两件事。
                    没有卡的概念后端连这个键都不带（只摆非零），这里也就不显示。 */}
                {c.cards_summary ? (
                  <Link
                    data-concept-cards={c.concept}
                    to={`/review?${c.cards_summary.topics
                      .map((t) => `topic=${encodeURIComponent(t)}`)
                      .join('&')}`}
                    title="去复习页看这个概念名下的卡"
                    className="block truncate pb-1 pr-5 text-[10px] text-sky-600 hover:underline dark:text-sky-400/90"
                  >
                    {c.cards_summary.n} 张卡 · {c.cards_summary.mature} 成熟 · 近 7 天重来{' '}
                    {c.cards_summary.again_7d} 次
                  </Link>
                ) : null}
                {/* 卡点的出口主要是自动回写（同一概念后来说通了），这里是手动兜底：
                    「我不打算再管这个了」。悬停才现身，免得右栏每行都挂个按钮。 */}
                {c.stuck ? (
                  <button
                    onClick={() => void resolveStuck(c.last_session_id, !c.stuck_resolved)}
                    title={c.stuck_resolved ? '标回待解' : '这条卡点不用管了'}
                    className="absolute right-0 top-1.5 text-[10px] text-neutral-300 opacity-0 transition-opacity hover:text-violet-600 focus:opacity-100 group-hover/c:opacity-100 dark:text-neutral-600 dark:hover:text-violet-300"
                  >
                    {c.stuck_resolved ? '↺' : '✓'}
                  </button>
                ) : null}
                {expanded ? (
                  <div className="mb-1 ml-2 border-l border-neutral-200 pl-2 dark:border-neutral-700">
                    {/* 把这条概念挂到某件事上——念头是看到它的时候冒出来的，所以就在这里 */}
                    <AttachToThread
                      kind="session"
                      ref={String(c.last_session_id)}
                      className="block pb-1"
                    />
                    {evo.length > 0 ? (
                      evo.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => void open(r.id)}
                          className="block w-full rounded py-1 text-left text-[11px] text-neutral-500 transition-colors hover:text-violet-600 dark:text-neutral-400 dark:hover:text-violet-300"
                        >
                          {(r.created_at || '').slice(5, 10)} · {VERDICT_LABEL[r.verdict] || '没标'}
                          {r.stuck ? <span className="text-neutral-400"> · {r.stuck}</span> : null}
                        </button>
                      ))
                    ) : (
                      <button
                        onClick={() => void open(c.last_session_id)}
                        className="block w-full rounded py-1 text-left text-[11px] text-neutral-500 transition-colors hover:text-violet-600 dark:text-neutral-400 dark:hover:text-violet-300"
                      >
                        打开最近一场
                      </button>
                    )}
                    {/* 「邻居」：同一件事 / 同一份材料 / 语义相近。是**观察**不是待办——
                        旁边还有谁，不催你看。第一次要算向量，先占一行说着。 */}
                    {nebs === undefined ? (
                      <div className="pt-1 text-[10px] text-neutral-300 dark:text-neutral-600">
                        看旁边还有谁…
                      </div>
                    ) : nebs.length > 0 ? (
                      <div className="pt-1">
                        <span className="text-[10px] text-neutral-400">旁边还有</span>
                        <span className="flex flex-wrap gap-1 pt-0.5">
                          {nebs.map((n) => (
                            <button
                              key={n.concept}
                              onClick={() => openConceptRow(n.concept)}
                              title={n.why || '语义相近'}
                              className="max-w-full truncate rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 transition-colors hover:bg-violet-100 hover:text-violet-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                            >
                              {n.concept}
                            </button>
                          ))}
                        </span>
                      </div>
                    ) : null}

                    {/* 归一的人工出口（Q3.5）：机器并不了的那些由**人指认** —— 同一个领域的
                        相邻概念在向量空间里比某些该并的还近（尺子：backend/smoke_concept.py）。
                        放在展开了才看得见的地方：这是判断，不是每行都该挂的按钮。 */}
                    <ConceptMerge
                      concept={c.concept}
                      others={allConcepts}
                      busy={mergeBusy}
                      onMerge={doMerge}
                    />
                  </div>
                ) : null}
              </div>
    )
  }

  // 一档 = 小标题 + 该档的概念行。**空档不渲染**（不摆一个「0 个卡住」给人看）。
  const mapGroup = (label: string, cls: string, items: TutorConceptRow[]) =>
    items.length > 0 ? (
      <div key={label} className="pt-1.5">
        <p className={`px-1 pb-0.5 text-[10px] font-medium ${cls}`}>
          {label} <span className="text-neutral-400">{items.length}</span>
        </p>
        {items.slice(0, CONCEPT_RAIL_CAP).map(conceptRow)}
      </div>
    ) : null

  const mapCount = learnMap
    ? learnMap.mastered.length +
      learnMap.learning.length +
      learnMap.stuck.length +
      learnMap.untouched.length
    : 0
  // 档位标签上的数：四档各几个。**从地图那一份里数**（不另算一份）。
  const mapCounts: Record<ConceptState, number> = {
    mastered: learnMap?.mastered.length ?? 0,
    learning: learnMap?.learning.length ?? 0,
    stuck: learnMap?.stuck.length ?? 0,
    untouched: learnMap?.untouched.length ?? 0,
  }

  // 会话历史列表：开场屏概览和会话右栏共用同一份（两处不会同时出现）。
  // 工具面板的执行：面板里收话题，跑哪个工具由打开的那张卡决定
  const runTool = () => {
    const t = toolTopic.trim()
    if (!t) return
    setTopic(t)
    if (toolOpen === 'research') void runResearch(t)
    else if (toolOpen === 'decide') void runDecide(t)
    else if (toolOpen === 'conflict') void runConflict(t)
    setToolOpen('')
  }

  const historyList = (
    <div>
      {rows.length === 0 ? (
        <p className="px-1 py-2 text-xs text-neutral-400">还没有记录</p>
      ) : (
        <div className="space-y-0.5">
          {rows.map((r) => (
            <button
              key={r.id}
              onClick={() => void open(r.id)}
              className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                r.id === sid
                  ? 'bg-violet-100 dark:bg-violet-500/15'
                  : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/70'
              }`}
            >
              <span className="block truncate text-sm text-neutral-700 dark:text-neutral-200">
                {r.concept || r.topic}
              </span>
              <span className="block truncate text-[11px] text-neutral-400">
                {r.verdict ? VERDICT_LABEL[r.verdict] : '没标'}
                {r.recalled ? ' · 接上过' : ''}
                {r.stuck ? ` · ${r.stuck}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )

  const conceptsPanel = (
    <>
      {/* 并概念的回执挂在这里而不是那一行：并完之后 source 那一行就没了。
          「机器自己换了个名字」如果界面上不说，就是一件看不见也查不到的事。 */}
      {mergeMsg ? (
        <p data-merge-msg className="px-3 pb-2 text-[11px] text-neutral-500">
          {mergeMsg}
        </p>
      ) : null}
      {learnMap && mapCount > 0 ? (
        <div className="px-3 pb-3">
          <div className="flex items-center justify-between pb-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              学到哪了
            </p>
            <div className="flex items-center gap-1">
              <button
                onClick={() => void runRoundtable()}
                disabled={rtBusy}
                title="开一场圆桌：三个 AI 视角（老师/同侪/考官）笔谈最近的卡点"
                className="rounded-full border border-neutral-200 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-sky-400 hover:text-sky-600 disabled:opacity-40 dark:border-neutral-700 dark:hover:border-sky-500 dark:hover:text-sky-300"
              >
                {rtBusy && !rt ? '讨论中…' : '👥 圆桌'}
              </button>
              <button
                onClick={() => void makeStuckPodcast()}
                disabled={stuckBusy}
                title="把最近的卡点做成一期双人讨论播客"
                className="rounded-full border border-neutral-200 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-violet-400 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:hover:border-violet-500 dark:hover:text-violet-300"
              >
                {stuckBusy ? '生成中…' : '🎧 做成播客'}
              </button>
            </div>
          </div>
          {/* 档位标签：点一个只看那一档，再点一次回到全部——地图先是概览，
              需要时才下钻。**词与色在 `conceptState.ts` 一份**（小屋的概念卡读同一份）。 */}
          <div className="flex flex-wrap gap-1.5 pb-2">
            {CONCEPT_STATES.map((s) => (
              <button
                key={s.key}
                onClick={() => setMapFilter(mapFilter === s.key ? null : s.key)}
                title={mapFilter === s.key ? '再点一下回到全部' : `只看${s.label}`}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                  mapFilter === s.key
                    ? `${s.chip} font-medium ring-2`
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-500'
                }`}
              >
                {s.label} {mapCounts[s.key]}
              </button>
            ))}
          </div>
          {(mapFilter === null || mapFilter === 'mastered')
            ? mapGroup(CONCEPT_STATE.mastered.label, CONCEPT_STATE.mastered.text, learnMap.mastered)
            : null}
          {(mapFilter === null || mapFilter === 'learning')
            ? mapGroup(CONCEPT_STATE.learning.label, CONCEPT_STATE.learning.text, learnMap.learning)
            : null}
          {(mapFilter === null || mapFilter === 'stuck')
            ? mapGroup(CONCEPT_STATE.stuck.label, CONCEPT_STATE.stuck.text, learnMap.stuck)
            : null}
          {(mapFilter === null || mapFilter === 'untouched') && learnMap.untouched.length > 0 ? (
            <div className="pt-1.5">
              <p className={`px-1 pb-0.5 text-[10px] font-medium ${CONCEPT_STATE.untouched.text}`}>
                {CONCEPT_STATE.untouched.label}{' '}
                <span className="text-neutral-400">{learnMap.untouched.length}</span>
              </p>
              {learnMap.untouched.slice(0, CONCEPT_RAIL_CAP).map((p) => (
                <button
                  key={p.id}
                  onClick={() => void beginWith(p.point, '', 'socratic', p.id)}
                  disabled={busy}
                  title="拆自材料、还没开教——点开就专门搞懂这个点"
                  className="block w-full rounded-lg py-1.5 pr-3 text-left transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800/70"
                >
                  <span className="block truncate text-xs text-neutral-700 dark:text-neutral-200">
                    {p.point}
                  </span>
                  {p.why ? (
                    <span className="block truncate text-[11px] text-neutral-400">{p.why}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          {rt ? (
            <div className="mb-2 mt-2 rounded-lg border border-neutral-100 p-2 dark:border-neutral-800">
              <p className="truncate text-[10px] text-neutral-400">
                圆桌 · {rt.topic}
              </p>
              <ul className="mt-1 space-y-1.5">
                {rt.turns.map((t, i) => (
                  <li key={i} className="text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-300">
                    <span className="font-medium text-neutral-800 dark:text-neutral-100">{t.name}</span>
                    ：{t.text}
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={() => void makeRtPodcast()}
                  disabled={rtBusy}
                  className="rounded-full border border-neutral-200 px-2 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-violet-400 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:hover:border-violet-500 dark:hover:text-violet-300"
                >
                  {rtBusy ? '生成中…' : '🎧 做成播客'}
                </button>
              </div>
              {rtMsg ? (
                <p className="mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                  {rtMsg}
                  {rtAudio && <audio controls src={rtAudio} className="mt-1.5 w-full" />}
                </p>
              ) : null}
            </div>
          ) : null}
          {stuckMsg ? (
            <p className="pb-1.5 pt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              {stuckMsg}
              {stuckAudio && (
                <audio controls src={stuckAudio} className="mt-1.5 w-full" />
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  )

  // 会话右栏的内容（学过的 / 学到哪了 / 会话历史）。**闲置时渲染在开场屏的右栏，
  // 开了会话回到会话右栏**——同一份，两处不同时出现。
  const railPanel = (
    <>
  <div className="px-4 pb-2 pt-4">
    <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
      学过的
    </p>
    {stats && stats.sessions > 0 ? (
      <p className="pt-1 text-xs leading-relaxed text-neutral-500">
        近 {stats.days} 天 {stats.sessions} 次，{stats.got} 次说通了
        {stats.got_with_recall > 0 ? `，其中 ${stats.got_with_recall} 次接上了以前卡的点` : ''}
      </p>
    ) : null}
  </div>
  <div className="flex-1 overflow-y-auto px-2 pb-4">
    {/* 我学到哪了：按概念收敛后的当前状态（纯派生）。一个概念一行，点开看它的
        演进——同一概念历次自评与卡点。是记录，不是待办：不催、不排期。 */}
    {conceptsPanel}
    {rows.length > 0 ? (
      <p className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
        会话历史
      </p>
    ) : null}
    {historyList}
  </div>
    </>
  )

  // 开场屏要不要给卡片留位置——几张卡都没动静时不占地方。
  const hasCards = !!(
    rs || rsDraft || rsBusy || rsMsg ||
    dc || dcFrame || dcDraft || dcBusy || dcMsg ||
    cf || cfSubject || cfDraft || cfBusy || cfMsg ||
    dgOpen || dg || dgBusy || dgMsg
  )

  return (
    <>
      <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {sid === null ? (
            <div className="wb-page flex-1 overflow-y-auto px-6 py-6">
              {/* 开场屏 = 一屏式主页：学 / 练 / 记录 三个标签，一屏只做一类事。
                  2026-09-18 版面改版：容器从 5xl（1024px）放到 1600px，与别的页对齐——
                  它原来是全站最窄的一页，1920 窗口下两侧空掉一半还多。 */}
              <div className="mx-auto flex max-w-[1600px] flex-col gap-6">
                {/* 「学 / 练 / 记录」那排标签已经搬到**侧栏**（2026-09-18 导航改版）：
                    同一件事不留两个入口。这一档仍然走 `?tab=`，所以
                    `/tutor?tab=record` 这种深链、以及页内那几处 setTab 都照旧。 */}
                {tab === 'learn' ? (
                <section className="mx-auto w-full max-w-2xl pt-2 text-center">
                <h1 className="pb-1 text-2xl font-semibold tracking-tight">
                  {mode === 'interview' ? '面试什么方向？' : '你想搞懂什么？'}
                </h1>
                <p className="pb-4 text-sm text-neutral-500">
                  {mode === 'interview'
                    ? '它扮面试官：一次只问一个问题，答得含糊就追一层。散场出一份复盘报告。'
                    : '说一个具体的东西。它会先问你现在怎么理解，再讲。'}
                </p>
                {/* 模式切换：学（苏格拉底）还是讲（费曼）。是会话级选择，不是设置。 */}
                <div className="mb-3 flex justify-center gap-2 text-xs">
                  <button
                    onClick={() => setMode('socratic')}
                    className={`rounded-full border px-3 py-1.5 transition-colors ${
                      mode === 'socratic'
                        ? 'border-violet-500 bg-violet-500/10 font-medium text-violet-600 dark:text-violet-300'
                        : 'border-neutral-300 text-neutral-500 hover:border-violet-300 dark:border-neutral-700'
                    }`}
                  >
                    🎓 老师教我
                  </button>
                  <button
                    onClick={() => setMode('feynman')}
                    className={`rounded-full border px-3 py-1.5 transition-colors ${
                      mode === 'feynman'
                        ? 'border-amber-500 bg-amber-500/10 font-medium text-amber-600 dark:text-amber-300'
                        : 'border-neutral-300 text-neutral-500 hover:border-amber-300 dark:border-neutral-700'
                    }`}
                    title="反转：你来讲，它当较真的学生追问，检验你是不是真懂"
                  >
                    🗣 我来讲（费曼）
                  </button>
                  <button
                    onClick={() => setMode('future')}
                    className={`rounded-full border px-3 py-1.5 transition-colors ${
                      mode === 'future'
                        ? 'border-sky-500 bg-sky-500/10 font-medium text-sky-600 dark:text-sky-300'
                        : 'border-neutral-300 text-neutral-500 hover:border-sky-300 dark:border-neutral-700'
                    }`}
                    title="和一年后的自己聊聊：用你的记忆、日记、学习记录合成「一年后的档案」"
                  >
                    🔮 未来的你
                  </button>
                  {/* M3 面试陪练：只问不教，散场出复盘报告。题库是**他自己的**东西
                      （面试准备.md + 半懂/又卡住的概念 + 到期卡），只读。 */}
                  <button
                    data-mode="interview"
                    onClick={() => setMode('interview')}
                    className={`rounded-full border px-3 py-1.5 transition-colors ${
                      mode === 'interview'
                        ? 'border-amber-500 bg-amber-500/10 font-medium text-amber-600 dark:text-amber-300'
                        : 'border-neutral-300 text-neutral-500 hover:border-amber-300 dark:border-neutral-700'
                    }`}
                    title="它扮面试官：一次一问、答得含糊就追一层，一场 5–8 题，散场出一份复盘报告到 vault/reports/"
                  >
                    🎤 面试陪练
                  </button>
                </div>
                {/* 选中面试陪练时看一眼题库（**只读**）：它问什么，你自己得能查得到。
                    只在选中时拉——不选它的人不该为它付一次请求。 */}
                {mode === 'interview' ? (
                  <p data-interview-bank className="pb-2 text-[11px] text-neutral-400">
                    {bank
                      ? `题库：${
                          bank.file ? `${bank.file} ${bank.questions.length} 条` : '没有 面试准备.md'
                        } · 半懂/又卡住 ${bank.concepts.length} 个 · 到期卡 ${bank.cards.length} 张`
                      : '看一眼题库…'}
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <input
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void begin()
                    }}
                    autoFocus
                    data-tutor-topic
                    placeholder={
                      mode === 'interview'
                        ? '例如：Python 后端'
                        : '例如：asyncio 里 await 到底把控制权交给了谁'
                    }
                    className="min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-left text-sm outline-none transition-colors placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                  <button
                    data-tutor-begin
                    onClick={() => void begin()}
                    disabled={!topic.trim() || busy}
                    className="shrink-0 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-violet-300 transition-all hover:brightness-110 disabled:opacity-40 disabled:shadow-none dark:shadow-violet-900/60"
                  >
                    开始
                  </button>
                </div>
                {err ? <p className="pt-3 text-sm text-rose-600 dark:text-rose-400">{err}</p> : null}
                {/* 开场建议：你自己的记录放在手边（DeepTutor 参考项）。点了才开会话，
                    不是队列——没有计数、没有到期，想不理就不理。 */}
                {starters.length > 0 ? (
                  <div className="flex flex-wrap justify-center gap-2 pt-4">
                    {starters.map((s) => (
                      <button
                        key={s.kind + s.topic}
                        onClick={() => void beginWith(s.topic)}
                        title={
                          s.kind === 'half'
                            ? '上次没完全搞懂，点它从上次的状态接着来'
                            : '你日记里写下的困惑，点它开一场会话'
                        }
                        className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-violet-500/50 dark:hover:text-violet-300"
                      >
                        {s.kind === 'half' ? '↳' : '📔'} {s.note}：{s.topic}
                      </button>
                    ))}
                  </div>
                ) : null}
                </section>
                ) : null}

                {/* 继续上次：最近的会话一跳直达，不用去历史列表里翻 */}
                {tab === 'learn' && rows.length > 0 ? (
                  <div className="mx-auto flex w-full max-w-2xl items-center gap-3 rounded-2xl border border-neutral-200/80 bg-white px-4 py-2.5 dark:border-neutral-800 dark:bg-neutral-900/60">
                    <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">
                      继续上次
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-neutral-600 dark:text-neutral-300">
                      {rows[0].concept || rows[0].topic}
                      {rows[0].stuck ? ` · 卡在：${rows[0].stuck}` : ''}
                    </span>
                    <button
                      onClick={() => void open(rows[0].id)}
                      className="shrink-0 rounded-lg border border-violet-300 px-2.5 py-1 text-xs text-violet-600 transition-colors hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10"
                    >
                      接着学 →
                    </button>
                  </div>
                ) : null}

                {/* 练：一进来就是测验，不摆别的 */}
                {tab === 'practice' ? (
                  <div className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-200/80 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/60">
                    <p className="text-sm text-neutral-600 dark:text-neutral-300">
                      出几道题考你，找出没懂的地方；没答上的就地开教学补课。
                    </p>
                    <Link
                      to="/review"
                      className="shrink-0 rounded-lg border border-violet-300 px-2.5 py-1 text-xs text-violet-600 transition-colors hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10"
                    >
                      出好的卡片去「今日」复习 →
                    </Link>
                  </div>
                ) : null}

                {/* 工具台：一张卡一个工具，点卡片展开它自己的输入面板——话题
                    就地收，不用先去顶部输入框写一遍。跑完的成品卡出现在下面。
                    卡片行只在「学」标签出现；「练」标签下这一节只剩测验面板。 */}
                <section>
                  {tab === 'learn' ? (
                  <>
                  <p className="pb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                    或者直接用这些工具 · 不用先开一场教学
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    <button
                      onClick={() => {
                        setToolTopic(topic)
                        setToolOpen(toolOpen === 'research' ? '' : 'research')
                      }}
                      className={`flex h-full flex-col gap-1 rounded-2xl border p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm ${
                        toolOpen === 'research'
                          ? 'border-sky-400 ring-2 ring-sky-200 dark:ring-sky-500/30'
                          : 'border-neutral-200 bg-white hover:border-sky-300 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-sky-500/40'
                      }`}
                    >
                      <span className="text-xl">🔍</span>
                      <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                        深入研究{rsBusy ? '…' : ''}
                      </span>
                      <span className="text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                        围绕话题搜资料、读正文，写一篇带引用的讲解；成品可存进知识库。
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        setToolTopic(topic)
                        setToolOpen(toolOpen === 'decide' ? '' : 'decide')
                      }}
                      className={`flex h-full flex-col gap-1 rounded-2xl border p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm ${
                        toolOpen === 'decide'
                          ? 'border-violet-400 ring-2 ring-violet-200 dark:ring-violet-500/30'
                          : 'border-neutral-200 bg-white hover:border-violet-300 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-violet-500/40'
                      }`}
                    >
                      <span className="text-xl">🤔</span>
                      <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                        帮我理清{dcBusy ? '…' : ''}
                      </span>
                      <span className="text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                        把它当成一次决策：先复述题面，再摆开选项、指出判据，给有条件的判断。
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        setToolTopic(topic)
                        setToolOpen(toolOpen === 'conflict' ? '' : 'conflict')
                      }}
                      className={`flex h-full flex-col gap-1 rounded-2xl border p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm ${
                        toolOpen === 'conflict'
                          ? 'border-rose-400 ring-2 ring-rose-200 dark:ring-rose-500/30'
                          : 'border-neutral-200 bg-white hover:border-rose-300 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-rose-500/40'
                      }`}
                    >
                      <span className="text-xl">⚔️</span>
                      <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                        对质{cfBusy ? '…' : ''}
                      </span>
                      <span className="text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                        把你的说法和外部来源摆在一起，逐处找对不上的地方。
                      </span>
                    </button>
                    <button
                      onClick={() => setDgOpen(true)}
                      className={`flex h-full flex-col gap-1 rounded-2xl border p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm ${
                        dgOpen
                          ? 'border-teal-400 ring-2 ring-teal-200 dark:ring-teal-500/30'
                          : 'border-neutral-200 bg-white hover:border-teal-300 dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-teal-500/40'
                      }`}
                    >
                      <span className="text-xl">🎒</span>
                      <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                        消化一份材料
                      </span>
                      <span className="text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                        拿一份教程 / 长文 / 仓库，拆成「要搞懂的点」，逐点开教、顺手出卡。
                      </span>
                    </button>
                    <button
                      onClick={() => setTab('practice')}
                      className="flex h-full flex-col gap-1 rounded-2xl border border-neutral-200 bg-white p-4 text-left transition-all hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-orange-500/40"
                    >
                      <span className="text-xl">📝</span>
                      <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                        模拟测验
                      </span>
                      <span className="text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                        拿一份材料出几道题考你，逐题自判；没答上的一键开教学补课。
                      </span>
                    </button>
                  </div>
                  </>
                  ) : null}
                  {/* 点开的工具面板：就地收话题、就地开跑 */}
                  {toolOpen ? (
                    <div
                      className={`mt-3 rounded-2xl border p-4 ${
                        toolOpen === 'research'
                          ? 'border-sky-200 bg-sky-50/40 dark:border-sky-500/30 dark:bg-sky-500/10'
                          : toolOpen === 'decide'
                            ? 'border-violet-200 bg-violet-50/40 dark:border-violet-500/30 dark:bg-violet-500/10'
                            : 'border-rose-200 bg-rose-50/40 dark:border-rose-500/30 dark:bg-rose-500/10'
                      }`}
                    >
                      <div className="flex items-center justify-between pb-2">
                        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                          {toolOpen === 'research'
                            ? '🔍 研究什么？'
                            : toolOpen === 'decide'
                              ? '🤔 要理清什么？'
                              : '⚔️ 拿什么去对质？'}
                        </p>
                        <button
                          onClick={() => setToolOpen('')}
                          className="text-[11px] text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
                        >
                          收起
                        </button>
                      </div>
                      <div className="flex gap-2">
                        <input
                          value={toolTopic}
                          onChange={(e) => setToolTopic(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') runTool()
                          }}
                          autoFocus
                          placeholder="说一个具体的东西…"
                          className="min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                        />
                        <button
                          onClick={runTool}
                          disabled={!toolTopic.trim()}
                          className="shrink-0 rounded-xl bg-neutral-800 px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-125 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
                        >
                          开跑
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {/* 模拟测验面板：选材料 → 出题 → 逐题作答自判 → 总结。
                      没答上的题就地开一场教学，题面就是开场话题。 */}
                  {tab === 'practice' ? (
                    <div className="mt-3 rounded-2xl border border-orange-200 bg-orange-50/40 p-4 dark:border-orange-500/30 dark:bg-orange-500/10">
                      <div className="flex items-center justify-between pb-2">
                        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                          📝 拿什么材料考你？
                        </p>
                        <button
                          onClick={() => setTab('learn')}
                          className="text-[11px] text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
                        >
                          收起
                        </button>
                      </div>

                      {!qz ? (
                        <>
                          <div className="mb-2 flex gap-1 text-xs">
                            {(['file', 'text'] as const).map((m) => (
                              <button
                                key={m}
                                onClick={() => setQzMode(m)}
                                className={`rounded-full border px-2.5 py-1 transition-colors ${
                                  qzMode === m
                                    ? 'border-orange-500 bg-orange-500/10 font-medium text-orange-700 dark:text-orange-300'
                                    : 'border-neutral-300 text-neutral-500 hover:border-orange-300 dark:border-neutral-700'
                                }`}
                              >
                                {m === 'file' ? '📄 选一份材料' : '✍️ 粘一段'}
                              </button>
                            ))}
                          </div>
                          {qzMode === 'file' ? (
                            <div className="space-y-1">
                              <input
                                value={qzQuery}
                                onChange={(e) => setQzQuery(e.target.value)}
                                placeholder="筛选文件名…"
                                className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-orange-400 dark:border-neutral-700 dark:bg-neutral-900"
                              />
                              <select
                                value={qzSource}
                                onChange={(e) => setQzSource(e.target.value)}
                                size={6}
                                className="w-full rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-orange-400 dark:border-neutral-700 dark:bg-neutral-900"
                              >
                                {(
                                  [
                                    ['vault 笔记', qzSources?.vault],
                                    ['代码仓库', qzSources?.repos],
                                    ['本地目录', qzSources?.dirs],
                                  ] as const
                                ).map(([label, items]) =>
                                  items?.length ? (
                                    <optgroup key={label} label={label}>
                                      {items.map((p) => (
                                        <option key={p} value={p}>
                                          {p}
                                        </option>
                                      ))}
                                    </optgroup>
                                  ) : null
                                )}
                              </select>
                            </div>
                          ) : (
                            <textarea
                              value={qzText}
                              onChange={(e) => setQzText(e.target.value)}
                              rows={5}
                              placeholder="把要考的材料粘进来…"
                              className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-orange-400 dark:border-neutral-700 dark:bg-neutral-900"
                            />
                          )}
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              onClick={() => void runQuiz()}
                              disabled={qzBusy || (qzMode === 'text' ? !qzText.trim() : !qzSource)}
                              className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
                            >
                              {qzBusy ? '出题中…' : '出 5 道题考我'}
                            </button>
                            {qzMsg ? (
                              <p className="text-[11px] text-rose-600 dark:text-rose-400">{qzMsg}</p>
                            ) : null}
                          </div>
                        </>
                      ) : null}

                      {/* 逐题作答：先自己想（可写下来），看答案，再自判 */}
                      {qz && qz.idx < qz.cards.length ? (
                        <div className="rounded-xl border border-orange-200/70 bg-white/80 p-4 dark:border-orange-500/20 dark:bg-neutral-900/50">
                          <p className="pb-1 text-[11px] text-neutral-400">
                            第 {qz.idx + 1} / {qz.cards.length} 题 · 已答上{' '}
                            {qz.marks.filter((m) => m === 'hit').length} · 没答上{' '}
                            {qz.marks.filter((m) => m === 'miss').length}
                          </p>
                          <p className="pb-3 text-sm font-medium text-neutral-800 dark:text-neutral-100">
                            {qz.cards[qz.idx].front}
                          </p>
                          {!qz.revealed ? (
                            <>
                              <textarea
                                value={qz.answer}
                                onChange={(e) =>
                                  setQz((c) => (c ? { ...c, answer: e.target.value } : c))
                                }
                                rows={2}
                                placeholder="先把你记得的答案写下来（也可以空着，直接在心里想）"
                                className="w-full resize-none rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-orange-400 dark:border-neutral-700 dark:bg-neutral-900"
                              />
                              <div className="pt-2">
                                <button
                                  onClick={() => setQz({ ...qz, revealed: true })}
                                  className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-medium text-white transition-all hover:brightness-125 dark:bg-neutral-100 dark:text-neutral-900"
                                >
                                  看答案
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="rounded-lg bg-neutral-100 p-3 text-sm leading-relaxed text-neutral-700 dark:bg-neutral-800/70 dark:text-neutral-200">
                                {qz.cards[qz.idx].back}
                              </div>
                              {qz.cards[qz.idx].hint ? (
                                <p className="pt-1.5 text-[11px] text-neutral-400">
                                  提示：{qz.cards[qz.idx].hint}
                                </p>
                              ) : null}
                              <div className="flex gap-2 pt-3">
                                <button
                                  onClick={() => markQuiz('hit')}
                                  className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs text-emerald-700 transition-colors hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
                                >
                                  ✓ 答上了
                                </button>
                                <button
                                  onClick={() => markQuiz('miss')}
                                  className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs text-rose-700 transition-colors hover:bg-rose-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-500/10"
                                >
                                  ✗ 没答上
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ) : null}

                      {/* 总结：全判完才出现。没答上的题就地开教学，题面当开场话题 */}
                      {qz && qz.marks.every((m) => m !== null) ? (
                        <div className="rounded-xl border border-orange-200/70 bg-white/80 p-4 dark:border-orange-500/20 dark:bg-neutral-900/50">
                          <p className="pb-2 text-sm font-medium text-neutral-800 dark:text-neutral-100">
                            测验完成：{qz.marks.filter((m) => m === 'hit').length} / {qz.cards.length}{' '}
                            答上了
                          </p>
                          {qz.marks.some((m) => m === 'miss') ? (
                            <div className="space-y-1.5">
                              <p className="text-[11px] text-neutral-400">
                                这几道没答上——点一题，专门开一场教学把它搞懂：
                              </p>
                              {qz.cards.map((c, i) =>
                                qz.marks[i] === 'miss' ? (
                                  <button
                                    key={i}
                                    onClick={() => {
                                      setTab('learn')
                                      void beginWith(c.front)
                                    }}
                                    className="block w-full rounded-lg px-2 py-1.5 text-left text-sm text-neutral-700 transition-colors hover:bg-orange-100/70 hover:text-orange-800 dark:text-neutral-200 dark:hover:bg-orange-500/10 dark:hover:text-orange-300"
                                  >
                                    ↳ {c.front}
                                  </button>
                                ) : null
                              )}
                            </div>
                          ) : (
                            <p className="text-xs text-emerald-600 dark:text-emerald-400">
                              全部答上了——这份材料你是真懂了。
                            </p>
                          )}
                          <button
                            onClick={() => setQz(null)}
                            className="pt-2 text-[11px] text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
                          >
                            再测一份
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </section>
                {tab === 'learn' && hasCards ? (
                  <div className="flex flex-col gap-4">{reportCards}</div>
                ) : null}

                {tab === 'record' ? (
                <>
                {/* 全空的时候只摆一张欢迎卡：四个「还没有」的空盒子各自漂在页面上，
                    不如把「从哪开始」一次说清。三条入口全是真链接，不造假数据。 */}
                {(!learnMap || mapCount === 0) &&
                (!mastery || mastery.events.length === 0) &&
                stuckRows.length === 0 &&
                (!stats || stats.sessions === 0) ? (
                  <section className="wb-card-hero rounded-2xl p-6">
                    <h2 className="text-base font-semibold text-neutral-800 dark:text-neutral-100">
                      从一场教学开始
                    </h2>
                    <p className="mt-1 max-w-2xl text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
                      这里会记下你学到哪了：说通的概念、挂着的卡点、每一次会话。
                      现在这页还是白的——下面三条路都能让它长出内容。
                    </p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                      <Link
                        to="/tutor"
                        className="rounded-xl border border-violet-200/70 bg-white p-3 transition-colors hover:border-violet-400 dark:border-violet-500/30 dark:bg-neutral-900/60 dark:hover:border-violet-500/60"
                      >
                        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                          🗣 开一场教学
                        </p>
                        <p className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                          挑一个概念讲给零柒听——说通了它就记住，地图上多一颗星。
                        </p>
                      </Link>
                      <Link
                        to="/notes"
                        className="rounded-xl border border-violet-200/70 bg-white p-3 transition-colors hover:border-violet-400 dark:border-violet-500/30 dark:bg-neutral-900/60 dark:hover:border-violet-500/60"
                      >
                        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                          📝 消化一份材料
                        </p>
                        <p className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                          在笔记页划词挖空、让它出题——学的东西带着出处，以后可考。
                        </p>
                      </Link>
                      <Link
                        to="/companion?tab=audio"
                        className="rounded-xl border border-violet-200/70 bg-white p-3 transition-colors hover:border-violet-400 dark:border-violet-500/30 dark:bg-neutral-900/60 dark:hover:border-violet-500/60"
                      >
                        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                          🎙 拿卡点录一期播客
                        </p>
                        <p className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                          没解的卡点让它讲成人话——通勤路上也能把没懂的过一遍。
                        </p>
                      </Link>
                    </div>
                  </section>
                ) : (
                <>
                {/* 学习概览：数据块、概念地图、最近搞懂、卡点清单、会话历史——
                    都收在「记录」标签下，一屏看完自己学到哪了。 */}
                {stats && stats.sessions + stats.concepts > 0 ? (
                  <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {([
                      ['近 14 天', `${stats.sessions} 场`, '教学会话'],
                      ['学过的概念', `${stats.concepts} 个`, '说过「搞懂了」或「半懂」的'],
                      ['说通了', `${stats.got} 次`, '最近一次自评是搞懂'],
                      [
                        '从半懂到懂',
                        `${mastery?.events.filter((e) => e.from_half).length ?? 0} 个`,
                        '以前半懂、后来真说通了',
                      ],
                    ] as const).map(([label, value, hint]) => (
                      <div
                        key={label}
                        className="wb-card p-4"
                      >
                        <p className="text-[11px] text-neutral-400">{label}</p>
                        <p className="pb-0.5 text-xl font-semibold text-neutral-800 dark:text-neutral-100">
                          {value}
                        </p>
                        <p className="text-[10px] leading-relaxed text-neutral-400">{hint}</p>
                      </div>
                    ))}
                  </section>
                ) : null}

                <section className="grid items-start gap-6 lg:grid-cols-2">
                  <div className="wb-card p-4">
                    {conceptsPanel}
                    {!learnMap || mapCount === 0 ? (
                      <p className="px-1 py-2 text-xs leading-relaxed text-neutral-400">
                        还没有学习记录。在上面开一场，或者消化一份材料，这里会长出你的概念地图。
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-6">
                    {/* 最近搞懂：学会一个东西的「时刻」。从半懂到懂的格外标出来——
                        那是这份记录里最值钱的线索 */}
                    <div className="wb-card p-4">
                      <p className="pb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                        最近搞懂
                      </p>
                      {mastery && mastery.events.length > 0 ? (
                        <ul className="space-y-1.5">
                          {mastery.events.slice(0, 6).map((e) => (
                            <li key={e.concept + e.at} className="flex items-baseline gap-2">
                              <span className="shrink-0 text-emerald-500">✦</span>
                              <span className="min-w-0 flex-1 truncate text-sm text-neutral-700 dark:text-neutral-200">
                                {e.concept}
                              </span>
                              {e.from_half ? (
                                <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300">
                                  从半懂到懂
                                </span>
                              ) : null}
                              <span className="shrink-0 text-[10px] text-neutral-400">
                                {(e.at || '').slice(5, 10)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="px-1 py-1 text-xs leading-relaxed text-neutral-400">
                          还没有「说通了」的记录。学完标一次「搞懂了」，这里会记下那个时刻。
                        </p>
                      )}
                    </div>
                    {/* 待解的卡点：全库的卡点集中在这里，逐条可以关掉；做成播客、
                        开圆桌的入口在左边地图的标题行 */}
                    <div className="wb-card p-4">
                      <p className="pb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                        待解的卡点 {stuckRows.filter((s) => !s.resolved_at).length > 0 ? stuckRows.filter((s) => !s.resolved_at).length : ''}
                      </p>
                      {stuckRows.some((s) => !s.resolved_at) ? (
                        <ul className="space-y-2">
                          {stuckRows
                            .filter((s) => !s.resolved_at)
                            .slice(0, 8)
                            .map((s) => (
                              <li key={s.id} className="group/st flex items-start gap-2">
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-baseline gap-1.5">
                                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-700 dark:text-neutral-200">
                                      {s.concept}
                                    </span>
                                    {/* 同一个标也出现在这里：这条卡点所属的概念要正是
                                        「又卡住」的那一批，扫描这一列时才不会看漏 */}
                                    <RepeatChip c={repeatMap.get(s.concept) ?? null} />
                                  </span>
                                  <span className="block text-[11px] leading-relaxed text-neutral-400">
                                    ↳ {s.stuck}
                                  </span>
                                </span>
                                <button
                                  onClick={() => void resolveStuck(s.id, true)}
                                  title="这条不用再管了"
                                  className="shrink-0 text-xs text-neutral-300 opacity-0 transition-opacity hover:text-emerald-600 focus:opacity-100 group-hover/st:opacity-100 dark:text-neutral-600 dark:hover:text-emerald-300"
                                >
                                  ✓
                                </button>
                              </li>
                            ))}
                        </ul>
                      ) : (
                        <p className="px-1 py-1 text-xs leading-relaxed text-neutral-400">
                          没有挂着的卡点。学的时候说「这里没懂」，它会记在这里，等哪天回头解决。
                        </p>
                      )}
                    </div>
                  </div>
                </section>

                {/* 学过的：统计一句话 + 完整会话历史，通栏铺开 */}
                <section className="wb-card p-4">
                  <div className="flex items-baseline justify-between pb-2">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                      学过的
                    </p>
                    {stats && stats.sessions > 0 ? (
                      <p className="text-[11px] text-neutral-400">
                        近 {stats.days} 天 {stats.sessions} 次，{stats.got} 次说通了
                        {stats.got_with_recall > 0
                          ? `，其中 ${stats.got_with_recall} 次接上了以前卡的点`
                          : ''}
                      </p>
                    ) : null}
                  </div>
                  {historyList}
                </section>
                </>
                )}
                </>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              <header className="flex items-center gap-3 border-b border-neutral-200/80 px-6 py-3 dark:border-neutral-800/80">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {mode === 'feynman' && (
                      <span className="mr-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                        费曼
                      </span>
                    )}
                    {mode === 'future' && (
                      <span className="mr-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">
                        未来的你
                      </span>
                    )}
                    {topic || '这次'}
                  </p>
                  {ended?.concept ? (
                    <p className="truncate text-[11px] text-neutral-500">
                      {ended.concept}
                      {ended.domain ? ` · 领域：${ended.domain}` : ''}
                      {ended.stuck ? ` · 卡点：${ended.stuck}` : ''}
                    </p>
                  ) : null}
                  {/* 这次归并了什么，必须说出来：机器自己换了个名字如果界面上不提，
                      就是一件用户看不见也查不到的事。 */}
                  {ended?.merged ? (
                    <p data-ended-merged className="truncate text-[11px] text-violet-600 dark:text-violet-300">
                      这次的叫法「{ended.merged.from}」并进了已有概念「{ended.merged.into}」
                      （{ended.merged.why}）
                    </p>
                  ) : null}
                </div>
                <button
                  onClick={() => void runResearch()}
                  disabled={rsBusy || !topic.trim()}
                  title="围绕这个话题搜资料、读正文，写一篇带引用的讲解；成品可存进知识库"
                  className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-sky-600 transition-colors hover:bg-sky-50 hover:text-sky-700 disabled:opacity-40 dark:text-sky-300 dark:hover:bg-sky-500/10"
                >
                  {rsBusy ? '研究中…' : '🔍 深入研究'}
                </button>
                <button
                  onClick={() => void runDecide()}
                  disabled={dcBusy || !topic.trim()}
                  title="把这个话题当成一次决策：先摆出「我理解你要决定的是什么」，再摆开选项、指出判据、给一个有条件的判断；成品可存进知识库"
                  className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-violet-600 transition-colors hover:bg-violet-50 hover:text-violet-700 disabled:opacity-40 dark:text-violet-300 dark:hover:bg-violet-500/10"
                >
                  {dcBusy ? '理清中…' : '🤔 帮我理清'}
                </button>
                <button
                  onClick={() => void runConflict()}
                  disabled={cfBusy || !topic.trim()}
                  title="把你自己的说法和外部来源摆在一起，看哪两处对不上；一处都没有它会直说没有。成品可存进知识库"
                  className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-teal-600 transition-colors hover:bg-teal-50 hover:text-teal-700 disabled:opacity-40 dark:text-teal-300 dark:hover:bg-teal-500/10"
                >
                  {cfBusy ? '对质中…' : '⚔️ 对质'}
                </button>
                <button
                  onClick={reset}
                  className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  再学一个
                </button>
              </header>

              {modelOk ? null : (
                <p className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  当前默认模型最近失败过，回答可能出不来。去
                  <Link to="/settings" className="underline">
                    设置
                  </Link>
                  换一个。
                </p>
              )}

              <div className="flex-1 overflow-y-auto px-6 py-4">
                <div className="mx-auto flex max-w-3xl flex-col gap-4">
                  {hits.length > 0 ? <RecallChip hits={hits} /> : null}
                  {turns.map((t, i) => (
                    <Bubble key={i} turn={t} />
                  ))}
                  {streaming ? <Bubble turn={{ role: 'assistant', content: streaming }} /> : null}
                  {busy && !streaming ? (
                    <p className="text-sm text-neutral-400">在想…</p>
                  ) : null}
                  {err ? <p className="text-sm text-rose-600 dark:text-rose-400">{err}</p> : null}
                  {reportCards}
                  <div ref={bottom} />
                </div>
              </div>

              <div className="border-t border-neutral-200/80 px-6 py-3 dark:border-neutral-800/80">
                <div className="mx-auto max-w-3xl">
                  {/* 自评在输入框上方，不在会话末尾：标完还能继续问，半懂改成搞懂了
                      也只是再点一次。它是记录这次的结果，不是「交作业」的按钮。
                      **面试陪练没有自评**：面试不是教学，那是另一套收尾（出复盘报告）。 */}
                  {mode === 'interview' ? (
                    <InterviewRow
                      sid={sid}
                      turns={turns.length}
                      busy={busy}
                      onTeach={(topic) => void beginWith(topic, '', 'socratic')}
                    />
                  ) : (
                  <>
                  <div className="flex flex-wrap items-center gap-2 pb-2">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                      这次
                    </span>
                    {VERDICTS.map((v) => (
                      <button
                        key={v.v}
                        data-verdict={v.v}
                        onClick={() => void mark(v.v)}
                        disabled={busy || turns.length === 0}
                        className={`rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
                          verdict === v.v ? 'ring-2 ring-violet-300 dark:ring-violet-500/50 ' : ''
                        }${v.cls}`}
                      >
                        {v.label}
                      </button>
                    ))}
                    {/* M1 场景 B：讲完了不想自己评？让它读一遍全文给一档。
                        它判完走的是**同一条 end()**——概念/卡点、「又卡住」全都照常。 */}
                    <button
                      data-judge
                      onClick={() => void judge()}
                      disabled={busy || judging || turns.length === 0}
                      title="读完整场对话判一档（一次模型调用）；判不了会退回来让你自己标"
                      className="rounded-lg border border-violet-300 px-2.5 py-1 text-xs text-violet-600 transition-colors hover:bg-violet-50 disabled:opacity-40 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-500/10"
                    >
                      {judging ? '判中…' : '让它判'}
                    </button>
                    {judgeMsg ? (
                      <span data-judge-msg className="text-[11px] text-neutral-400">
                        {judgeMsg}
                      </span>
                    ) : null}
                    {verdict ? (
                      <span className="text-[11px] text-neutral-400">
                        {verdict === 'useless'
                          ? '记下了，不会再翻出来'
                          : ended?.concept
                            ? `记下了：${ended.concept}`
                            : '记下了'}
                      </span>
                    ) : null}
                    {/* R3 · PLAN5 §3：把**这一场会话**挂到某件事上。
                        放在这里是因为念头出现的时刻就是「刚聊完这一场」——
                        概念卡里那个入口要你先展开一张卡才看得见，而一场课讲完的那一刻
                        你手里正好有一个 sid。**不做自动挂接**（PLAN5 §4-7 一事一处：
                        归到哪件事是判断，判断留给人点）。
                        只在评过之后摆：没评之前这一场还没「成」，挂上去的是半场。 */}
                    {verdict && sid !== null ? (
                      <AttachToThread kind="session" ref={String(sid)} className="inline-flex" />
                    ) : null}
                    {ended && ended.nearby.length > 0 ? (
                      <span className="text-[11px] text-neutral-400">
                        材料里还有：
                        {ended.nearby.map((n) => (
                          <span key={n.source} className="ml-1 rounded bg-neutral-200/70 px-1.5 py-0.5 dark:bg-neutral-700/60">
                            {shortSource(n.source)}
                          </span>
                        ))}
                      </span>
                    ) : null}
                    {/* 迁移问题（Bjork 参考项）：原场景答对不算懂，换个场景还能用才算。
                        和 material_nearby 一样只在总结里出现一次，不落库。 */}
                    {ended?.transfer ? (
                      <span className="text-[11px] text-violet-500 dark:text-violet-300">
                        换个场景试试：{ended.transfer}
                      </span>
                    ) : null}
                  </div>
                  </>
                  )}
                  {/* 讲法快捷指令：一听没跟上时最常见的四句，一键发出。
                      最后「考我一题」是反转——让它出题，不是继续听讲。 */}
                  <div className="flex flex-wrap items-center gap-1.5 pb-1.5">
                    {QUICK_ASKS.map(([label, text]) => (
                      <button
                        key={label}
                        onClick={() => {
                          if (sid !== null && !busy) void send(sid, text)
                        }}
                        disabled={busy || turns.length === 0}
                        title={text}
                        className="rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-violet-500/50 dark:hover:text-violet-300"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-end gap-2">
                    <textarea
                      data-tutor-say
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          void submit()
                        }
                      }}
                      rows={2}
                      placeholder="先按你自己的理解答一遍（Enter 发送，Shift+Enter 换行）"
                      className="min-w-0 flex-1 resize-none rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                    />
                    <button
                      onClick={() => void submit()}
                      disabled={!draft.trim() || busy}
                      className="shrink-0 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
                    >
                      发送
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* 右栏是历史，不是待办：只写已经发生过的事，没有到期、没有未完成计数。
            开场屏不再渲染它——概览已经铺进页面主体，窄条里什么都看不见。 */}
        {sid !== null ? (
          <aside className="hidden w-64 shrink-0 flex-col border-l border-neutral-200/80 lg:flex dark:border-neutral-800/80">
            {railPanel}
          </aside>
        ) : null}
      </div>
    </>
  )
}




