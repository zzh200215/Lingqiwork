/** 模块 → 组件、以及「每条路由长什么样」，两条路由共用一份。
 *
 *  为什么单独一个文件：主壳（`Root.tsx` 的 `<Routes>`）和嵌进侧栏的那一份
 *  （同一个 `Root.tsx`，走 `isEmbedded()` 那条分支）渲染的是**同一批页面**。
 *  把「页面 + RouteShell」抽在这里，两边都引它，就不会出现「加了一条路由忘了另一条」。
 *
 *  注意这里**不能**引 `Layout`：`Layout` 引 `routes`，再引回来就是环。
 */
import type { ReactNode } from 'react'
import { Route } from 'react-router-dom'

import App from './App'
import AssetsPage from './AssetsPage'
import CompanionPage from './CompanionPage'
import DashboardPage from './DashboardPage'
import GrowthPage from './GrowthPage'
import KBPage from './KBPage'
import NotesPage from './NotesPage'
import ReviewPage from './ReviewPage'
import SettingsPage from './SettingsPage'
import ThreadsPage from './ThreadsPage'
import TutorPage from './TutorPage'
import WorkPage from './WorkPage'
import { ROUTES, RouteShell, type Module } from './routes'

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
  return <RouteShell page={module}>{PAGES[module]}</RouteShell>
}

/** 全部路由，给 `<Routes>` 当 children 用。 */
export function moduleRoutes(): ReactNode[] {
  return Object.entries(ROUTES).map(([path, module]) => (
    <Route key={path} path={path} element={moduleElement(module)} />
  ))
}
