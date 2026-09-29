// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 common 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

/** One retrieval hit, already carrying the spec the material endpoints accept. */
export interface MaterialHit {
  source: string
  /** "" when the hit is a namespace entry rather than a file */
  spec: string
  title: string
  chunk: number | null
  score: number | null
  text: string
  cards: number
}
