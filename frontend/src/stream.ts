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

/** One KB chunk the teaching drew on this turn (PLAN.md 第 7 节 取材). */
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

export interface ResearchReport {
  title: string
  sections: { heading: string; body: string }[]
  /** 正文里真正引用到的来源编号 */
  used: number[]
  sources: ResearchSourceRef[]
  model_id?: string
}

export interface ResearchDone {
  ok: boolean
  error?: string
  report?: ResearchReport
}

/** Progress stages the page renders as it goes: plan / gathering / sources / writing. */
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
