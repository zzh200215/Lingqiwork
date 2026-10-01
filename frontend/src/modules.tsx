/** 模块 → 组件、以及「每条路由长什么样」，两条路由共用一份。
 *
 *  为什么单独一个文件：主壳（`Root.tsx` 的 `<Routes>`）和嵌进侧栏的那一份
 *  （同一个 `Root.tsx`，走 `isEmbedded()` 那条分支）渲染的是**同一批页面**。
 *  把「页面 + RouteShell」抽在这里，两边都引它，就不会出现「加了一条路由忘了另一条」。
 *
 *  注意这里**不能**引 `Layout`：`Layout` 引 `routes`，再引回来就是环。
 *
 *  ## 页面按路由懒加载（2026-10-01）
 *
 *  十二个页面全部 `lazy(() => import(...))`。起因是构建警告：主 chunk 1.26MB
 *  （gzip 360KB），把十二页连同 echarts 这类只有一两页用的重东西全驮在首屏。
 *  拆开后首屏只拉外壳 + 当前页，echarts 只在仪表盘/成长真正要画图时才下载。
 *  `vite.config.ts` 里那份 `manualChunks: { echarts }` 保留——它管「echarts 单独成包」，
 *  这里的 lazy 管「什么时候才需要它」，两层不冲突。
 *
 *  代价是切页瞬间有一帧 fallback：只垫一个最小高度，不画骨架——底色是皮肤给的，
 *  闪一帧骨架比闪一帧素底更显眼。
 */
import { lazy, Suspense, type ReactNode } from 'react'
import { Route } from 'react-router-dom'

import { ROUTES, RouteShell, type Module } from './routes'

const App = lazy(() => import('./App'))
const AssetsPage = lazy(() => import('./AssetsPage'))
const CompanionPage = lazy(() => import('./CompanionPage'))
const DashboardPage = lazy(() => import('./DashboardPage'))
const GrowthPage = lazy(() => import('./GrowthPage'))
const KBPage = lazy(() => import('./KBPage'))
const NotesPage = lazy(() => import('./NotesPage'))
const ReviewPage = lazy(() => import('./ReviewPage'))
const SettingsPage = lazy(() => import('./SettingsPage'))
const ThreadsPage = lazy(() => import('./ThreadsPage'))
const TutorPage = lazy(() => import('./TutorPage'))
const WorkPage = lazy(() => import('./WorkPage'))

const PAGES: Record<Module, ReactNode> = {
  chat: <App />,
  tutor: <TutorPage />,
  work: <WorkPage />,
  threads: <ThreadsPage />,
  growth: <GrowthPage />,
  dashboard: <DashboardPage />,
  notes: <NotesPage />,
  kb: <KBPage />,
  settings: <SettingsPage />,
  review: <ReviewPage />,
  assets: <AssetsPage />,
  companion: <CompanionPage />,
}

/** 一条路由对应的一页内容（带 RouteShell 给的滚动容器）。 */
export function moduleElement(module: Module): ReactNode {
  return (
    <RouteShell page={module}>
      <Suspense fallback={<div data-route-loading="" className="min-h-[40vh]" />}>
        {PAGES[module]}
      </Suspense>
    </RouteShell>
  )
}

/** 全部路由，给 `<Routes>` 当 children 用。 */
export function moduleRoutes(): ReactNode[] {
  return Object.entries(ROUTES).map(([path, module]) => (
    <Route key={path} path={path} element={moduleElement(module)} />
  ))
}
