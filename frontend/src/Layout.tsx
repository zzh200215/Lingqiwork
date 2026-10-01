import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Brain, ChevronDown, Moon, Palette, Search, Sun } from 'lucide-react'

import CommandPalette from './CommandPalette'
import PetWidget from './PetWidget'
import ThemeBackdrop from './ThemeBackdrop'
import { useTheme } from './ThemeProvider'
import { api } from './api'
import { NAV, navCrumbs, navState, useModule } from './routes'

// 外壳：侧栏 + 顶栏 + 内容区。外观（皮肤 / 亮暗 / 自定义背景）是**全局状态**，
// 真相在 `ThemeProvider`（见那个文件顶部的分工说明），这里只消费。

/** 亮暗切换：改的是**全局主题**里的明暗档位，不是本地一份 state。
 *
 *  以前它自带一个 `useState` + 一个 `localStorage['theme']`——于是「顶栏那个按钮」
 *  与「设置里的外观」会是两份互不相干的真值（点了一个，另一个不动）。
 *  现在两条路都走 `useTheme()`，键也统一成 `wb:theme`（旧键 `theme` 的迁移在
 *  `theme.ts` 的 `loadTheme` 里做）。
 *
 *  图标与提示语看的是 **`resolved.dark`（现在实际是什么色）**，而不是 `config.mode`：
 *  后者可能是 `'system'`，那时按钮上写「切到亮色」还是「切到暗色」得看系统当前是什么。
 *  点一下的语义也因此是明确的——**离开跟随、改成另一种明确档位**，这正是用户按这个
 *  按钮时的意思。 */
function ThemeToggle() {
  const { resolved, setDark } = useTheme()
  return (
    <button
      onClick={() => setDark(!resolved.dark)}
      data-theme-toggle=""
      className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      title={resolved.dark ? '切到亮色' : '切到暗色'}
    >
      {resolved.dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  )
}

/** 换肤入口（顶栏）：**不是**「再放一个主题按钮」，而是「去设置里的外观那一页」。
 *
 *  皮肤、强调色、自定义背景、图片库是同一件事的四个面，挤在一个下拉里会变成
 *  一堆没有预览的小色块；而它们本来就有家——设置页。这里只负责**让人找得到那个家**：
 *  顶栏紧挨着亮暗按钮，一眼能看见。
 *
 *  入口是链接不是弹层：地址是 `/settings?section=appearance`，可以收藏、可以深链，
 *  与全站「侧栏是唯一入口、地址是唯一真相」的约定一致。 */
function AppearanceLink() {
  return (
    <Link
      to="/settings?section=appearance"
      data-topbar-appearance=""
      title="外观：皮肤与背景"
      className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
    >
      <Palette className="h-4 w-4" />
    </Link>
  )
}

function Logo() {
  return (
    <Link to="/" title="回对话" className="flex items-center gap-2">
      <div className="wb-accent-fill flex h-8 w-8 items-center justify-center rounded-md text-white shadow-sm shadow-violet-300 dark:shadow-violet-900/50">
        <Brain className="h-[18px] w-[18px]" />
      </div>
      <span className="text-[15px] font-semibold tracking-tight">AI 工作台</span>
    </Link>
  )
}

// 导航（2026-09-18 改版）：**可展开的分组**，分组表在 `routes.tsx`（唯一真相）。
//
// 上一版是五个平铺的大区，毛病是「功能全藏在页面里的标签栏里」——工作页六个标签、
// 零柒五个、设置七个，侧栏却只看得见五个字。现在子功能就摆在模块下面，
// 页面里那套标签栏已经删掉（侧栏是唯一入口），而地址一个都没改。
//
// 展开状态：**当前所在的那一组默认展开**，其余收起；手动开合过的记在 localStorage
// （只记「手动的那几次」，没记过的仍然跟着当前组走——不然切页时展开状态会打架）。
const OPEN_KEY = 'nav-open'

function loadOpen(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}')
    return raw && typeof raw === 'object' ? (raw as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronDown
      aria-hidden="true"
      className={`h-4 w-4 transition-transform ${open ? '' : '-rotate-90'}`}
    />
  )
}

// 每组一个专属色：图标坐在淡色 chip 里，扫一眼就知道自己在哪个区
const GROUP_CHIP: Record<string, { bg: string; fg: string }> = {
  review: { bg: 'bg-amber-100 dark:bg-amber-400/15', fg: 'text-amber-600 dark:text-amber-300' },
  tutor: { bg: 'bg-sky-100 dark:bg-sky-400/15', fg: 'text-sky-600 dark:text-sky-300' },
  work: { bg: 'bg-violet-100 dark:bg-violet-400/15', fg: 'text-violet-600 dark:text-violet-300' },
  assets: { bg: 'bg-emerald-100 dark:bg-emerald-400/15', fg: 'text-emerald-600 dark:text-emerald-300' },
  companion: { bg: 'bg-pink-100 dark:bg-pink-400/15', fg: 'text-pink-600 dark:text-pink-300' },
  settings: { bg: 'bg-neutral-200/70 dark:bg-neutral-700/50', fg: 'text-neutral-500 dark:text-neutral-300' },
}

/** 顶栏（2026-09-18 版面改版）：左边是「你在哪」，右边是全局动作。
 *
 *  **为什么要有它**：原来「当前在哪一页」只体现在侧栏那一格的高亮上，而每一页
 *  又各自在正文顶部念一遍自己的名字——信息重复、还占掉一行高度。现在这一段收进顶栏，
 *  页面正文从内容开始（参考项目 Robot Admin 的 `C_Header` 就是这个分工：面包屑在顶栏，
 *  内容区不放页名）。
 *  2026-09-19：右侧加了全局搜索入口（Ctrl+K 命令面板）——顶栏从「只报位置」
 *  升级成「能办事」。 */
function TopBar({ page, onOpenSearch }: { page: string; onOpenSearch: () => void }) {
  const { pathname, search } = useLocation()
  const crumbs = navCrumbs(pathname, search)
  return (
    <header className="wb-chrome wb-topbar sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-neutral-200/70 px-6 dark:border-neutral-800/70">
      <nav aria-label="面包屑" className="flex min-w-0 items-center gap-2 text-sm">
        {crumbs.href ? (
          <Link
            to={crumbs.href}
            data-crumb="module"
            className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-violet-700 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:hover:text-violet-300"
          >
            {crumbs.module}
          </Link>
        ) : (
          <span data-crumb="module" className="shrink-0 px-1.5 font-medium text-neutral-700 dark:text-neutral-200">
            {crumbs.module}
          </span>
        )}
        {crumbs.item ? (
          <>
            <span className="shrink-0 text-neutral-300 dark:text-neutral-600">/</span>
            <span data-crumb="item" className="truncate text-neutral-500 dark:text-neutral-400">
              {crumbs.item}
            </span>
          </>
        ) : null}
      </nav>

      <div className="flex-1" />
      <button
        onClick={onOpenSearch}
        data-topbar-search=""
        title="全局搜索（Ctrl+K）"
        className="flex h-9 items-center gap-2 rounded-md border border-neutral-200/80 bg-white/60 px-3 text-sm text-neutral-400 transition-colors hover:border-violet-300 hover:text-neutral-600 dark:border-neutral-700/70 dark:bg-neutral-800/40 dark:hover:border-violet-500/40 dark:hover:text-neutral-300"
      >
        <Search className="h-4 w-4" />
        <span className="hidden md:inline">搜索</span>
        <kbd className="hidden rounded-md border border-neutral-200 px-1.5 py-0.5 text-xs dark:border-neutral-700 md:inline">
          Ctrl K
        </kbd>
      </button>
      <span
        data-topbar-page={page}
        className="hidden text-xs tabular-nums text-neutral-300 sm:block dark:text-neutral-600"
      >
        数据不出本机
      </span>
      <AppearanceLink />
      <ThemeToggle />
    </header>
  )
}

export default function Layout() {
  // 由当前路径推导，不是 prop：埋点和「最近对话」都要**每次路由变化**重新触发
  const page = useModule()
  const navigate = useNavigate()
  const location = useLocation()
  const [conversations, setConversations] = useState<{ id: number; title: string }[]>([])
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const active = navState(location.pathname, location.search)
  const isOpen = (key: string) => open[key] ?? key === active.group

  function toggle(key: string) {
    setOpen((prev) => {
      const next = { ...prev, [key]: !(prev[key] ?? key === active.group) }
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next))
      } catch {
        /* 存不下就只在这一次会话里生效——不值得为此挡住导航 */
      }
      return next
    })
  }

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

  // Ctrl+K 只挂在非会话页：会话页有自己的 Ctrl+K（搜会话），别跟它抢
  useEffect(() => {
    if (page === 'chat') return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page])

  return (
    <div className="relative flex h-full bg-[color:var(--page-bg)]">
      {/* 自定义背景层：铺在下面，侧栏与顶栏的半透明才透得出它 */}
      <ThemeBackdrop />
      {/* 侧栏与顶栏共用 `.wb-chrome`：**「壳」是一个区域，不是一个地方**。
          它的底色、透明度、模糊都由皮肤给（见 `index.css` 那一节），
          所以侧栏与顶栏永远一致——两处各写一遍透明度的下场是「侧栏跟着皮肤变了、
          顶栏没变」，而那种不一致只会被读成渲染 bug。 */}
      <aside className="wb-chrome wb-sidebar relative z-[1] flex w-60 shrink-0 flex-col border-r border-neutral-200/70 dark:border-neutral-800/70">
        <div className="flex items-center px-4 pb-2 pt-4">
          <Logo />
        </div>

        <div className="px-3 pb-3 pt-2">
          <button
            onClick={() => {
              // on the chat page App already listens for this (tray menu uses it);
              // elsewhere hand the intent over via URL so App creates it on load
              if (page === 'chat') window.dispatchEvent(new Event('workbench:new-chat'))
              else navigate('/?new=1')
            }}
            className="wb-btn-primary w-full gap-1.5 px-3 py-2 text-sm shadow-sm shadow-violet-300 transition-all hover:shadow-md hover:shadow-violet-400 dark:shadow-violet-900/60 dark:hover:shadow-violet-700/60"
          >
            <span className="text-base leading-none">＋</span> 新对话
          </button>
        </div>

        {/* 导航与「最近对话」共用一块滚动区：分组展开之后这一列会变长，
            不给它滚动的话，底部那块（本地用户）会被顶出屏幕。 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <nav className="flex flex-col gap-0.5 px-3">
            {NAV.map((g) => {
              const on = isOpen(g.key)
              const inGroup = g.key === active.group
              const chip = GROUP_CHIP[g.key] ?? GROUP_CHIP.settings
              const GroupIcon = g.icon
              const groupCls = inGroup
                ? 'bg-violet-50/70 font-medium text-neutral-900 dark:bg-violet-500/10 dark:text-neutral-100'
                : 'text-neutral-500 hover:bg-neutral-100/70 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/50 dark:hover:text-neutral-200'
              return (
                <div key={g.key} className="relative">
                  {inGroup ? (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-neutral-400 dark:bg-neutral-500"
                    />
                  ) : null}
                  <div className={`flex items-center rounded-md transition-colors ${groupCls}`}>
                    <Link
                      to={g.href}
                      data-nav-group={g.key}
                      data-nav-active={inGroup ? '1' : undefined}
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-sm"
                    >
                      <span
                        className={`wb-chip h-6 w-6 rounded-lg ${
                          inGroup ? 'bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300' : `${chip.bg} ${chip.fg}`
                        }`}
                      >
                        <GroupIcon className="h-4 w-4" />
                      </span>
                      <span className={`truncate ${inGroup ? 'font-medium' : ''}`}>{g.label}</span>
                    </Link>
                    {g.items.length > 0 ? (
                      <button
                        onClick={() => toggle(g.key)}
                        data-nav-toggle={g.key}
                        aria-expanded={on}
                        aria-label={`${on ? '收起' : '展开'}${g.label}`}
                        title={on ? '收起' : '展开'}
                        className="mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-200/60 hover:text-neutral-600 dark:hover:bg-neutral-700/60 dark:hover:text-neutral-200"
                      >
                        <Chevron open={on} />
                      </button>
                    ) : null}
                  </div>

                  {g.items.length > 0 && on ? (
                    <div data-nav-items={g.key} className="mt-0.5 flex flex-col gap-0.5 pb-0.5 pl-4">
                      {g.items.map((i) => {
                        const ItemIcon = i.icon
                        return (
                          <Link
                            key={i.href}
                            to={i.href}
                            data-nav-item={i.href}
                            data-nav-active={i.href === active.href ? '1' : undefined}
                            className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] transition-colors ${
                              i.href === active.href
                                ? 'bg-violet-50 font-medium text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'
                                : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200'
                            }`}
                          >
                            <ItemIcon
                              className={`h-4 w-4 shrink-0 ${
                                i.href === active.href
                                  ? 'text-violet-500 dark:text-violet-400'
                                  : 'text-neutral-400'
                              }`}
                            />
                            <span className="truncate">{i.label}</span>
                          </Link>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </nav>

          {page !== 'chat' && conversations.length > 0 && (
            <div className="mt-4 border-t border-neutral-200/80 px-3 pt-3 dark:border-neutral-800/80">
              <p className="px-3 pb-1.5 text-xs font-medium uppercase tracking-wider text-neutral-400">
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
        </div>

        <div className="border-t border-neutral-200/80 p-4 dark:border-neutral-800/80">
          <div className="flex items-center gap-2.5">
            <div className="wb-accent-fill flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white shadow-sm shadow-violet-300 dark:shadow-violet-900/50">
              ME
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">本地用户</p>
              <p className="text-xs text-neutral-400">数据不出本机</p>
            </div>
          </div>
        </div>
      </aside>
      {/* 跨模块分栏（SplitPane）已整体移除（2026-09-13）：用得少，且开侧栏时主区
          变窄却仍按**窗口**宽度选断点，排版不匹配。滚动/高度容器在 RouteShell
          （routes.tsx）里，这里只把页面放回来。
          2026-09-18 版面改版：外面多了一层「顶栏 + 内容」的竖排——顶栏是全局的
          （面包屑 + 主题），内容区照旧由 RouteShell 管滚动。 */}
      <div className="relative z-[1] flex min-w-0 flex-1 flex-col">
        {/* 对话页自带页头（会话标题、模型、工具那一排），再顶一条就重复了 */}
        {page === 'chat' ? null : <TopBar page={page} onOpenSearch={() => setPaletteOpen(true)} />}
        <Outlet />
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <PetWidget />
    </div>
  )
}
