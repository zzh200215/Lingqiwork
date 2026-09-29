// SettingsPage 分片共享件（方向 6 第十一刀，2026-09-29 起）：多个分区卡共用的
// 样式与格式化小件，随分片推进继续往这里收拢。
export const inputCls =
  'w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700'

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function fmtTime(iso: string | null): string {
  return iso ? iso.slice(5, 16).replace('T', ' ') : '—'
}
