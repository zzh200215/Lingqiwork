import { request } from './request'
import type { NoteSearchHit, SearchHit, VoicePending } from '../api'

export const notesApi = {
  globalSearch: async (q: string): Promise<SearchHit[]> => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
    if (!res.ok) throw new Error(`search failed: ${res.status}`)
    const data = (await res.json()) as { results: SearchHit[] }
    return data.results
  },

  listNotes: () =>
    request<{ dir: string; files: { path: string; mtime: number }[] }>('/api/notes'),

  /** 那一问（R2 · PLAN5 §3）：还没归类的语音备忘。拉取式，只在打开笔记页时取一次。 */
  voiceNotes: () => request<VoicePending>('/api/notes/voice'),

  /** 零柒说过的话（它自己的账本）。今天页拿它摆「最近说的」——那不是新真值，
   *  与挂件里那个气泡读的是同一张表（`pet_events`）。
   *  **端点的形状是 `{events: […]}`，不是裸数组**（2026-09-18 踩过：按数组读，
   *  `lines.length` 是 undefined，那一块就静默不渲染了）。 */
  notesBriefing: () =>
    request<{ text: string; cached: boolean; facts: { total: number; today_new: number; this_week_touched: number; latest_titles: string[]; latest_today: string[] } }>(
      '/api/notes/briefing'
    ),
  searchNotes: (q: string) =>
    request<{ query: string; hits: NoteSearchHit[] }>(
      `/api/notes/search?q=${encodeURIComponent(q)}`
    ),
  readNote: (path: string) =>
    request<{ path: string; content: string }>(
      `/api/notes/content?path=${encodeURIComponent(path)}`
    ),
  saveNote: (path: string, content: string) =>
    request<{ ok: boolean; chunks: number }>('/api/notes/content', {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),
  deleteNote: (path: string) =>
    request<{ ok: boolean }>(`/api/notes/content?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),

  clipUrl: (url: string, title?: string) =>    request<{ filename: string; title: string; chars: number; chunks: number }>('/api/kb/clip', {
      method: 'POST',
      body: JSON.stringify({ url, title }),
    }),

  /** 划词助手的「剪藏」：直接落盘所选文本（/api/kb/clip_text） */
  clipText: (text: string, title?: string) =>
    request<{ filename: string; title: string; chars: number; chunks: number }>('/api/kb/clip_text', {
      method: 'POST',
      body: JSON.stringify({ text, title }),
    }),

  /** 信念演化时间线：automemory 事实按语义聚成的「信念线」 */
}
