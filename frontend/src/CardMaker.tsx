import { useState } from 'react'

import { api, type CardDraft, type CardKind } from './api'
import { streamCardsGenerate, type CardGenStage } from './stream'

// Shared card generator: used by the review page (paste mode) and the notes
// sidebar (current-note mode). Candidates ALWAYS go through this tick-and-edit
// step before they enter the deck — one bad auto-inserted card is enough to
// stop trusting the queue, and trust does not come back.

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

  const inputCls =
    'w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-900'

  async function generate() {
    if (busy) return
    if (pasteMode && text.trim().length < MIN_TEXT) {
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
      const done = await streamCardsGenerate(
        pasteMode
          ? { text: text.trim(), count }
          : { source_path: sourcePath, count },
        (s: CardGenStage) => setStage(s.stage)
      )
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

  return (
    <div className="flex min-h-0 flex-col gap-2.5">
      {pasteMode ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="粘贴一段技术材料（踩坑记录、changelog、文档节选…），至少 80 字"
          className={`${inputCls} resize-none font-mono text-[12px] leading-relaxed`}
          rows={compact ? 5 : 8}
        />
      ) : (
        <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
          来源：<span className="text-neutral-700 dark:text-neutral-200">{sourceLabel || sourcePath}</span>
        </p>
      )}

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
                      {c.topic && (
                        <span className="text-[10px] text-neutral-400">#{c.topic}</span>
                      )}
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
            className="rounded-lg border border-violet-300 px-3 py-1.5 text-sm font-medium text-violet-700 transition-colors hover:bg-violet-50 disabled:opacity-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-500/10"
          >
            入库勾选的 {picked.size} 张
          </button>
        </>
      )}
    </div>
  )
}

