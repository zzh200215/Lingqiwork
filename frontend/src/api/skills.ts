import { request } from './request'
import type { FormReport, SkillCandidateResult, SkillCandidateRow, SkillCasesPayload, SkillEvalReport, SkillItem, SkillTrials } from '../api'

export const skillsApi = {
  form: () => request<FormReport>('/api/form'),

  listSkills: () => request<{ dir: string; skills: SkillItem[] }>('/api/skills'),
  installSkill: (url: string, name = '', overwrite = false) =>
    request<SkillItem>('/api/skills/install', {
      method: 'POST',
      body: JSON.stringify({ url, name, overwrite }),
    }),
  deleteSkill: (name: string) =>
    request<{ ok: boolean; name: string }>(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  readSkill: (name: string) =>
    request<{ name: string; content: string; raw: string }>(`/api/skills/content?name=${encodeURIComponent(name)}`),
  updateSkill: (name: string, content: string) =>
    request<{ name: string; description: string; chars: number }>(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  /** 能力候选（环一）：读一份材料，看它有没有一套值得反复用的工序；有就落一份
   *  SKILL.md 草稿。`ok=false` 是**正常结论**（读不出来 / 没有工序 / 没配模型），
   *  不是错误——所以这个接口不抛 5xx，理由一律走 `reason` 那一句人话。 */
  makeCandidate: (source_path: string, text: string, overwrite = false, signal?: AbortSignal) =>
    request<SkillCandidateResult>('/api/skills/candidate', {
      method: 'POST',
      body: JSON.stringify({ source_path, text, overwrite }),
      // 传进来就带上：页面上那颗「不等了」据此真的断开这次请求。
      // **注意它只是「不等了」**——一次性 POST 断开之后服务端照样跑完那份调用。
      ...(signal ? { signal } : {}),
    }),
  /** S2：读**一次运行**（连带它那条链的最近几步）→ 判断这段工作里有没有一套工序。
   *
   *  与 `makeCandidate` 同一套纪律与落盘出口；差异只在输入——这里给的是**你自己干过的活**
   *  （题目 + 产出），不是一份材料。**不抛 5xx**：读不到那次运行、没有 provider、
   *  判不出工序，都是 `ok=false` / `usable=false` + 一句理由。 */
  draftFromRun: (run_id: number, overwrite = false) =>
    request<SkillCandidateResult>('/api/skills/draft-from-run', {
      method: 'POST',
      body: JSON.stringify({ run_id, overwrite }),
    }),
  /** 现有技能 + 有没有基线（没基线不许当能力展示，这一处说了算）。 */
  listCandidates: () =>
    request<{
      skills: SkillCandidateRow[]
      measured: boolean
      checks: { name: string; why: string }[]
      fixture_dir: string
      /** S3：试用计数的窗口（每个任务只留最近 N 条运行）——界面必须把它显示出来 */
      trial_window: number
    }>('/api/skills/candidates'),
  /** S3：这份草稿在真实工作里被用过几次（派生自运行日志，零新表）。 */
  skillTrials: (name: string) =>
    request<SkillTrials>(`/api/skills/${encodeURIComponent(name)}/trials`),
  /** 给一份技能存用例（尺子）。**不自动生成**：模型自己出题自己考，考的是它会不会出题。 */
  saveSkillCases: (
    name: string,
    cases: { id?: string; intent?: string; ask: string; checks?: string[] }[]
  ) =>
    request<{ skill: string; cases: number; file: string }>(
      `/api/skills/${encodeURIComponent(name)}/cases`,
      { method: 'POST', body: JSON.stringify({ cases }) }
    ),
  /** 读这份技能的用例 + 断言清单（默认值由后端给，前端不自己拼一份）。 */
  skillCases: (name: string) =>
    request<SkillCasesPayload>(`/api/skills/${encodeURIComponent(name)}/cases`),
  /** 量一遍：每条用例问两次（没它 / 有它）+ `k/n` + Wilson 区间。**会花钱**（报告里有 calls）。 */
  runSkillEval: (name: string, model_id = '') =>
    request<SkillEvalReport>(`/api/skills/${encodeURIComponent(name)}/run`, {
      method: 'POST',
      body: JSON.stringify({ model_id }),
    }),
  /** 请正在跑的那次「量一遍」停下（合作式：每条用例之间生效）。
   *  `stopped: false` = 没有在跑的。 */
  cancelSkillEval: (name: string) =>
    request<{ stopped: boolean }>(`/api/skills/${encodeURIComponent(name)}/run/cancel`, {
      method: 'POST',
    }),

}
