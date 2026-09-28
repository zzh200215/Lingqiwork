import { request } from './request'
import type { CostSummary, JournalRecent, JournalSaved, QualitySummary } from '../api'

export const journalApi = {
  costSummary: (days = 30) => request<CostSummary>(`/api/cost/summary?days=${days}`),

  /** 语音日记：转写文本按天落盘 vault/journal/（automemory 后台提取，best-effort） */
  journalAdd: (text: string) =>
    request<JournalSaved>('/api/journal', { method: 'POST', body: JSON.stringify({ text }) }),
  journalRecent: () => request<JournalRecent>('/api/journal/recent'),

  /** 卡点讨论播客（对话播客 2.0）：最近的卡点 → 双人讨论音频 */
  qualityFeedback: (payload: {
    kind: 'research' | 'compose' | 'recap' | 'decide' | 'conflict' | 'deliver'
    verdict: 'good' | 'bad'
    prompt_sha?: string
    model_id?: string
    reason?: string
    ref?: string
    /** S1：这份产出吃着技能生成的没有。**三态**：不传 = 不知道，`"[]"` = 没有注入，
     *  `'["技能名"]'` = 有注入。点 👍 的那一刻手上有注入清单的调用方才传得起。 */
    injected?: string
  }) =>
    request<{ id: number; kind: string; verdict: string }>('/api/quality/feedback', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  qualitySummary: (days = 90) => request<QualitySummary>(`/api/quality/summary?days=${days}`),

  /** 最近若干聊天回合（W5）。`only` = 只看某一类毛病（keys 见返回里的 filters）。 */
}
