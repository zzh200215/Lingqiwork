import { request } from './request'
import type { PromptCaseSpec, PromptCategoryItem, PromptCheckReport, PromptFacets, PromptInlineNote, PromptItem, PromptRegistryEntry, PromptRegistryEntryDetail } from '../api'
import type { PromptUsageItem, PromptVarsResult, PromptVersionItem } from '../api'

export const promptsApi = {
  listPrompts: (opts?: { q?: string; category?: string; favorite?: boolean }) => {
    const p = new URLSearchParams()
    if (opts?.q) p.set('q', opts.q)
    if (opts?.category) p.set('category', opts.category)
    if (opts?.favorite) p.set('favorite', 'true')
    const qs = p.toString()
    return request<PromptItem[]>(`/api/prompts${qs ? `?${qs}` : ''}`)
  },
  createPrompt: (p: Partial<PromptItem> & { title: string; content: string }) =>
    request<PromptItem>('/api/prompts', { method: 'POST', body: JSON.stringify(p) }),
  updatePrompt: (id: number, p: Partial<PromptItem>) =>
    request<PromptItem>(`/api/prompts/${id}`, { method: 'PUT', body: JSON.stringify(p) }),
  deletePrompt: (id: number) => request<{ ok: boolean }>(`/api/prompts/${id}`, { method: 'DELETE' }),
  /** 分类与标签清单——**从库里算出来**，不另养一份配置 */
  promptFacets: () => request<PromptFacets>('/api/prompts/facets'),
  /** 记一次使用（复制走 / 填完变量发出去时调）。`vars` 是这次填的值，下次复用不必重填。 */
  usePrompt: (id: number, vars: Record<string, string> = {}) =>
    request<{ ok: boolean; used_count: number }>(`/api/prompts/${id}/use`, {
      method: 'POST',
      body: JSON.stringify({ vars }),
    }),
  promptVersions: (id: number) => request<PromptVersionItem[]>(`/api/prompts/${id}/versions`),
  restorePromptVersion: (id: number, versionId: number) =>
    request<PromptItem>(`/api/prompts/${id}/versions/${versionId}/restore`, { method: 'POST' }),
  /** 使用历史。**记了就要能看**——只记不读的那份账换不来任何判断。 */
  promptUsages: (id: number, limit = 50) =>
    request<PromptUsageItem[]>(`/api/prompts/${id}/usages?limit=${limit}`),
  /** 分类表 + 各自几条。改名会**连条目一起搬**；删分类只把条目退回「未分类」。 */
  promptCategories: () => request<PromptCategoryItem[]>('/api/prompts/categories'),
  createPromptCategory: (name: string, color = '') =>
    request<PromptCategoryItem>('/api/prompts/categories', {
      method: 'POST',
      body: JSON.stringify({ name, color }),
    }),
  updatePromptCategory: (
    id: number,
    patch: { name?: string; color?: string; position?: number }
  ) =>
    request<PromptCategoryItem>(`/api/prompts/categories/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deletePromptCategory: (id: number) =>
    request<{ ok: boolean; uncategorized: number }>(`/api/prompts/categories/${id}`, {
      method: 'DELETE',
    }),
  /** 导出成文件。**「拿去其他项目」全靠它。** */
  exportPrompts: async (format: 'json' | 'csv'): Promise<void> => {
    const res = await fetch(`/api/prompts/export?format=${format}`)
    if (!res.ok) throw new Error(`export failed: ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `prompts.${format}`
    a.click()
    URL.revokeObjectURL(url)
  },
  importPrompts: (prompts: Array<Partial<PromptItem> & { title: string; content: string }>) =>
    request<{ added: string[]; skipped: string[] }>('/api/prompts/import', {
      method: 'POST',
      body: JSON.stringify({ prompts }),
    }),

  // AI 三条（只产出文本，**不落库**——写不写进库是你的决定）
  //
  // 三个都收 `signal`：页面上那颗「不等了」据此真的断开请求。**它不是「停止」**——
  // 一次性 POST 断开之后服务端照样跑完那次模型调用。
  promptAiGenerate: (idea: string, signal?: AbortSignal) =>
    request<{ title: string; content: string }>('/api/prompts/ai/generate', {
      method: 'POST',
      body: JSON.stringify({ idea }),
      ...(signal ? { signal } : {}),
    }),
  promptAiRefine: (content: string, instruction: string, signal?: AbortSignal) =>
    request<{ content: string }>('/api/prompts/ai/refine', {
      method: 'POST',
      body: JSON.stringify({ content, instruction }),
      ...(signal ? { signal } : {}),
    }),
  promptAiVars: (content: string, signal?: AbortSignal) =>
    request<PromptVarsResult>('/api/prompts/ai/vars', {
      method: 'POST',
      body: JSON.stringify({ content }),
      ...(signal ? { signal } : {}),
    }),

  // ---------- 提示词登记表 + 对照台（Q1）----------
  //
  // 与上面那三个是**两个东西**：上面是用户的片段库（`Prompt` 表），这里是系统提示词的
  // 登记表（`core/prompts.py::_SPECS`，32 条，有 sha 指纹）。**没有"改"这个动作**——
  // 内容活在源码里，这里只读、只跑对照。
  promptRegistry: () =>
    request<{ prompts: PromptRegistryEntry[]; inline: PromptInlineNote[] }>(
      '/api/prompts/registry'
    ),
  promptEntry: (key: string) =>
    request<PromptRegistryEntryDetail>(`/api/prompts/registry/${encodeURIComponent(key)}`),
  checkPrompt: (key: string, body: { variant?: string; variant_label?: string; model_id?: string }) =>
    request<PromptCheckReport>(`/api/prompts/registry/${encodeURIComponent(key)}/check`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 请正在跑的那次对照停下。**合作式**：每条用例之间生效，所以当前那条会跑完才停
   *  ——界面上因此写「正在停…（这一条跑完就停）」，不写「已停止」。
   *  `stopped: false` = 没有在跑的（如实说，不假装停成功）。 */
  cancelPromptCheck: (key: string) =>
    request<{ stopped: boolean }>(
      `/api/prompts/registry/${encodeURIComponent(key)}/check/cancel`,
      { method: 'POST' }
    ),
  /** 喂一条用例进金标集（**写的是 `backend/evals/prompts/*.json`**，不是提示词）。 */
  addPromptCase: (
    key: string,
    body: { user: string; intent: string; checks: string[]; id?: string }
  ) =>
    request<PromptCaseSpec>(`/api/prompts/registry/${encodeURIComponent(key)}/cases`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removePromptCase: (key: string, caseId: string) =>
    request<{ key: string; removed: string; left: number }>(
      `/api/prompts/registry/${encodeURIComponent(key)}/cases/${encodeURIComponent(caseId)}`,
      { method: 'DELETE' }
    ),
  /** 给一套 golden set 标一个领域（Q3 形态的分组键；写的是用例文件，不是提示词）。 */
  setPromptDomain: (key: string, domain: string) =>
    request<{ key: string; domain: string }>(
      `/api/prompts/registry/${encodeURIComponent(key)}/domain`,
      { method: 'POST', body: JSON.stringify({ domain }) }
    ),

  // ---------- 形态（Q3）----------
  /** 全部领域 + 各自的三个数（只读）。小屋只要长出来的，工作页要全部。 */
}
