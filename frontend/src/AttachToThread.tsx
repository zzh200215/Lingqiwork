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

/** 把 `request()` 抛的那串 `503: {"detail":"…"}` 里那句人话挖出来。 */
function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const m = raw.match(/\{"detail":"([\s\S]*?)"\}/)
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`) as string
    } catch {
      return m[1]
    }
  }
  return raw
}

import { api, type ThreadKind, type ThreadRow } from './api'

export default function AttachToThread({
  kind,
  ref: itemRef,
  className = '',
  // **别叫 `label`**：这个组件里 `label` 已经是「派生出来的那件事的名字」（下面那个
  // `useState`），两个同名会直接编译不过——这个名字说的是**按钮上那句话**。
  label: buttonLabel = '挂到…',
  onAttached,
  onError,
  onCreated,
}: {
  kind: ThreadKind
  ref: string
  /** 放按钮的容器样式（悬停才现身、缩进之类由调用方决定） */
  className?: string
  /** 按钮上那句话。默认「挂到…」；那一问里叫「工作留痕」（同一个动作，说法跟着那一格走） */
  label?: string
  /** 挂上之后叫一声。**那一问那张单子靠它把这一份划掉**（挂完还留在单子上就成了假的） */
  onAttached?: (name: string) => void
  /** 失败了叫一声。**原来这里两个 catch 都是空的**——挂不上、界面上什么都不说，
   *  而 `ThreadsPage` 自己那套实现失败时会显示页级红条。
   *
   *  所以这个回调是**换组件的前置**：不给出口就换过去，等于把 `ThreadsPage` 已有的
   *  错误可见性**倒退**回去（而「失败不再静默」正是 P0 的目标）。 */
  onError?: (message: string) => void
  /** 新建并挂上之后，把那件事**整个交出去**（调用方要拿 id 去打开它）。
   *  `onAttached` 只给名字，够「划掉单子」不够「打开那件事」。 */
  onCreated?: (thread: { id: number; name: string }) => void
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
    } catch (e) {
      // 建议拉不到只剩「用它的名字新建」那条路——**但要说一声**，否则用户会以为
      // 这一条本来就没有可挂的事。
      onError?.(`可挂的事拉不出来：${errText(e)}`)
    }
  }

  async function pick(t: ThreadRow) {
    setBusy(true)
    try {
      await api.attachThreadItem(t.id, kind, itemRef)
      setAttached(t.name)
      setOpen(false)
      onAttached?.(t.name)
    } catch (e) {
      // 失败就保持原样，别把界面改成假的「已挂上」——**但也别静默**。
      onError?.(`没挂上：${errText(e)}`)
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
      onAttached?.(t.name)
      onCreated?.({ id: t.id, name: t.name })
    } catch (e) {
      onError?.(`没建成也没挂上：${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  if (attached) {
    return <span className={`text-xs text-emerald-600 dark:text-emerald-400 ${className}`}>
      已挂到 {attached}
    </span>
  }

  return (
    <span className={className}>
      <button
        onClick={(e) => void toggle(e)}
        title="把这一条挂到某件事上"
        className="shrink-0 rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-400 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-500"
      >
        {buttonLabel}
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
              className="rounded-full border border-violet-300 px-2 py-0.5 text-xs text-violet-700 hover:bg-violet-50 disabled:opacity-40 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-500/10"
            >
              {t.name}
            </button>
          ))}
          <button
            disabled={busy || !label.trim()}
            onClick={(e) => void createAndAttach(e)}
            title="用这一条自己的名字建一件事，并把它挂上去"
            className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400"
          >
            ＋ 新建「{(label || '这一条').slice(0, 12)}」
          </button>
        </span>
      ) : null}
    </span>
  )
}
