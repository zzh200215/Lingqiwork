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

/** 一条产出回执：工具刚落盘了一份成品（目前只有 `save_artifact` 会发）。
 *  给的是**能点开的路径**和体裁标签——正文在 vault 文件里，不在对话流里。 */
export interface ArtifactRef {
  kind: string
  label: string
  title: string
  path: string
  href: string
  chunks: number
  /** 这次落盘干了什么：存为 / 更新（覆盖本轮的上一版）/ 另存（同名已有，另开一个）/
   *  未变（和已存的一样，没重复写）。老回执没有这个字段，按「存为」显示。 */
  action?: string
  /** **服务端数过的**实际字数（W4）。以前「超没超」只有模型自己心里算过。 */
  chars?: number
  /** 用户那一句里的字数预算；没认出来就是 null/undefined（不许编一个「不限」出来）。 */
  budget?: number | null
  /** 预算是硬上限（不超过/以内）还是软约束（左右）。 */
  hard?: boolean | null
  /** 超了没有 —— 服务端判的，界面只显示。 */
  over?: boolean
  over_by?: number
  /** 这是本回合同一体裁的第几次落盘（1 = 初稿，2 = 修订）。 */
  save_no?: number
  revised?: boolean
}

/** W2a：服务端对**这一轮**的两条底线校验结论。判定在 `core/turn_quality.py` 一处，
 *  界面只负责显示 —— 前端再算一遍就是第二份实现，两份分叉的那天这条提示就没人敢信了。 */
export interface QualityNote {
  /** 命中的判据代码（`long_body_without_a_receipt` / `invented_path` /
   *  `claims_a_save_without_one`…）。空数组 = 这一轮两条底线都过了。 */
  codes?: string[]
  /** 服务端替它补跑过一次（上一轮没落盘）。 */
  retried?: boolean
  /** 补跑成功、东西真进产出区了。 */
  repaired?: boolean
  /** 用户这一句里明说过要落盘（「存进产出」）。**只有为真时**才把「存进产出」
   *  按钮提到最显眼处 —— 对一次「我不想凭空编」的正确拒绝，提那个按钮是在误导人。 */
  asked_to_save?: boolean
  /** 没能给出去的回执（过不了白名单）与原因。界面不渲染成链接，但要如实说一句。 */
  dropped_receipts?: { path?: string; why?: string }[]
}

/** P3：这一轮有几个**编造的** `[来源 N]` 被拿掉了。
 *
 *  判定在服务端一处（`core/citations.py`），界面只负责显示 —— 前端再识别一遍就是第二份
 *  实现，两份分叉的那天这个数就没人敢信了（与 `QualityNote` 同一条规矩）。
 *  这一帧带的是**剥完之后**的正文：那几个编号已经随流到了屏幕上，不换掉它，就成了
 *  「库里剥了、屏幕上还留着」——两边不一致比不剥更糟。 */
export interface CitationFix {
  /** 剥完之后的正文（拿它替换气泡里已经流出来的那一段）。 */
  text: string
  /** 被拿掉的编号（这一轮没注入的那几个）。 */
  fake: number[]
  /** 这一轮一共注入了多少条材料（= 合法编号的上界）。 */
  injected: number
  /** 真被引用到的编号。 */
  cited: number[]
}

export interface StreamCallbacks {
  onDelta: (text: string, uid?: string) => void
  onError: (message: string) => void
  onDone: () => void
  onSources?: (sources: SourceRef[]) => void
  onTool?: (tc: ToolTrace) => void
  onToolResult?: (name: string, meta: Record<string, unknown>, uid?: string) => void
  onQuality?: (note: QualityNote, uid?: string) => void
  /** P3：服务端剥掉了编造的 `[来源 N]`，带一份干净正文来（界面拿它替换气泡）。 */
  onCitations?: (fix: CitationFix, uid?: string) => void
  /** 这一轮刚落库的那条消息的 id（跑完才有）。界面拿它把气泡接上后端，
   *  于是「📄 存进产出」当场就能点，不用先刷新。 */
  onSaved?: (messageId: number, uid?: string) => void
  onFollowups?: (questions: string[]) => void
  onModelDone?: (uid: string) => void
  onMemorized?: (facts: string[]) => void
  /** 协作的**逐步账**（A2）：每跑完一步就来一条——谁跑的、几轮、调了哪些工具、几秒、
   *  有没有把轮数烧光。与后端 `collab._fact` 那份事实同形（界面不自己算）。 */
  onStep?: (fact: CollabStep) => void
}

/** 协作的一步之账（后端 `collab._fact` 的投影）。 */
export interface CollabStep {
  step: number
  title: string
  /** work / read / digest / draft / review / revise / merge */
  phase: string
  agent: string
  model_id?: string
  rounds: number
  tools: string[]
  artifacts?: string[]
  seconds: number
  error?: string
  /** 轮数烧光：这一步只吐出占位符，**没有答案**（别把它读成"跑完了"） */
  rounds_exhausted?: boolean
  /** 这一步是不是在并行那一波里 */
  parallel?: boolean
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
      else if (event === 'tool_result')
        cb.onToolResult?.(data.name as string, (data.meta ?? {}) as Record<string, unknown>, data.uid as string | undefined)
      else if (event === 'quality') cb.onQuality?.(data as QualityNote, data.uid as string | undefined)
      else if (event === 'citations') cb.onCitations?.(data as CitationFix, data.uid as string | undefined)
      else if (event === 'saved') cb.onSaved?.(data.message_id as number, data.uid as string | undefined)
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
  // A2 加了 fanout（并行分派 → 汇总）。并行是**编排器**说了算的，这里只是选模式。
  pattern: 'pipeline' | 'review' | 'fanout',
  useRag: boolean,
  // 材料清单的第二个来源（2026-09-22）：你钉的这一轮要读哪几份。只有 fanout 吃它，
  // 而且后端会跳过读步打不开的那些（`repo:` / 不在 vault 里的）——所以这里原样发。
  pinned: string[],
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
      pinned,
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
      else if (event === 'step') cb.onStep?.(data.fact as CollabStep)
      else if (event === 'error') cb.onError(data.message as string)
      else if (event === 'done') cb.onDone()
      // meta events: transcript headers already carry the structure
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

// ---------- 零柒的事件流 ----------

/** 一条台词（就是 `/api/pet/feed` 会给的那一行）。 */
export interface PetStreamLine {
  id: number
  kind: string
  text: string
  detail: string
  created_at: string
  name: string
}

/**
 * 零柒的事件流（P4）：**有事发生就立刻说**，不再靠每 15 秒问一次。
 *
 * 两件事会来：`event`（新台词）与 `work`（此刻在跑什么变了）。状态本身不在这条流上算——
 * 它取决于你在哪个页面、多久没动键鼠，那是浏览器才知道的事，所以流只说「有新东西了」，
 * 界面收到 `work` 就重算一次 `/api/pet/state`。
 *
 * **无限流**：正常返回只在服务端关掉它时发生（那就当断了，调用方负责重连）。
 * 用 `fetch` 而不是 `EventSource`：后者发不了自定义 header，也读不出别的错误信息。
 */
export async function streamPet(
  sinceId: number,
  onFrame: (event: string, data: Record<string, unknown>) => void,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch(`/api/pet/stream?since_id=${sinceId}`, { signal })
  if (!res.ok || !res.body) throw new Error(`pet stream failed: ${res.status}`)
  for await (const [event, data] of sseFrames(res)) onFrame(event, data)
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

/** AI card generation with live progress. Resolves with the terminal done event.
 * `focus` 非空 = 只围绕这一点出卡（材料消化后「按点出卡」）。 */
export async function streamCardsGenerate(
  body: {
    source_path?: string
    text?: string
    count?: number
    kinds?: string[]
    focus?: string
  },
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
  /** whether 「你上次卡过」 fired in this session — one of the two numbers */
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

export interface DeliverSourceRef {
  n: number
  /** 'kb' = 你的知识库；'memory' = 长期记忆；'journal' = 日记 */
  kind: 'kb' | 'memory' | 'journal' | string
  title: string
  /** vault 相对路径（kb）；记忆与日记没有单一路径，为空 */
  ref: string
}

export interface DeliverReport {
  title: string
  sections: { heading: string; body: string }[]
  /** 正文里真正引用到的来源编号 */
  used: number[]
  sources: DeliverSourceRef[]
  model_id?: string
  /** 这版提示词（体裁×读者拼出来的）的指纹——质量闭环按它分版本统计 */
  prompt_sha?: string
  /** 这次交付的体裁与读者——存进 vault 之后还看得出这份是给谁写的 */
  genre?: string
  audience?: string
  /** 这次是按哪份提纲写的（空 = 没走提纲）。**提纲不进 `prompt_sha`**：它是每一次运行的
   *  输入，不是提示词版本——算进去的话每份定稿都自成一版，满意率再也聚不起来。 */
  outline?: string[]
}

export interface DeliverDone {
  ok: boolean
  error?: string
  report?: DeliverReport
}

/** Progress stages: gathering / sources / writing / draft（可多帧）. */
export type DeliverStage = (event: string, data: Record<string, unknown>) => void

/**
 * One deliverable run（把你自己积累的材料改写成一份能交出去的体裁）。Same shape as
 * `streamCompose`, plus the two knobs that define the output: 体裁（结构与篇幅）与读者（详略与口气）。
 */
export async function streamDeliver(
  topic: string,
  genre: string,
  audience: string,
  onStage: DeliverStage,
  signal?: AbortSignal,
  /** 「加进这次产出」：钉进来的材料 spec，排在最前（§4-14） */
  pinned: string[] = [],
  /** §8.1 长稿那一模：用户在提纲确认区**定稿的小节名**。空 = 没走提纲（一键直出）。 */
  outline: string[] = []
): Promise<DeliverDone> {
  const res = await fetch('/api/deliver', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, genre, audience, pinned, outline }),
    signal,
  })
  if (!res.ok || !res.body) {
    let detail = `交付失败: ${res.status}`
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* keep status line */
    }
    throw new Error(detail)
  }

  let done: DeliverDone = { ok: false, error: '流提前结束' }
  for await (const [event, data] of sseFrames(res)) {
    if (event === 'report') done = { ok: true, report: data as unknown as DeliverReport }
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

// ---------- 跨源对质 ----------

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
