import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import App from './App'
import DashboardPage from './DashboardPage'
import KBPage from './KBPage'
import Layout from './Layout'
import NotesPage from './NotesPage'
import ReviewPage from './ReviewPage'
import SettingsPage from './SettingsPage'
import TutorPage from './TutorPage'
import { LegacyRedirect, RouteShell } from './routes'

/** 单个外壳 + 客户端路由。用 BrowserRouter 而不是 HashRouter：pywebview 用
    WebView2 加载 `http://127.0.0.1`，有真正的 History API；换成 hash 路由反而会
    把书签小工具依赖的路径形状弄坏。 */
export default function Root() {
  return (
    <BrowserRouter>
      <LegacyRedirect>
        <Routes>
          {/* 无 path 的布局路由：外壳常驻，页面进 <Outlet/> */}
          <Route element={<Layout />}>
            <Route
              path="/"
              element={
                <RouteShell page="chat">
                  <App />
                </RouteShell>
              }
            />
            <Route
              path="/tutor"
              element={
                <RouteShell page="tutor">
                  <TutorPage />
                </RouteShell>
              }
            />
            <Route
              path="/dashboard"
              element={
                <RouteShell page="dashboard">
                  <DashboardPage />
                </RouteShell>
              }
            />
            <Route
              path="/notes"
              element={
                <RouteShell page="notes">
                  <NotesPage />
                </RouteShell>
              }
            />
            <Route
              path="/kb"
              element={
                <RouteShell page="kb">
                  <KBPage />
                </RouteShell>
              }
            />
            <Route
              path="/settings"
              element={
                <RouteShell page="settings">
                  <SettingsPage />
                </RouteShell>
              }
            />
            <Route
              path="/review"
              element={
                <RouteShell page="review">
                  <ReviewPage />
                </RouteShell>
              }
            />
          </Route>
          {/* 地址打错时回首页，而不是白屏 */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </LegacyRedirect>
    </BrowserRouter>
  )
}
