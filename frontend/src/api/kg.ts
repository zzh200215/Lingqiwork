import { request } from './request'
import type { KgRetrieval, KgStatus } from '../api'

export const kgApi = {
  getKgStatus: () => request<KgStatus>('/api/kg/status'),
  saveKgConfig: (c: { uri: string; user: string; password: string; enabled: boolean }) =>
    request<{ ok: boolean; files?: number; entities?: number; relations?: number }>('/api/kg/config', {
      method: 'PUT',
      body: JSON.stringify(c),
    }),
  buildKg: (maxFiles: number) =>
    request<{ extracted: number; unchanged: number; failed: { file: string; error: string }[] }>('/api/kg/build', {
      method: 'POST',
      body: JSON.stringify({ max_files: maxFiles }),
    }),
  queryKg: (q: string, topK: number) =>
    request<KgRetrieval>('/api/kg/query', { method: 'POST', body: JSON.stringify({ q, top_k: topK }) }),
  clearKg: () => request<{ ok: boolean; deleted_entities: number }>('/api/kg/clear', { method: 'POST' }),

  // ---------- 复习卡片 ----------
}
