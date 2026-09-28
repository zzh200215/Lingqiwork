import { request } from './request'
import type { InterviewBank, InterviewReportResult, SessionCalibration, TutorConceptRow, TutorDetail, TutorDigestResult, TutorEndResult, TutorJudgeResult } from '../api'
import type { TutorLearningMap, TutorMastery, TutorNeighbor, TutorProfile, TutorSessionRow, TutorSessionStart, TutorStarter, TutorStats } from '../api'
import type { TutorStuckRow } from '../api'

export const tutorApi = {
  tutorStart: (
    topic: string,
    repo?: string,
    mode?: 'socratic' | 'feynman' | 'future' | 'interview',
    origin_point_id?: number,
    prereq_card_id?: number,
  ) =>
    request<TutorSessionStart>('/api/tutor/start', {
      method: 'POST',
      body: JSON.stringify({
        topic,
        repo: repo || '',
        mode: mode || 'socratic',
        origin_point_id: origin_point_id || null,
        prereq_card_id: prereq_card_id || null,
      }),
    }),
  /** 懂了 / 半懂 / 没用 — the only manual input in the product */
  tutorEnd: (session_id: number, verdict: 'got' | 'half' | 'useless') =>
    request<TutorEndResult>('/api/tutor/end', {
      method: 'POST',
      body: JSON.stringify({ session_id, verdict }),
    }),
  /** M1 场景 B：「我来讲 · 让它判」——它读完整场对话给一档，**走同一条 `end()`**
   *  （概念/卡点照常回写，「又卡住」那条链路一行都没改）。
   *  `judged=false` 时什么都没动：退回你自己标一档，**不编分**。 */
  tutorJudge: (session_id: number, model_id = '') =>
    request<TutorJudgeResult>(`/api/tutor/sessions/${session_id}/judge`, {
      method: 'POST',
      body: JSON.stringify({ model_id }),
    }),
  /** M3 面试陪练：题库（只读）与散场报告。报告落 `vault/reports/`，题库文件不动。 */
  interviewBank: () => request<InterviewBank>('/api/interview/bank'),
  interviewReport: (session_id: number, model_id = '') =>
    request<InterviewReportResult>(`/api/interview/${session_id}/report`, {
      method: 'POST',
      body: JSON.stringify({ model_id }),
    }),
  tutorSessions: (limit = 50) =>
    request<{ sessions: TutorSessionRow[] }>(`/api/tutor/sessions?limit=${limit}`),
  // 全量卡点：右栏会话列表只取 50 条，第 52 次记的卡点不能跟着消失
  tutorProfile: () =>
    request<TutorProfile>('/api/tutor/profile'),
  tutorStuck: (limit = 200) =>
    request<{ stuck: TutorStuckRow[] }>(`/api/tutor/stuck?limit=${limit}`),
  tutorConcepts: () => request<{ concepts: TutorConceptRow[] }>('/api/tutor/concepts'),
  /** 「又卡住」的那几个概念：接住过卡在哪、最近一次还是半懂、就在这几天。
   *  **与零柒那句台词同一个判据**（后端 `tutor.is_recurring_mistake`）——界面和它说的
   *  必须是同一批，否则「它凭什么这么说」就查不到了。 */
  tutorRecurring: (days = 7) =>
    request<{ recurring: TutorConceptRow[] }>(`/api/tutor/recurring?days=${days}`),
  /** 把两个概念并成一个（**人工**，Q3.5）。
   *
   *  机器自己只在有量出来的余量的地方并（相似度 0.80，尺子在 `backend/smoke_concept.py`：
   *  零误并、余量 +0.10）；**同领域的相邻概念它分不开**，只能由你指认。
   *  只改 concept 与 aliases 两列，可复算。 */
  mergeConcepts: (source: string, into: string) =>
    request<{ from: string; into: string; moved: number }>('/api/tutor/concepts/merge', {
      method: 'POST',
      body: JSON.stringify({ source, into }),
    }),
  /** 学习地图：已掌握 / 在学 / 卡住 / 未触及 四档（前三档纯派生，第四档读建议日志）。 */
  tutorMap: () => request<TutorLearningMap>('/api/tutor/map'),
  /** 会话侧校准（PLAN2 P2-3）：自己标的 vs 让它判的。**只进仪表盘**。 */
  tutorCalibration: (days = 90) =>
    request<SessionCalibration>(`/api/tutor/calibration?days=${days}`),
  /** 成长事件：概念「学会了」的时刻（零柒成长面板的原料）。纯派生。 */
  tutorMastery: () => request<TutorMastery>('/api/tutor/mastery'),
  /** 一个概念的「邻居」（同一件事 / 同一份材料 / 语义相近）。纯派生。 */
  tutorNeighbors: (concept: string, limit = 6) =>
    request<{ neighbors: TutorNeighbor[] }>(
      `/api/tutor/neighbors?concept=${encodeURIComponent(concept)}&limit=${limit}`
    ),
  /** 一份材料 → 「要搞懂的点」。逐点去搞懂走 tutorStart（话题就是那个点）。 */
  tutorDigest: (body: { source_path?: string; text?: string }) =>
    request<TutorDigestResult>('/api/tutor/digest', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 手动把一条卡点标成已解 / 待解。主要出口是自动回写（同一概念后来说通了）。 */
  tutorResolveStuck: (session_id: number, resolved = true) =>
    request<{ id: number; resolved: boolean }>(`/api/tutor/stuck/${session_id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolved }),
    }),
  tutorStarters: () => request<{ starters: TutorStarter[] }>('/api/tutor/starters'),
  tutorSession: (id: number) => request<TutorDetail>(`/api/tutor/sessions/${id}`),
  tutorStats: (days = 14) => request<TutorStats>(`/api/tutor/stats?days=${days}`),
}
