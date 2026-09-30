// CompanionPage 分片共享件（方向 6 第二十二刀，2026-09-30 起）：
// 教学/聊天两条对话流共用的形状与小件，随分片推进继续往这里收拢。
import type { PetToolReceipt } from './petChat'

export interface ChatMsg {
  role: 'user' | 'pet'
  text: string
  /** 这一轮零柒真的做了什么（P3）。空 = 它只是回了句话。 */
  tools?: PetToolReceipt[]
}

