import { request } from './request'
import type { PetChatMsg, PetEvent, PetGrowth, PetPlugin, PetPluginCommandResult, PetRoom, PetState, PodcastEntry } from '../api'
import type { WeeklyReport } from '../api'

export const petApi = {
  petFeed: (limit = 8) => request<{ events: PetEvent[] }>('/api/pet/feed?limit=' + limit),
  petState: (idleSec?: number, path?: string) => {
    const q = new URLSearchParams()
    if (idleSec != null && Number.isFinite(idleSec)) {
      q.set('idle_sec', String(Math.max(0, Math.round(idleSec))))
    }
    if (path) q.set('path', path)
    const s = q.toString()
    return request<PetState>(`/api/pet/state${s ? `?${s}` : ''}`)
  },
  petGrowth: () => request<PetGrowth>('/api/pet/growth'),
  /** 小屋：它攒下的东西 + 今天喂了它什么 + 架上那几份产出。 */
  petRoom: () => request<PetRoom>('/api/pet/room'),
  /** 陈述式周报（M4）：这一周已经发生的事。任何一天都能看，周日那句问候说的是同一份。 */
  weeklyReport: () => request<WeeklyReport>('/api/pet/weekly-report'),
  /** 周报 → 一段音频（单音色念稿，不过模型）。空的一周回 422，界面照实说。 */
  weeklyPodcast: (voice = '') =>
    request<PodcastEntry>('/api/pet/weekly-report/podcast', {
      method: 'POST',
      body: JSON.stringify({ voice }),
    }),
  petPlugins: () => request<{ plugins: PetPlugin[] }>('/api/pet/plugins'),
  /** 最近几轮跟零柒的问答（旧 → 新）。P5 落库之后，刷新、隔天回来它还记得。 */
  petChats: (limit = 30) => request<{ chats: PetChatMsg[] }>(`/api/pet/chats?limit=${limit}`),
  petPluginCommand: (name: string, command: string, args?: Record<string, unknown>) =>
    request<PetPluginCommandResult>(`/api/pet/plugins/${encodeURIComponent(name)}/command`, {
      method: 'POST',
      body: JSON.stringify({ command, args }),
    }),
  petPluginToggle: (name: string, enabled: boolean) =>
    request<{ ok: boolean; name: string; enabled: boolean }>(
      `/api/pet/plugins/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify({ enabled }) }
    ),

  // ---------- 工作：已经生成出来的产出 ----------
  /** 产出清单：五个引擎落在 vault 里的成品。真值是文件系统，没有登记表。 */
}
