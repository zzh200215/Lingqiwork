import React from 'react'
import ReactDOM from 'react-dom/client'
import Root from './Root'
import { ThemeProvider } from './ThemeProvider'
import { bootTheme } from './theme'
import './index.css'

// **必须在 render 之前**：皮肤是一串写在 <html> 上的内联 CSS 变量，晚一步就是
// 「先按出厂配色画一帧、再跳成你的配色」。同步执行，不放进 effect。
bootTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  </React.StrictMode>
)
