// 全局搜索遮罩（方向 6 第十七刀，2026-09-30 自 App.tsx 拆出）：
// Ctrl+P 唤起、防抖搜全部会话内容、Enter/点击跳转，开合与查询状态全部自含——
// 关着的时候渲染 null。教学命中跳「学」页深链（useNavigate 自取），
// 会话命中走 openConversation 回调；Ctrl+K / Ctrl+N 快捷键仍归 ChatView。
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type SearchHit } from './api'

export default function ChatSearchOverlay({
  openConversation,
}: {
  openConversation: (id: number) => Promise<void>
}) {
  const navigate = useNavigate()
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const globalSearchRef = useRef<HTMLInputElement>(null)

  // Ctrl+P 唤起（原 ChatView 全局快捷键里的 Ctrl+P 分支随迁）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setSearchOpen(true)
        setSearchQ('')
        setSearchHits([])
        setTimeout(() => globalSearchRef.current?.focus(), 50)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // debounced global search
  useEffect(() => {
    if (!searchOpen) return
    const q = searchQ.trim()
    if (!q) {
      setSearchHits([])
      return
    }
    const t = setTimeout(() => {
      setSearching(true)
      api
        .globalSearch(q)
        .then(setSearchHits)
        .catch(() => setSearchHits([]))
        .finally(() => setSearching(false))
    }, 250)
    return () => clearTimeout(t)
  }, [searchQ, searchOpen])

  async function jumpToHit(hit: SearchHit) {
    setSearchOpen(false)
    // 教学命中跳「学」页深链打开那次会话；教学是另一个模块，不能只切状态
    if (hit.source === 'tutor') {
      navigate(`/tutor?session=${hit.ref_id}`)
      return
    }
    await openConversation(hit.ref_id)
  }

  if (!searchOpen) return null
  return (
      <div
        className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[12vh] backdrop-blur-sm"
        onClick={() => setSearchOpen(false)}
      >
        <div
          className="w-full max-w-xl animate-slide-up overflow-hidden rounded-lg border border-neutral-200 wb-float bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
            <span className="text-neutral-400">🔍</span>
            <input
              ref={globalSearchRef}
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearchOpen(false)
                if (e.key === 'Enter' && searchHits.length > 0) jumpToHit(searchHits[0])
              }}
              placeholder="搜索所有会话内容…  Enter 跳第一条"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
            />
            <button onClick={() => setSearchOpen(false)} className="text-xs text-neutral-400 hover:text-neutral-600">
              Esc
            </button>
          </div>
          <div className="max-h-[50vh] overflow-y-auto">
            {searching && <p className="px-4 py-4 text-xs text-neutral-400">搜索中…</p>}
            {!searching && searchQ.trim() && !searchHits.length && (
              <p className="px-4 py-4 text-xs text-neutral-400">没有找到包含「{searchQ.trim()}」的消息</p>
            )}
            {!searchQ.trim() && (
              <p className="px-4 py-4 text-xs text-neutral-400">
                输入关键词搜索全部历史消息（Ctrl+P 随时唤起）
              </p>
            )}
            {searchHits.map((hit) => (
              <button
                key={`${hit.source}-${hit.id}`}
                onClick={() => jumpToHit(hit)}
                className="block w-full border-b border-neutral-50 px-4 py-3 text-left transition-colors last:border-0 hover:bg-violet-50 dark:border-neutral-800/60 dark:hover:bg-violet-500/10"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-neutral-700 dark:text-neutral-200">
                    {hit.source === 'tutor' && <span className="mr-1 text-amber-600 dark:text-amber-400">🎓</span>}
                    {hit.title}
                  </span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                    hit.source === 'tutor'
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300'
                      : hit.role === 'user'
                        ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
                        : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
                  }`}>
                    {hit.source === 'tutor' ? '教学' : hit.role === 'user' ? '我' : 'AI'}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-neutral-400">{hit.excerpt}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
  )
}
