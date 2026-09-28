import { request } from './request'
import type { BeliefThread, DecisionEntry, DecisionLogView, DecisionOutcome, DecisionWitness } from '../api'

export const decisionsApi = {
  beliefThreads: () => request<{ threads: BeliefThread[] }>('/api/beliefs'),

  /** 决策日志 + 校准分：把判断与当时的把握钉下来，回看时才算得出校准 */
  listDecisions: () => request<DecisionLogView>('/api/decisions'),  addDecision: (body: { text: string; basis?: string; topic?: string; confidence?: number }) =>
    request<DecisionEntry>('/api/decisions', { method: 'POST', body: JSON.stringify(body) }),
  reviewDecision: (id: number, outcome: DecisionOutcome, note = '') =>
    request<DecisionEntry>(`/api/decisions/${id}/review`, {
      method: 'PUT',
      body: JSON.stringify({ outcome, note }),
    }),
  deleteDecision: (id: number) =>
    request<{ ok: boolean }>(`/api/decisions/${id}`, { method: 'DELETE' }),
  /** 到点的那条判断（M4 · G5）：主动开口的**唯一**一处，走 nudge 管线的第 5 个来源。 */
  decisionWitness: () => request<DecisionWitness>('/api/decisions/witness'),

  /** 用量与成本：最近 N 天的 token 花在哪些操作 / 模型上 */
}
