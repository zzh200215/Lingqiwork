import { request } from './request'
import type { ArtifactsResult, ArtifactsStatus } from '../api'
import type { ArtifactRef } from '../stream'

export const outputsApi = {
  artifactsStatus: () => request<ArtifactsStatus>('/api/artifacts/status'),
  runArtifact: (code: string, language: string, timeout?: number) =>
    request<ArtifactsResult>('/api/artifacts/run', {
      method: 'POST',
      body: JSON.stringify({ code, language, timeout }),
    }),
  outputKinds: () =>
    request<{ kinds: { kind: string; label: string; dir: string }[] }>('/api/outputs/kinds'),
  /** 把一条已有回答存成产出。返回回执，调用方把它写回那条消息。 */
  saveOutputFromMessage: (conversationId: number, messageId: number, kind: string, title = '') =>
    request<ArtifactRef>('/api/outputs/from-message', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: conversationId,
        message_id: messageId,
        kind,
        title,
      }),
    }),
  /** 把一段**不在会话里**的 AI 回答存成产出（导师 / 陪伴 / 笔记对话 / 划词助手…）。
   *  同一条工具路径落盘；回执直接返回、由调用方就地展示。 */
  saveOutputFromText: (kind: string, content: string, title = '') =>
    request<ArtifactRef>('/api/outputs/from-text', {
      method: 'POST',
      body: JSON.stringify({ kind, title, content }),
    }),

  // ---------- 零柒：成长 + 能力插件（Track B） ----------
  /** 成长：等级 / 称号 / 累计 EXP / 各来源。只正面呈现。 */
  /** 零柒**此刻**的状态。`idleSec` / `path` 由前端算好传进去——服务端不存它们。 */
}
