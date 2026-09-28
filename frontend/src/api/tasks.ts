import { request } from './request'
import type { DispatchBoard, ScheduledTask, TaskRunItem, TaskRunResult, TaskTool } from '../api'

export const tasksApi = {
  listTasks: () => request<ScheduledTask[]>('/api/tasks'),
  createTask: (t: Partial<ScheduledTask>) =>
    request<ScheduledTask>('/api/tasks', { method: 'POST', body: JSON.stringify(t) }),
  updateTask: (id: number, t: Partial<ScheduledTask>) =>
    request<ScheduledTask>(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(t) }),
  deleteTask: (id: number) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' }),
  /** 手动跑一次任务。`topic` 是运行期题目覆盖——工作流第一步靠它接住你输入的题目，
   *  不改掉 preset 模板（后端 RunIn）。不给就发空串，省掉无 body 的边界情况。
   *  `thread`（M2）：这次在处理哪件「事」——后端按这个名字复用或新建一条，这一步的
   *  成品就挂到它上面（下游自动继承）。 */
  runTask: (id: number, topic = '', thread = '') =>
    request<TaskRunResult>(`/api/tasks/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ topic, thread }),
    }),
  /** 人工卡点（§4-12）：放行——这一步的产出交给下游任务 */
  approveRun: (runId: number) =>
    request<{ ok: boolean; approved: boolean; next_task_id: number | null }>(
      `/api/tasks/runs/${runId}/approve`,
      { method: 'POST' }
    ),
  /** 人工卡点（§4-12）：驳回——流程到此为止（产出留着，由你处置） */
  rejectRun: (runId: number) =>
    request<{ ok: boolean; approved: boolean; next_task_id: number | null }>(
      `/api/tasks/runs/${runId}/reject`,
      { method: 'POST' }
    ),
  listTaskTools: () => request<TaskTool[]>('/api/tasks/tools'),
  listTaskRuns: (id: number) => request<TaskRunItem[]>(`/api/tasks/${id}/runs`),
  /** **一批任务各自的最近一次运行**——工作页顶那块「最近几次运行」要的就是这个。
   *
   *  原来它是 `t.slice(0, 8).map(t => listTaskRuns(t.id))`：**8 个并发请求换 8 条数据**，
   *  而且每次切回那一档都重来一遍。返回按 task_id 分组（JSON 的键是字符串）；
   *  **没跑过的任务不出现**在结果里——那不叫「跑了但没记录」，叫「没跑过」。 */
  recentTaskRuns: (ids: number[]) =>
    request<Record<string, TaskRunItem>>(`/api/tasks/recent-runs?ids=${ids.join(',')}`),
  /** **一批任务各自的最近 n 条运行**（`n>1` 时后端返回的是数组、新在前）。
   *
   *  工作流清单每行的「最近运行结果条」（Buildkite 式：颜色=结果、高度=耗时）要的
   *  就是这个小历史——展开行才能看到的 20 条它不背，每行扫一眼要的只是最近这几条。
   *  同一个端点：`n` 缺省 1 时返回的是单条（`recentTaskRuns`），形状不动。 */
  recentTaskRunBatches: (ids: number[], n = 10) =>
    request<Record<string, TaskRunItem[]>>(`/api/tasks/recent-runs?ids=${ids.join(',')}&n=${n}`),
  /** 外部事件起一次运行（webhook 触发器，2026-09-26）。`dedupe_seconds > 0`：
   *  窗口内已起过一趟就直接返回那一趟（幂等，不烧两次钱）。 */
  triggerTask: (id: number, body?: { topic?: string; dedupe_seconds?: number }) =>
    request<{ status: string; run?: TaskRunItem }>(`/api/tasks/${id}/trigger`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),
  /** Q4 调度台：确定性编排的看板（状态全部由后端从 tasks/task_runs 算出来） */
  dispatch: (limit = 20) => request<DispatchBoard>(`/api/dispatch?limit=${limit}`),
  parseTask: (text: string) =>
    request<{ cron: string; name: string; prompt: string }>('/api/tasks/parse', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

}
