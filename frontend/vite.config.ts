import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'vite'
/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'

/** The backend's startup token (PLAN §10.1 #6), read per request so this heals
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
      input: {
        index: resolve(__dirname, 'index.html'),
        tutor: resolve(__dirname, 'tutor.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        notes: resolve(__dirname, 'notes.html'),
        review: resolve(__dirname, 'review.html'),
        settings: resolve(__dirname, 'settings.html'),
        kb: resolve(__dirname, 'kb.html'),
        quick: resolve(__dirname, 'quick.html'),
        selection: resolve(__dirname, 'selection.html'),
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
