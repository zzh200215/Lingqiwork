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
