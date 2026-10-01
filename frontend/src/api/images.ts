import { request } from './request'
import type { AsrResult, AsrStatus, ImageConfig, ImageGenResult, ImageItem, TtsResult } from '../api'

export const imagesApi = {
  listImages: () =>
    request<{ config: ImageConfig; images: ImageItem[] }>('/api/images'),
  generateImage: (prompt: string, size = '', model = '') =>
    request<ImageGenResult>('/api/images/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt, size, model }),
    }),
  deleteImage: (name: string) =>
    request<{ ok: boolean }>(`/api/images/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  /** 没被任何已知引用（配置/数据库/vault + 前端传来的皮肤底图）指着的图。只扫不删。 */
  unreferencedImages: (keep: string[]) =>
    request<{ images: ImageItem[]; count: number; bytes: number }>('/api/images/unreferenced', {
      method: 'POST',
      body: JSON.stringify({ keep }),
    }),
  /** 删掉未引用的图。后端在同一次请求里重新扫一遍再删，两步之间没有时间窗。 */
  cleanupImages: (keep: string[]) =>
    request<{ deleted: string[]; count: number; bytes: number }>('/api/images/cleanup', {
      method: 'POST',
      body: JSON.stringify({ keep }),
    }),
  uploadImage: async (file: File): Promise<ImageItem> => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/images/upload', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
    return res.json()
  },
  asrStatus: () => request<AsrStatus>('/api/asr/status'),
  transcribeAudio: async (blob: Blob): Promise<AsrResult> => {
    const fd = new FormData()
    fd.append('file', blob, 'audio.webm')
    const res = await fetch('/api/asr/transcribe', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
    return res.json()
  },
  ocrImage: (name: string) =>
    request<{ text: string }>('/api/images/ocr', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  ttsVoices: () => request<{ voices: string[]; engines: string[]; max_chars: number }>('/api/tts/voices'),
  tts: (text: string, voice = '', engine = 'edge') =>
    request<TtsResult>('/api/tts', { method: 'POST', body: JSON.stringify({ text, voice, engine }) }),
}
