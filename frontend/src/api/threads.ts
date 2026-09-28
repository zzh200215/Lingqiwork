import { request } from './request'
import type { ThreadCandidate, ThreadDetail, ThreadKind, ThreadRow, ThreadStep } from '../api'

export const threadsApi = {
  listThreads: (includeArchived = false) =>
    request<{ threads: ThreadRow[]; steps: ThreadStep[] }>(
      `/api/threads?include_archived=${includeArchived}`
    ),
  threadDetail: (id: number) => request<ThreadDetail>(`/api/threads/${id}`),
  createThread: (name: string, note = '') =>
    request<ThreadRow>('/api/threads', { method: 'POST', body: JSON.stringify({ name, note }) }),
  /** 局部更新。`status`/`deadline` 是方案 §8.4 的状态机与截止日。
   *
   *  **`deadline` 传空串 = 清掉；不传 = 不改它**（后端 `None` 就是「这次不动」，
   *  所以「清掉」另给一个 `clear_deadline`——两者不能都用 undefined 表达）。 */
  updateThread: (
    id: number,
    patch: {
      name?: string
      note?: string
      archived?: boolean
      status?: 'open' | 'done'
      deadline?: string
      clear_deadline?: boolean
    }
  ) => request<ThreadRow>(`/api/threads/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteThread: (id: number) =>
    request<{ ok: boolean }>(`/api/threads/${id}`, { method: 'DELETE' }),
  attachThreadItem: (id: number, kind: ThreadKind, ref: string) =>
    request<{ ok: boolean; attached: boolean }>(`/api/threads/${id}/items`, {
      method: 'POST',
      body: JSON.stringify({ kind, ref }),
    }),
  detachThreadItem: (id: number, kind: ThreadKind, ref: string) =>
    request<{ ok: boolean }>(
      `/api/threads/${id}/items?kind=${kind}&ref=${encodeURIComponent(ref)}`,
      { method: 'DELETE' }
    ),
  /** 收件箱的候选：还没挂到任何事、**也没被忽略过**的条目 */
  unclassified: (limit = 60) =>
    request<{ items: ThreadCandidate[]; total: number }>(
      `/api/threads/unclassified?limit=${limit}`
    ),
  /** 从收件箱里划掉一条（§8.4）。幂等。**东西一件都不动**——只是不再出现在收件箱里。
   *  收件箱的目标是清空，而候选是派生的：没有这一档它永远清不空。 */
  ignoreInboxItem: (kind: ThreadKind, ref: string) =>
    request<{ ok: boolean; ignored: boolean }>('/api/threads/inbox/ignore', {
      method: 'POST',
      body: JSON.stringify({ kind, ref }),
    }),
  /** 撤销忽略——它回到收件箱里。 */
  unignoreInboxItem: (kind: ThreadKind, ref: string) =>
    request<{ ok: boolean }>(
      `/api/threads/inbox/ignore?kind=${kind}&ref=${encodeURIComponent(ref)}`,
      { method: 'DELETE' }
    ),
  /** 这个条目该挂到哪件事上（按它自己的标签派生，不用你打字） */
  suggestThreads: (kind: ThreadKind, ref: string) =>
    request<{ label: string; threads: ThreadRow[] }>(
      `/api/threads/suggest?kind=${kind}&ref=${encodeURIComponent(ref)}`
    ),
  /** 就这件事写一份交付——**这一路的模型用量记在这件事头上**（§4-16） */
  /** 就这件事写一份交付。**这一路的账记在这件事头上**（§4-16）。
   *
   *  `signal` 传进来就带上——而且这一条的取消**是真停**：客户端断开 → Starlette 取消
   *  这个请求 → 取消沿 await 链传到 `llm.stream_chat`，那里 `finally` 显式关上游流。
   *  所以界面上写的是「停止」，不是「不等了」。 */
  deliverIntoThread: (id: number, genre: string, audience: string, signal?: AbortSignal) =>
    request<{ filename: string; title: string; chunks: number }>(`/api/threads/${id}/deliver`, {
      method: 'POST',
      body: JSON.stringify({ genre, audience }),
      ...(signal ? { signal } : {}),
    }),

  // ---------- 工作：交付（把材料改写成能交出去的体裁） ----------
  /** 体裁 × 读者的定义（唯一真值在后端，含「长稿」判据） */
}
