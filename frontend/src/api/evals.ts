import { request } from './request'
import type { AgentEvalBoard, EngineEvalLatest, EngineEvalRunResult, EvalItem, EvalRun, PromptEvalBoard, TurnFilter, TurnSummary } from '../api'
import type { TurnTrace } from '../api'

export const evalsApi = {
  turns: (limit = 30, only = '') =>
    request<{ traces: TurnTrace[]; filters: TurnFilter[]; only: string }>(
      `/api/turns?limit=${limit}${only ? `&only=${encodeURIComponent(only)}` : ''}`
    ),

  /** 成文引擎的自动标尺：每个引擎最近一次的得分 + golden set 覆盖 */
  engineEvalLatest: () => request<EngineEvalLatest>('/api/evals/engines/latest'),

  /** 回合读数（R1 · PLAN5 §3）：窗口内跑过几个聊天回合、各毛病几例。
   *
   *  **只给计数，不给成功率**——`core/turn_trace.py` 开篇写死的是「诊断工具，不是考核仪表」。
   *  读数与口径一起从后端来（`rules`），界面照抄不自己编。 */
  turnSummary: (days = 30) => request<TurnSummary>(`/api/dashboard/turns?days=${days}`),

  /** 提示词评测（R1 补齐 · PLAN5 §2-2）：登记了多少条、量过几条、几条站得住。
   *
   *  与上面两条同一条红线：**只进仪表盘**，不设目标、不排名、不进零柒嘴里。
   *  这一格尤其不能变成排行榜——载荷里没有任何一条提示词的名字或分数。 */
  promptEvalBoard: () => request<PromptEvalBoard>('/api/dashboard/prompt-eval'),
  agentEvalBoard: () => request<AgentEvalBoard>('/api/dashboard/agent-eval'),

  /** 在真模型上跑一遍 golden set（每个用例至少一次模型调用，可能要几分钟） */
  engineEvalRun: (engine?: string) =>
    request<EngineEvalRunResult>('/api/evals/engines/run', {
      method: 'POST',
      body: JSON.stringify(engine ? { engine } : {}),
    }),

  listEvalItems: () => request<EvalItem[]>('/api/evals'),
  /** 全量配置读/写（夜间回归等开关的家；后端 PUT /api/settings/prefs）。 */
  createEvalItem: (i: Partial<EvalItem>) =>
    request<EvalItem>('/api/evals', { method: 'POST', body: JSON.stringify(i) }),
  updateEvalItem: (id: number, i: Partial<EvalItem>) =>
    request<EvalItem>(`/api/evals/${id}`, { method: 'PUT', body: JSON.stringify(i) }),
  deleteEvalItem: (id: number) =>
    request<{ ok: boolean }>(`/api/evals/${id}`, { method: 'DELETE' }),
  listEvalRuns: () => request<EvalRun[]>('/api/evals/runs'),
  getEvalRun: (id: number) => request<EvalRun>(`/api/evals/runs/${id}`),
  deleteEvalRun: (id: number) =>
    request<{ ok: boolean }>(`/api/evals/runs/${id}`, { method: 'DELETE' }),
  cancelEvalRun: () =>
    request<{ stopped: boolean }>('/api/evals/run/cancel', { method: 'POST' }),
  /** 全量重建索引的合作式取消：当前文件做完才停。没在跑时如实回 stopped:false */
  runEval: (top_k: number | null, judge: boolean, signal?: AbortSignal) =>
    request<EvalRun>('/api/evals/run', {
      method: 'POST',
      body: JSON.stringify({ top_k, judge }),
      signal,
    }),

}
