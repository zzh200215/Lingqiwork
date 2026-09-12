/** 前端路由的单一真相：路径 ↔ 模块，以及旧 `.html` 路径的别名。

    这个文件里除了两个组件，其余都是**纯函数**——协议的正确性靠直测这些函数来保证，
    不需要渲染整棵树（这个仓库目前没有任何渲染整页的测试设施）。
*/
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

export type Module = 'chat' | 'tutor' | 'dashboard' | 'notes' | 'kb' | 'settings' | 'review'

/** 路径 → 模块。`/review` 在表里但**不进导航**：页面还在、书签还有效，
    只是「到期了要还债」那种感觉正是被否掉的那一版（见 Layout 的注释）。 */
export const ROUTES: Record<string, Module> = {
  '/': 'chat',
  '/tutor': 'tutor',
  '/dashboard': 'dashboard',
  '/notes': 'notes',
  '/kb': 'kb',
  '/settings': 'settings',
  '/review': 'review',
}

const TITLES: Record<Module, string> = {
  chat: '对话',
  tutor: '学',
  dashboard: '仪表盘',
  notes: '笔记',
  kb: '知识库',
  settings: '设置',
  review: '复盘',
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

/** 旧路径 → 该跳去的新地址；已经是新路径、或不是已知路由 → null。
 *
 *  **`search` 和 `hash` 必须原样带上。** 存量书签打过来的是
 *  `/kb.html?clip=<url>&title=<t>`——剪藏的参数就在 search 里，只把路径改掉而丢掉
 *  query，等于把这条集成从「能用」变成「点了没反应」。
 */
export function legacyTarget(
  pathname: string,
  search: string,
  hash: string
): { pathname: string; search: string; hash: string } | null {
  const target = normalizePath(pathname)
  if (target === null || target === pathname) return null
  return { pathname: target, search, hash }
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
