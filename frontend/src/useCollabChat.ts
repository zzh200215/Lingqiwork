// 多智能体协作子系统（方向 6 第十九刀，2026-09-30 自 App.tsx 拆出）：
// 选择状态（开合/成员/模式/钉选材料）与两条处理器自含——
// startCollab：无会话先建会话再进 runCollab；runCollab：第二条流式引擎，
// streamCollab 的 A2 逐步账逐条挂到流式气泡上（与 `sources` 同一个写法）。
// 与 ChatView 核心的耦合全部经 deps 注入：input 草稿、busy 与 abortRef
// （与 runStream 共用同一面「停止」键和禁用态）、messages 装载、会话新建与重拉。
import { useState, type Dispatch, type SetStateAction } from 'react'
import { streamCollab, type CollabStep } from './stream'
import { api } from './api'
import type { PinnedMaterial } from './CollabPins'
import type { ChatMessage } from './ChatMessageRow'

export function useCollabChat(deps: {
  input: string
  setInput: Dispatch<SetStateAction<string>>
  busy: boolean
  setBusy: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string>>
  activeId: number | null
  setActiveId: Dispatch<SetStateAction<number | null>>
  currentModel: string
  refreshConversations: () => Promise<void>
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  abortRef: { current: AbortController | null }
  useRag: boolean
}) {
  const {
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
  } = deps

  const [collabOpen, setCollabOpen] = useState(false)
  const [collabPick, setCollabPick] = useState<number[]>([])
  const [collabPattern, setCollabPattern] = useState<'pipeline' | 'review' | 'fanout'>('pipeline')
  // 「这一轮读哪几份」（材料清单的第二个来源，2026-09-22）：只有 fanout 吃材料清单，
  // 所以这一栏也只在 fanout 下露出来（后端对别的模式会记一行"钉了不生效"，见 agents.py）。
  const [collabPins, setCollabPins] = useState<PinnedMaterial[]>([])

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

  return {
    collabOpen,
    setCollabOpen,
    collabPick,
    setCollabPick,
    collabPattern,
    setCollabPattern,
    collabPins,
    setCollabPins,
    startCollab,
  }
}
