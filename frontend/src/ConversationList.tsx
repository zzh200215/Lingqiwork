// 会话列表侧栏（方向 6 第十八刀，2026-09-30 自 App.tsx 拆出）：
// 过滤（convQuery）/ 置顶 / 文件夹分组 / 重命名——展示与列表内 CRUD 自含，
// CRUD 完了经 refreshConversations 回调让父级重拉。打开与删除仍走父级回调：
// 打开要装消息流、删除要清当前会话的 messages，都与核心状态耦合。
// searchRef 由父级传入：Ctrl+K 聚焦这个输入框。
import { useMemo, useState, type Ref } from 'react'
import { type Conversation } from './api'

export default function ConversationList({
  conversations,
  activeId,
  searchRef,
  onOpen: openConversation,
  onDelete: deleteConversation,
  refreshConversations,
}: {
  conversations: Conversation[]
  activeId: number | null
  searchRef: Ref<HTMLInputElement>
  onOpen: (id: number) => void
  onDelete: (id: number) => void
  refreshConversations: () => Promise<void>
}) {
  const [convQuery, setConvQuery] = useState('')
  const filteredConversations = useMemo(() => {
    const q = convQuery.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter((c) => c.title.toLowerCase().includes(q))
  }, [conversations, convQuery])

  async function togglePin(c: Conversation) {
    await fetch(`/api/conversations/${c.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !c.pinned }),
    })
    await refreshConversations()
  }

  async function setFolder(c: Conversation, folder: string) {
    await fetch(`/api/conversations/${c.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    })
    await refreshConversations()
  }

  async function renameConversation(c: Conversation) {
    const name = window.prompt('重命名会话：', c.title)
    if (!name?.trim() || name.trim() === c.title) return
    await fetch(`/api/conversations/${c.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: name.trim().slice(0, 100) }),
    })
    await refreshConversations()
  }

  return (
    <>
      {/* conversation list (chat page only) */}
      <div className="hidden w-52 shrink-0 flex-col overflow-hidden border-r border-neutral-200/80 md:flex dark:border-neutral-800/80">
        <div className="p-2">
          <input
            ref={searchRef}
            value={convQuery}
            onChange={(e) => setConvQuery(e.target.value)}
            placeholder="搜索会话…  Ctrl+K"
            className="w-full rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs transition-colors placeholder:text-neutral-400 focus:border-violet-300 focus:bg-white focus:outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:focus:border-violet-500/50"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {(() => {
            const pinned = filteredConversations.filter((c) => c.pinned)
            const folders = new Map<string, Conversation[]>()
            const loose: Conversation[] = []
            for (const c of filteredConversations) {
              if (c.pinned) continue
              if (c.folder) {
                if (!folders.has(c.folder)) folders.set(c.folder, [])
                folders.get(c.folder)!.push(c)
              } else {
                loose.push(c)
              }
            }
            const rowCls = (active: boolean) =>
              `group flex items-center justify-between rounded-lg px-2 py-1.5 text-sm transition-colors ${
                active
                  ? 'bg-violet-100 font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
                  : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200'
              }`
            const Row = (c: Conversation) => (
              <div key={c.id} className={rowCls(activeId === c.id)}>
                <button className="flex-1 truncate text-left" onClick={() => openConversation(c.id)}>
                  {c.folder && <span className="mr-1 text-xs">📁</span>}
                  {c.title}
                </button>
                <button
                  onClick={() => renameConversation(c)}
                  className="ml-1 shrink-0 text-neutral-400 opacity-60 transition-[color,opacity] hover:text-violet-500 hover:opacity-100 focus-visible:opacity-100"
                  title="重命名"
                >
                  ✎
                </button>
                <button
                  onClick={() => togglePin(c)}
                  className={`ml-0.5 shrink-0 opacity-60 transition-[color,opacity] hover:opacity-100 focus-visible:opacity-100 ${
                    c.pinned ? 'text-violet-500' : 'text-neutral-400 hover:text-violet-500'
                  }`}
                  title={c.pinned ? '取消置顶' : '置顶'}
                >
                  📌
                </button>
                <select
                  value={c.folder || ''}
                  onChange={(e) => setFolder(c, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  className="ml-0.5 w-5 shrink-0 cursor-pointer bg-transparent text-xs opacity-60 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100"
                  title="移入文件夹"
                >
                  <option value="">📁+</option>
                  {[...new Set(conversations.map((x) => x.folder).filter(Boolean))].map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => deleteConversation(c.id)}
                  className="ml-0.5 shrink-0 text-neutral-400 opacity-60 transition-[color,opacity] hover:text-red-500 hover:opacity-100 focus-visible:opacity-100"
                  title="删除"
                >
                  ×
                </button>
              </div>
            )
            return (
              <>
                {pinned.length > 0 && (
                  <>
                    <p className="px-2 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wider text-neutral-400">
                      📌 置顶
                    </p>
                    {pinned.map(Row)}
                  </>
                )}
                {[...folders.entries()].map(([folder, items]) => (
                  <div key={folder}>
                    <p className="px-2 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-neutral-400">
                      📁 {folder}
                    </p>
                    {items.map(Row)}
                  </div>
                ))}
                {loose.length > 0 && (pinned.length > 0 || folders.size > 0) && (
                  <p className="px-2 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-neutral-400">
                    全部
                  </p>
                )}
                {loose.map(Row)}
              </>
            )
          })()}
          {!filteredConversations.length && (
            <p className="px-2 py-4 text-xs leading-relaxed text-neutral-400">
              {convQuery ? '没有匹配的会话' : '还没有会话，发送第一条消息后自动创建'}
            </p>
          )}
        </div>
      </div>
    </>
  )
}
