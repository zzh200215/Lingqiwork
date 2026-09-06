import { useEffect, useState } from 'react'

import PetWidget from './PetWidget'
import { api } from './api'

// Theme + shared sidebar layout for all pages

function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark')
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])
  return { dark, toggle: () => setDark((d) => !d) }
}

function ThemeToggle() {
  const { dark, toggle } = useTheme()
  return (
    <button
      onClick={toggle}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      title={dark ? '切到亮色' : '切到暗色'}
    >
      {dark ? '☀️' : '🌙'}
    </button>
  )
}

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-base shadow-sm shadow-violet-300 dark:shadow-violet-900/50">
        🧠
      </div>
      <span className="text-[15px] font-semibold tracking-tight">AI 工作台</span>
    </div>
  )
}

// 「学」排第二位：PLAN.md 第 1 节的主线就是它。/review.html（今日队列 + 习惯）
// 按第 3 节封存 —— 页面还在，只从导航移走，因为「到期了要还债」的感觉正是被否
// 掉的那一版。文件名仍是 review.html，改入口要动 vite.config.ts 和书签。
const NAV = [
  { href: '/', label: '对话', icon: '💬', key: 'chat' },
  { href: '/tutor.html', label: '学', icon: '🎓', key: 'tutor' },
  { href: '/dashboard.html', label: '仪表盘', icon: '📊', key: 'dashboard' },
  { href: '/notes.html', label: '笔记', icon: '📝', key: 'notes' },
  { href: '/kb.html', label: '知识库', icon: '📚', key: 'kb' },
  { href: '/settings.html', label: '设置', icon: '⚙️', key: 'settings' },
] as const

export default function Layout({
  page,
  children,
}: {
  page: 'chat' | 'kb' | 'settings' | 'dashboard' | 'notes' | 'review' | 'tutor'
  children: React.ReactNode
}) {
  const [conversations, setConversations] = useState<{ id: number; title: string }[]>([])

  // open-count baseline (PLAN 第0周). best-effort: a failing telemetry call must
  // never delay or break the page it is reporting on
  useEffect(() => {
    api.visit(page).catch(() => {})
  }, [page])

  useEffect(() => {
    if (page === 'chat') return
    fetch('/api/conversations')
      .then((r) => r.json())
      .then((cs) => setConversations(cs.slice(0, 8)))
      .catch(() => {})
  }, [page])

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200/80 bg-neutral-50/60 dark:border-neutral-800/80 dark:bg-neutral-900/40">
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <Logo />
          <ThemeToggle />
        </div>

        <div className="px-3 pb-3 pt-2">
          <button
            onClick={() => {
              // on the chat page App already listens for this (tray menu uses it);
              // elsewhere hand the intent over via URL so App creates it on load
              if (page === 'chat') window.dispatchEvent(new Event('workbench:new-chat'))
              else window.location.href = '/?new=1'
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-2 text-sm font-medium text-white shadow-sm shadow-violet-300 transition-all hover:shadow-md hover:shadow-violet-400 hover:brightness-110 dark:shadow-violet-900/60 dark:hover:shadow-violet-700/60"
          >
            <span className="text-base leading-none">＋</span> 新对话
          </button>
        </div>

        <nav className="flex flex-col gap-1 px-3">
          {NAV.map((n) => (
            <a
              key={n.key}
              href={n.href}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                page === n.key
                  ? 'bg-violet-100 font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
                  : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200'
              }`}
            >
              <span className="text-[15px] leading-none">{n.icon}</span>
              {n.label}
            </a>
          ))}
        </nav>

        {page !== 'chat' && conversations.length > 0 && (
          <div className="mt-4 border-t border-neutral-200/80 px-3 pt-3 dark:border-neutral-800/80">
            <p className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              最近对话
            </p>
            <nav className="flex flex-col gap-0.5">
              {conversations.map((c) => (
                <a
                  key={c.id}
                  href={'/?conv=' + c.id}
                  className="truncate rounded-lg px-3 py-1.5 text-sm text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200"
                >
                  {c.title}
                </a>
              ))}
            </nav>
          </div>
        )}

        <div className="flex-1" />
        <div className="border-t border-neutral-200/80 p-4 dark:border-neutral-800/80">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-neutral-300 to-neutral-400 text-xs font-semibold text-neutral-600 dark:from-neutral-700 dark:to-neutral-800 dark:text-neutral-300">
              ME
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">本地用户</p>
              <p className="text-[11px] text-neutral-400">数据不出本机</p>
            </div>
          </div>
        </div>
      </aside>
      {/* chat and 学 own their scrolling: both keep a composer pinned at the
          bottom, which a page-level overflow container would scroll away */}
      {page === 'chat' || page === 'tutor' ? (
        children
      ) : (
        <main className="flex-1 overflow-y-auto">{children}</main>
      )}
      <PetWidget />
    </div>
  )
}
