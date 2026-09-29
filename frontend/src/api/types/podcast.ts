// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 podcast 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

/** 学习小组圆桌：一次笔谈纪要（mentor / peer / skeptic 串行两轮） */
export interface RoundtableResult {
  topic: string
  turns: { persona: 'mentor' | 'peer' | 'skeptic'; name: string; text: string }[]
  file: string
  at: string
}

export interface PodcastTurn {
  speaker: 'host' | 'guest'
  text: string
}

export interface PodcastEntry {
  id: string
  title: string
  sources: string[]
  turns: number
  duration_sec: number
  file: string
  script: PodcastTurn[]
  created_at: string
  ok?: boolean
}
