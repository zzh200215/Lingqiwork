// 方向 6 第二刀（2026-09-29）：从 api.ts 拆出的 backups 域类型；api.ts 做 type-only 转发，全仓导入路径不变。

export interface BackupItem {
  name: string
  size: number
  created_at: string
}

export interface BackupList {
  dir: string
  keep: number
  next_run: string | null
  backups: BackupItem[]
  restore_hint: string
}
