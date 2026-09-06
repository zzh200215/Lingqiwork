import { resolve } from 'path'
import { defineConfig } from 'vite'
/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'

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
      },
    },
  },
})
