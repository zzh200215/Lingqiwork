import { request } from './request'
import type { DeliverCatalogue, DeliverOutline, DeliverTemplate, DeliverWitness, ScheduledTask, WorkMeeting, WorkOutput } from '../api'

export const workApi = {
  researchSave: (payload: {
    title: string
    sections: { heading: string; body: string }[]
    used: number[]
    sources: { n: number; kind: string; title: string; ref: string }[]
  }) =>
    request<{ filename: string; title: string; chunks: number }>('/api/research/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** 产出（学习闭环的出口跳）：把上次的产出落成 vault/notes/ 里的一篇 md 并进索引 */
  composeSave: (payload: {
    title: string
    sections: { heading: string; body: string }[]
    used: number[]
    sources: { n: number; kind: string; title: string; ref: string }[]
  }) =>
    request<{ filename: string; title: string; chunks: number }>('/api/compose/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** 分析 / 方案：把上一次的方案落成 vault/decisions/ 里的一篇 md 并进索引 */
  decideSave: (payload: {
    title: string
    sections: { heading: string; body: string }[]
    used: number[]
    sources: { n: number; kind: string; title: string; ref: string }[]
  }) =>
    request<{ filename: string; title: string; chunks: number }>('/api/decide/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** 对质：把上一次的报告落成 vault/conflicts/ 里的一篇 md 并进索引 */
  conflictSave: (payload: {
    title: string
    sections: { heading: string; body: string }[]
    used: number[]
    sources: { n: number; kind: string; title: string; ref: string }[]
  }) =>
    request<{ filename: string; title: string; chunks: number }>('/api/conflict/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** 生成质量闭环：一次 👍/👎，挂在 (kind, 提示词版本, 模型) 上 */
  workOutputs: (limit = 200) => request<{ outputs: WorkOutput[] }>(`/api/work/outputs?limit=${limit}`),

  /** 会议闭环（§4-13）的成品：一场一行 */
  workMeetings: (limit = 100) =>
    request<{ meetings: WorkMeeting[] }>(`/api/work/meetings?limit=${limit}`),
  /** `<audio>` 的原声地址。它带不了请求头，靠的是 cookie 鉴权。 */
  installMeetingPreset: () =>
    request<{ created: number; tasks: ScheduledTask[] }>('/api/tasks/preset/meeting', {
      method: 'POST',
    }),
  /** 一键装好工作流：三步链（调研 → 方案 → 汇报稿），每步一个人工卡点。幂等。 */
  installWorkPreset: () =>
    request<{ created: number; tasks: ScheduledTask[] }>('/api/tasks/preset/work', {
      method: 'POST',
    }),
  /** 一键装好语音进料（R2）：`voice/inbox/` + 一个监听它的转写任务。幂等。
   *
   *  丢进 `voice/inbox/` 的录音会变成 `vault/voice/YYYY-MM-DD-HHMM.md`，
   *  **原录音随后被删掉**——这条 preset 只留文本（会议闭环那条留着原声）。 */
  installVoicePreset: () =>
    request<{ created: number; tasks: ScheduledTask[] }>('/api/tasks/preset/voice', {
      method: 'POST',
    }),

  // ---------- 一件事（§4-15） ----------
  deliverGenres: () => request<DeliverCatalogue>('/api/deliver/genres'),
  /** 先出提纲（§8.1 双模的长稿那一模）：**不取材**，只拿话题与体裁×读者问一次结构。
   *  确认之后才带着 `outline` 调 `/api/deliver` 取材成文——取材与成文才是贵的那两段。 */
  deliverOutline: (payload: { topic: string; genre: string; audience: string }) =>
    request<DeliverOutline>('/api/deliver/outline', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // 自定义体裁模板（§8.1 行2）。**它是体裁，不是别的东西**——所以列表那一份并进
  // `/deliver/genres`，这一份只给编辑用（带结构指令）。
  /** 你自己写的体裁模板（含结构指令）。 */
  deliverTemplates: () => request<DeliverTemplate[]>('/api/deliver/templates'),
  deliverTemplateCreate: (payload: { label: string; prompt: string; long: boolean }) =>
    request<DeliverTemplate>('/api/deliver/templates', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  /** 改模板。只改传进来的字段（`undefined` = 不动）。**id 不会变**：`prompt_sha` 按它分版本，
   *  改名不该让质量闭环的历史断裂。 */
  deliverTemplateUpdate: (
    id: string,
    payload: { label?: string; prompt?: string; long?: boolean }
  ) =>
    request<DeliverTemplate>(`/api/deliver/templates/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  /** 删模板。**已经写出去的成品一份都不动**（它们在 vault 里，文件头写的是界面名）。 */
  deliverTemplateDelete: (id: string) =>
    request<{ deleted: string }>(`/api/deliver/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  /** 把上一次的交付落成 vault/deliver/ 里的一篇 md 并进索引。
   *  `genre` / `audience` 会写进文件头（M5）——「这份是给谁写的」存下来才留得住，
   *  交付的事后见证（`deliverWitness`）就是读它。 */
  deliverSave: (payload: {
    title: string
    sections: { heading: string; body: string }[]
    used: number[]
    sources: { n: number; kind: string; title: string; ref: string }[]
    genre?: string
    audience?: string
  }) =>
    request<{ filename: string; title: string; chunks: number }>('/api/deliver/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  /** 交付的事后见证（M5）：到点的一份 + 还有几份在等着（nudge 的第 6 个来源）。 */
  deliverWitness: () => request<DeliverWitness>('/api/deliver/witness'),
  /** GB/T 9704 公文版式 docx 导出。两种给法二选一：`path` = vault 里已落盘的那份
   *  （阅读视图用）；`title+sections` = 生成屏上还没存的。`org` = 红头单位名
   *  （空 = 不加红头——后端不替用户编造机关名）。文件走 blob 下载（同会话导出）。 */
  exportWorkDocx: async (
    body: {
      path?: string
      title?: string
      sections?: { heading: string; body: string }[]
      org?: string
    },
    fileName: string,
  ): Promise<void> => {
    const res = await fetch('/api/work/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`export failed: ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName.endsWith('.docx') ? fileName : `${fileName}.docx`
    a.click()
    URL.revokeObjectURL(url)
  },

  // ---------- 对话式教学 ----------
  /** repo 非空 = 代码库陪读：会话取材限定在该仓库；mode = socratic | feynman。
   * origin_point_id 非空 = 从「材料拆出的点」开场，带上就把它标成已教。
   * prereq_card_id 非空 = 从**那张搁置卡的前置候选**点进来的（PLAN2 §6 回指采纳的分子）。 */
}
