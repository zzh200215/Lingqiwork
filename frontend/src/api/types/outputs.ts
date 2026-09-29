// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 outputs 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

export interface ArtifactsStatus {
  enabled: boolean
  timeout: number
  python: string
  node: string | null
  languages: string[]
}

export interface ArtifactsResult {
  ok: boolean
  exit_code: number
  timeout: boolean
  stdout: string
  stderr: string
  elapsed_ms: number
  run_dir?: string
}
