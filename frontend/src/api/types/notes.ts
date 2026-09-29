// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 notes 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

export interface SearchHit {
  source: 'chat' | 'tutor'
  id: number
  // chat 命中 → conversation_id；tutor 命中 → session_id（教学页深链用）
  ref_id: number
  title: string
  role: string
  excerpt: string
  at: string | null
}

export interface NoteSearchHit {
  path: string
  count: number
  excerpt: string
}

export interface NotesChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/** 语音备忘的一条（那一问的候选）。 */
export interface VoiceNoteItem {
  /** vault 相对路径（`voice/YYYY-MM-DD-HHMM.md`）——挂事与拆点都用它当引用 */
  path: string
  name: string
  title: string
  chars: number
  mtime: number
}

/** 那一问（R2 · PLAN5 §3）：哪几份语音备忘还没回答「这是材料还是工作留痕」。
 *
 *  **拉取式**：只在打开它的时候回答，不催、不计数、不进零柒的提醒来源。
 *  `readable=false` 是「读不到」——**不是**「都归类完了」（§4-8）。 */
export interface VoicePending {
  readable: boolean
  error: string
  /** 还没回答的那几份（回答了就从这里下去） */
  open: VoiceNoteItem[]
  counts: { total: number; material: number; thread: number; open: number }
  rules: { pull: string; material: string; thread: string; state: string }
}
