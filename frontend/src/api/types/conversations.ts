// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 conversations 域类型；api.ts 做 type-only 转发，全仓导入路径不变。
import type { ArtifactRef, CollabStep, QualityNote } from '../../stream'

export interface Conversation {
  id: number
  title: string
  model_id: string
  pinned?: boolean
  folder?: string
  created_at: string
  updated_at: string
  messages?: Message[]
}

export interface Message {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  sources?: unknown
  /** 这一轮落盘的产出回执（`save_artifact` 的副产物）。正文在 vault 文件里，
   *  刷新后就是靠它把「已存入产出」那行重建出来的。 */
  artifacts?: ArtifactRef[] | null
  /** W2a 的两条底线校验结论（从回合账本读，不在界面重算）。 */
  quality?: QualityNote | null
  /** A2 的**逐步账**（只有协作那条路有）：刷新之后靠它把那一栏重建出来。
   *  **照抄后端那份事实**——界面不聚合、不自己算总耗时（那会与后端那笔账分叉）。
   *  `null`/缺省 = 那时候没有这笔账（老行、聊天那条路），**不是空账**。 */
  steps?: CollabStep[] | null
  model_id?: string | null
  feedback?: 'up' | 'down' | null
  created_at: string
}
