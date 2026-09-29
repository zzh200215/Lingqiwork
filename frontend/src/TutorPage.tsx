import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import type { ConceptState } from './conceptState'
import { TUTOR_TABS, type TutorTab } from './routes'
import {
  api,
  type CardDraft,
  type CardSources,
  type InterviewBank,
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
} from './api'
import {
  streamCardsGenerate,
  streamTutorSay,
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

import TutorReportCards from './TutorReportCards'
import { TutorConceptsPanel, TutorHistoryList, TutorRailPanel, type TutorRecords } from './TutorRecordsPanels'
import TutorOpening, { type TutorOpeningRec } from './TutorOpening'
import TutorSessionView, { type TutorSessionRec } from './TutorSessionView'
import { useTutorToolRuns } from './useTutorToolRuns'
import { VERDICT_LABEL, pointCardBody, type Turn } from './tutorShared'
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
  // 方向 2：讲解在途**单独一个状态**——`busy` 也被自评保存（mark）置位，共用的话
  // 「在想怎么讲」会在记自评的半秒里说谎。RunPanel 的六态只认这一个。
  const [asking, setAsking] = useState(false)
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
  const { rs, rsBusy, rsDraft, rsMsg, rsSaved, rsInjected, rsOpen, setRsOpen, rsAbortRef, runResearch, saveResearch, clearResearch, dc, dcBusy, dcDraft, dcFrame, dcMsg, dcSaved, dcInjected, dcOpen, setDcOpen, dcAbortRef, runDecide, saveDecide, clearDecide, cf, cfBusy, cfDraft, cfSubject, cfMsg, cfSaved, cfInjected, cfOpen, setCfOpen, cfAbortRef, runConflict, saveConflict, clearConflict } = useTutorToolRuns(topic)
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
    setAsking(true)
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
      setAsking(false)
    }
  }, [])

  // 方向 2：讲解的「停止」是**真停**——/api/tutor/say 是流式端点，掐请求 = 服务端
  // 生成器被取消（部分回复服务端也存了）。RunPanel 的按钮所以敢叫「停止」。
  const stop = useCallback(() => {
    abortRef.current?.abort()
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
  const reportCards = <TutorReportCards {...{ rs, rsDraft, rsBusy, rsMsg, rsSaved, rsOpen, rsInjected, setRsOpen, rsAbortRef, dc, dcDraft, dcBusy, dcFrame, dcMsg, dcSaved, dcOpen, dcInjected, setDcOpen, dcAbortRef, cf, cfDraft, cfBusy, cfSubject, cfMsg, cfSaved, cfOpen, cfInjected, setCfOpen, cfAbortRef, dgOpen, dgMode, dgQuery, dgSources, dgSource, dgText, dgBusy, dg, dgMsg, setDgMode, setDgQuery, setDgSource, setDgText, closeDigest, pc, pcNotice, setPc, runDigest, makePointCards, savePointCards, saveResearch, saveDecide, saveConflict, busy, beginWith }} />
  // 展开一个概念：顺带把它的「邻居」拉回来（一次向量计算，按概念缓存，不重复请求）。
  const runTool = () => {
    const t = toolTopic.trim()
    if (!t) return
    setTopic(t)
    if (toolOpen === 'research') void runResearch(t)
    else if (toolOpen === 'decide') void runDecide(t)
    else if (toolOpen === 'conflict') void runConflict(t)
    setToolOpen('')
  }

  const mapCount = learnMap
    ? learnMap.mastered.length +
      learnMap.learning.length +
      learnMap.stuck.length +
      learnMap.untouched.length
    : 0
  const rec: TutorRecords = {
    allConcepts,
    beginWith,
    busy,
    doMerge,
    learnMap,
    makeRtPodcast,
    makeStuckPodcast,
    mapCount,
    mapFilter,
    mergeBusy,
    mergeMsg,
    neighbors,
    open,
    openConcept,
    repeatMap,
    resolveStuck,
    rows,
    rt,
    rtAudio,
    rtBusy,
    rtMsg,
    runRoundtable,
    setMapFilter,
    setNeighbors,
    setOpenConcept,
    sid,
    stats,
    stuckAudio,
    stuckBusy,
    stuckMsg,
  }
  const historyList = <TutorHistoryList r={rec} />
  const conceptsPanel = <TutorConceptsPanel r={rec} />
  const railPanel = <TutorRailPanel r={rec} />
  const hasCards = !!(
    rs || rsDraft || rsBusy || rsMsg ||
    dc || dcFrame || dcDraft || dcBusy || dcMsg ||
    cf || cfSubject || cfDraft || cfBusy || cfMsg ||
    dgOpen || dg || dgBusy || dgMsg
  )

  const openingRec: TutorOpeningRec = {
    bank,
    begin,
    beginWith,
    busy,
    cfBusy,
    conceptsPanel,
    dcBusy,
    dgOpen,
    err,
    hasCards,
    historyList,
    learnMap,
    mapCount,
    markQuiz,
    mastery,
    mode,
    open,
    qz,
    qzBusy,
    qzMode,
    qzMsg,
    qzQuery,
    qzSource,
    qzSources,
    qzText,
    repeatMap,
    reportCards,
    resolveStuck,
    rows,
    rsBusy,
    runQuiz,
    runTool,
    setDgOpen,
    setMode,
    setQz,
    setQzMode,
    setQzQuery,
    setQzSource,
    setQzText,
    setTab,
    setToolOpen,
    setToolTopic,
    setTopic,
    starters,
    stats,
    stuckRows,
    tab,
    toolOpen,
    toolTopic,
    topic,
  }

  const sessionRec: TutorSessionRec = {
    asking,
    beginWith,
    bottom,
    busy,
    cfBusy,
    dcBusy,
    draft,
    ended,
    err,
    hits,
    judge,
    judgeMsg,
    judging,
    mark,
    mode,
    modelOk,
    reportCards,
    reset,
    rsBusy,
    runConflict,
    runDecide,
    runResearch,
    send,
    setDraft,
    sid,
    stop,
    streaming,
    submit,
    topic,
    turns,
    verdict,
  }
  return (
    <>
      <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {sid === null ? (
            <TutorOpening r={openingRec} />
          ) : (
            <TutorSessionView r={sessionRec} />
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

// 方向 6 第六刀（2026-09-29）：页面小件拆到 tutorShared.tsx——下面这些名字原本就从本文件导出
// （TutorPage.test.tsx 引用），经这里 re-export 保持导入路径不变。
export { pointCardBody, RecallChip, RepeatChip, reportGroups, InterviewRow, shortSource, MaterialLine, ReceiptLine, ConceptMerge } from './tutorShared'
