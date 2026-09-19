import { useEffect, useRef, useState } from 'react'

import { api } from './api'
import { asSingleUrl } from './capture'

// Selection assistant popup (Cherry Studio 选中助手 style, ROADMAP V4.2).
// desktop.py grabs the selected text via simulated Ctrl+C, then navigates this
// window to selection.html#t=<urlencoded text>. 翻译/解释/总结/自定义 stream
// from /api/ask；教学 / 剪藏 是两个跳转动作——进教学会话、落盘进知识库。
//
// pywebview 的 window.api 形状**只在 QuickView.tsx 声明一份**（全局合并）：
// 这里再写一份，两边的属性列表迟早不同步——TS 会用 TS2717 当场拦下（撞过）。

const ACTIONS = [
  { key: 'translate', label: '翻译' },
  { key: 'explain', label: '解释' },
  { key: 'summarize', label: '总结' },
  { key: 'tutor', label: '🎓 教学' },
  { key: 'clip', label: '剪藏' },
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
    // 教学：开一场教学会话并让主窗口深链打开；剪藏：落盘进知识库。
    // 两个都是「处置」动作，不走 /api/ask 的流式回答。
    if (action === 'tutor' || action === 'clip') {
      setError(null)
      setBusy(true)
      try {
        if (action === 'tutor') {
          const s = await api.tutorStart(text.current)
          setBusy(false)
          hideWindow()
          window.pywebview?.api?.open_tutor?.(s.id)
        } else {
          // 选中的就是一个网址 → 去抓正文，并把来源 URL 一起留下（clip_text 存的是
          // 那行字本身：既没正文，也没有出处）。
          const url = asSingleUrl(text.current)
          const r = url
            ? await api.clipUrl(url)
            : await api.clipText(text.current, text.current.slice(0, 30))
          setAnswered(true)
          setAnswer(
            url
              ? `已剪藏网页正文：${r.title} → ${r.filename}（${r.chars} 字 / ${r.chunks} 块）`
              : `已剪藏进知识库：${r.filename}（${r.chunks} 块）`
          )
          setBusy(false)
          setTimeout(() => hideWindow(), 1500)
        }
      } catch (e) {
        setBusy(false)
        setError(e instanceof Error ? e.message : String(e))
      }
      return
    }
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

  // 选中的是网址时按钮说「剪藏网页」——它做的事和「把这段字存下来」不是一回事
  const selIsUrl = !!asSingleUrl(text.current)

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
            {a.key === 'clip' && selIsUrl ? '剪藏网页' : a.label}
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
