import { request } from './request'
import type { AgentPreset, ArenaResult } from '../api'

export const agentsApi = {
  listAgents: () => request<AgentPreset[]>('/api/agents'),
  createAgent: (a: Omit<AgentPreset, 'id'>) =>
    request<AgentPreset>('/api/agents', { method: 'POST', body: JSON.stringify(a) }),
  updateAgent: (id: number, a: Partial<AgentPreset>) =>
    request<AgentPreset>(`/api/agents/${id}`, { method: 'PUT', body: JSON.stringify(a) }),
  deleteAgent: (id: number) => request<{ ok: boolean }>(`/api/agents/${id}`, { method: 'DELETE' }),

  arenaRun: (prompt: string, models?: string[], system?: string, signal?: AbortSignal) =>
    request<{ results: ArenaResult[] }>('/api/arena', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        ...(models && models.length ? { models } : {}),
        ...(system ? { system } : {}),
      }),
      // 「不等了」据此真的断开这次请求。**它不是「停止」**：服务端那一趟并行调用
      // 会照旧跑完（最多 90 秒/家），钱照花——所以按钮上不写「停止」。
      ...(signal ? { signal } : {}),
    }),
  /** 历次对打记录（`vault/prompts/duels/`，新在前封顶 50）——对打浏览器的清单。
   *  正文不在这里：记录就是普通 md，点开走既有的笔记页。 */
  listArenaRecords: () =>
    request<{ records: { path: string; title: string; mtime: number }[] }>('/api/arena/records'),
  /** 把这次对打落成 `vault/prompts/duels/` 里一篇 md 并进索引。
   *  **一份对照记录，不是一条断言**——为什么不进评测区的金标集，见后端 `arena.save_record`。 */
  arenaSave: (payload: {
    title?: string
    system: string
    prompt: string
    model_id?: string
    results: ArenaResult[]
  }) =>
    request<{ filename: string; chunks: number }>('/api/arena/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // ---------- 第0周：使用基线 + 今日建议 ----------
  /** best-effort page-open count; fire from Layout on mount, ignore errors */
}
