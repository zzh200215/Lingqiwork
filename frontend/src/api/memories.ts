import { request } from './request'
import type { MemoryExpose, MemoryItem, MemoryTidyReport, MemoryTidyStatus } from '../api'

export const memoriesApi = {
  listMemories: () => request<MemoryItem[]>('/api/settings/memories'),
  addMemory: (content: string) =>
    request<{ ok: boolean; message: string }>('/api/settings/memories', {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  updateMemory: (id: number, content: string) =>
    request<{ ok: boolean; message: string }>(`/api/settings/memories/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  deleteMemory: (id: number) =>
    request<{ ok: boolean }>(`/api/settings/memories/${id}`, { method: 'DELETE' }),
  clearMemories: () => request<{ ok: boolean; deleted: number }>('/api/settings/memories', { method: 'DELETE' }),
  getMemoryExpose: () => request<MemoryExpose>('/api/settings/mcp/expose'),
  getMemoryTidy: () => request<MemoryTidyStatus>('/api/settings/memories/tidy'),
  runMemoryTidy: () =>
    request<MemoryTidyReport>('/api/settings/memories/tidy', { method: 'POST' }),

}
