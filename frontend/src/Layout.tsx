import { useEffect, useState } from 'react'
import { Link, Outlet, useNavigate } from 'react-router-dom'

import PetWidget from './PetWidget'
import { api } from './api'
import { useModule } from './routes'

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

// 「学」「工作」挨着：两条线是主线。`/review`（今日：复习队列 + 习惯打卡）也进导航——
// 页面一直在，只是从前只有一处 11px 的隐藏链接够得着，那才是缺陷。
// 「成长」跟在三条线后面：它读的就是 学 / 工作 / 习惯 的积累，是它们的合并视图。
const NAV = [
  { href: '/', label: '对话', icon: '💬', key: 'chat' },
  { href: '/tutor', label: '学', icon: '🎓', key: 'tutor' },
  { href: '/work', label: '工作', icon: '🗂', key: 'work' },
  { href: '/threads', label: '事', icon: '🧵', key: 'threads' },
  { href: '/growth', label: '成长', icon: '🌱', key: 'growth' },
  { href: '/review', label: '今日', icon: '☀️', key: 'review' },
  { href: '/dashboard', label: '仪表盘', icon: '📊', key: 'dashboard' },
  { href: '/notes', label: '笔记', icon: '📝', key: 'notes' },
  { href: '/kb', label: '知识库', icon: '📚', key: 'kb' },
  { href: '/settings', label: '设置', icon: '⚙️', key: 'settings' },
] as const

export default function Layout() {
  // 由当前路径推导，不是 prop：埋点和「最近对话」都要**每次路由变化**重新触发
  const page = useModule()
  const navigate = useNavigate()
  const [conversations, setConversations] = useState<{ id: number; title: string }[]>([])

  // open-count baseline. best-effort: a failing telemetry call must
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
              else navigate('/?new=1')
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-2 text-sm font-medium text-white shadow-sm shadow-violet-300 transition-all hover:shadow-md hover:shadow-violet-400 hover:brightness-110 dark:shadow-violet-900/60 dark:hover:shadow-violet-700/60"
          >
            <span className="text-base leading-none">＋</span> 新对话
          </button>
        </div>

        <nav className="flex flex-col gap-1 px-3">
          {NAV.map((n) => (
            <Link
              key={n.key}
              to={n.href}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                page === n.key
                  ? 'bg-violet-100 font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
                  : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200'
              }`}
            >
              <span className="text-[15px] leading-none">{n.icon}</span>
              {n.label}
            </Link>
          ))}
        </nav>

        {page !== 'chat' && conversations.length > 0 && (
          <div className="mt-4 border-t border-neutral-200/80 px-3 pt-3 dark:border-neutral-800/80">
            <p className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              最近对话
            </p>
            <nav className="flex flex-col gap-0.5">
              {conversations.map((c) => (
                <Link
                  key={c.id}
                  to={'/?conv=' + c.id}
                  className="truncate rounded-lg px-3 py-1.5 text-sm text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200"
                >
                  {c.title}
                </Link>
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
      {/* 跨模块分栏（SplitPane）已整体移除（2026-09-13）：用得少，且开侧栏时主区
          变窄却仍按**窗口**宽度选断点，排版不匹配。滚动/高度容器在 RouteShell
          （routes.tsx）里，这里只把页面放回来。 */}
      <Outlet />
      <PetWidget />
    </div>
  )
}
