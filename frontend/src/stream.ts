// SSE chat streaming via fetch (POST + ReadableStream, no EventSource)

export interface SourceRef {
  source: string
  title: string | null
  chunk: number | null
  score: number
  text: string
  channels?: string[]
}

export interface ToolTrace {
  name: string
  arguments: Record<string, unknown>
}

export interface StreamCallbacks {
  onDelta: (text: string, uid?: string) => void
  onError: (message: string) => void
  onDone: () => void
  onSources?: (sources: SourceRef[]) => void
  onTool?: (tc: ToolTrace) => void
  onFollowups?: (questions: string[]) => void
  onModelDone?: (uid: string) => void
  onMemorized?: (facts: string[]) => void
}

export async function streamChat(
  conversationId: number,
  content: string | null,
  useRag: boolean,
  cb: StreamCallbacks,
  signal: AbortSignal,
  regenerate = false,
  agentId: number | null = null,
  compareModel: string | null = null,
  contextFiles: string[] = []
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: conversationId,
      content: content ?? '',
      use_rag: useRag,
      regenerate,
      agent_id: agentId,
      compare_model: compareModel,
      context_files: contextFiles,
    }),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`chat failed: ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    // SSE events separated by \n\n
    let sep: number
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      }
      if (!dataLines.length) continue
      const data = JSON.parse(dataLines.join('\n'))
      if (event === 'delta') cb.onDelta(data.text as string, data.uid as string | undefined)
      else if (event === 'sources') cb.onSources?.(data.sources as SourceRef[])
      else if (event === 'tool_call') cb.onTool?.({ name: data.name as string, arguments: data.arguments as Record<string, unknown> })
      else if (event === 'followups') cb.onFollowups?.(data.questions as string[])
      else if (event === 'answer_done') cb.onModelDone?.(data.uid as string)
      else if (event === 'memorized') cb.onMemorized?.(data.facts as string[])
      else if (event === 'error') cb.onError(data.message as string)
      else if (event === 'done') cb.onDone()
    }
  }
}

// Multi-agent collaboration run: same SSE vocabulary as chat, plus meta/step
// events the UI may ignore. Deltas are uid-less and build one message.
export async function streamCollab(
  conversationId: number,
  goal: string,
  agentIds: number[],
  pattern: 'pipeline' | 'review',
  useRag: boolean,
  cb: StreamCallbacks,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch('/api/agents/collab', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: conversationId,
      goal,
      agent_ids: agentIds,
      pattern,
      use_rag: useRag,
    }),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`collab failed: ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    let sep: number
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      }
      if (!dataLines.length) continue
      const data = JSON.parse(dataLines.join('\n'))
      if (event === 'delta') cb.onDelta(data.text as string)
      else if (event === 'sources') cb.onSources?.(data.sources as SourceRef[])
      else if (event === 'error') cb.onError(data.message as string)
      else if (event === 'done') cb.onDone()
      // meta / step events: transcript headers already carry the structure
    }
  }
}

export interface PodcastStage {
  stage: 'script' | 'tts' | 'assemble' | string
  index?: number
  total?: number
}

export interface PodcastDone extends Record<string, unknown> {
  ok: boolean
  error?: string
}

// Podcast generation with live progress. Resolves with the terminal done
// event (ok=false carries error); stage events go to onStage as they arrive.
export async function streamPodcastGenerate(
  paths: string[],
  hostVoice: string,
  guestVoice: string,
  title: string,
  onStage: (s: PodcastStage) => void,
  signal?: AbortSignal
): Promise<PodcastDone> {
  const res = await fetch('/api/podcast/generate/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths, host_voice: hostVoice, guest_voice: guestVoice, title }),
    signal,
  })
  if (!res.ok || !res.body) {
    let detail = `podcast generate failed: ${res.status}`
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* keep status line */
    }
    throw new Error(detail)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let done: PodcastDone = { ok: false, error: '流提前结束' }

  for (;;) {
    const { done: streamDone, value } = await reader.read()
    if (streamDone) break
    buf += decoder.decode(value, { stream: true })

    let sep: number
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      }
      if (!dataLines.length) continue
      const data = JSON.parse(dataLines.join('\n'))
      if (event === 'stage') onStage(data as PodcastStage)
      else if (event === 'done') done = data as PodcastDone
    }
  }
  return done
}

/**
 * Read an SSE body as (event, data) pairs.
 *
 * The three functions above each inline this loop; rather than refactor live
 * paths (streamChat is the chat hot path) this exists for new callers only.
 */
export async function* sseFrames(
  res: Response
): AsyncGenerator<[string, Record<string, unknown>]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      }
      if (!dataLines.length) continue
      yield [event, JSON.parse(dataLines.join('\n'))]
    }
  }
}

export interface CardGenStage {
  stage: 'reading' | 'drafting' | 'dedup' | string
  total?: number
  model_id?: string
}

export interface CardGenDone {
  ok: boolean
  error?: string
  cards?: unknown[]
  dropped?: number
  dedup?: 'ok' | 'skipped'
  source?: string
  source_label?: string
  model_id?: string
}

/** AI card generation with live progress. Resolves with the terminal done event. */
export async function streamCardsGenerate(
  body: { source_path?: string; text?: string; count?: number; kinds?: string[] },
  onStage: (s: CardGenStage) => void,
  signal?: AbortSignal
): Promise<CardGenDone> {
  const res = await fetch('/api/cards/generate/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    let detail = `出卡失败: ${res.status}`
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* keep status line */
    }
    throw new Error(detail)
  }

  let done: CardGenDone = { ok: false, error: '流提前结束' }
  for await (const [event, data] of sseFrames(res)) {
    if (event === 'stage') onStage(data as unknown as CardGenStage)
    else if (event === 'done') done = data as unknown as CardGenDone
  }
  return done
}

export interface TutorRecallHit {
  concept: string
  verdict: string
  stuck: string
  /** already local 'MM-DD' — the backend owns the timezone conversion */
  date: string
  score: number
  /** which text won: the concept line or one of the aliases */
  via?: 'concept' | 'alias'
}

/** One KB chunk the teaching drew on this turn (取材). */
export interface TutorMaterialSource {
  source: string
  title: string
  score: number
}

export interface TutorSayDone {
  ok: boolean
  error?: string
  model_id?: string
  /** whether 「你上次卡过」 fired in this session — 第 4 节's second number */
  recalled?: boolean
}

/**
 * One teaching exchange. `onRecall` fires at most once per session, before the
 * first delta; `onDelta` gets the reply as it arrives. Resolves rather than
 * throwing on a model failure: by then the page has already rendered part of the
 * answer, and the backend has stored it, so an exception would throw that away.
 */
export async function streamTutorSay(
  body: { session_id: number; text: string },
  handlers: {
    onDelta: (text: string) => void
    onRecall?: (hits: TutorRecallHit[]) => void
    onSources?: (sources: TutorMaterialSource[]) => void
  },
  signal?: AbortSignal
): Promise<TutorSayDone> {
  const res = await fetch('/api/tutor/say', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    let detail = `讲课失败: ${res.status}`
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* keep status line */
    }
    throw new Error(detail)
  }

  let done: TutorSayDone = { ok: false, error: '流提前结束' }
  for await (const [event, data] of sseFrames(res)) {
    if (event === 'delta') handlers.onDelta(String((data as { text?: string }).text ?? ''))
    else if (event === 'recall')
      handlers.onRecall?.(((data as { hits?: TutorRecallHit[] }).hits ?? []) as TutorRecallHit[])
    else if (event === 'sources')
      handlers.onSources?.(
        ((data as { sources?: TutorMaterialSource[] }).sources ?? []) as TutorMaterialSource[]
      )
    else if (event === 'done') done = { ok: true, ...(data as object) }
    else if (event === 'error')
      done = { ok: false, error: String((data as { message?: string }).message ?? '出错了') }
  }
  return done
}

export interface ResearchSourceRef {
  n: number
  /** 'kb' = 你自己的知识库；'web' = 网络 */
  kind: 'kb' | 'web' | string
  title: string
  /** vault 相对路径（kb）或 URL（web） */
  ref: string
}

/**
 * 流式过程中的**半截**报告——只有 title 与 sections，最后一段正文可能还在写。
 *
 * 四个引擎都发这个（`draft` 事件，可能连着好几帧），页面据此边生成边渲染；
 * `used` / `sources` / `model_id` 这些只有最终产物才准的东西不在这里。
 */
export interface ReportDraft {
  title: string
  sections: { heading: string; body: string }[]
}

export interface ResearchReport {
  title: string
  sections: { heading: string; body: string }[]
  /** 正文里真正引用到的来源编号 */
  used: number[]
  sources: ResearchSourceRef[]
  model_id?: string
  /** 这版成文提示词的指纹——质量闭环按它把评价分版本统计 */
  prompt_sha?: string
  /** 搜了几轮（含第一轮）。多轮 = 发现缺口后又补搜过 */
  rounds?: number
}

export interface ResearchDone {
  ok: boolean
  error?: string
  report?: ResearchReport
}

/** Progress stages: plan / gathering / sources / writing / draft（可多帧）. */
export type ResearchStage = (event: string, data: Record<string, unknown>) => void

/**
 * One research run (学习闭环的中间两跳). `onStage` fires for each progress event;
 * resolves with the terminal report (ok=false carries the error). Like the tutor
 * stream it does not throw on a model/material failure — progress is already on
 * screen, so the page reports it inline and keeps the session alive.
 */
export async function streamResearch(
  topic: string,
  onStage: ResearchStage,
  signal?: AbortSignal
): Promise<ResearchDone> {
  const res = await fetch('/api/research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic }),
    signal,
  })
  if (!res.ok || !res.body) {
    let detail = `研究失败: ${res.status}`
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* keep status line */
    }
    throw new Error(detail)
  }

  let done: ResearchDone = { ok: false, error: '流提前结束' }
  for await (const [event, data] of sseFrames(res)) {
    if (event === 'report') done = { ok: true, report: data as unknown as ResearchReport }
    else if (event === 'error')
      done = { ok: false, error: String((data as { message?: string }).message ?? '出错了') }
    else onStage(event, data)
  }
  return done
}

export interface ComposeSourceRef {
  n: number
  /** 'kb' = 你的知识库；'memory' = 长期记忆；'journal' = 日记 */
  kind: 'kb' | 'memory' | 'journal' | string
  title: string
  /** vault 相对路径（kb）；记忆与日记没有单一路径，为空 */
  ref: string
}

export interface ComposeReport {
  title: string
  sections: { heading: string; body: string }[]
  /** 正文里真正引用到的来源编号 */
  used: number[]
  sources: ComposeSourceRef[]
  model_id?: string
  /** 这版成文提示词的指纹——质量闭环按它把评价分版本统计 */
  prompt_sha?: string
}

export interface ComposeDone {
  ok: boolean
  error?: string
  report?: ComposeReport
}

/** Progress stages: gathering / sources / writing / draft（可多帧）. */
export type ComposeStage = (event: string, data: Record<string, unknown>) => void

/**
 * One produce run (学习闭环的出口跳): 从你自己的材料成文。Same shape as
 * `streamResearch` minus the `plan` stage — 产出不规划检索式，话题直接取自你。
 */
export async function streamCompose(
  topic: string,
  onStage: ComposeStage,
  signal?: AbortSignal
): Promise<ComposeDone> {
  const res = await fetch('/api/compose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic }),
    signal,
  })
  if (!res.ok || !res.body) {
    let detail = `产出失败: ${res.status}`
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* keep status line */
    }
    throw new Error(detail)
  }

  let done: ComposeDone = { ok: false, error: '流提前结束' }
  for await (const [event, data] of sseFrames(res)) {
    if (event === 'report') done = { ok: true, report: data as unknown as ComposeReport }
    else if (event === 'error')
      done = { ok: false, error: String((data as { message?: string }).message ?? '出错了') }
    else onStage(event, data)
  }
  return done
}

export interface RecapSourceRef {
  n: number
  /** belief = 信念线；teach = 学习画像；stuck = 卡点；journal = 日记；files = 最近动的文件 */
  kind: 'belief' | 'teach' | 'stuck' | 'journal' | 'files' | string
  title: string
  ref: string
}

export interface RecapReport {
  title: string
  sections: { heading: string; body: string }[]
  used: number[]
  sources: RecapSourceRef[]
  model_id?: string
  /** 这版成文提示词的指纹——质量闭环按它把评价分版本统计 */
  prompt_sha?: string
}

/** 复盘已落盘（`vault/recap/YYYY-MM-DD.md`）——它自成文就存，没有「先看再决定存不存」。 */
export interface RecapSaved {
  filename: string
  title: string
  chunks: number
}

export interface RecapDone {
  ok: boolean
  error?: string
  report?: RecapReport
  saved?: RecapSaved
}

/** Progress stages: gathering / sources / writing / draft（可多帧）. */
export type RecapStage = (event: string, data: Record<string, unknown>) => void

/**
 * One recap run: 把散落的记录合成一篇「最近」。Same shape as the research stream,
 * plus a terminal `saved` event — recap writes itself to the vault, because there
 * is nothing to decide before storing it.
 */
export async function streamRecap(
  onStage: RecapStage,
  signal?: AbortSignal
): Promise<RecapDone> {
  const res = await fetch('/api/recap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal,
  })
  if (!res.ok || !res.body) {
    let detail = `复盘失败: ${res.status}`
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* keep status line */
    }
    throw new Error(detail)
  }

  let done: RecapDone = { ok: false, error: '流提前结束' }
  for await (const [event, data] of sseFrames(res)) {
    if (event === 'report') done = { ...done, ok: true, report: data as unknown as RecapReport }
    else if (event === 'saved') done = { ...done, ok: true, saved: data as unknown as RecapSaved }
    else if (event === 'error')
      done = { ok: false, error: String((data as { message?: string }).message ?? '出错了') }
    else onStage(event, data)
  }
  return done
}

export interface DecideSourceRef {
  n: number
  /** 'kb' = 你的知识库；'memory' = 长期记忆；'web' = 网络 */
  kind: 'kb' | 'memory' | 'web' | string
  title: string
  /** vault 相对路径（kb）或 URL（web）；记忆没有单一路径，为空 */
  ref: string
}

/**
 * 读题结果。它是这一条独有的、**给人看的**中间产物：先摆出「我理解你要决定的是 X，
 * 要比的是 A / B / C」，再去取材料。读错题是这类功能第一位的失败模式。
 */
export interface DecideFrame {
  decision: string
  /** 2-4 个真正的备选——你只提了一个，后端也会把别的补出来 */
  options: string[]
  /** 3-5 条真正会左右结果的判据 */
  criteria: string[]
}

export interface DecideReport {
  title: string
  sections: { heading: string; body: string }[]
  /** 正文里真正引用到的来源编号 */
  used: number[]
  sources: DecideSourceRef[]
  model_id?: string
  /** 这版成文提示词的指纹——质量闭环按它把评价分版本统计 */
  prompt_sha?: string
  /** 题面随报告一起回来，存进知识库之后还看得出这份方案在回答什么 */
  frame?: DecideFrame
}

export interface DecideDone {
  ok: boolean
  error?: string
  report?: DecideReport
}

/** Progress stages: framing / frame / gathering / sources / writing / draft（可多帧）. */
export type DecideStage = (event: string, data: Record<string, unknown>) => void

/**
 * One decision run（拿不准的事，理清楚再出方案）。Same shape as `streamResearch`,
 * except `frame` is a stage the page renders rather than an internal step: 题读得对不对
 * 只有人看得出来，所以在取材料之前就摆到屏幕上。
 */
export async function streamDecide(
  topic: string,
  onStage: DecideStage,
  signal?: AbortSignal
): Promise<DecideDone> {
  const res = await fetch('/api/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic }),
    signal,
  })
  if (!res.ok || !res.body) {
    let detail = `理清失败: ${res.status}`
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* keep status line */
    }
    throw new Error(detail)
  }

  let done: DecideDone = { ok: false, error: '流提前结束' }
  for await (const [event, data] of sseFrames(res)) {
    if (event === 'report') done = { ok: true, report: data as unknown as DecideReport }
    else if (event === 'error')
      done = { ok: false, error: String((data as { message?: string }).message ?? '出错了') }
    else onStage(event, data)
  }
  return done
}

// ---------- 跨源对质 (PLAN §10.3 B) ----------

/** 一处对不上：两侧的来源编号 + 一句话说清哪一点撞上了。 */
export interface ConflictPair {
  a_n: number
  b_n: number
  basis: string
}

export interface ConflictSourceRef {
  n: number
  kind: string
  title: string
  ref: string
}

export interface ConflictReport {
  title: string
  sections: { heading: string; body: string }[]
  /** 正文里真正引用到的来源编号 */
  used: number[]
  sources: ConflictSourceRef[]
  model_id?: string
  /** 这版成文提示词的指纹——质量闭环按它把评价分版本统计 */
  prompt_sha?: string
  /** 读题结果随报告一起回来——「这次比的是什么」在存进知识库之后还看得见 */
  subject?: string
  /** 判定对不上的编号对；空数组 = 材料里确实没找到对不上的（不是失败） */
  pairs?: ConflictPair[]
}

export interface ConflictDone {
  ok: boolean
  error?: string
  report?: ConflictReport
}

/** Progress stages: framing / frame / gathering / sources / finding / writing / draft（可多帧）. */
export type ConflictStage = (event: string, data: Record<string, unknown>) => void

/**
 * One confrontation run（你自己的说法 vs 外部来源，看哪两处对不上）。
 *
 * Same shape as `streamDecide`, with one extra stage: `finding` fires after the
 * material is in hand and before anything is written — the page says "在比对…"
 * there. A run that finds nothing still terminates with a `report` (its title
 * says so); that is a normal outcome, not an error.
 */
export async function streamConflict(
  topic: string,
  onStage: ConflictStage,
  signal?: AbortSignal
): Promise<ConflictDone> {
  const res = await fetch('/api/conflict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic }),
    signal,
  })
  if (!res.ok || !res.body) {
    let detail = `对质失败: ${res.status}`
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* keep status line */
    }
    throw new Error(detail)
  }

  let done: ConflictDone = { ok: false, error: '流提前结束' }
  for await (const [event, data] of sseFrames(res)) {
    if (event === 'report') done = { ok: true, report: data as unknown as ConflictReport }
    else if (event === 'error')
      done = { ok: false, error: String((data as { message?: string }).message ?? '出错了') }
    else onStage(event, data)
  }
  return done
}
