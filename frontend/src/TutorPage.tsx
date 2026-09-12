import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import CodeBlock from './CodeBlock'
import FeedbackButtons from './FeedbackButtons'
import {
  api,
  type RoundtableResult,
  type TutorEndResult,
  type TutorSessionRow,
  type TutorStarter,
  type TutorStats,
  type TutorStuckRow,
  type TutorTurn,
} from './api'
import {
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
// daily count. 第 2 节 makes that the single test — the moment a widget here
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

function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{ pre: CodeBlock }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

/** 成文（研究 / 方案同一形状）→ markdown。正文里的 [n] 原样保留，对应来源在卡片的折叠区里。 */
function reportMarkdown(r: { title: string; sections: { heading: string; body: string }[] }): string {
  return (
    `## ${r.title}\n\n` +
    r.sections.map((s) => (s.heading ? `### ${s.heading}\n\n${s.body}` : s.body)).join('\n\n')
  )
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

export default function TutorPage() {
  const [searchParams] = useSearchParams()
  const [sid, setSid] = useState<number | null>(null)
  const [topic, setTopic] = useState('')
  const [mode, setMode] = useState<'socratic' | 'feynman' | 'future'>('socratic')
  const [modelOk, setModelOk] = useState(true)
  const [turns, setTurns] = useState<Turn[]>([])
  const [hits, setHits] = useState<TutorRecallHit[]>([])
  const [streaming, setStreaming] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [verdict, setVerdict] = useState<'' | 'got' | 'half' | 'useless'>('')
  const [ended, setEnded] = useState<{ concept: string; stuck: string; transfer: string; nearby: TutorEndResult['material_nearby'] } | null>(null)
  const [rows, setRows] = useState<TutorSessionRow[]>([])
  const [stuckRows, setStuckRows] = useState<TutorStuckRow[]>([])
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
  // 分析 / 方案（拿不准的事，理清楚再出方案）：拉取式——点「帮我理清」才跑。
  // 和研究的区别在于先出 `frame`（我理解你要决定什么），那是给人看的。
  const [dcBusy, setDcBusy] = useState(false)
  const [dc, setDc] = useState<DecideReport | null>(null)
  const [dcDraft, setDcDraft] = useState<ReportDraft | null>(null)
  const [dcFrame, setDcFrame] = useState<DecideFrame | null>(null)
  const [dcMsg, setDcMsg] = useState('')
  const [dcSaved, setDcSaved] = useState('')
  // 对质（跨源冲突检测）：把你自己的说法和外部来源摆在一起，看哪两处对不上。同样是
  // 拉取式——点「对质」才跑；材料里没有对不上的时它会直说没有，那不是失败。
  const [cfBusy, setCfBusy] = useState(false)
  const [cf, setCf] = useState<ConflictReport | null>(null)
  const [cfDraft, setCfDraft] = useState<ReportDraft | null>(null)
  const [cfSubject, setCfSubject] = useState('')
  const [cfMsg, setCfMsg] = useState('')
  const [cfSaved, setCfSaved] = useState('')
  const [stats, setStats] = useState<TutorStats | null>(null)
  // 开场建议（DeepTutor 参考项）：从记录里派生的就近入口，挂了就静默没有
  const [starters, setStarters] = useState<TutorStarter[]>([])
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
    api.tutorStuck().then((r) => setStuckRows(r.stuck)).catch(() => {})
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
  const runResearch = useCallback(async () => {
    const t = topic.trim()
    if (!t || rsBusy) return
    rsAbortRef.current?.abort()
    const ctl = new AbortController()
    rsAbortRef.current = ctl
    setRsBusy(true)
    setRs(null)
    setRsDraft(null)
    setRsSaved('')
    setRsMsg('规划检索式…')
    try {
      const r = await streamResearch(
        t,
        (event, data) => {
          if (event === 'plan')
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
  const runDecide = useCallback(async () => {
    const t = topic.trim()
    if (!t || dcBusy) return
    dcAbortRef.current?.abort()
    const ctl = new AbortController()
    dcAbortRef.current = ctl
    setDcBusy(true)
    setDc(null)
    setDcDraft(null)
    setDcFrame(null)
    setDcSaved('')
    setDcMsg('读题中…')
    try {
      const r = await streamDecide(
        t,
        (event, data) => {
          if (event === 'frame') {
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
  const runConflict = useCallback(async () => {
    const t = topic.trim()
    if (!t || cfBusy) return
    cfAbortRef.current?.abort()
    const ctl = new AbortController()
    cfAbortRef.current = ctl
    setCfBusy(true)
    setCf(null)
    setCfDraft(null)
    setCfSubject('')
    setCfSaved('')
    setCfMsg('读题中…')
    try {
      const r = await streamConflict(
        t,
        (event, data) => {
          if (event === 'frame') {
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
    async (topicText: string, repo = '', m: 'socratic' | 'feynman' | 'future' = 'socratic') => {
    const t = topicText.trim()
    if (!t || busy) return
    setTopic(t)
    setMode(m)
    setErr('')
    clearResearch()
    clearDecide()
    try {
      const s = await api.tutorStart(t, repo, m)
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

  const begin = useCallback(() => beginWith(topic), [beginWith, topic])

  const submit = useCallback(async () => {
    const t = draft.trim()
    if (!t || sid === null || busy) return
    setDraft('')
    await send(sid, t)
  }, [draft, sid, busy, send])

  const mark = useCallback(
    async (v: 'got' | 'half' | 'useless') => {
      if (sid === null || busy) return
      setBusy(true)
      try {
        const got = await api.tutorEnd(sid, v)
        setVerdict(v)
        setEnded({ concept: got.concept, stuck: got.stuck, transfer: got.transfer ?? '', nearby: got.material_nearby ?? [] })
        refreshRail()
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [sid, busy, refreshRail]
  )

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
      setEnded(d.verdict ? { concept: d.concept, stuck: d.stuck, transfer: '', nearby: [] } : null)
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
  const handledDeepLink = useRef<string | null>(null)
  useEffect(() => {
    const key = sessionParam
      ? `session:${sessionParam}`
      : newTopic
        ? `new:${newTopic}|${repoParam}`
        : null
    if (!key) {
      handledDeepLink.current = null
      return
    }
    if (handledDeepLink.current === key) return
    handledDeepLink.current = key
    const s = Number(sessionParam)
    if (sessionParam && Number.isFinite(s) && s > 0) void open(s)
    else if (newTopic) void beginWith(newTopic, repoParam)
  }, [sessionParam, newTopic, repoParam, open, beginWith])

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

  return (
    <>
      <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {sid === null ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6">
              <div className="w-full max-w-xl">
                <h1 className="pb-1 text-2xl font-semibold tracking-tight">你想搞懂什么？</h1>
                <p className="pb-4 text-sm text-neutral-500">
                  说一个具体的东西。它会先问你现在怎么理解，再讲。
                </p>
                {/* 模式切换：学（苏格拉底）还是讲（费曼）。是会话级选择，不是设置。 */}
                <div className="mb-3 flex gap-2 text-xs">
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
                </div>
                <div className="flex gap-2">
                  <input
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void begin()
                    }}
                    autoFocus
                    placeholder="例如：asyncio 里 await 到底把控制权交给了谁"
                    className="min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                  <button
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
                  <div className="flex flex-wrap gap-2 pt-4">
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
                      {ended.stuck ? ` · 卡点：${ended.stuck}` : ''}
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
                  {/* 研究卡就地展开在会话流里：进度 → 带引用的讲解 → 存进知识库。
                      它是这一场会话的动作，不落右栏、不计数（第 2 节）。 */}
                  {rs || rsDraft || rsBusy || rsMsg ? (
                    <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-4 dark:border-sky-500/30 dark:bg-sky-500/10">
                      <div className="flex items-center justify-between gap-2 pb-1">
                        <p className="text-[11px] font-medium uppercase tracking-wider text-sky-700 dark:text-sky-300">
                          🔍 研究{rs && rs.rounds && rs.rounds > 1 ? ` · 搜了 ${rs.rounds} 轮` : ''}
                        </p>
                        {rs ? (
                          <button
                            onClick={() => void saveResearch()}
                            disabled={rsBusy || !!rsSaved}
                            className="rounded-full border border-sky-300 px-2 py-0.5 text-[10px] text-sky-700 transition-colors hover:bg-sky-100 disabled:opacity-40 dark:border-sky-500/40 dark:text-sky-300 dark:hover:bg-sky-500/20"
                          >
                            {rsSaved ? '已存进知识库' : rsBusy ? '保存中…' : '存进知识库'}
                          </button>
                        ) : null}
                      </div>
                      {rsMsg ? <p className="text-[11px] text-neutral-500">{rsMsg}</p> : null}
                      {/* draft 先渲染出来（边生成边看）；来源清单、存档、评价这些
                          只有最终产物才准的东西，等 `rs` 到了再出现。 */}
                      {rs || rsDraft ? (
                        <Markdown>{reportMarkdown(rs ?? rsDraft!)}</Markdown>
                      ) : null}
                      {rs ? (
                        <>
                          {rs.sources.length > 0 ? (
                            <details className="mt-2 border-t border-sky-200/70 pt-2 dark:border-sky-500/20">
                              <summary className="cursor-pointer text-[11px] text-neutral-500">
                                来源 {rs.sources.length} 条（你自己的材料{' '}
                                {rs.sources.filter((s) => s.kind === 'kb').length} 条）
                              </summary>
                              <ul className="mt-1 space-y-0.5">
                                {rs.sources.map((s) => (
                                  <li key={s.n} className="text-[11px] leading-relaxed">
                                    <span
                                      className={
                                        rs.used.includes(s.n)
                                          ? 'font-medium text-neutral-800 dark:text-neutral-100'
                                          : 'text-neutral-500 dark:text-neutral-400'
                                      }
                                    >
                                      [{s.n}] {s.kind === 'kb' ? '📄' : '🌐'} {s.title}
                                    </span>
                                    <span className="text-neutral-400"> — {s.ref}</span>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          ) : null}
                          {rsSaved ? (
                            <p className="mt-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                              已存到 {rsSaved}，已进索引——下次相关话题的取材会先捞到它
                            </p>
                          ) : null}
                          <div className="mt-2 border-t border-sky-200/70 pt-2 dark:border-sky-500/20">
                            <FeedbackButtons
                              kind="research"
                              promptSha={rs.prompt_sha}
                              modelId={rs.model_id}
                              artifactRef={rsSaved}
                            />
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {/* 方案卡：先摆「我理解你要决定的是什么」再出正文——读错题是这类功能
                      第一位的失败模式，题面必须在成文之前就看得见。同样是这一场会话的
                      动作，不落右栏、不计数（第 2 节）。 */}
                  {dc || dcFrame || dcDraft || dcBusy || dcMsg ? (
                    <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-4 dark:border-violet-500/30 dark:bg-violet-500/10">
                      <div className="flex items-center justify-between gap-2 pb-1">
                        <p className="text-[11px] font-medium uppercase tracking-wider text-violet-700 dark:text-violet-300">
                          🤔 方案
                        </p>
                        {dc ? (
                          <button
                            onClick={() => void saveDecide()}
                            disabled={dcBusy || !!dcSaved}
                            className="rounded-full border border-violet-300 px-2 py-0.5 text-[10px] text-violet-700 transition-colors hover:bg-violet-100 disabled:opacity-40 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/20"
                          >
                            {dcSaved ? '已存进知识库' : dcBusy ? '保存中…' : '存进知识库'}
                          </button>
                        ) : null}
                      </div>

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

                      {dcMsg ? <p className="text-[11px] text-neutral-500">{dcMsg}</p> : null}

                      {dc || dcDraft ? (
                        <Markdown>{reportMarkdown(dc ?? dcDraft!)}</Markdown>
                      ) : null}
                      {dc ? (
                        <>
                          {dc.sources.length > 0 ? (
                            <details className="mt-2 border-t border-violet-200/70 pt-2 dark:border-violet-500/20">
                              <summary className="cursor-pointer text-[11px] text-neutral-500">
                                来源 {dc.sources.length} 条（你的材料{' '}
                                {dc.sources.filter((s) => s.kind === 'kb').length} 条 · 记忆{' '}
                                {dc.sources.filter((s) => s.kind === 'memory').length} 条）
                              </summary>
                              <ul className="mt-1 space-y-0.5">
                                {dc.sources.map((s) => (
                                  <li key={s.n} className="text-[11px] leading-relaxed">
                                    <span
                                      className={
                                        dc.used.includes(s.n)
                                          ? 'font-medium text-neutral-800 dark:text-neutral-100'
                                          : 'text-neutral-500 dark:text-neutral-400'
                                      }
                                    >
                                      [{s.n}] {s.kind === 'kb' ? '📄' : s.kind === 'memory' ? '🧠' : '🌐'}{' '}
                                      {s.title}
                                    </span>
                                    <span className="text-neutral-400"> — {s.ref}</span>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          ) : null}
                          {dcSaved ? (
                            <p className="mt-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                              已存到 {dcSaved}，已进索引——下次相关话题的取材会先捞到它
                            </p>
                          ) : null}
                          <div className="mt-2 border-t border-violet-200/70 pt-2 dark:border-violet-500/20">
                            <FeedbackButtons
                              kind="decide"
                              promptSha={dc.prompt_sha}
                              modelId={dc.model_id}
                              artifactRef={dcSaved}
                            />
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {/* 对质卡：先摆「这次比的是什么」，再出正文。零冲突时它直接给一句实话
                      （标题就写着「没有对不上的」），那是正常结果不是失败。同一场会话的
                      动作，不落右栏、不计数（第 2 节）。 */}
                  {cf || cfSubject || cfDraft || cfBusy || cfMsg ? (
                    <div className="rounded-xl border border-teal-200 bg-teal-50/60 p-4 dark:border-teal-500/30 dark:bg-teal-500/10">
                      <div className="flex items-center justify-between gap-2 pb-1">
                        <p className="text-[11px] font-medium uppercase tracking-wider text-teal-700 dark:text-teal-300">
                          ⚔️ 对质
                        </p>
                        {cf ? (
                          <button
                            onClick={() => void saveConflict()}
                            disabled={cfBusy || !!cfSaved}
                            className="rounded-full border border-teal-300 px-2 py-0.5 text-[10px] text-teal-700 transition-colors hover:bg-teal-100 disabled:opacity-40 dark:border-teal-500/40 dark:text-teal-300 dark:hover:bg-teal-500/20"
                          >
                            {cfSaved ? '已存进知识库' : cfBusy ? '保存中…' : '存进知识库'}
                          </button>
                        ) : null}
                      </div>

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

                      {cfMsg ? <p className="text-[11px] text-neutral-500">{cfMsg}</p> : null}

                      {cf || cfDraft ? (
                        <Markdown>{reportMarkdown(cf ?? cfDraft!)}</Markdown>
                      ) : null}
                      {cf ? (
                        <>
                          {cf.sources.length > 0 ? (
                            <details className="mt-2 border-t border-teal-200/70 pt-2 dark:border-teal-500/20">
                              <summary className="cursor-pointer text-[11px] text-neutral-500">
                                来源 {cf.sources.length} 条（你的材料{' '}
                                {cf.sources.filter((s) => s.kind === 'kb').length} 条 · 记忆{' '}
                                {cf.sources.filter((s) => s.kind === 'memory').length} 条）
                              </summary>
                              <ul className="mt-1 space-y-0.5">
                                {cf.sources.map((s) => (
                                  <li key={s.n} className="text-[11px] leading-relaxed">
                                    <span
                                      className={
                                        cf.used.includes(s.n)
                                          ? 'font-medium text-neutral-800 dark:text-neutral-100'
                                          : 'text-neutral-500 dark:text-neutral-400'
                                      }
                                    >
                                      [{s.n}] {s.kind === 'kb' ? '📄' : s.kind === 'memory' ? '🧠' : '🌐'}{' '}
                                      {s.title}
                                    </span>
                                    <span className="text-neutral-400"> — {s.ref}</span>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          ) : null}
                          {cfSaved ? (
                            <p className="mt-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                              已存到 {cfSaved}，已进索引——下次相关话题的取材会先捞到它
                            </p>
                          ) : null}
                          <div className="mt-2 border-t border-teal-200/70 pt-2 dark:border-teal-500/20">
                            <FeedbackButtons
                              kind="conflict"
                              promptSha={cf.prompt_sha}
                              modelId={cf.model_id}
                              artifactRef={cfSaved}
                            />
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  <div ref={bottom} />
                </div>
              </div>

              <div className="border-t border-neutral-200/80 px-6 py-3 dark:border-neutral-800/80">
                <div className="mx-auto max-w-3xl">
                  {/* 自评在输入框上方，不在会话末尾：标完还能继续问，半懂改成搞懂了
                      也只是再点一次。它是记录这次的结果，不是「交作业」的按钮。 */}
                  <div className="flex flex-wrap items-center gap-2 pb-2">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                      这次
                    </span>
                    {VERDICTS.map((v) => (
                      <button
                        key={v.v}
                        onClick={() => void mark(v.v)}
                        disabled={busy || turns.length === 0}
                        className={`rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
                          verdict === v.v ? 'ring-2 ring-violet-300 dark:ring-violet-500/50 ' : ''
                        }${v.cls}`}
                      >
                        {v.label}
                      </button>
                    ))}
                    {verdict ? (
                      <span className="text-[11px] text-neutral-400">
                        {verdict === 'useless'
                          ? '记下了，不会再翻出来'
                          : ended?.concept
                            ? `记下了：${ended.concept}`
                            : '记下了'}
                      </span>
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
                  <div className="flex items-end gap-2">
                    <textarea
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

        {/* 右栏是历史，不是待办：只写已经发生过的事，没有到期、没有未完成计数。 */}
        <aside className="hidden w-64 shrink-0 flex-col border-l border-neutral-200/80 lg:flex dark:border-neutral-800/80">
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
            {/* 卡过的点是记录，不是清单：不计数、不打勾、不催。你想看的时候它在那里。 */}
            {stuckRows.length > 0 ? (
              <div className="px-3 pb-3">
                <div className="flex items-center justify-between pb-1.5">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                    卡过的点
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
                {rt ? (
                  <div className="mb-2 rounded-lg border border-neutral-100 p-2 dark:border-neutral-800">
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
                  <p className="pb-1.5 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                    {stuckMsg}
                    {stuckAudio && (
                      <audio controls src={stuckAudio} className="mt-1.5 w-full" />
                    )}
                  </p>
                ) : null}
                {stuckRows.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => void open(r.id)}
                    className="block w-full rounded-lg py-1.5 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800/70"
                  >
                    <span className="block truncate text-xs text-neutral-600 dark:text-neutral-300">
                      {r.concept}
                      <span className="ml-1.5 text-[10px] text-neutral-400">
                        {(r.created_at || '').slice(5, 10)}
                        {r.verdict === 'half' ? ' · 半懂' : ''}
                      </span>
                    </span>
                    <span className="block truncate text-[11px] text-neutral-400">
                      ↳ {r.stuck}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            {rows.length === 0 ? (
              <p className="px-3 py-2 text-xs text-neutral-400">还没有记录</p>
            ) : (
              rows.map((r) => (
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
              ))
            )}
          </div>
        </aside>
      </div>
    </>
  )
}




