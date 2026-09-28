import { request } from './request'
import type { DashboardBriefing, DashboardStats, NorthStar, ProcessMetrics, SkillLoop, TodayNext, TodaySummaryRow } from '../api'

export const dashboardApi = {
  dashboard: () => request<DashboardStats>('/api/dashboard'),
  dashboardBriefing: () => request<DashboardBriefing>('/api/dashboard/briefing'),
  /** 北极星曲线（PLAN §7）：只画曲线，不设目标、不排名、不进零柒嘴里 */
  northStar: () => request<NorthStar>('/api/dashboard/north-star'),
  /** 过程指标（PLAN §7.2）：半懂率按周。**只进仪表盘**。 */
  process: () => request<ProcessMetrics>('/api/dashboard/process'),
  /** 技能闭环的两条（PLAN3 §6）：试用期漏斗 + 注入命中率。只进仪表盘。 */
  skillLoop: () => request<SkillLoop>('/api/dashboard/skill-loop'),

  visit: (page: string) =>
    request<{ recorded: boolean; page: string; day: string }>('/api/usage/visit', {
      method: 'POST',
      body: JSON.stringify({ page }),
    }),
  /** 功能真实用量（CTO review #6）：model_usage 按操作名聚合，「30 天自用窗口」的读数。 */
  todayNext: () => request<TodayNext>('/api/today/next'),
  /** 今日概览五档：失败任务 / 未消化 / 到期卡 / 卡点 / 进行中产出。空档不返回。 */
  todaySummary: () => request<{ rows: TodaySummaryRow[] }>('/api/today/summary'),

  // ---------- 产出归档（人工出口） ----------
  /** 可选体裁。真值在后端 `mcp._ARTIFACT_KINDS`（决定了落点目录），前端不硬编码。 */
}
