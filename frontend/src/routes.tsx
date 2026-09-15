/** 前端路由的单一真相：路径 ↔ 模块，以及旧 `.html` 路径的别名。

    这个文件里除了两个组件，其余都是**纯函数**——协议的正确性靠直测这些函数来保证，
    不需要渲染整棵树（这个仓库目前没有任何渲染整页的测试设施）。
*/
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

export type Module =
  | 'chat'
  | 'tutor'
  | 'work'
  | 'threads'
  | 'growth'
  | 'dashboard'
  | 'notes'
  | 'kb'
  | 'settings'
  | 'review'
  | 'assets'
  | 'companion'

/** 路径 → 模块。`/review` 现在是**进了导航的「今日」**（复习队列 + 习惯打卡）——
    够不着是客观缺陷，已修；主动提醒本身仍然封存（复习是你想起来才做的事）。
    `/assets` 是「资产」：产出物速览 + 各个库的入口（导航收缩成五区后的集中点）。
    `/companion` 是「陪伴」：零柒的整页聊天 / 成长 / 有声——刻意不进导航，入口是宠物。 */
export const ROUTES: Record<string, Module> = {
  '/': 'chat',
  '/tutor': 'tutor',
  '/work': 'work',
  '/threads': 'threads',
  '/growth': 'growth',
  '/dashboard': 'dashboard',
  '/notes': 'notes',
  '/kb': 'kb',
  '/settings': 'settings',
  '/review': 'review',
  '/assets': 'assets',
  '/companion': 'companion',
}

/** 导航收缩后「整页搬家」的旧地址 → 新地址（带 search）。
 *
 *  只收**真的不再有自己的页面**的路径；页面还活着的（/notes、/kb、/dashboard）
 *  不进这里——它们的入口挪到了资产页，但地址没变，书签照用。
 *  `/threads` 搬进工作页的「跟进」标签；`/growth` 搬进陪伴页的「成长」标签
 *  （成长本来就是宠物那条线的账）。
 */
export const REDIRECTS: Record<string, string> = {
  '/threads': '/work?tab=follow',
  '/growth': '/companion?tab=growth',
}

const TITLES: Record<Module, string> = {
  chat: '对话',
  tutor: '学',
  work: '工作',
  threads: '事',
  growth: '成长',
  dashboard: '仪表盘',
  notes: '笔记',
  kb: '知识库',
  settings: '设置',
  review: '今日',
  assets: '资产',
  companion: '陪伴',
}

/** 把路径规范化成路由表里的形状；不是已知路由就返回 null。
 *
 *  `.html` 后缀当**别名**而不是 404：`capture.ts` 把 `/kb.html` 编进了用户浏览器里
 *  已经保存的书签小工具，那些字符串我们改不了。丢掉这条别名 = 静默废掉一条集成。
 */
export function normalizePath(pathname: string): string | null {
  let p = (pathname || '/').trim() || '/'
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1) // 去尾斜杠
  if (p in ROUTES) return p
  if (p === '/index.html') return '/'
  if (p.endsWith('.html')) {
    const stem = p.slice(0, -'.html'.length)
    if (stem in ROUTES) return stem
  }
  return null
}

/** 不是已知路由 → null；否则 → 模块名。 */
export function parseRoute(pathname: string): Module | null {
  const p = normalizePath(pathname)
  return p === null ? null : ROUTES[p]
}

/** 侧栏顶栏那行字用的：给一个 href（可能带 query）→ 该叫什么。 */
export function titleFor(href: string): string {
  const module = parseRoute((href || '').split(/[?#]/)[0])
  return module ? TITLES[module] : '侧栏'
}

/** 旧路径 → 该跳去的新地址；已经是新路径、或不是已知路由 → null。
 *
 *  **`search` 和 `hash` 必须原样带上。** 存量书签打过来的是
 *  `/kb.html?clip=<url>&title=<t>`——剪藏的参数就在 search 里，只把路径改掉而丢掉
 *  query，等于把这条集成从「能用」变成「点了没反应」。
 *
 *  两层：`.html` 别名先摆正成路由路径；再查 `REDIRECTS`（整页搬家的路径）。
 *  搬家目标自带 search 时两边合并——旧参数保留、新参数说了算
 *  （`/threads?thread=3` → `/work?tab=follow&thread=3`）。目标不带 search 时
 *  旧 search **一个字节都不动**（上面书签小工具那条测试钉死了这一点）。
 */
export function legacyTarget(
  pathname: string,
  search: string,
  hash: string
): { pathname: string; search: string; hash: string } | null {
  const normalized = normalizePath(pathname)
  if (normalized === null) return null

  const moved = REDIRECTS[normalized]
  if (moved === undefined) {
    if (normalized === pathname) return null
    return { pathname: normalized, search, hash }
  }

  const q = moved.indexOf('?')
  const toPath = q === -1 ? moved : moved.slice(0, q)
  if (q === -1) return { pathname: toPath, search, hash }

  const merged = new URLSearchParams(search)
  for (const [k, v] of new URLSearchParams(moved.slice(q + 1))) merged.set(k, v)
  const s = merged.toString()
  return { pathname: toPath, search: s ? `?${s}` : '', hash }
}

/** 当前路径对应的模块。Layout 用它决定高亮和埋点。 */
export function useModule(): Module {
  return parseRoute(useLocation().pathname) ?? 'chat'
}

/** 承接旧 `.html` 地址：在路由表之外先把它换成新地址（保留 query 和 hash）。
 *
 *  必须放在 `<BrowserRouter>` 里面（要用 useLocation）但在 `<Routes>` 外面——
 *  它是「把地址摆正」，不是一条路由。 */
export function LegacyRedirect({ children }: { children: React.ReactNode }) {
  const { pathname, search, hash } = useLocation()
  const navigate = useNavigate()
  const target = legacyTarget(pathname, search, hash)

  useEffect(() => {
    if (target) navigate(target, { replace: true })
  }, [target, navigate])

  // 还没跳完就先不渲染——否则页面会先按旧地址挂载一次再重挂
  if (target) return null
  return <>{children}</>
}

/** 页面内容容器。原先是 `Layout` 负责的（`Layout.tsx:149-153`），上提到路由层之后
    由它接管——**裸渲染的页面没有这层会塌成 0px**。
 *
 *  chat 和 学 例外：它们自己管滚动（输入框钉在底部，外面再套一层滚动容器会把它
 *  连同内容一起滚走），这与改动前的行为一致。 */
export function RouteShell({ page, children }: { page: Module; children: React.ReactNode }) {
  useEffect(() => {
    // 单页外壳之后 <title> 没有地方按页给了（以前每个 .html 各带一个）
    document.title = `${TITLES[page]} · AI 工作台`
  }, [page])

  if (page === 'chat' || page === 'tutor') return <>{children}</>
  return <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>
}
