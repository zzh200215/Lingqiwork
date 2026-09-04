import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { api, type CardDraft, type CardKind, type CardSources } from './api'
import { streamCardsGenerate, type CardGenStage } from './stream'

// Shared card maker — used by the review page and by the notes sidebar. Three
// ways in, and two of them never touch a model:
//
//   🤖 AI    模型出卡。Candidates ALWAYS go through the tick-and-edit list below
//            before they enter the deck: one bad auto-inserted card is enough to
//            stop trusting the queue, and that trust does not come back.
//   ✍️ 手写  type the card yourself. Zero LLM, zero cost, instant.
//   📄 取材  load an indexed file (vault path, or `repo:`/`dir:` for material
//            outside the vault), select a span in the read-only pane, blank it
//            into a cloze card. Also zero LLM.
//
// The two manual paths are the whole point of this revision: a feature meant to
// become a daily habit must not single-point-depend on a model quota.

type Mode = 'ai' | 'write' | 'clip'

const KIND_LABEL: Record<CardKind, string> = {
  scenario: '情境',
  debug: '排错',
  cloze: '填空',
  concept: '概念',
}

const KIND_CLS: Record<CardKind, string> = {
  scenario: 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300',
  debug: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300',
  cloze: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300',
  concept: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
}

const STAGE_TEXT: Record<string, string> = {
  reading: '读材料…',
  drafting: '出卡中…',
  dedup: '查重…',
}

const MIN_TEXT = 80
const BLANK_WRITE = { kind: 'concept' as CardKind, front: '', back: '', hint: '', topic: '' }
const MODES: { key: Mode; label: string }[] = [
  { key: 'ai', label: '🤖 AI' },
  { key: 'write', label: '✍️ 手写' },
  { key: 'clip', label: '📄 取材' },
]

export default function CardMaker({
  sourcePath = '',
  sourceLabel = '',
  onSaved,
  compact = false,
}: {
  sourcePath?: string
  sourceLabel?: string
  onSaved?: (added: number) => void
  compact?: boolean
}) {
  const pasteMode = !sourcePath
  const [mode, setMode] = useState<Mode>('ai')
  const [text, setText] = useState('')
  const [count, setCount] = useState(8)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [drafts, setDrafts] = useState<CardDraft[]>([])
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<number | null>(null)
  const [meta, setMeta] = useState({ source: '', source_label: '', model_id: '' })
  // AI mode can also read an indexed file instead of pasted text
  const [aiSource, setAiSource] = useState('')
  // 取材 pane
  const [sources, setSources] = useState<CardSources | null>(null)
  const [clipSource, setClipSource] = useState('')
  const [clipText, setClipText] = useState('')
  // 手写 form
  const [written, setWritten] = useState(BLANK_WRITE)
  const paneRef = useRef<HTMLPreElement>(null)

  const inputCls =
    'w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-900'

  useEffect(() => {
    api.cardSources().then(setSources).catch(() => setSources({ vault: [], repos: [], dirs: [] }))
  }, [])

  /** Guard against silently mislabelling a batch's source. */
  function addDraft(card: CardDraft, src: { source: string; source_label: string }): boolean {
    if (drafts.length && meta.source !== src.source) {
      setError(`列表里已有来自「${meta.source_label || '手工'}」的卡，先入库再换来源`)
      return false
    }
    setMeta({ ...src, model_id: '' })
    setPicked((p) => new Set([...p, drafts.length]))
    setDrafts((d) => [...d, card])
    setError('')
    setNotice('已加入下面的列表')
    return true
  }

  async function generate() {
    if (busy) return
    if (pasteMode && !aiSource && text.trim().length < MIN_TEXT) {
      setError(`文本至少 ${MIN_TEXT} 字才能出卡`)
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    setDrafts([])
    setPicked(new Set())
    setStage('reading')
    try {
      const input = sourcePath
        ? { source_path: sourcePath, count }
        : aiSource
          ? { source_path: aiSource, count }
          : { text: text.trim(), count }
      const done = await streamCardsGenerate(input, (s: CardGenStage) => setStage(s.stage))
      if (!done.ok) {
        setError(done.error || '出卡失败')
        return
      }
      const cards = (done.cards ?? []) as CardDraft[]
      setDrafts(cards)
      // duplicates start UNTICKED but stay visible — you decide, not the model
      setPicked(new Set(cards.map((_, i) => i).filter((i) => !cards[i].duplicate_of)))
      setMeta({
        source: done.source ?? '',
        source_label: done.source_label ?? sourceLabel,
        model_id: done.model_id ?? '',
      })
      const bits: string[] = [`出了 ${cards.length} 张`]
      if (done.dropped) bits.push(`${done.dropped} 张超长已丢弃`)
      if (done.dedup === 'skipped') bits.push('本次未做语义查重')
      setNotice(bits.join(' · '))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setStage('')
    }
  }

  function addWritten() {
    const front = written.front.trim()
    const back = written.back.trim()
    if (!front || !back) {
      setError('题面和答案都要填')
      return
    }
    const ok = addDraft(
      {
        kind: written.kind,
        front,
        back,
        hint: written.hint.trim(),
        topic: written.topic.trim(),
        excerpt: '',
        origin: 'manual',
      },
      { source: '', source_label: '手工' }
    )
    if (ok) setWritten(BLANK_WRITE)
  }

  async function loadClip(source: string) {
    setClipSource(source)
    setClipText('')
    if (!source) return
    setBusy(true)
    setError('')
    try {
      const r = await api.cardMaterial(source)
      setClipText(r.text)
      setNotice(`已载入 ${r.text.length} 字，选中要挖掉的部分`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** Character offsets of the pane selection within `clipText`. */
  function paneSelection(): { start: number; end: number } | null {
    const sel = window.getSelection()
    const pane = paneRef.current
    if (!sel || sel.rangeCount === 0 || !pane) return null
    const r = sel.getRangeAt(0)
    if (r.collapsed || !pane.contains(r.commonAncestorContainer)) return null
    const before = document.createRange()
    before.selectNodeContents(pane)
    before.setEnd(r.startContainer, r.startOffset)
    const start = before.toString().length
    return { start, end: start + r.toString().length }
  }

  async function clipCloze() {
    const span = paneSelection()
    if (!span) {
      setError('先在正文里选中要挖掉的部分')
      return
    }
    try {
      const card = await api.makeCloze({ text: clipText, start: span.start, end: span.end })
      addDraft({ ...card, origin: 'manual' }, { source: clipSource, source_label: clipSource })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function save() {
    const chosen = drafts.filter((_, i) => picked.has(i))
    if (!chosen.length) {
      setError('至少勾选一张')
      return
    }
    setBusy(true)
    setError('')
    try {
      const r = await api.saveCards({ cards: chosen, ...meta })
      setDrafts([])
      setPicked(new Set())
      setText('')
      setNotice(
        r.skipped ? `入库 ${r.added} 张，跳过 ${r.skipped} 张重复` : `入库 ${r.added} 张`
      )
      onSaved?.(r.added)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function patch(i: number, field: 'front' | 'back', value: string) {
    setDrafts((d) => d.map((c, n) => (n === i ? { ...c, [field]: value } : c)))
  }

  function toggle(i: number) {
    setPicked((p) => {
      const next = new Set(p)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const pill = (on: boolean) =>
    `rounded-full border px-2.5 py-1 text-xs transition-colors ${
      on
        ? 'border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-600 dark:bg-violet-500/15 dark:text-violet-300'
        : 'border-neutral-200 text-neutral-500 hover:border-violet-300 dark:border-neutral-700 dark:text-neutral-400'
    }`

  const onCtrlEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      addWritten()
    }
  }

  const picker = (value: string, onChange: (v: string) => void, pasteOption: boolean) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputCls} min-w-0 flex-1`}
    >
      <option value="">{pasteOption ? '粘贴文本' : '选择文件…'}</option>
      {sources?.vault.length ? (
        <optgroup label="vault 笔记">
          {sources.vault.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </optgroup>
      ) : null}
      {sources?.repos.length ? (
        <optgroup label="代码仓库">
          {sources.repos.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </optgroup>
      ) : null}
      {sources?.dirs.length ? (
        <optgroup label="本地目录">
          {sources.dirs.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  )

  return (
    <div className="flex min-h-0 flex-col gap-2.5">
      <div className="flex gap-1">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => {
              setMode(m.key)
              setError('')
            }}
            className={pill(mode === m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'ai' &&
        (pasteMode ? (
          <>
            <div className="flex items-center gap-2">
              <label className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
                来源
              </label>
              {picker(aiSource, setAiSource, true)}
            </div>
            {!aiSource && (
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="粘贴一段技术材料（踩坑记录、changelog、文档节选…），至少 80 字"
                className={`${inputCls} resize-none font-mono text-[12px] leading-relaxed`}
                rows={compact ? 5 : 8}
              />
            )}
          </>
        ) : (
          <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
            来源：
            <span className="text-neutral-700 dark:text-neutral-200">
              {sourceLabel || sourcePath}
            </span>
          </p>
        ))}

      {mode === 'ai' && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-neutral-500 dark:text-neutral-400">出</label>
          <input
            type="number"
            min={1}
            max={20}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(20, Number(e.target.value) || 8)))}
            className={`${inputCls} w-16`}
          />
          <label className="text-xs text-neutral-500 dark:text-neutral-400">张</label>
          <button
            onClick={() => void generate()}
            disabled={busy}
            className="ml-auto rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
          >
            {busy ? STAGE_TEXT[stage] || '处理中…' : '🎴 出卡'}
          </button>
        </div>
      )}

      {mode === 'write' && (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <select
              value={written.kind}
              onChange={(e) => setWritten((w) => ({ ...w, kind: e.target.value as CardKind }))}
              className={`${inputCls} w-24 shrink-0`}
            >
              {(Object.keys(KIND_LABEL) as CardKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <input
              value={written.topic}
              onChange={(e) => setWritten((w) => ({ ...w, topic: e.target.value }))}
              placeholder="主题（可选，如 sqlite）"
              className={inputCls}
            />
          </div>
          <textarea
            value={written.front}
            onChange={(e) => setWritten((w) => ({ ...w, front: e.target.value }))}
            onKeyDown={onCtrlEnter}
            placeholder="题面 — 填空卡用 ____ 标出要填的部分"
            className={`${inputCls} resize-none text-[13px]`}
            rows={3}
          />

          <textarea
            value={written.back}
            onChange={(e) => setWritten((w) => ({ ...w, back: e.target.value }))}
            onKeyDown={onCtrlEnter}
            placeholder="答案 + 为什么（代码用 ``` 围起来）"
            className={`${inputCls} resize-none text-[13px]`}
            rows={4}
          />
          <input
            value={written.hint}
            onChange={(e) => setWritten((w) => ({ ...w, hint: e.target.value }))}
            placeholder="提示（可选，复习时按 H 才看得到）"
            className={inputCls}
          />
          <button
            onClick={addWritten}
            className="w-full rounded-lg border border-violet-300 px-3 py-1.5 text-sm font-medium text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-500/10"
          >
            ＋ 添加到列表
            <span className="ml-1.5 text-[10px] text-neutral-400">Ctrl+↵</span>
          </button>
        </div>
      )}

      {mode === 'clip' && (
        <>
          <div className="flex items-center gap-2">
            <label className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">文件</label>
            {picker(clipSource, (v) => void loadClip(v), false)}
          </div>
          {clipText && (
            <>
              <pre
                ref={paneRef}
                className="max-h-64 min-h-0 overflow-auto whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50/60 p-2 font-mono text-[12px] leading-relaxed selection:bg-violet-200 dark:border-neutral-800 dark:bg-neutral-900/40 dark:selection:bg-violet-500/40"
              >
                {clipText}
              </pre>
              <button
                onClick={() => void clipCloze()}
                className="rounded-lg border border-violet-300 px-3 py-1.5 text-sm font-medium text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-500/10"
              >
                🎴 把选中的挖成填空卡
              </button>
            </>
          )}
        </>
      )}

      {error && (
        <p className="rounded-md bg-rose-50 px-2.5 py-1.5 text-xs text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{notice}</p>
      )}

      {drafts.length > 0 && (
        <>
          <div className="flex items-center justify-between border-t border-neutral-200/80 pt-2 text-xs dark:border-neutral-800/80">
            <span className="text-neutral-500 dark:text-neutral-400">
              勾选 {picked.size}/{drafts.length}
            </span>
            <button
              onClick={() =>
                setPicked(
                  picked.size === drafts.length ? new Set() : new Set(drafts.map((_, i) => i))
                )
              }
              className="text-neutral-400 hover:text-violet-600 dark:hover:text-violet-300"
            >
              {picked.size === drafts.length ? '全不选' : '全选'}
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
            {drafts.map((c, i) => (
              <div
                key={i}
                className={`rounded-lg border p-2.5 transition-colors ${
                  picked.has(i)
                    ? 'border-violet-300 bg-violet-50/40 dark:border-violet-700 dark:bg-violet-500/5'
                    : 'border-neutral-200 dark:border-neutral-800'
                }`}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={picked.has(i)}
                    onChange={() => toggle(i)}
                    className="mt-1 accent-violet-600"
                  />
                  <div className="min-w-0 flex-1">

                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${KIND_CLS[c.kind]}`}>
                        {KIND_LABEL[c.kind]}
                      </span>
                      {c.origin === 'manual' && (
                        <span className="text-[10px] text-neutral-400">手工</span>
                      )}
                      {c.topic && <span className="text-[10px] text-neutral-400">#{c.topic}</span>}
                      {c.duplicate_of != null && (
                        <span className="text-[10px] text-amber-600 dark:text-amber-400">
                          疑似重复
                          {c.similarity != null ? `（${c.similarity}）` : ''}
                          {c.duplicate_of === -1 ? ' · 同批内' : ''}
                        </span>
                      )}
                      <button
                        onClick={() => setEditing(editing === i ? null : i)}
                        className="ml-auto text-[10px] text-neutral-400 hover:text-violet-600 dark:hover:text-violet-300"
                      >
                        {editing === i ? '收起' : '编辑'}
                      </button>
                    </div>
                    {editing === i ? (
                      <div className="space-y-1.5">
                        <textarea
                          value={c.front}
                          onChange={(e) => patch(i, 'front', e.target.value)}
                          className={`${inputCls} resize-none text-[12px]`}
                          rows={3}
                        />
                        <textarea
                          value={c.back}
                          onChange={(e) => patch(i, 'back', e.target.value)}
                          className={`${inputCls} resize-none text-[12px]`}
                          rows={4}
                        />
                      </div>
                    ) : (
                      <>
                        <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{c.front}</p>
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[10px] text-neutral-400">
                            答案
                          </summary>
                          <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-neutral-600 dark:text-neutral-300">
                            {c.back}
                          </p>
                        </details>
                      </>
                    )}

                  </div>
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={() => void save()}
            disabled={busy || !picked.size}
            className="rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
          >
            入库勾选的 {picked.size} 张
          </button>
        </>
      )}
    </div>
  )
}
