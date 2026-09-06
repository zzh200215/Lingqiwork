import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { streamChat } from './stream'

// Quick-ask window shown by the global hotkey (Ctrl+Alt+Q).
// Esc / blur hides the native window via pywebview JS API.

declare global {
  interface Window {
    pywebview?: {
      api?: {
        hide_quick?: () => void
        open_main?: () => void
        hide_selection?: () => void
        hide_pet?: () => void
        open_tutor?: (sessionId: number) => void
      }
    }
  }
}

function hideWindow() {
  window.pywebview?.api?.hide_quick?.()
}

export default function QuickView() {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [convId, setConvId] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // desktop shell re-pops the window via Ctrl+Alt+Q: refocus + clear stale text
  useEffect(() => {
    const onReset = () => {
      setQuestion('')
      setError(null)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
    window.addEventListener('workbench:quick-reset', onReset)
    return () => window.removeEventListener('workbench:quick-reset', onReset)
  }, [])

  async function send() {
    const text = question.trim()
    if (!text || busy) return
    setQuestion('')
    setAnswer('')
    setError(null)
    setBusy(true)
    const ac = new AbortController()
    abortRef.current = ac
    try {
      let id = convId
      if (id == null) {
        const providers = await api.listProviders()
        const model =
          providers.flatMap((p) => (p.enabled ? p.models.map((m) => `${p.name}/${m}`) : []))[0] || ''
        const conv = await api.createConversation(model)
        id = conv.id
        setConvId(id)
      }
      let acc = ''
      await streamChat(
        id,
        text,
        false,
        {
          onDelta: (t) => {
            acc += t
            setAnswer(acc)
          },
          onError: (m) => setError(m),
          onDone: () => {},
        },
        ac.signal
      )
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (busy) abortRef.current?.abort()
      hideWindow()
    }
  }

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        <span className="text-lg">🧠</span>
        <input
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="快速提问，Enter 发送，Esc 关闭…"
          disabled={busy}
          className="flex-1 bg-transparent text-base outline-none placeholder:text-zinc-600 disabled:opacity-50"
        />
        {busy ? (
          <span className="text-xs text-violet-400">生成中… (Esc 中止并关闭)</span>
        ) : (
          <button
            onClick={() => window.pywebview?.api?.open_main?.()}
            className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            title="打开完整工作台查看会话"
          >
            打开会话 ↗
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed">
        {error && <div className="rounded-lg bg-red-950/60 px-3 py-2 text-red-300">{error}</div>}
        {answer ? <div className="whitespace-pre-wrap">{answer}</div> : null}
      </div>
    </div>
  )
}
