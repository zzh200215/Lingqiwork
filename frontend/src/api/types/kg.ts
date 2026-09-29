// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 kg 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

export interface KgStatus {
  enabled: boolean
  uri: string
  user: string
  password_set: boolean
  ok?: boolean
  files?: number
  entities?: number
  relations?: number
  error?: string
}

export interface KgRetrieval {
  entities: { name: string; description: string; score: number }[]
  relations: { src: string; type: string; dst: string; description: string }[]
}
