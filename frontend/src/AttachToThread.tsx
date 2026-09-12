/** 「挂到…」——有清单的地方就地就能把这一条挂到某件事上（§4-14）。
 *
 *  候选是**派生**出来的（`/api/threads/suggest` 拿这条自己的标签去比对已有「事」的名字），
 *  所以这个交互里没有「输入标签」这一步——你只点。一个都没撞上时，用这条自己的名字建一个
 *  再挂上去，等于一个字都不用打。
 *
 *  为什么各自页面要就地做：到 `/threads` 页去挂，得先想起有这件事、再翻出对应的事；而
 *  「这条属于哪件事」的念头是**在你看到它的那一刻**冒出来的。
 */
import { useState, type MouseEvent } from 'react'

import { api, type ThreadKind, type ThreadRow } from './api'

export default function AttachToThread({
  kind,
  ref: itemRef,
  className = '',
}: {
  kind: ThreadKind
  ref: string
  /** 放按钮的容器样式（悬停才现身、缩进之类由调用方决定） */
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [picks, setPicks] = useState<ThreadRow[]>([])
  const [label, setLabel] = useState('')
  const [attached, setAttached] = useState('')
  const [busy, setBusy] = useState(false)

  async function toggle(e: MouseEvent) {
    // 清单行本身往往是个按钮——别顺带把它也点了
    e.stopPropagation()
    e.preventDefault()
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    setPicks([])
    setLabel('')
    try {
      const r = await api.suggestThreads(kind, itemRef)
      setPicks(r.threads)
      setLabel(r.label)
    } catch {
      /* 建议拉不到，就只剩「用它自己的名字新建」那条路 */
    }
  }

  async function pick(t: ThreadRow) {
    setBusy(true)
    try {
      await api.attachThreadItem(t.id, kind, itemRef)
      setAttached(t.name)
      setOpen(false)
    } catch {
      /* 失败就保持原样，别把界面改成假的"已挂上" */
    } finally {
      setBusy(false)
    }
  }

  async function createAndAttach(e: MouseEvent) {
    e.stopPropagation()
    const name = label.trim()
    if (!name) return
    setBusy(true)
    try {
      const t = await api.createThread(name)
      await api.attachThreadItem(t.id, kind, itemRef)
      setAttached(t.name)
      setOpen(false)
    } catch {
      /* 同上 */
    } finally {
      setBusy(false)
    }
  }

  if (attached) {
    return <span className={`text-[11px] text-emerald-600 dark:text-emerald-400 ${className}`}>
      已挂到 {attached}
    </span>
  }

  return (
    <span className={className}>
      <button
        onClick={(e) => void toggle(e)}
        title="把这一条挂到某件事上"
        className="shrink-0 rounded-full border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-400 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-500"
      >
        挂到…
      </button>
      {open ? (
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          {picks.map((t) => (
            <button
              key={t.id}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                void pick(t)
              }}
              className="rounded-full border border-violet-300 px-2 py-0.5 text-[11px] text-violet-700 hover:bg-violet-50 disabled:opacity-40 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-500/10"
            >
              {t.name}
            </button>
          ))}
          <button
            disabled={busy || !label.trim()}
            onClick={(e) => void createAndAttach(e)}
            title="用这一条自己的名字建一件事，并把它挂上去"
            className="rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-500 hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400"
          >
            ＋ 新建「{(label || '这一条').slice(0, 12)}」
          </button>
        </span>
      ) : null}
    </span>
  )
}
