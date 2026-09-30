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

/** 偏好设置的前端形状（refresh() 把 GET /api/settings/prefs 规整成这个对象）。
 *  状态住在 SettingsPage（general 大卡还在本体），各分区偏好卡经 props 共享编辑；
 *  第十五刀起从 SettingsPage 的内联 useState 泛型提升到这里，供四个分区卡文件引用。 */
export type WorkbenchPrefs = {
    system_prompt: string
    rag_top_k: number
    hybrid_search: boolean
    rerank_enabled: boolean
    full_context: boolean
    full_context_max_chars: number
    digest_enabled: boolean
    digest_time: string
    memory_enabled: boolean
    automemory_enabled: boolean
    memory_tidy_enabled: boolean
    memory_tidy_time: string
    asr_model: string
    asr_language: string
    tts_voice: string
    tts_engine: string
    tts_auto: boolean
    podcast_host_voice: string
    podcast_guest_voice: string
    podcast_daily_enabled: boolean
    artifacts_enabled: boolean
    artifacts_timeout: number
    desktop_notify: boolean
    backup_enabled: boolean
    backup_time: string
    backup_keep: number
    backup_dir: string
    image_enabled: boolean
    image_api: string
    image_provider: string
    image_model: string
    image_size: string
    websearch_api: string
    websearch_api_key: string
    feeds_enabled: boolean
    feeds_time: string
    smtp_host: string
    smtp_port: number
    smtp_user: string
    smtp_password: string
    smtp_from: string
    smtp_to: string
    smtp_tls: boolean
    email_on_digest: boolean
    email_on_feeds: boolean
    cards_new_per_day: number
    cards_review_per_day: number
}
