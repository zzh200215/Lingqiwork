import { useEffect, useRef, useState } from 'react'

// Selection assistant popup (Cherry Studio 选中助手 style, ROADMAP V4.2).
// desktop.py grabs the selected text via simulated Ctrl+C, then navigates this
// window to selection.html#t=<urlencoded text>. Actions stream from /api/ask.

declare global {
  interface Window {
    pywebview?: {
      api?: { hide_quick?: () => void; open_main?: () => void; hide_selection?: () => void; hide_pet?: () => void }
    }
  }
}

const ACTIONS = [
  { key: 'translate', label: '翻译' },
  { key: 'explain', label: '解释' },
  { key: 'summarize', label: '总结' },
] as const

type ActionKey = (typeof ACTIONS)[number]['key'] | 'custom'

function hideWindow() {
  window.pywebview?.api?.hide_selection?.()
}

export default function SelectionView() {
  const text = useRef('')
  const [hasText, setHasText] = useState(false)
  const [manual, setManual] = useState('')
  const [answered, setAnswered] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customPrompt, setCustomPrompt] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const customRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const m = window.location.hash.match(/^#t=(.*)$/s)
    if (m) {
      try {
        text.current = decodeURIComponent(m[1])
      } catch {
        text.current = m[1]
      }
      setHasText(!!text.current)
    }
  }, [])

  useEffect(() => {
    if (customOpen) customRef.current?.focus()
  }, [customOpen])

  async function run(action: ActionKey, prompt?: string) {
    if (busy || !text.current) return
    setAnswered(true)
    setAnswer('')
    setError(null)
    setCopied(false)
    setBusy(true)
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.current,
          action,
          prompt,
          target: action === 'translate' ? (/[一-鿿]/.test(text.current) ? 'English' : '简体中文') : null,
        }),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) throw new Error(`ask failed: ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let acc = ''
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
            setAnswer(acc)
          } else if (event === 'error') {
            throw new Error(data.message as string)
          }
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(answer)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('复制失败')
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      setCustomOpen(false)
      void run('custom', customPrompt)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (customOpen) {
        setCustomOpen(false)
      } else {
        if (busy) abortRef.current?.abort()
        hideWindow()
      }
    }
  }

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <div className="flex items-center gap-1.5 border-b border-zinc-800 px-3 py-2">
        <span className="mr-1 text-base">🧠</span>
        {ACTIONS.map((a) => (
          <button
            key={a.key}
            onClick={() => void run(a.key)}
            disabled={busy || !hasText}
            className="rounded-full border border-zinc-700 px-3 py-1 text-xs transition-colors hover:border-violet-500 hover:bg-violet-950 hover:text-violet-300 disabled:opacity-50"
          >
            {a.label}
          </button>
        ))}
        <button
          onClick={() => setCustomOpen((v) => !v)}
          disabled={busy || !hasText}
          className="rounded-full border border-zinc-700 px-3 py-1 text-xs transition-colors hover:border-violet-500 hover:bg-violet-950 hover:text-violet-300 disabled:opacity-50"
        >
          自定义…
        </button>
        <div className="flex-1" />
        {answered && !busy && !error && (
          <button
            onClick={() => void copy()}
            className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            title="复制结果"
          >
            {copied ? '✓ 已复制' : '复制'}
          </button>
        )}
        {text.current && (
          <span className="max-w-[200px] truncate text-xs text-zinc-600" title={text.current}>
            {text.current.slice(0, 40)}
          </span>
        )}
      </div>
      {customOpen && (
        <div className="border-b border-zinc-800 px-3 py-2">
          <input
            ref={customRef}
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="输入指令（如：改成正式语气 / 提取所有邮箱），Enter 执行"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-violet-500"
          />
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed">
        {!hasText && (
          <div className="space-y-2">
            <div className="text-zinc-500">
              没抓到选中文本（有些应用不接受模拟复制）。可以直接粘贴或输入要处理的内容：
            </div>
            <textarea
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              rows={5}
              placeholder="粘贴文本后点下面的按钮"
              className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-violet-500"
            />
            <button
              onClick={() => {
                text.current = manual.trim()
                setHasText(!!text.current)
              }}
              disabled={!manual.trim()}
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-500 disabled:opacity-50"
            >
              使用这段文本
            </button>
          </div>
        )}
        {hasText && !answered && (
          <div className="text-zinc-600">选择上方动作开始处理，Esc 关闭。</div>
        )}
        {error && <div className="rounded-lg bg-red-950/60 px-3 py-2 text-red-300">{error}</div>}
        {answer ? <div className="whitespace-pre-wrap">{answer}</div> : null}
        {busy && <span className="mt-1 inline-block animate-pulse text-violet-400">▊</span>}
      </div>
    </div>
  )
}
