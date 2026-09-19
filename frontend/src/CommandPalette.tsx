import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BookOpen,
  CornerDownLeft,
  FileOutput,
  MessageSquare,
  NotebookPen,
  Search,
} from 'lucide-react'
import { api, type SearchHit } from './api'
import { NAV } from './routes'

// 全局命令面板（Ctrl+K）。参考项目 Robot Admin 的顶栏搜索是它「像产品」最直接的
// 一处——这里抄交互，不抄实现：搜索全部打现有接口（/api/search 是后端本来就有的
// 会话/教学全文检索），不建索引、不加新真值。
//
// 四个来源：页面直达（NAV）、会话与教学内容（/api/search）、笔记（按文件名过滤）、
// 产出物（按标题过滤）。后两个在打开面板时拉一次、内存里过滤——量级是几百条，
// 不值得为此建节流请求。

interface PaletteItem {
  key: string
  label: string
  sub?: string
  href: string
  icon: typeof Search
}

interface PaletteGroup {
  key: string
  label: string
  items: PaletteItem[]
}

const PAGE_ITEMS: PaletteItem[] = NAV.flatMap((g) => [
  { key: `page:${g.key}`, label: g.label, sub: '页面', href: g.href, icon: g.icon },
  ...g.items.map((i) => ({ key: `page:${i.href}`, label: `${g.label} · ${i.label}`, sub: '页面', href: i.href, icon: i.icon })),
])

function basename(p: string) {
  return p.split('/').pop() || p
}

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [conversations, setConversations] = useState<{ id: number; title: string }[]>([])
  const [notes, setNotes] = useState<{ path: string }[]>([])
  const [outputs, setOutputs] = useState<{ title: string; path: string; date: string }[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开时拉一次静态目录；fetch 全部 .catch——面板挂了不能连累页面
  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    setHits([])
    inputRef.current?.focus()
    api.listConversations().then(setConversations).catch(() => {})
    api
      .listNotes()
      .then((r) => setNotes(r.files.map((f) => ({ path: f.path }))))
      .catch(() => {})
    api
      .workOutputs(200)
      .then((r) => setOutputs(r.outputs.map((o) => ({ title: o.title, path: o.path, date: o.date }))))
      .catch(() => {})
  }, [open])

  // 正文搜索：两个字符起搜，180ms 去抖（输入法组合期间 value 也会跳，量小无所谓）
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      return
    }
    const t = setTimeout(() => {
      api
        .globalSearch(q)
        .then((r) => setHits(r.slice(0, 8)))
        .catch(() => setHits([]))
    }, 180)
    return () => clearTimeout(t)
  }, [query, open])

  const groups: PaletteGroup[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (s: string) => s.toLowerCase().includes(q)

    const pages = PAGE_ITEMS.filter((p) => !q || match(p.label))
    const convs = conversations
      .filter((c) => !q || match(c.title))
      .slice(0, 6)
      .map((c) => ({ key: `conv:${c.id}`, label: c.title, sub: '会话', href: `/?conv=${c.id}`, icon: MessageSquare }))
    const noteHits = notes
      .filter((n) => !q || match(n.path))
      .slice(0, 6)
      .map((n) => ({
        key: `note:${n.path}`,
        label: basename(n.path),
        sub: n.path,
        href: `/notes?path=${encodeURIComponent(n.path)}`,
        icon: NotebookPen,
      }))
    const outHits = outputs
      .filter((o) => !q || match(o.title))
      .slice(0, 6)
      .map((o) => ({
        key: `out:${o.path}`,
        label: o.title,
        sub: `产出物 · ${o.date}`,
        href: o.path.startsWith('notes/') ? `/notes?path=${encodeURIComponent(o.path)}` : '/work?tab=output',
        icon: FileOutput,
      }))
    const searchHits: PaletteItem[] = hits.map((h) => ({
      key: `hit:${h.source}:${h.id}`,
      label: h.title,
      sub: h.excerpt,
      href: h.source === 'chat' ? `/?conv=${h.ref_id}` : `/tutor?session=${h.ref_id}`,
      icon: BookOpen,
    }))

    return [
      { key: 'pages', label: '去哪', items: pages },
      { key: 'search', label: '会话与教学', items: searchHits },
      { key: 'convs', label: '最近会话', items: convs },
      { key: 'notes', label: '笔记', items: noteHits },
      { key: 'outputs', label: '产出物', items: outHits },
    ].filter((g) => g.items.length > 0)
  }, [query, hits, conversations, notes, outputs])

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  useEffect(() => {
    setIndex((i) => (i >= flat.length ? 0 : i))
  }, [flat.length])

  if (!open) return null

  function pick(item: PaletteItem) {
    onClose()
    navigate(item.href)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (flat.length ? (i + 1) % flat.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flat[index]
      if (item) pick(item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  let cursor = -1
  return (
    <div
      data-cmd-dialog=""
      className="fixed inset-0 z-50 bg-neutral-950/25 px-4 pt-24 backdrop-blur-sm dark:bg-black/40"
      onClick={onClose}
      onKeyDown={onKeyDown}
    >
      <div
        className="wb-card mx-auto flex max-w-xl flex-col overflow-hidden rounded-2xl !shadow-2xl"
        role="dialog"
        aria-label="全局搜索"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-neutral-200/70 px-4 dark:border-neutral-800">
          <Search className="h-4 w-4 shrink-0 text-neutral-400" />
          <input
            ref={inputRef}
            data-cmd-input=""
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜会话、笔记、产出物，或直接去某页…"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
          />
          <kbd className="rounded-md border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-400 dark:border-neutral-700">
            Esc
          </kbd>
        </div>

        <div className="max-h-96 overflow-y-auto p-2" data-cmd-list="">
          {flat.length === 0 ? (
            <p data-cmd-empty="" className="px-3 py-8 text-center text-sm text-neutral-400">
              没有匹配的结果
            </p>
          ) : (
            groups.map((g) => (
              <div key={g.key} className="mb-1">
                <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                  {g.label}
                </p>
                {g.items.map((item) => {
                  cursor += 1
                  const on = cursor === index
                  const myIndex = cursor
                  return (
                    <button
                      key={item.key}
                      data-cmd-item={item.href}
                      onMouseEnter={() => setIndex(myIndex)}
                      onClick={() => pick(item)}
                      className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${
                        on
                          ? 'bg-violet-100 text-violet-900 dark:bg-violet-500/15 dark:text-violet-100'
                          : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800/70'
                      }`}
                    >
                      <item.icon className="h-4 w-4 shrink-0 text-neutral-400" />
                      <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                      {item.sub ? (
                        <span className="max-w-40 shrink-0 truncate text-xs text-neutral-400">{item.sub}</span>
                      ) : null}
                      {on ? <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-violet-400" /> : null}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
