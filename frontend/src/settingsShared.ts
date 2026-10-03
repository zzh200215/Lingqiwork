// SettingsPage 分片共享件（方向 6 第十一刀，2026-09-29 起）：多个分区卡共用的
// 样式与格式化小件，随分片推进继续往这里收拢。
//
// 2026-10-02 设置中心改版：inputCls 从「只统一边框」升级成完整的输入控件语言
// （高度 / 底色 / placeholder / focus 边色 / disabled）。底色用 `bg-white` 而不是
// `bg-transparent`——`[data-wb-skin] input.bg-white` 那条覆盖会让输入框跟着皮肤
// 的 field 透明度走；透明底在图片背景上会透出底下的图，字压图读不清。
// 高度仍由 py-1.5 + text-sm 推出（≈34px），不锁死 h-*——textarea 也用同一个类。
export const inputCls =
  'w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 transition-colors focus:border-violet-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-violet-500'

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
    backup_removable: boolean
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

/** 偏好 → PUT 正文。**纯函数**，所以自动保存的「清洗规矩」可以钉在测试里：
 *  时间不是合法 HH:MM 就落回默认值、数字夹在界内、字符串去首尾、
 *  空模型名/尺寸落回默认——离开页面那一发 keepalive 冲刷走的也是同一份清洗，
 *  不能出现「平时保存是一套、临走补存是另一套」。 */
export function prefsPayload(p: WorkbenchPrefs): Record<string, unknown> {
    const time = (v: string, fallback: string) =>
        /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? v.trim() : fallback
    return {
        system_prompt: p.system_prompt,
        rag_top_k: Number(p.rag_top_k) || 5,
        hybrid_search: p.hybrid_search,
        rerank_enabled: p.rerank_enabled,
        full_context: p.full_context,
        full_context_max_chars: Number(p.full_context_max_chars) || 4000,
        digest_enabled: p.digest_enabled,
        digest_time: time(p.digest_time, '09:00'),
        memory_enabled: p.memory_enabled,
        automemory_enabled: p.automemory_enabled,
        memory_tidy_enabled: p.memory_tidy_enabled,
        memory_tidy_time: time(p.memory_tidy_time, '03:30'),
        asr_model: p.asr_model,
        asr_language: p.asr_language,
        tts_voice: p.tts_voice,
        tts_engine: p.tts_engine,
        tts_auto: p.tts_auto,
        podcast_host_voice: p.podcast_host_voice,
        podcast_guest_voice: p.podcast_guest_voice,
        podcast_daily_enabled: p.podcast_daily_enabled,
        artifacts_enabled: p.artifacts_enabled,
        artifacts_timeout: p.artifacts_timeout,
        desktop_notify: p.desktop_notify,
        backup_enabled: p.backup_enabled,
        backup_time: time(p.backup_time, '03:00'),
        backup_keep: Math.max(1, Number(p.backup_keep) || 7),
        backup_dir: p.backup_dir.trim(),
        image_enabled: p.image_enabled,
        image_api: p.image_api,
        image_provider: p.image_provider.trim(),
        image_model: p.image_model.trim() || 'qwen-image-3.0',
        image_size: p.image_size.trim() || '1024*1024',
        websearch_api: p.websearch_api,
        websearch_api_key: p.websearch_api_key.trim(),
        feeds_enabled: p.feeds_enabled,
        feeds_time: time(p.feeds_time, '08:00'),
        smtp_host: p.smtp_host.trim(),
        smtp_port: Number(p.smtp_port) || 587,
        smtp_user: p.smtp_user.trim(),
        smtp_password: p.smtp_password,
        smtp_from: p.smtp_from.trim(),
        smtp_to: p.smtp_to.trim(),
        smtp_tls: p.smtp_tls,
        email_on_digest: p.email_on_digest,
        email_on_feeds: p.email_on_feeds,
        cards_new_per_day: Math.max(0, Math.min(500, Number(p.cards_new_per_day) || 0)),
        cards_review_per_day: Math.max(0, Math.min(500, Number(p.cards_review_per_day) || 0)),
    }
}
