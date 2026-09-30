import { useEffect, useRef, useState } from 'react'
import { streamNotesAi, type NotesChatTurn } from './api'
import type { ArtifactRef } from './stream'

export interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

// 笔记对话（右侧栏）领域的状态与动作——从 NotesPage 抽出（方向 6）。
// 宿主传入三样依赖：当前笔记路径、正文草稿、报错出口；其余自持。
export function useNoteChat(deps: {
  activePath: string | null
  draft: string
  setError: (msg: string) => void
}) {
  const { activePath, draft, setError } = deps
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([])
  // 方向 1：笔记对话里 AI 的回答也能沉淀成产出（与「插入到笔记」并列的第三条路）。
  const [chatSaved, setChatSaved] = useState<Record<number, ArtifactRef[]>>({})
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const chatAbortRef = useRef<AbortController | null>(null)
  const chatBottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ block: 'end' })
  }, [chatMsgs])

  async function sendChat() {
    const q = chatInput.trim()
    if (!q || chatBusy || !activePath) return
    setChatInput('')
    setError('')
    const history: ChatMsg[] = [...chatMsgs]
    setChatMsgs([...history, { role: 'user', content: q }, { role: 'assistant', content: '' }])
    setChatBusy(true)
    const controller = new AbortController()
    chatAbortRef.current = controller
    let acc = ''
    try {
      await streamNotesAi(
        'chat',
        draft,
        (t) => {
          acc += t
          setChatMsgs((prev) => {
            const next = [...prev]
            next[next.length - 1] = { ...next[next.length - 1], content: acc }
            return next
          })
        },
        controller.signal,
        {
          question: q,
          history: history.slice(-6).map((m) => ({ role: m.role, content: m.content }) as NotesChatTurn),
        }
      )
    } catch (e) {
      if (!controller.signal.aborted) setError(String(e))
    } finally {
      setChatBusy(false)
      chatAbortRef.current = null
    }
  }

  function stopChat() {
    chatAbortRef.current?.abort()
    setChatBusy(false)
    chatAbortRef.current = null
  }

  return { chatMsgs, setChatMsgs, chatSaved, setChatSaved, chatInput, setChatInput, chatBusy, sendChat, stopChat, chatBottomRef }
}
