import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'vite'
/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'

/** The backend's startup token, read per request so this heals
 * if vite is up before the backend has written it. */
function apiToken(): string | null {
  try {
    return readFileSync(resolve(__dirname, '../data/api_token'), 'utf-8').trim() || null
  } catch {
    return null
  }
}

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // 三个真实入口：SPA 外壳，加两个全局热键弹的无边框窗口。
      // `quick` / `selection` 刻意不进 SPA——它们要的是极短冷启动，
      // 且是独立窗口，没有共享导航状态可言。
      // （零柒的桌面小窗试过第四个入口 pet.html，P5 末尾换成了原生分层窗
      // `backend/desktop_pet.py`——WebView2 的子窗口进不了分层窗的合成，
      // 透明像素透出来的永远是表单底色，见 desktop_pet.py 开头的弯路记录。）
      input: {
        index: resolve(__dirname, 'index.html'),
        quick: resolve(__dirname, 'quick.html'),
        selection: resolve(__dirname, 'selection.html'),
      },
      output: {
        // echarts（2026-09-19 起图表用）单独拆包：它只被几个指标页异步用到，
        // 混进主包会把首屏凭空拖大几百 KB。
        manualChunks: {
          echarts: ['echarts'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        // Dev the page is on :5173 while the API is on :8000, so the backend's
        // SameSite=Strict cookie never reaches it. Inject the token into every
        // proxied request here instead: the browser — including the `/api/...`
        // subresource loads (`<img>`/`<audio>`/backup download) that cannot
        // carry a header — then needs no token logic of its own, and the
        // backend stays strict in dev exactly as in production.
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            const tok = apiToken()
            if (tok) proxyReq.setHeader('X-WB-Token', tok)
          })
        },
      },
    },
  },
})
