import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { upsertArtifact } from './artifacts'
import SakuraLayer from './SakuraLayer'
import { api, type AgentPreset, type Conversation, type ProviderConfig } from './api'
import {
  streamChat,
  type ArtifactRef,
  type SourceRef,
} from './stream'
import { useVoiceInput } from './voice'
import { MessageRow, toChatMessage, type ChatMessage } from './ChatMessageRow'
import Welcome from './Welcome'
import ChatSearchOverlay from './ChatSearchOverlay'
import ConversationList from './ConversationList'
import { useCollabChat } from './useCollabChat'
import { useAttachments } from './useAttachments'
import { useVoicePlayback } from './useVoicePlayback'
import ChatHeader from './ChatHeader'
import CollabPanel from './CollabPanel'

export default function App() {
  return (
    <>
      <SakuraLayer on={ambienceOn()} />
      <ChatView />
    </>
  )
}

/** 氛围粒子的开关真值在 localStorage（🌸 按钮切换）。App 根与工具栏各自读它。 */
function ambienceOn(): boolean {
  try {
    return localStorage.getItem('wb:ambience') !== '0'
  } catch {
    return true
  }
}

function ChatView() {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [useRag, setUseRag] = useState(() => localStorage.getItem('useRag') !== '0')
  // 氛围粒子（🌸）：二次元个性化的开关，localStorage 记住选择
  const [ambience, setAmbience] = useState(ambienceOn)
  const [searchParams, setSearchParams] = useSearchParams()
  const [agents, setAgents] = useState<AgentPreset[]>([])
  const [agentId, setAgentId] = useState<number | null>(null)
  const [followups, setFollowups] = useState<string[]>([])
  const [memorizedNote, setMemorizedNote] = useState<string | null>(null)
  const memorizedTimer = useRef<number | null>(null)
  const [compareModel, setCompareModel] = useState<string>('')
  // ---- 附件与联想输入：状态与处理器在 useAttachments ----
  const {
    slashOpen,
    setSlashOpen,
    hashOpen,
    setHashOpen,
    attachedFiles,
    setAttachedFiles,
    attachedImages,
    setAttachedImages,
    queuedMsgs,
    setQueuedMsgs,
    queuedRef,
    fileInputRef,
    ocrBusy,
    slashMatches,
    hashMatches,
    applyPrompt,
    attachFile,
    attachImage,
    handlePaste,
    captureScreen,
    ocrAttached,
  } = useAttachments({ input, setInput, setError })
  // 录音 → 转写：实现搬去了 `voice.ts`，三处共用（这里、今日日记、零柒面板）。
  // 拆出 `recording` / `transcribing` 是为了下面的 JSX 一个字都不用改。
  const voice = useVoiceInput(
    (t) => setInput((prev) => (prev ? `${prev} ${t}` : t)),
    setError
  )
  const { recording, transcribing } = voice
  const { speakingKey, ttsAutoRef, speakText } = useVoicePlayback({ setError })

  function msgKey(m: ChatMessage): string {
    return m.id != null ? `id-${m.id}` : `c-${m.content}`
  }

  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const modelOptions = useMemo(
    () =>
      providers.flatMap((p) =>
        p.enabled ? p.models.map((m) => ({ value: `${p.name}/${m}`, label: `${p.name}/${m}` })) : []
      ),
    [providers]
  )
  const currentModel = conversations.find((c) => c.id === activeId)?.model_id || modelOptions[0]?.value || ''

  useEffect(() => {
    localStorage.setItem('useRag', useRag ? '1' : '0')
  }, [useRag])

  // global shortcuts: Ctrl+K focus search, Ctrl+N new chat（Ctrl+P 全局搜索在 ChatSearchOverlay）
  useEffect(() => {
    // tray menu (desktop shell) asks for a new conversation
    const onNewChat = () => void newChat()
    window.addEventListener('workbench:new-chat', onNewChat)
    return () => window.removeEventListener('workbench:new-chat', onNewChat)
  })

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (k === 'n') {
        e.preventDefault()
        newChat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await api.listProviders())
    } catch (e) {
      setError(String(e))
    }
  }, [])

  const refreshConversations = useCallback(async () => {
    setConversations(await api.listConversations())
  }, [])

  useEffect(() => {
    refreshProviders()
    refreshConversations()
    api.listAgents().then(setAgents).catch(() => {})
  }, [refreshProviders, refreshConversations])

  // 深链：`/?conv=<id>`（仪表盘、侧栏最近对话）与 `/?new=1`（侧栏「＋ 新对话」）。
  // **必须 key 在 search 上**：SPA 里同路由换参数不会重挂这个组件，挂在 `[]` 上的
  // effect 只跑一次——从「最近对话」连点两条，第二条就不生效了。这是 MPA 时代
  // 没有的回归（那时每次点击都是整页加载）。
  // `handled` 挡住同一个值被处理两次：`setSearchParams` 触发的重渲染会再进这里。
  const handledLink = useRef<string | null>(null)
  const convParam = searchParams.get('conv')
  const newParam = searchParams.get('new')
  useEffect(() => {
    const key = convParam ? `conv:${convParam}` : newParam === '1' ? 'new' : null
    if (!key) {
      handledLink.current = null // 参数清掉之后，同一个值应该能再触发一次
      return
    }
    if (handledLink.current === key) return
    handledLink.current = key
    if (key === 'new') {
      void newChat()
    } else {
      const id = Number(convParam)
      if (Number.isFinite(id) && id > 0) void openConversation(id)
    }
    setSearchParams({}, { replace: true })
  }, [convParam, newParam, setSearchParams, newChat, openConversation])

  // auto-scroll only if user is near bottom (don't fight manual scrolling)
  useEffect(() => {
    const el = bottomRef.current?.parentElement
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
    if (nearBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function openConversation(id: number) {
    if (busy) return
    const c = await api.getConversation(id)
    setActiveId(id)
    setMessages(c.messages?.map(toChatMessage) || [])
    setError('')
  }

  async function rateMessage(m: ChatMessage, rating: 'up' | 'down' | null) {
    if (!activeId || !m.id) return
    // optimistic update
    setMessages((prev) =>
      prev.map((x) => (x === m ? { ...x, feedback: rating ?? undefined } : x))
    )
    try {
      await api.setFeedback(activeId, m.id, rating)
    } catch (e) {
      setError(String(e))
      setMessages((prev) =>
        prev.map((x) => (x === m ? { ...x, feedback: m.feedback } : x))
      )
    }
  }

  /** 人工把一条回答存成产出后，把回执挂回那条消息。落盘已经由服务端做完，
   *  这里只更新界面——回执是点开 vault 文件的那条线索，不能等下次刷新才有。 */
  function attachSavedArtifact(m: ChatMessage, art: ArtifactRef) {
    setMessages((prev) =>
      prev.map((x) => (x === m ? { ...x, artifacts: upsertArtifact(x.artifacts, art) } : x))
    )
  }

  async function newChat() {
    if (busy) return
    if (!currentModel) {
      setError('请先在设置页配置 provider 和模型')
      return
    }
    const c = await api.createConversation(currentModel)
    await refreshConversations()
    setActiveId(c.id)
    setMessages([])
    setError('')
  }

  async function deleteConversation(id: number) {
    if (busy) return
    await api.deleteConversation(id)
    if (activeId === id) {
      setActiveId(null)
      setMessages([])
    }
    await refreshConversations()
  }

  async function runStream(convId: number, content: string | null, regenerate = false, contextFiles: string[] = []) {
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setFollowups([])
    let got = false
    let streamedPrimary = '' // primary answer text, for auto-read

    // batch streaming deltas into one setState per animation frame —
    // token-level updates otherwise re-render on every SSE chunk.
    // In comparison mode deltas carry a uid ('a'/'b') to target their message.
    const pending: Record<string, string> = {}
    const rafs: Record<string, number> = {}
    const flush = (key: string) => {
      delete rafs[key]
      const chunk = pending[key]
      if (!chunk) return
      delete pending[key]
      setMessages((prev) => {
        const next = [...prev]
        if (key === 'none') {
          const last = next[next.length - 1]
          next[next.length - 1] = { ...last, content: last.content + chunk }
        } else {
          const idx = next.findLastIndex((m) => (m as { streamUid?: string }).streamUid === key)
          if (idx !== -1) next[idx] = { ...next[idx], content: next[idx].content + chunk }
        }
        return next
      })
    }
    const onDelta = (t: string, uid?: string) => {
      got = true
      if (!uid || uid === 'a') streamedPrimary += t
      const key = uid ?? 'none'
      pending[key] = (pending[key] ?? '') + t
      if (!rafs[key]) rafs[key] = requestAnimationFrame(() => flush(key))
    }

    try {
      await streamChat(
        convId,
        content,
        useRag,
        {
          onDelta,
          onSources: (sources) => {
            setMessages((prev) => {
              const next = [...prev]
              const idx = next.findLastIndex((m) => m.role === 'assistant' && m.streaming)
              if (idx !== -1) next[idx] = { ...next[idx], sources }
              return next
            })
          },
          onTool: (tc) => {
            setMessages((prev) => {
              const next = [...prev]
              const idx = next.findLastIndex((m) => m.role === 'assistant' && m.streaming)
              if (idx === -1) return next
              next[idx] = { ...next[idx], tools: [...(next[idx].tools ?? []), tc] }
              return next
            })
          },
          onToolResult: (_name, meta, uid) => {
            // 后端有两条回执形态：非结构化工具路径发**复数** `meta.artifacts`（支持
            // delegate/多产物，见 chat.py:987），结构化路径发**单数** `meta.artifact`
            // （chat.py:1041）。两种都要认——只读单数会漏掉前者，且 artifacts 空 +
            // 正文说「已存为」会误触发 saveHint 的假告警「说了存却没落盘」。
            const plural = (Array.isArray(meta.artifacts) ? meta.artifacts : []) as ArtifactRef[]
            const single = meta.artifact as ArtifactRef | undefined
            const incoming = (plural.length ? plural : single ? [single] : []).filter(
              (a) => a?.href,
            )
            if (!incoming.length) return
            setMessages((prev) => {
              const next = [...prev]
              // uid 只在对比模式（A/B 两路）里有值；单路时找最后一条流式消息
              const idx =
                uid != null
                  ? next.findLastIndex((m) => m.streaming && m.streamUid === uid)
                  : next.findLastIndex((m) => m.role === 'assistant' && m.streaming)
              if (idx === -1) return next
              const cur = next[idx]
              // 按 path 去重留最后一条：同一轮里同一个文件被存了两版时，流式期间
              // 不能并排出现两条指向同一处的回执（刷新后从库里读到的只有一条，
              // 两边不一致更糟）。见 `artifacts.ts`。
              let artifacts = cur.artifacts
              for (const art of incoming) artifacts = upsertArtifact(artifacts, art)
              next[idx] = { ...cur, artifacts }
              return next
            })
          },
          onError: (msg) => setError(msg),
          onQuality: (note, uid) => {
            // W2a。两种帧：①正在补跑（`retried`）——上一轮那篇长文已经流到屏幕上了，
            // 这一帧就是让界面把它丢掉，换成补跑那一句短回执（长文不进对话是这件事的
            // 全部目的，光在库里不存、屏幕上还留着，等于没做）；
            // ②收尾那一帧——把服务端的判据结论挂在这条消息上，提示由它决定。
            if (note.retried && !note.repaired) {
              setMessages((prev) => {
                const next = [...prev]
                const idx =
                  uid != null
                    ? next.findLastIndex((m) => m.streaming && m.streamUid === uid)
                    : next.findLastIndex((m) => m.role === 'assistant' && m.streaming)
                if (idx === -1) return next
                next[idx] = { ...next[idx], content: '', quality: note }
                return next
              })
              // 补跑那一轮的正文要重新累积：自动播报读的是这里的文本
              if (!uid || uid === 'a') streamedPrimary = ''
              pending[uid ?? 'none'] = ''
              return
            }
            setMessages((prev) => {
              const next = [...prev]
              const idx =
                uid != null
                  ? next.findLastIndex((m) => m.streaming && m.streamUid === uid)
                  : next.findLastIndex((m) => m.role === 'assistant' && m.streaming)
              if (idx === -1) return next
              next[idx] = { ...next[idx], quality: note }
              return next
            })
          },
          onCitations: (fix, uid) => {
            // P3：编造的 `[来源 N]` 已经随流到了屏幕上。服务端把正文剥干净了，这一帧就是
            // 让界面换成剥完的那一份 —— 库里剥了、屏幕上还留着，两边就不一致（那比不剥
            // 更糟：用户以为那条引用是真的，刷新之后它又不见了）。
            //
            // **气泡上不另说一句**：正文换掉之后屏幕与库里就是同一份（刷新也一样），
            // 而这件事的账在服务端（`turn_traces.quality.citations` + 那一栏毛病）。
            // 要弹提示就得把它落进 `messages`，否则刷一下提示就没了 —— 那是另一种不一致。
            const key = uid ?? 'none'
            // 这一帧给的是**完整**正文，所以正在攒的那一批 delta 要丢掉：留着的话，
            // 那个还没执行的 flush 会把旧文本（或整份新文本）再拼一次 —— 屏幕上出现两份。
            pending[key] = ''
            if (rafs[key]) {
              cancelAnimationFrame(rafs[key])
              delete rafs[key]
            }
            if (!uid || uid === 'a') streamedPrimary = fix.text
            setMessages((prev) => {
              const next = [...prev]
              const idx =
                uid != null
                  ? next.findLastIndex((m) => m.streaming && m.streamUid === uid)
                  : next.findLastIndex((m) => m.role === 'assistant' && m.streaming)
              if (idx === -1) return next
              next[idx] = { ...next[idx], content: fix.text }
              return next
            })
          },
          onModelError: (message, uid) => {
            // 单个模型分支失败（对比模式 A/B 之一，或单模型）。后端仍会走到 done，
            // 界面若不认这一帧，那条流式气泡就空着转圈到结束。把它当场收尾成错误。
            const key = uid ?? 'none'
            pending[key] = ''
            if (rafs[key]) {
              cancelAnimationFrame(rafs[key])
              delete rafs[key]
            }
            const notice = `⚠️ 模型出错：${message}`
            setMessages((prev) => {
              const next = [...prev]
              const idx =
                uid != null
                  ? next.findLastIndex((m) => m.streaming && m.streamUid === uid)
                  : next.findLastIndex((m) => m.role === 'assistant' && m.streaming)
              if (idx === -1) return next
              const cur = next[idx]
              next[idx] = {
                ...cur,
                content: cur.content ? `${cur.content}\n\n${notice}` : notice,
                streaming: false,
              }
              return next
            })
          },
          onSaved: (messageId, uid) => {
            // 这一轮刚落库的那条消息：把 id 接上，「📄 存进产出」当场就能点。
            setMessages((prev) => {
              const next = [...prev]
              const idx =
                uid != null
                  ? next.findLastIndex((m) => m.streamUid === uid)
                  : next.findLastIndex((m) => m.role === 'assistant')
              if (idx === -1) return next
              next[idx] = { ...next[idx], id: messageId }
              return next
            })
          },
          onDone: () => {},
          onFollowups: (qs) => setFollowups(qs),
          onMemorized: (facts) => {
            if (!facts.length) return
            const note = `🧠 已记住：${facts.join('；')}`
            setMemorizedNote(note)
            if (memorizedTimer.current) window.clearTimeout(memorizedTimer.current)
            memorizedTimer.current = window.setTimeout(() => setMemorizedNote(null), 8000)
          },
        },
        controller.signal,
        regenerate,
        agentId,
        compareModel || null,
        contextFiles
      )
    } catch (e) {
      if (!controller.signal.aborted) setError(String(e))
    } finally {
      Object.values(rafs).forEach((r) => cancelAnimationFrame(r))
      Object.keys(pending).forEach((k) => flush(k))
      setMessages((prev) => {
        const next = [...prev]
        if (!got) {
          // 一个字都没吐：真正的空占位丢掉。但**落过产出的那一轮不能丢**——正文在
          // vault 文件里，那行回执是这一轮仅有的记录，pop 掉它等于当场把它抹了。
          while (next.length && !next[next.length - 1].content && next[next.length - 1].streaming) {
            if (next[next.length - 1].artifacts?.length) break
            next.pop()
          }
        }
        for (let i = 0; i < next.length; i++) {
          if (next[i].streaming) {
            const { streamUid: _s, ...rest } = next[i] as ChatMessage & { streamUid?: string }
            next[i] = { ...rest, streaming: false }
          }
        }
        return next
      })
      setBusy(false)
      abortRef.current = null
      await refreshConversations()
      // auto-read the finished answer when the pref is on (skip compare mode)
      if (ttsAutoRef.current && got && streamedPrimary.trim() && !compareModel) {
        void speakText(streamedPrimary.trim(), `auto-${activeId}-${Date.now()}`)
      }
      // drain queued messages one at a time
      if (queuedRef.current.length && activeId) {
        const next = queuedRef.current[0]
        setQueuedMsgs((prev) => prev.slice(1))
        await dispatchMessage(activeId, next)
      }
    }
  }

  async function send() {
    const text = input.trim()
    const pending = attachedImages.filter((im) => !im.uploading && im.url.startsWith('/api/images/'))
    if (!text && !pending.length) return
    if (attachedImages.some((im) => im.uploading)) return
    setInput('')
    const imgMd = pending.map((im) => `\n\n![${im.name}](${im.url})`).join('')
    setAttachedImages([])
    // message queue: while a stream is running, queue instead of dropping
    if (busy) {
      setQueuedMsgs((prev) => [...prev, text + imgMd])
      return
    }
    let convId = activeId
    if (!convId) {
      if (!currentModel) {
        setError('请先在设置页配置 provider 和模型')
        return
      }
      const c = await api.createConversation(currentModel)
      convId = c.id
      setActiveId(c.id)
      await refreshConversations()
    }

    await dispatchMessage(convId, text + imgMd)
  }

  async function dispatchMessage(convId: number, text: string) {
    setError('')
    const files = attachedFiles
    setAttachedFiles([])
    const secondary = compareModel && compareModel !== currentModel ? compareModel : null
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text, ctxFiles: files.length ? files : undefined },
      {
        role: 'assistant',
        content: '',
        streaming: true,
        streamUid: 'a',
        modelLabel: secondary ? `A · ${currentModel}` : undefined,
      } as ChatMessage & { streamUid?: string },
      ...(secondary
        ? [
            {
              role: 'assistant' as const,
              content: '',
              streaming: true,
              streamUid: 'b',
              modelLabel: `B · ${secondary}`,
            } as ChatMessage & { streamUid?: string },
          ]
        : []),
    ])
    await runStream(convId, text, false, files)
  }

  // ---- multi-agent collaboration：选择状态与两条处理器在 useCollabChat ----
  const { collabOpen, setCollabOpen, collabPick, setCollabPick, collabPattern, setCollabPattern, collabPins, setCollabPins, startCollab } = useCollabChat({
    input,
    setInput,
    busy,
    setBusy,
    setError,
    activeId,
    setActiveId,
    currentModel,
    refreshConversations,
    setMessages,
    abortRef,
    useRag,
  })

  async function regenerate() {
    if (busy || !activeId) return
    // drop trailing assistant message(s) locally, then ask backend to re-answer
    setMessages((prev) => {
      const next = [...prev]
      while (next.length && next[next.length - 1].role === 'assistant') next.pop()
      next.push({ role: 'assistant', content: '', streaming: true })
      return next
    })
    await runStream(activeId, null, true)
  }

  function stop() {
    abortRef.current?.abort()
  }

  async function editUserMessage(m: ChatMessage, content: string) {
    if (busy || !activeId || !m.id) return
    try {
      await api.editMessage(activeId, m.id, content)
      setFollowups([])
      // local: keep history up to this user msg, then re-run the turn
      setMessages((prev) => {
        const idx = prev.findIndex((x) => x === m)
        const next = prev.slice(0, idx + 1)
        next[next.length - 1] = { ...next[next.length - 1], content }
        next.push({ role: 'assistant', content: '', streaming: true })
        return next
      })
      await runStream(activeId, null, true)
    } catch (e) {
      setError(String(e))
    }
  }

  async function forkFrom(m: ChatMessage) {
    if (!activeId || !m.id) return
    try {
      const fork = await api.forkConversation(activeId, m.id)
      await refreshConversations()
      setActiveId(fork.id)
      const detail = await api.getConversation(fork.id)
      setMessages(
        detail.messages?.map((msg) => ({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          sources: (msg as { sources?: SourceRef[] | null }).sources ?? undefined,
          artifacts: msg.artifacts ?? undefined,
          quality: msg.quality ?? undefined,
        })) || []
      )
      setFollowups([])
    } catch (e) {
      setError(String(e))
    }
  }

  function exportChat() {
    if (activeId) void api.exportConversation(activeId).catch((e) => setError(String(e)))
  }

  async function sendFollowup(q: string) {
    if (busy) return
    let convId = activeId
    if (!convId) return
    setInput('')
    setError('')
    setFollowups([])
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: q },
      { role: 'assistant', content: '', streaming: true },
    ])
    await runStream(convId, q)
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      {/* 页头：整体在 ChatHeader */}
      <ChatHeader
        currentModel={currentModel}
        modelOptions={modelOptions}
        activeId={activeId}
        refreshConversations={refreshConversations}
        agents={agents}
        agentId={agentId}
        setAgentId={setAgentId}
        compareModel={compareModel}
        setCompareModel={setCompareModel}
        useRag={useRag}
        setUseRag={setUseRag}
        ambience={ambience}
        setAmbience={setAmbience}
        conversations={conversations}
        exportChat={exportChat}
      />

      {/* Messages */}
      <div className="flex flex-1 overflow-hidden">
        {/* 会话列表：整体在 ConversationList */}
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          searchRef={searchRef}
          onOpen={openConversation}
          onDelete={deleteConversation}
          refreshConversations={refreshConversations}
        />

        <div className="flex min-w-0 flex-1 flex-col">
        {!messages.length ? (
          <Welcome useRag={useRag} onPick={(p) => { setInput(p); }} />
        ) : (
          <div className="flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto flex max-w-3xl flex-col gap-6">
              {messages.map((m, i) => (
                <MessageRow
                  key={m.id ?? `local-${i}`}
                  m={m}
                  onRegenerate={
                    !busy && i === messages.length - 1 && m.role === 'assistant'
                      ? regenerate
                      : undefined
                  }
                  onFork={
                    !busy && m.id && (m.role === 'assistant' || i === 0)
                      ? () => forkFrom(m)
                      : undefined
                  }
                  onEditUser={
                    !busy && m.role === 'user' && m.id
                      ? (content) => editUserMessage(m, content)
                      : undefined
                  }
                  onFeedback={
                    !busy && m.id && m.role === 'assistant' && !m.streaming
                      ? (rating) => rateMessage(m, rating)
                      : undefined
                  }
                  onSpeak={
                    m.role === 'assistant' && !m.streaming ? () => void speakText(m.content, msgKey(m)) : undefined
                  }
                  speaking={speakingKey === msgKey(m)}
                  convId={activeId ?? undefined}
                  onSavedArtifact={
                    // 已经有回执的不再提供——这条出口是为「模型没存」那一轮准备的
                    !busy && m.id && !m.streaming && !m.artifacts?.length
                      ? (art) => attachSavedArtifact(m, art)
                      : undefined
                  }
                />
              ))}
              {memorizedNote && (
                <div className="flex animate-fade-in justify-center">
                  <span className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-600 dark:border-violet-500/30 dark:bg-violet-950/40 dark:text-violet-300">
                    {memorizedNote}
                  </span>
                </div>
              )}
              {followups.length > 0 && !busy && (
                <div className="flex animate-fade-in flex-wrap gap-2">
                  {followups.map((q) => (
                    <button
                      key={q}
                      onClick={() => sendFollowup(q)}
                      className="rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-600 transition-all hover:-translate-y-0.5 hover:border-violet-300 hover:text-violet-700 hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:border-violet-500/40 dark:hover:text-violet-300"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </div>
        )}
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-neutral-200/80 bg-neutral-50/50 p-4 dark:border-neutral-800/80 dark:bg-neutral-900/30">
        {queuedMsgs.length > 0 && (
          <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-1.5">
            <span className="text-xs uppercase tracking-wider text-neutral-400">排队中</span>
            {queuedMsgs.map((q, i) => (
              <button
                key={`${i}-${q.slice(0, 8)}`}
                onClick={() => setQueuedMsgs((prev) => prev.filter((_, j) => j !== i))}
                title="点击取消发送"
                className="max-w-[220px] truncate rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs text-violet-600 transition-colors hover:border-red-300 hover:text-red-500 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        {attachedFiles.length > 0 && (
          <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-1.5">
            <span className="text-xs uppercase tracking-wider text-neutral-400">附带全文</span>
            {attachedFiles.map((f) => (
              <button
                key={f}
                onClick={() => setAttachedFiles((prev) => prev.filter((x) => x !== f))}
                title="点击移除"
                className="max-w-[240px] truncate rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-600 transition-colors hover:border-red-300 hover:text-red-500 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
              >
                # {f} ✕
              </button>
            ))}
          </div>
        )}
        {attachedImages.length > 0 && (
          <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-neutral-400">图片</span>
            {attachedImages.map((im, i) => (
              <div key={`${im.name}-${i}`} className="group relative">
                <img
                  src={im.url}
                  alt={im.name}
                  className={`h-14 w-14 rounded-lg border border-neutral-200 object-cover dark:border-neutral-700 ${
                    im.uploading ? 'animate-pulse opacity-60' : ''
                  }`}
                />
                {im.uploading && (
                  <span className="absolute inset-0 flex items-center justify-center text-xs text-neutral-500">
                    上传中…
                  </span>
                )}
                {!im.uploading && (
                  <button
                    onClick={() => void ocrAttached(im)}
                    title="提取图中文字（本地 OCR，填入输入框）"
                    className="absolute -bottom-1.5 -left-1.5 h-5 w-5 rounded-full bg-neutral-800 text-xs leading-5 text-white opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50"
                  >
                    {ocrBusy === (im.url.split('/').pop() || im.name) ? '…' : '🔍'}
                  </button>
                )}
                <button
                  onClick={() => setAttachedImages((prev) => prev.filter((x) => x !== im))}
                  title="点击移除"
                  className="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full bg-red-500 text-xs leading-5 text-white opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                >
                  ×
                </button>
              </div>
            ))}
            <span className="text-xs text-neutral-400">
              发送后交给视觉模型理解；悬停图片点 🔍 可本地 OCR 提取文字
            </span>
          </div>
        )}
        {/* data-pet-clear：右下角的零柒按这个属性给自己让位——
            这个输入行在窄屏上正好压在它底下（见 PetWidget 的 dodge）。 */}
        <div data-pet-clear className="relative mx-auto flex max-w-3xl items-end gap-2">
          {/* min-w-0：输入框自己的固有宽度（textarea 按字符数算）不肯缩，
              右边的按钮又都是固定宽。窄窗格（分栏侧栏最窄 260）里这一行会顶出去。 */}
          <div className="relative min-w-0 flex-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              hidden
              onChange={(e) => {
                for (const f of e.target.files ?? []) void attachImage(f)
                e.target.value = ''
              }}
            />
            <textarea
              value={input}
              onPaste={handlePaste}
              onChange={(e) => {
                setInput(e.target.value)
                const v = e.target.value
                setSlashOpen(v.startsWith('/') && !v.slice(1).includes('\n'))
                setHashOpen(/(?:^|\s)#[^\s#]*$/.test(v))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  if (slashOpen && slashMatches.length > 0) {
                    applyPrompt(slashMatches[0])
                    return
                  }
                  if (hashOpen && hashMatches.length > 0) {
                    attachFile(hashMatches[0])
                    return
                  }
                  send()
                } else if (e.key === 'Escape') {
                  setSlashOpen(false)
                  setHashOpen(false)
                }
              }}
              rows={Math.min(8, Math.max(1, input.split('\n').length))}
              placeholder={useRag ? '向你的知识库提问…  / 提示词  # 引用笔记' : '输入消息，Enter 发送，/ 提示词库，# 引用笔记全文'}
              className="w-full resize-none rounded-lg border border-neutral-300 bg-white px-4 py-3 pr-12 text-sm shadow-sm transition-all focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-200 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-violet-500 dark:focus:ring-violet-500/20"
            />
            {slashOpen && (
              <div className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
                <p className="border-b border-neutral-100 px-3 py-1.5 text-xs uppercase tracking-wider text-neutral-400 dark:border-neutral-800">
                  提示词库 · {slashMatches.length} 条匹配（Enter 用第一条）
                </p>
                <div className="max-h-56 overflow-y-auto">
                  {slashMatches.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => applyPrompt(p)}
                      className="block w-full px-3 py-2 text-left transition-colors hover:bg-violet-50 dark:hover:bg-violet-500/10"
                    >
                      <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">/{p.title}</span>
                      <span className="mt-0.5 line-clamp-1 block text-xs text-neutral-400">{p.content}</span>
                    </button>
                  ))}
                  {!slashMatches.length && (
                    <p className="px-3 py-3 text-xs text-neutral-400">没有匹配的提示词 — 在设置页添加</p>
                  )}
                </div>
              </div>
            )}
            {hashOpen && (
              <div className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
                <p className="border-b border-neutral-100 px-3 py-1.5 text-xs uppercase tracking-wider text-neutral-400 dark:border-neutral-800">
                  引用笔记全文 · {hashMatches.length} 个文件（Enter 用第一条）
                </p>
                <div className="max-h-56 overflow-y-auto">
                  {hashMatches.map((f) => (
                    <button
                      key={f}
                      onClick={() => attachFile(f)}
                      className="block w-full truncate px-3 py-2 text-left text-xs text-neutral-700 transition-colors hover:bg-violet-50 dark:text-neutral-200 dark:hover:bg-violet-500/10"
                    >
                      # {f}
                    </button>
                  ))}
                  {!hashMatches.length && (
                    <p className="px-3 py-3 text-xs text-neutral-400">没有匹配的笔记文件</p>
                  )}
                </div>
              </div>
            )}
            <span className="pointer-events-none absolute bottom-3 right-4 text-xs text-neutral-300 dark:text-neutral-600">
              Enter ↵
            </span>
            <button
              onClick={() => fileInputRef.current?.click()}
              title="附加图片（也可直接 Ctrl+V 粘贴截图）"
              className="absolute bottom-2.5 right-9 flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-violet-600 dark:hover:bg-neutral-800"
            >
              📎
            </button>
          </div>
          <CollabPanel
            collabOpen={collabOpen}
            setCollabOpen={setCollabOpen}
            collabPattern={collabPattern}
            setCollabPattern={setCollabPattern}
            collabPick={collabPick}
            setCollabPick={setCollabPick}
            collabPins={collabPins}
            setCollabPins={setCollabPins}
            agents={agents}
            input={input}
            busy={busy}
            startCollab={startCollab}
          />
          <button
            onClick={() => void captureScreen()}
            title="截取屏幕/窗口进行问答（截图会附加为图片）"
            className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-lg border border-neutral-300 bg-white text-lg text-neutral-400 transition-all hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-violet-500/50"
          >
            📷
          </button>
          <button
            onClick={voice.toggle}
            disabled={transcribing}
            title={recording ? '停止录音并转写' : transcribing ? '转写中…' : '语音输入（再次点击结束）'}
            className={`flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-lg border text-lg transition-all disabled:opacity-40 ${
              recording
                ? 'border-red-400 bg-red-50 text-red-500 dark:border-red-500/50 dark:bg-red-500/10'
                : 'border-neutral-300 bg-white text-neutral-400 hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-violet-500/50'
            }`}
          >
            {transcribing ? '⏳' : recording ? <span className="h-2.5 w-2.5 animate-pulse-dot rounded-full bg-red-500" /> : '🎤'}
          </button>
          {busy ? (
            <>
              <button
                onClick={stop}
                className="flex h-[46px] w-[64px] items-center justify-center gap-1.5 rounded-lg border border-neutral-300 bg-white text-sm font-medium text-neutral-600 transition-colors hover:border-red-300 hover:text-red-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-red-500/50"
              >
                <span className="h-2.5 w-2.5 animate-pulse-dot rounded-full bg-red-500" />
                停止
              </button>
              <button
                onClick={send}
                disabled={!input.trim()}
                title="加入队列，回答完成后自动发送"
                className="flex h-[46px] w-[52px] items-center justify-center rounded-lg border border-violet-300 bg-violet-50 text-lg text-violet-600 transition-all hover:border-violet-500 hover:bg-violet-100 disabled:opacity-40 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300"
              >
                ⏭
              </button>
            </>
          ) : (
            <button
              onClick={send}
              disabled={!input.trim()}
              className="flex h-[46px] w-[76px] items-center justify-center rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 text-sm font-medium text-white shadow-sm shadow-violet-300 transition-all hover:shadow-md hover:shadow-violet-400 hover:brightness-110 disabled:from-neutral-200 disabled:to-neutral-200 disabled:text-neutral-400 disabled:shadow-none dark:disabled:from-neutral-800 dark:disabled:to-neutral-800 dark:disabled:text-neutral-600"
            >
              发送
            </button>
          )}
        </div>
        {error && (
          <p className="mx-auto mt-2 max-w-3xl rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
            {error}
          </p>
        )}
      </div>

      {/* 全局搜索遮罩（Ctrl+P）：整体在 ChatSearchOverlay */}
      <ChatSearchOverlay openConversation={openConversation} />
    </main>
  )
}
