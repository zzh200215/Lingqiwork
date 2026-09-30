import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import CollabPins, { type PinnedMaterial } from './CollabPins'
import { upsertArtifact } from './artifacts'
import SakuraLayer from './SakuraLayer'
import { api, type AgentPreset, type Conversation, type PromptItem, type ProviderConfig } from './api'
import {
  streamChat,
  streamCollab,
  type ArtifactRef,
  type CollabStep,
  type SourceRef,
} from './stream'
import { useVoiceInput } from './voice'
import { MessageRow, toChatMessage, type ChatMessage } from './ChatMessageRow'
import Welcome from './Welcome'
import type { SearchHit } from './api'

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
  const [convQuery, setConvQuery] = useState('')
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [agents, setAgents] = useState<AgentPreset[]>([])
  const [agentId, setAgentId] = useState<number | null>(null)
  const [collabOpen, setCollabOpen] = useState(false)
  const [collabPick, setCollabPick] = useState<number[]>([])
  const [collabPattern, setCollabPattern] = useState<'pipeline' | 'review' | 'fanout'>('pipeline')
  // 「这一轮读哪几份」（材料清单的第二个来源，2026-09-22）：只有 fanout 吃材料清单，
  // 所以这一栏也只在 fanout 下露出来（后端对别的模式会记一行"钉了不生效"，见 agents.py）。
  const [collabPins, setCollabPins] = useState<PinnedMaterial[]>([])
  const [followups, setFollowups] = useState<string[]>([])
  const [memorizedNote, setMemorizedNote] = useState<string | null>(null)
  const memorizedTimer = useRef<number | null>(null)
  const [compareModel, setCompareModel] = useState<string>('')
  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [slashOpen, setSlashOpen] = useState(false)
  const [hashOpen, setHashOpen] = useState(false)
  const [noteFiles, setNoteFiles] = useState<string[]>([])
  const [attachedFiles, setAttachedFiles] = useState<string[]>([])
  const [attachedImages, setAttachedImages] = useState<{ name: string; url: string; uploading: boolean }[]>([])
  const [queuedMsgs, setQueuedMsgs] = useState<string[]>([])
  const queuedRef = useRef<string[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // 录音 → 转写：实现搬去了 `voice.ts`，三处共用（这里、今日日记、零柒面板）。
  // 拆出 `recording` / `transcribing` 是为了下面的 JSX 一个字都不用改。
  const voice = useVoiceInput(
    (t) => setInput((prev) => (prev ? `${prev} ${t}` : t)),
    setError
  )
  const { recording, transcribing } = voice
  const [ocrBusy, setOcrBusy] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [speakingKey, setSpeakingKey] = useState<string | null>(null)
  const ttsAutoRef = useRef(false)

  function msgKey(m: ChatMessage): string {
    return m.id != null ? `id-${m.id}` : `c-${m.content}`
  }

  async function speakText(content: string, key: string) {
    if (speakingKey === key) {
      audioRef.current?.pause()
      audioRef.current = null
      setSpeakingKey(null)
      return
    }
    audioRef.current?.pause()
    audioRef.current = null
    setSpeakingKey(key)
    try {
      const r = await api.tts(content)
      const audio = new Audio(r.url)
      audioRef.current = audio
      audio.onended = () => {
        setSpeakingKey(null)
        audioRef.current = null
      }
      audio.onerror = () => setSpeakingKey(null)
      await audio.play()
    } catch (e) {
      setSpeakingKey(null)
      setError(`语音播报失败：${String(e)}`)
    }
  }

  useEffect(() => {
    fetch('/api/settings/prefs')
      .then((r) => r.json())
      .then((p) => {
        ttsAutoRef.current = !!p.tts_auto
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    queuedRef.current = queuedMsgs
  }, [queuedMsgs])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const globalSearchRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const filteredConversations = useMemo(() => {
    const q = convQuery.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter((c) => c.title.toLowerCase().includes(q))
  }, [conversations, convQuery])

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

  // global shortcuts: Ctrl+K focus search, Ctrl+N new chat, Ctrl+P global search
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
      } else if (k === 'p') {
        e.preventDefault()
        setSearchOpen(true)
        setSearchQ('')
        setSearchHits([])
        setTimeout(() => globalSearchRef.current?.focus(), 50)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // debounced global search
  useEffect(() => {
    if (!searchOpen) return
    const q = searchQ.trim()
    if (!q) {
      setSearchHits([])
      return
    }
    const t = setTimeout(() => {
      setSearching(true)
      api
        .globalSearch(q)
        .then(setSearchHits)
        .catch(() => setSearchHits([]))
        .finally(() => setSearching(false))
    }, 250)
    return () => clearTimeout(t)
  }, [searchQ, searchOpen])

  async function jumpToHit(hit: SearchHit) {
    setSearchOpen(false)
    // 教学命中跳「学」页深链打开那次会话；教学是另一个模块，不能只切状态
    if (hit.source === 'tutor') {
      navigate(`/tutor?session=${hit.ref_id}`)
      return
    }
    await openConversation(hit.ref_id)
  }

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
    api.listPrompts().then(setPrompts).catch(() => {})
    api.listNotes().then((r) => setNoteFiles(r.files.map((f) => f.path))).catch(() => {})
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

  const slashMatches = useMemo(() => {
    if (!slashOpen) return []
    const q = input.slice(1).trim().toLowerCase()
    return prompts.filter(
      (p) => !q || p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q)
    )
  }, [slashOpen, input, prompts])

  // # command: last whitespace-delimited token starting with # picks a vault file
  const hashToken = useMemo(() => {
    const m = input.match(/(?:^|\s)#([^\s#]*)$/)
    return m ? m[1] : null
  }, [input])
  const hashMatches = useMemo(() => {
    if (!hashOpen || hashToken === null) return []
    const q = hashToken.toLowerCase()
    return noteFiles.filter((f) => !q || f.toLowerCase().includes(q)).slice(0, 20)
  }, [hashOpen, hashToken, noteFiles])

  const activeAgent = agents.find((a) => a.id === agentId) ?? null

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

  async function togglePin(c: Conversation) {
    await fetch(`/api/conversations/${c.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !c.pinned }),
    })
    await refreshConversations()
  }

  async function setFolder(c: Conversation, folder: string) {
    await fetch(`/api/conversations/${c.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    })
    await refreshConversations()
  }

  async function renameConversation(c: Conversation) {
    const name = window.prompt('重命名会话：', c.title)
    if (!name?.trim() || name.trim() === c.title) return
    await fetch(`/api/conversations/${c.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: name.trim().slice(0, 100) }),
    })
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

  // ---- multi-agent collaboration ----

  async function startCollab() {
    const goal = input.trim()
    if (!goal || busy) return
    if (collabPick.length < 2) {
      setError('协作至少选择 2 个智能体（设置页可创建）')
      return
    }
    setInput('')
    setCollabOpen(false)
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
    await runCollab(convId, goal)
  }

  async function runCollab(convId: number, goal: string) {
    setError('')
    setMessages((prev) => [...prev, { role: 'user', content: goal }, { role: 'assistant', content: '', streaming: true }])
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    let acc = ''
    let raf = 0
    // A2 的逐步账：流式事件一条条来，攒在这里再挂到那条消息上（与 `sources` 同一个写法）
    const steps: CollabStep[] = []
    const flush = () => {
      raf = 0
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last.role === 'assistant') next[next.length - 1] = { ...last, content: acc }
        return next
      })
    }
    try {
      await streamCollab(
        convId,
        goal,
        collabPick,
        collabPattern,
        useRag,
        // 钉的材料原样发：只有 fanout 吃，而且后端会跳过读步打不开的那些
        collabPins.map((p) => p.spec),
        {
          onDelta: (t) => {
            acc += t
            if (!raf) raf = requestAnimationFrame(flush)
          },
          onSources: (sources) => {
            setMessages((prev) => {
              const next = [...prev]
              const idx = next.findLastIndex((m) => m.role === 'assistant' && m.streaming)
              if (idx !== -1) next[idx] = { ...next[idx], sources }
              return next
            })
          },
          // A2 的逐步账：每跑完一步来一条。**照抄后端那份事实**（谁/几轮/几次工具/几秒/
          // 有没有烧光），界面不聚合、不加权——那会与后端那笔账分叉。
          onStep: (fact) => {
            steps.push(fact)
            setMessages((prev) => {
              const next = [...prev]
              const idx = next.findLastIndex((m) => m.role === 'assistant' && m.streaming)
              if (idx !== -1) next[idx] = { ...next[idx], collabSteps: [...steps] }
              return next
            })
          },
          onError: (msg) => setError(msg),
          onDone: () => {},
        },
        controller.signal
      )
    } catch (e) {
      if (!controller.signal.aborted) setError(String(e))
    } finally {
      if (raf) cancelAnimationFrame(raf)
      flush()
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last.role === 'assistant') next[next.length - 1] = { ...last, streaming: false }
        return next
      })
      setBusy(false)
      abortRef.current = null
      await refreshConversations()
    }
  }

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

  function applyPrompt(p: PromptItem) {
    setSlashOpen(false)
    const vars = [...p.content.matchAll(/\{([^{}\n]{1,30})\}/g)].map((m) => m[1])
    if (!vars.length) {
      setInput(p.content)
      return
    }
    const original = input
    setInput(p.content)
    for (const v of vars) {
      const val = window.prompt(`提示词「${p.title}」中的 {${v}} 填入：`, '')
      if (val === null) {
        setInput(original)
        return
      }
      if (val) setInput((prev) => prev.replace(`{${v}}`, val))
    }
  }

  function attachFile(path: string) {
    setHashOpen(false)
    setAttachedFiles((prev) => (prev.includes(path) ? prev : [...prev, path]))
    // strip the trailing "#token" fragment from the input
    setInput((prev) => prev.replace(/(?:^|\s)#[^\s#]*$/, (m) => (m[0] === '#' ? '' : m[0])))
  }

  async function attachImage(file: File) {
    if (!file.type.startsWith('image/')) {
      setError('只支持图片文件（png/jpg/webp）')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('图片超过 20MB 上限')
      return
    }
    const placeholder = { name: file.name, url: URL.createObjectURL(file), uploading: true }
    setAttachedImages((prev) => [...prev, placeholder])
    try {
      const saved = await api.uploadImage(file)
      setAttachedImages((prev) =>
        prev.map((im) => (im === placeholder ? { name: saved.name, url: saved.url, uploading: false } : im))
      )
    } catch (e) {
      setAttachedImages((prev) => prev.filter((im) => im !== placeholder))
      setError(String(e))
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const imgs = [...e.clipboardData.items].filter((it) => it.type.startsWith('image/'))
    if (!imgs.length) return
    e.preventDefault()
    for (const it of imgs) {
      const f = it.getAsFile()
      if (f) void attachImage(f)
    }
  }

  async function captureScreen() {
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const video = document.createElement('video')
      video.srcObject = stream
      video.muted = true
      await video.play()
      await new Promise((r) => setTimeout(r, 150)) // let the first frame land
      if (!video.videoWidth) throw new Error('画面尚未就绪')
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d')!.drawImage(video, 0, 0)
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/png'))
      if (blob) {
        await attachImage(new File([blob], `screenshot-${Date.now()}.png`, { type: 'image/png' }))
      }
    } catch (e) {
      const msg = String(e)
      if (!msg.includes('Permission denied') && !msg.includes('NotAllowedError')) {
        setError(`截图失败：${msg}`)
      } // 否则视为用户取消了系统选择框
    } finally {
      stream?.getTracks().forEach((t) => t.stop())
    }
  }

  async function ocrAttached(im: { name: string; url: string }) {
    const name = im.url.startsWith('/api/images/') ? im.url.split('/').pop()! : im.name
    if (ocrBusy) return
    setOcrBusy(name)
    setError('')
    try {
      const r = await api.ocrImage(name)
      if (r.text) setInput((prev) => (prev ? `${prev}\n${r.text}` : r.text))
      else setError('没有识别到图中的文字')
    } catch (e) {
      setError(`OCR 失败：${String(e)}`)
    } finally {
      setOcrBusy('')
    }
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
      {/* Header */}
      {/* flex-wrap：这一行放的是模型下拉 + RAG 开关 + 各种 icon 按钮，宽度由内容
          说了算（select 不会缩到自己文字以下）。不换行的话窄窗格/窄窗口里这一行会
          顶出横向滚动条——分屏侧栏只有三百来像素，一定会撞上。 */}
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-200/80 bg-white/80 px-4 py-2.5 backdrop-blur dark:border-neutral-800/80 dark:bg-neutral-950/80">
        <select
          value={currentModel}
          onChange={async (e) => {
            if (activeId) {
              await fetch(`/api/conversations/${activeId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model_id: e.target.value }),
              })
              await refreshConversations()
            }
          }}
          disabled={!modelOptions.length}
          className="min-w-0 max-w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm shadow-sm transition-colors hover:border-violet-300 focus:border-violet-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-violet-500/50"
        >
          {!modelOptions.length && <option value="">未配置模型</option>}
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {agents.length > 0 && (
          <select
            value={agentId ?? ''}
            onChange={(e) => setAgentId(e.target.value ? Number(e.target.value) : null)}
            className={`min-w-0 max-w-full rounded-lg border px-2.5 py-1.5 text-sm shadow-sm transition-colors focus:outline-none ${
              agentId != null
                ? 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300'
                : 'border-neutral-200 bg-white text-neutral-400 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-900'
            }`}
          >
            <option value="">🤖 默认助手</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.avatar} {a.name}
              </option>
            ))}
          </select>
        )}
        {modelOptions.length > 1 && (
          <select
            value={compareModel}
            onChange={(e) => setCompareModel(e.target.value)}
            title="选择第二个模型做一问多答对比"
            className={`min-w-0 max-w-full rounded-lg border px-2.5 py-1.5 text-sm shadow-sm transition-colors focus:outline-none ${
              compareModel
                ? 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-300'
                : 'border-neutral-200 bg-white text-neutral-400 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-900'
            }`}
          >
            <option value="">⚖ 对比关</option>
            {modelOptions
              .filter((o) => o.value !== currentModel)
              .map((o) => (
                <option key={o.value} value={o.value}>
                  ⚖ vs {o.label}
                </option>
              ))}
          </select>
        )}
        <label
          className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${
            useRag
              ? 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300'
              : 'border-neutral-200 bg-white text-neutral-400 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-500'
          }`}
        >
          <input
            type="checkbox"
            checked={useRag}
            onChange={(e) => setUseRag(e.target.checked)}
            className="h-4 w-4 accent-violet-600"
          />
          知识库
        </label>
        <button
          onClick={() =>
            setAmbience((v) => {
              const next = !v
              try {
                localStorage.setItem('wb:ambience', next ? '1' : '0')
              } catch {
                /* 无痕模式记不了就算了 */
              }
              return next
            })
          }
          aria-pressed={ambience}
          title={ambience ? '氛围粒子：开（点一下关掉）' : '氛围粒子：关'}
          className={`rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${
            ambience
              ? 'border-pink-200 bg-pink-50 text-pink-500 dark:border-pink-500/40 dark:bg-pink-500/10 dark:text-pink-300'
              : 'border-neutral-200 bg-white text-neutral-400 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-500'
          }`}
        >
          🌸
        </button>
        {activeId && (
          <>
            <span className="ml-auto truncate text-xs text-neutral-400">
              {activeAgent ? `${activeAgent.avatar} ${activeAgent.name} · ` : ''}
              {conversations.find((c) => c.id === activeId)?.title}
            </span>
            <button
              onClick={exportChat}
              title="导出为 Markdown"
              className="ml-1 shrink-0 rounded-md px-2 py-1 text-xs text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              ⬇ 导出
            </button>
          </>
        )}
      </header>

      {/* Messages */}
      <div className="flex flex-1 overflow-hidden">
        {/* conversation list (chat page only) */}
        <div className="hidden w-52 shrink-0 flex-col overflow-hidden border-r border-neutral-200/80 md:flex dark:border-neutral-800/80">
          <div className="p-2">
            <input
              ref={searchRef}
              value={convQuery}
              onChange={(e) => setConvQuery(e.target.value)}
              placeholder="搜索会话…  Ctrl+K"
              className="w-full rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs transition-colors placeholder:text-neutral-400 focus:border-violet-300 focus:bg-white focus:outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:focus:border-violet-500/50"
            />
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-3">
            {(() => {
              const pinned = filteredConversations.filter((c) => c.pinned)
              const folders = new Map<string, Conversation[]>()
              const loose: Conversation[] = []
              for (const c of filteredConversations) {
                if (c.pinned) continue
                if (c.folder) {
                  if (!folders.has(c.folder)) folders.set(c.folder, [])
                  folders.get(c.folder)!.push(c)
                } else {
                  loose.push(c)
                }
              }
              const rowCls = (active: boolean) =>
                `group flex items-center justify-between rounded-lg px-2 py-1.5 text-sm transition-colors ${
                  active
                    ? 'bg-violet-100 font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
                    : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200'
                }`
              const Row = (c: Conversation) => (
                <div key={c.id} className={rowCls(activeId === c.id)}>
                  <button className="flex-1 truncate text-left" onClick={() => openConversation(c.id)}>
                    {c.folder && <span className="mr-1 text-xs">📁</span>}
                    {c.title}
                  </button>
                  <button
                    onClick={() => renameConversation(c)}
                    className="ml-1 shrink-0 text-neutral-400 opacity-60 transition-[color,opacity] hover:text-violet-500 hover:opacity-100 focus-visible:opacity-100"
                    title="重命名"
                  >
                    ✎
                  </button>
                  <button
                    onClick={() => togglePin(c)}
                    className={`ml-0.5 shrink-0 opacity-60 transition-[color,opacity] hover:opacity-100 focus-visible:opacity-100 ${
                      c.pinned ? 'text-violet-500' : 'text-neutral-400 hover:text-violet-500'
                    }`}
                    title={c.pinned ? '取消置顶' : '置顶'}
                  >
                    📌
                  </button>
                  <select
                    value={c.folder || ''}
                    onChange={(e) => setFolder(c, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    className="ml-0.5 w-5 shrink-0 cursor-pointer bg-transparent text-xs opacity-60 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100"
                    title="移入文件夹"
                  >
                    <option value="">📁+</option>
                    {[...new Set(conversations.map((x) => x.folder).filter(Boolean))].map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => deleteConversation(c.id)}
                    className="ml-0.5 shrink-0 text-neutral-400 opacity-60 transition-[color,opacity] hover:text-red-500 hover:opacity-100 focus-visible:opacity-100"
                    title="删除"
                  >
                    ×
                  </button>
                </div>
              )
              return (
                <>
                  {pinned.length > 0 && (
                    <>
                      <p className="px-2 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wider text-neutral-400">
                        📌 置顶
                      </p>
                      {pinned.map(Row)}
                    </>
                  )}
                  {[...folders.entries()].map(([folder, items]) => (
                    <div key={folder}>
                      <p className="px-2 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-neutral-400">
                        📁 {folder}
                      </p>
                      {items.map(Row)}
                    </div>
                  ))}
                  {loose.length > 0 && (pinned.length > 0 || folders.size > 0) && (
                    <p className="px-2 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-neutral-400">
                      全部
                    </p>
                  )}
                  {loose.map(Row)}
                </>
              )
            })()}
            {!filteredConversations.length && (
              <p className="px-2 py-4 text-xs leading-relaxed text-neutral-400">
                {convQuery ? '没有匹配的会话' : '还没有会话，发送第一条消息后自动创建'}
              </p>
            )}
          </div>
        </div>

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
          <button
            onClick={() => setCollabOpen((v) => !v)}
            title="智能体协作：选 2-4 个智能体按流水线或评审回路协作完成输入框里的目标"
            className={`flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-lg border text-lg transition-all ${
              collabOpen
                ? 'border-violet-400 bg-violet-50 text-violet-600 dark:border-violet-500/50 dark:bg-violet-500/10'
                : 'border-neutral-300 bg-white text-neutral-400 hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-violet-500/50'
            }`}
          >
            👥
          </button>
          {collabOpen && (
            <div className="absolute bottom-full left-0 z-20 mb-2 w-80 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
              <p className="border-b border-neutral-100 px-3 py-1.5 text-xs uppercase tracking-wider text-neutral-400 dark:border-neutral-800">
                智能体协作 · 以输入框内容为目标
              </p>
              <div className="flex gap-1.5 px-3 pt-2.5">
                {(
                  [
                    ['pipeline', '流水线', '依次接力完成'],
                    ['review', '评审回路', '初稿→评审→修订'],
                    ['fanout', '并行分派', '各自独立做→汇总'],
                  ] as const
                ).map(([id, label, hint]) => (
                  <button
                    key={id}
                    onClick={() => setCollabPattern(id)}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-left transition-colors ${
                      collabPattern === id
                        ? 'border-violet-400 bg-violet-50 dark:border-violet-500/50 dark:bg-violet-500/10'
                        : 'border-neutral-200 hover:border-violet-300 dark:border-neutral-700'
                    }`}
                  >
                    <span className="block text-xs font-medium text-neutral-700 dark:text-neutral-200">{label}</span>
                    <span className="block text-xs text-neutral-400">{hint}</span>
                  </button>
                ))}
              </div>
              <div className="max-h-44 overflow-y-auto px-3 py-2">
                <p className="pb-1 text-xs text-neutral-400">选择 {collabPattern === 'review' ? '2 个（起草者与评审者）' : '2-4 个'}智能体：</p>
                {collabPattern === 'fanout' && (
                  <p className="pb-1 text-xs text-neutral-400">
                    每个智能体各做一版（互不依赖，服务端并行跑），最后一个负责汇总
                  </p>
                )}
                {agents.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {agents
                      .filter((a) => a.enabled)
                      .map((a) => {
                        const picked = collabPick.includes(a.id)
                        return (
                          <button
                            key={a.id}
                            onClick={() => setCollabPick((p) => (picked ? p.filter((x) => x !== a.id) : [...p, a.id]))}
                            className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                              picked
                                ? 'border-violet-400 bg-violet-100 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/15 dark:text-violet-300'
                                : 'border-neutral-200 text-neutral-500 hover:border-violet-300 dark:border-neutral-700 dark:text-neutral-400'
                            }`}
                          >
                            {a.avatar} {a.name}
                          </button>
                        )
                      })}
                  </div>
                ) : (
                  <p className="py-2 text-xs text-neutral-400">还没有智能体 — 在设置页「智能体预设」创建</p>
                )}
              </div>
              {collabPattern === 'fanout' && (
                <CollabPins pins={collabPins} onChange={setCollabPins} />
              )}
              <div className="flex items-center gap-2 border-t border-neutral-100 px-3 py-2 dark:border-neutral-800">
                <span className="text-xs leading-snug text-neutral-400">
                  已选 {collabPick.length} 个 · 评审回路用前 2 个
                  {collabPattern === 'fanout' && ' · 并行分派：第 1 个负责汇总'}
                </span>
                <button
                  onClick={startCollab}
                  disabled={busy || !input.trim() || collabPick.length < 2}
                  className="ml-auto rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-40 dark:bg-violet-500"
                >
                  ▶ 开始协作
                </button>
              </div>
            </div>
          )}
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

      {/* global search modal (Ctrl+P) */}
      {searchOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[12vh] backdrop-blur-sm"
          onClick={() => setSearchOpen(false)}
        >
          <div
            className="w-full max-w-xl animate-slide-up overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
              <span className="text-neutral-400">🔍</span>
              <input
                ref={globalSearchRef}
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSearchOpen(false)
                  if (e.key === 'Enter' && searchHits.length > 0) jumpToHit(searchHits[0])
                }}
                placeholder="搜索所有会话内容…  Enter 跳第一条"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
              />
              <button onClick={() => setSearchOpen(false)} className="text-xs text-neutral-400 hover:text-neutral-600">
                Esc
              </button>
            </div>
            <div className="max-h-[50vh] overflow-y-auto">
              {searching && <p className="px-4 py-4 text-xs text-neutral-400">搜索中…</p>}
              {!searching && searchQ.trim() && !searchHits.length && (
                <p className="px-4 py-4 text-xs text-neutral-400">没有找到包含「{searchQ.trim()}」的消息</p>
              )}
              {!searchQ.trim() && (
                <p className="px-4 py-4 text-xs text-neutral-400">
                  输入关键词搜索全部历史消息（Ctrl+P 随时唤起）
                </p>
              )}
              {searchHits.map((hit) => (
                <button
                  key={`${hit.source}-${hit.id}`}
                  onClick={() => jumpToHit(hit)}
                  className="block w-full border-b border-neutral-50 px-4 py-3 text-left transition-colors last:border-0 hover:bg-violet-50 dark:border-neutral-800/60 dark:hover:bg-violet-500/10"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-neutral-700 dark:text-neutral-200">
                      {hit.source === 'tutor' && <span className="mr-1 text-amber-600 dark:text-amber-400">🎓</span>}
                      {hit.title}
                    </span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                      hit.source === 'tutor'
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300'
                        : hit.role === 'user'
                          ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
                          : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
                    }`}>
                      {hit.source === 'tutor' ? '教学' : hit.role === 'user' ? '我' : 'AI'}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-neutral-400">{hit.excerpt}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
