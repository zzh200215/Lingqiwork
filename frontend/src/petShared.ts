// 零柒挂件的共享视图类型与小工具（方向 6 第四刀，2026-09-29 自 PetWidget 拆出）。
// 面板本体在 PetPanel.tsx，挂件编排在本体 PetWidget.tsx。
import type { PetStateMode } from './api'
import type { PetToolReceipt } from './petChat'

// 面板里给「此刻」一个说法。与后端 `pet_state._line()` 分工是刻意的：
// 那边是零柒的**台词**（会说话的只有它，没话说就闭嘴），这里是界面的**事实**——
// 面板是你主动打开看细节的地方，所以 `idle` 也得有字。
export const MODE_LABEL: Record<PetStateMode, string> = {
  idle: '待机',
  focusing: '专注中',
  working: '陪你干活',
  learning: '陪你学',
  reviewing: '陪你过卡',
  celebrating: '刚交出成品',
  gated: '有一步等你点头',
  busy: '有活在跑',
  idling: '你走开了一会儿',
  pupil: '在听你讲',
  resting: '你走开挺久了',
  tired: '有点蔫',
  sleepy: '深夜',
  night_owl: '这几天都熬得晚',
  returning: '好几天没见',
}

// 「你人不在」的那两个模式 → 宠物区降饱和。**只降宠物自己，不动页面**：
// 陪伴不该变成管教，何况你很可能只是切去别的窗口干正事。
export const DIM_MODES: PetStateMode[] = ['idling', 'resting']

export interface PetEvent {
  id: number
  kind: string
  text: string
  detail: string
  created_at: string
}

export interface ChatMsg {
  role: 'user' | 'pet'
  text: string
  /** 这一轮零柒**真的做了什么**（P3）。空 = 它只是回了句话。 */
  tools?: PetToolReceipt[]
}

export function timeLabel(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}
