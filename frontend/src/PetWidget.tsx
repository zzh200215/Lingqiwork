import { useCallback, useEffect, useRef, useState } from 'react'

// Animation states come from the Codex pet atlas (awesome-codex-pet v1):
// 9 states, each shipped as an animated webp under /pet/<state>.webp.
// The browser plays them natively, so switching state is just swapping src.
export type PetAction =
  | 'idle'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'running-right'
  | 'running-left'
  | 'review'

// 零柒 — the resident companion avatar fixed to the corner of the main workspace.
//
// This is NOT a separate window (that's PetView, /pet.html). This is the
// "real pet on the main screen" form: a rendered pet avatar fixed to the
// bottom-right of every main page (chat/dashboard/notes/kb/settings via
// Layout). It breathes, pops a speech bubble when the system does something,
// and expands into a chat panel on click.
//
// All data comes from the same /api/pet/* endpoints the companion already
// exposes — this is a second, visual face of the same 零柒, not a new brain.

interface PetEvent {
  id: number
  kind: string
  text: string
  detail: string
  created_at: string
}

interface PetStatus {
  tasks_done: number
  tasks_failed: number
  notes_today: number
  tokens_today: number
  time_of_day: string
  pet_enabled: boolean
}

interface ChatMsg {
  role: 'user' | 'pet'
  text: string
}

function timeLabel(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export default function PetWidget() {
  const [open, setOpen] = useState(false)
  const [bubble, setBubble] = useState<string | null>(null)
  const [action, setAction] = useState<PetAction>('idle')
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [events, setEvents] = useState<PetEvent[]>([])
  const [status, setStatus] = useState<PetStatus | null>(null)
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastIdRef = useRef(0)
  const openRef = useRef(false)
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    openRef.current = open
  }, [open])

  // play a one-shot action, then settle back to idle
  const playAction = useCallback((a: PetAction, ms: number) => {
    setAction(a)
    if (actionTimer.current) clearTimeout(actionTimer.current)
    actionTimer.current = setTimeout(() => setAction('idle'), ms)
  }, [])

  // initial load
  useEffect(() => {
    void (async () => {
      try {
        const [f, s] = await Promise.all([
          fetch('/api/pet/feed?limit=30').then((r) => r.json()),
          fetch('/api/pet/status').then((r) => r.json()),
        ])
        const evs: PetEvent[] = f.events ?? []
        setEvents([...evs].reverse())
        if (evs.length) lastIdRef.current = Math.max(...evs.map((e) => e.id))
        setStatus(s)
      } catch {
        /* offline — the pet just sits quietly */
      }
    })()
  }, [])

  // poll for new events → bubble (the pet "speaks first")
  useEffect(() => {
    const t = setInterval(() => {
      void (async () => {
        try {
          const r = await fetch(`/api/pet/feed?since_id=${lastIdRef.current}&limit=20`)
          if (!r.ok) return
          const data = await r.json()
          const fresh: PetEvent[] = data.events ?? []
          if (!fresh.length) return
          setEvents((prev) => {
            const ids = new Set(prev.map((e) => e.id))
            const add = fresh.filter((e) => !ids.has(e.id))
            return add.length ? [...prev, ...add.reverse()] : prev
          })
          for (const e of fresh) lastIdRef.current = Math.max(lastIdRef.current, e.id)
          // react to what happened: failures slump, everything else waves hello
          if (fresh[0]) {
            const isFail = fresh.some((e) => e.kind === 'task_failed')
            playAction(isFail ? 'failed' : 'waving', 6000)
          }
          if (!openRef.current && fresh[0]) {
            setBubble(fresh[0].text)
            if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
            bubbleTimer.current = setTimeout(() => setBubble(null), 6000)
          }
        } catch {
          /* retry next tick */
        }
      })()
    }, 15000)
    return () => clearInterval(t)
  }, [])

  // close panel on outside click
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  async function send() {
    const msg = input.trim()
    if (!msg || busy) return
    setInput('')
    setError(null)
    setChat((c) => [...c, { role: 'user', text: msg }])
    setBusy(true)
    setAction('review') // focused/inspecting while it thinks
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const res = await fetch('/api/pet/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) {
        const detail = await res.json().catch(() => null)
        throw new Error(detail?.detail || `chat failed: ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let acc = ''
      setChat((c) => [...c, { role: 'pet', text: '' }])
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
          if (event === 'delta') {
            acc += data.text as string
            setChat((c) => {
              const n = [...c]
              n[n.length - 1] = { role: 'pet', text: acc }
              return n
            })
          } else if (event === 'error') {
            throw new Error(data.message as string)
          }
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setAction('idle')
      abortRef.current = null
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape') {
      if (busy) abortRef.current?.abort()
      setOpen(false)
    }
  }

  return (
    <>
      <style>{`
        @keyframes pet-idle {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-4px) scale(1.03); }
        }
        @keyframes pet-bubble-in {
          from { opacity: 0; transform: translateY(6px) scale(0.9); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .pet-idle { animation: pet-idle 3.2s ease-in-out infinite; }
        .pet-bubble { animation: pet-bubble-in 0.22s ease-out; }
      `}</style>

      <div ref={panelRef} className="fixed bottom-5 right-5 z-50 flex flex-col items-end">
        {/* speech bubble above the sprite */}
        {bubble && !open && (
          <button
            onClick={() => setOpen(true)}
            className="pet-bubble mb-2 max-w-[260px] rounded-2xl rounded-br-sm border border-neutral-200 bg-white px-3.5 py-2.5 text-left text-sm leading-relaxed text-neutral-800 shadow-lg shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          >
            {bubble}
          </button>
        )}

        {/* expanded panel */}
        {open && (
          <div className="pet-bubble mb-2 flex h-[380px] w-[320px] flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl shadow-neutral-900/20 dark:border-neutral-700 dark:bg-neutral-900">
            <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">零柒</span>
              {status && (
                <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                  今日任务 {status.tasks_done}✓ {status.tasks_failed}✗ · 笔记 +{status.notes_today} · token{' '}
                  {status.tokens_today}
                </span>
              )}
              <div className="flex-1" />
              <button
                onClick={() => setOpen(false)}
                className="rounded-md px-1.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2 text-sm leading-relaxed">
              {!events.length && !chat.length && !error && (
                <div className="text-neutral-400 dark:text-neutral-500">
                  零柒还没说过话。它会在任务、摘要、备份、订阅有动静时主动开口——你也可以现在跟它聊。
                </div>
              )}
              {events.map((e) => (
                <div key={`e${e.id}`} className="max-w-[92%] rounded-lg rounded-bl-sm bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
                  <div className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-200">{e.text}</div>
                  <div className="mt-0.5 text-[10px] text-neutral-400 dark:text-neutral-500">{timeLabel(e.created_at)}</div>
                </div>
              ))}
              {chat.map((m, i) =>
                m.role === 'user' ? (
                  <div key={`u${i}`} className="ml-auto max-w-[92%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-violet-600 px-3 py-2 text-white">
                    {m.text}
                  </div>
                ) : (
                  <div key={`p${i}`} className="max-w-[92%] whitespace-pre-wrap rounded-lg rounded-bl-sm bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
                    <span className="text-neutral-700 dark:text-neutral-200">{m.text}</span>
                    {!m.text && <span className="inline-block animate-pulse text-violet-400">▊</span>}
                  </div>
                ),
              )}
              {error && <div className="rounded-lg bg-red-100 px-3 py-2 text-xs text-red-600 dark:bg-red-950/60 dark:text-red-300">{error}</div>}
            </div>

            <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
              <div className="flex gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="跟零柒说点什么"
                  className="flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-800 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                />
                <button
                  onClick={() => void send()}
                  disabled={busy || !input.trim()}
                  className="rounded-lg bg-violet-600 px-3 text-sm text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        )}

        {/* the avatar itself — animated webp per state, PNG fallback on error */}
        <button
          onClick={() => setOpen((v) => !v)}
          title="零柒"
          className="relative flex h-24 w-24 items-center justify-center transition-transform hover:scale-105 active:scale-95"
        >
          <div className="pet-idle flex items-center justify-center">
            <img
              key={action}
              src={`/pet/${action}.webp`}
              alt="零柒"
              className="h-[88px] w-[88px] object-contain drop-shadow-md"
              onError={(e) => {
                e.currentTarget.src = '/pet-avatar.png'
              }}
            />
          </div>
        </button>
      </div>
    </>
  )
}
