import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'

import Layout from './Layout'
import { moduleElement, moduleRoutes } from './modules'
import { LegacyRedirect, parseRoute } from './routes'

/** 这个文档是不是被嵌在 iframe 里跑的——也就是分屏右侧那一半。
 *
 *  判据用 `window.frameElement`，**不是 URL 参数**：文档内部每次导航之后它都还在，
 *  而各页面的 `setSearchParams({}, …)` 会把参数清干净——那样嵌在侧栏里的页面
 *  会突然长出左侧导航栏和宠物来。
 *
 *  跨源时读它会被拒，那种情况按普通页面处理（本应用同源，走不到）。 */
function isEmbedded(): boolean {
  try {
    return window.frameElement != null
  } catch {
    return false
  }
}

/** 嵌进来的那一份：只渲染页面本身，没有外壳、没有分栏、没有宠物。
 *  它是**独立的一份视口**，所以页面自己的响应式排版（`md:` 那些）按侧栏的宽度算——
 *  这正是「页面随窗格大小变化而重排」的实现方式。 */
function EmbeddedRoutes() {
  const module = parseRoute(useLocation().pathname)
  return module ? <>{moduleElement(module)}</> : <Navigate to="/" replace />
}

/** 单个外壳 + 客户端路由。用 BrowserRouter 而不是 HashRouter：pywebview 用
    WebView2 加载 `http://127.0.0.1`，有真正的 History API；换成 hash 路由反而会
    把书签小工具依赖的路径形状弄坏。 */
export default function Root() {
  if (isEmbedded()) {
    return (
      <BrowserRouter>
        <EmbeddedRoutes />
      </BrowserRouter>
    )
  }
  return (
    <BrowserRouter>
      <LegacyRedirect>
        <Routes>
          {/* 无 path 的布局路由：外壳常驻，页面进 <Outlet/> */}
          <Route element={<Layout />}>{moduleRoutes()}</Route>
          {/* 地址打错时回首页，而不是白屏 */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </LegacyRedirect>
    </BrowserRouter>
  )
}
