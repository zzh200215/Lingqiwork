import { request } from './request'
import type { HealthReport, JobHealth, McpProbe, McpServer, McpView, ModelProbe, ProviderConfig, SelfCheck } from '../api'

export const settingsApi = {
  // 这一条原来写在 api 对象的开行上，分片时单独接回（方向 6）
  listProviders: () => request<ProviderConfig[]>('/api/settings/providers'),
  createProvider: (p: Partial<ProviderConfig>) =>
    request<ProviderConfig>('/api/settings/providers', { method: 'POST', body: JSON.stringify(p) }),
  updateProvider: (id: number, p: Partial<ProviderConfig>) =>
    request<ProviderConfig>(`/api/settings/providers/${id}`, { method: 'PUT', body: JSON.stringify(p) }),
  deleteProvider: (id: number) =>
    request<{ ok: boolean }>(`/api/settings/providers/${id}`, { method: 'DELETE' }),

  getMcp: () => request<McpView>('/api/settings/mcp'),
  saveMcp: (servers: McpServer[]) =>
    request<McpView>('/api/settings/mcp', { method: 'PUT', body: JSON.stringify({ servers }) }),
  testMcp: (server: McpServer) =>
    request<McpProbe>('/api/settings/mcp/test', { method: 'POST', body: JSON.stringify(server) }),

  getPrefs: () => request<Record<string, unknown>>('/api/settings/prefs'),
  updatePrefs: (patch: Record<string, unknown>) =>
    request<Record<string, unknown>>('/api/settings/prefs', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  probeProvider: (id: number) =>
    request<{ provider: string; results: ModelProbe[]; default_model: string | null }>(
      `/api/settings/providers/${id}/probe`,
      { method: 'POST' }
    ),
  healthJobs: () => request<{ jobs: JobHealth[]; keep_runs: number }>('/api/health/jobs'),
  selfCheck: () => request<SelfCheck>('/api/health/self'),

  /** 体检报告：/api/health/report */
  healthReport: () => request<HealthReport>('/api/health/report'),

  /** 模型竞技场：同一段 prompt 打到几家 provider。
   *
   *  `models` 空 = 所有已启用的（原行为）；给了就只打这几家——
   *  提示词页的「对打」是**选 2–4 个比一比**，不必每次把全家桶叫起来。 */
  /** 对打：**两段输入**（§8.2 区2「同一输入并排比」）——`system` 是提示词（怎么答），
   *  `prompt` 是这一问（答什么）。`system` 不传 = 老行为（整段当 user 消息）。 */
}
