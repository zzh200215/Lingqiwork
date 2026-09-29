// 方向 6 第三刀（2026-09-29）：KBPage 按页签拆分时抽出的共享类型与工具。
// KBPage 本体只留页签栏与组合，各页签组件从这里取格式化函数和公共样式。

/** 五个页签的 key——页签栏与「跳转到对应页签」的快捷入口共用 */
export type KbTab = 'index' | 'repos' | 'dirs' | 'eval' | 'kg'

export interface KbStats {
  chunks: number
  files: number
  watcher: string
  /** 当前切法版本；块元数据里带着它 */
  chunker: number
  /** 用旧切法切出来的块数。不为 0 就说明该重建索引了 */
  stale: number
  /** 当前 embedding 模型名 */
  embed_model: string
  /** 用别的模型 embed 的块数。同一余弦空间里混两个模型，相似度没有意义——必须重建 */
  stale_embed: number
  /** 还没有内容哈希的块数（哈希是后加的）。不为 0 只说明漂移检查覆盖不全 */
  unhashed: number
}

export interface Hit {
  id: string
  text: string
  source: string | null
  title: string | null
  chunk: number | null
  score: number
  channels?: string[]
}

/** 页签栏角标用的计数：各页签加载完把自己的数量报给父级（原来这些列表都住在父组件里） */
export interface KbCounts {
  repos: number
  dirs: number
  eval: number
}

export const pct = (v: number) => `${Math.round(v * 100)}%`

export const fileIcon = (name: string) => {
  const ext = (name.toLowerCase().split('.').pop() || '').trim()
  if (ext === 'pdf') return '📕'
  if (ext === 'md' || ext === 'markdown') return '📝'
  if (ext === 'docx' || ext === 'doc') return '📘'
  if (ext === 'txt') return '📄'
  return '📎'
}

export const fmtSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const fmtTime = (ts: number) => {
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const scoreColor = (s: number) => (s >= 0.7 ? 'bg-emerald-500' : s >= 0.4 ? 'bg-amber-500' : 'bg-neutral-400')

export const hitColor = (v: number) =>
  v >= 0.8
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
    : v >= 0.5
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
      : 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'

/** 各页签表单输入的公共样式 */
export const box = 'rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700'
