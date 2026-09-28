import { request } from './request'
import type { PodcastEntry, RoundtableResult } from '../api'

export const podcastApi = {
  podcastFromStuck: (days = 90) =>
    request<{ ok: boolean; id: string; title: string; file: string; duration_sec: number }>(
      '/api/podcast/stuck',
      { method: 'POST', body: JSON.stringify({ days }) }
    ),

  /** 学习小组圆桌：三 persona 笔谈一个卡点，纪要落盘 vault/roundtable/ */
  roundtableRun: (topic = '', days = 90) =>
    request<RoundtableResult>('/api/roundtable', {
      method: 'POST',
      body: JSON.stringify({ topic, days })
    }),
  roundtablePodcast: (file: string) =>
    request<{ ok: boolean; id: string; title: string; file: string; duration_sec: number }>(
      '/api/roundtable/podcast',
      { method: 'POST', body: JSON.stringify({ file }) }
    ),

  /** 研究（学习闭环的中间两跳）：把上一次的报告落成 vault/research/ 里的一篇 md 并进索引 */
  listPodcasts: () => request<{ podcasts: PodcastEntry[] }>('/api/podcast'),
  generatePodcast: (paths: string[], hostVoice = '', guestVoice = '', title = '') =>
    request<PodcastEntry>('/api/podcast/generate', {
      method: 'POST',
      // LLM 写脚本 + 逐句 TTS + 音频装配，整体可能要 1-3 分钟
      body: JSON.stringify({ paths, host_voice: hostVoice, guest_voice: guestVoice, title }),
    }),
  deletePodcast: (id: string) =>
    request<{ ok: boolean }>(`/api/podcast/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  audioUrl: (path: string) => `/api/work/audio?path=${encodeURIComponent(path)}`,
  /** 一键装好会议闭环（inbox + 四步链）。幂等——装过就原样返回。 */
}
