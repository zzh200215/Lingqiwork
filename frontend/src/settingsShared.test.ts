// prefsPayload 的钉子（2026-10-02 设置中心·自动保存加固）：
// 自动保存与「临走冲刷」（pagehide 的 keepalive 补发）走同一份清洗——
// 这几条规矩坏任何一条，坏的都会是「存进 config.json 的真相」：
// 时间不合法落回默认、份数夹在界内、字符串去首尾、空模型/尺寸落回默认。
import { describe, expect, it } from 'vitest'
import { prefsPayload, type WorkbenchPrefs } from './settingsShared'

const base: WorkbenchPrefs = {
  system_prompt: '',
  rag_top_k: 5,
  hybrid_search: true,
  rerank_enabled: true,
  full_context: true,
  full_context_max_chars: 4000,
  digest_enabled: false,
  digest_time: '09:00',
  memory_enabled: true,
  automemory_enabled: false,
  memory_tidy_enabled: false,
  memory_tidy_time: '03:30',
  asr_model: 'small',
  asr_language: 'auto',
  tts_voice: 'zh-CN-XiaoxiaoNeural',
  tts_engine: 'edge',
  tts_auto: false,
  podcast_host_voice: 'zh-CN-YunxiNeural',
  podcast_guest_voice: 'zh-CN-XiaoxiaoNeural',
  podcast_daily_enabled: false,
  artifacts_enabled: false,
  artifacts_timeout: 30,
  desktop_notify: true,
  backup_enabled: false,
  backup_time: '03:00',
  backup_keep: 7,
  backup_dir: '',
  backup_removable: false,
  image_enabled: true,
  image_api: 'dashscope',
  image_provider: '',
  image_model: 'qwen-image-3.0',
  image_size: '1024*1024',
  websearch_api: '',
  websearch_api_key: '',
  feeds_enabled: false,
  feeds_time: '08:00',
  smtp_host: '',
  smtp_port: 587,
  smtp_user: '',
  smtp_password: '',
  smtp_from: '',
  smtp_to: '',
  smtp_tls: true,
  email_on_digest: false,
  email_on_feeds: false,
  cards_new_per_day: 20,
  cards_review_per_day: 200,
}

describe('prefsPayload · 自动保存的清洗规矩', () => {
  it('时间不是合法 HH:MM 就落回默认值（定时任务不吃到垃圾字符串）', () => {
    const out = prefsPayload({
      ...base,
      digest_time: '25:99',
      memory_tidy_time: ' 02:05 ',
      backup_time: 'abc',
    })
    expect(out.digest_time).toBe('09:00')
    expect(out.memory_tidy_time).toBe('02:05')
    expect(out.backup_time).toBe('03:00')
  })

  it('数字夹在界内：备份 0/非法落回默认 7、负数收到 1，卡片上限不越过 500', () => {
    const out = prefsPayload({
      ...base,
      backup_keep: 0,
      cards_new_per_day: 9999,
      cards_review_per_day: -5,
    })
    // 0 是 falsy → 落默认 7（原有规矩，不是收 1）；负数才被 max(1,…) 收住
    expect(out.backup_keep).toBe(7)
    expect(prefsPayload({ ...base, backup_keep: -3 }).backup_keep).toBe(1)
    expect(out.cards_new_per_day).toBe(500)
    expect(out.cards_review_per_day).toBe(0)
  })

  it('字符串去首尾；数字字段被填成非数字时落回默认', () => {
    const out = prefsPayload({
      ...base,
      backup_dir: '  D:\\backups  ',
      smtp_host: ' smtp.qq.com ',
      rag_top_k: ('x' as unknown) as number,
      smtp_port: Number.NaN,
    })
    expect(out.backup_dir).toBe('D:\\backups')
    expect(out.smtp_host).toBe('smtp.qq.com')
    expect(out.rag_top_k).toBe(5)
    expect(out.smtp_port).toBe(587)
  })

  it('空的模型名/尺寸落回默认——生成图片不吃到空字符串', () => {
    const out = prefsPayload({ ...base, image_model: '  ', image_size: '' })
    expect(out.image_model).toBe('qwen-image-3.0')
    expect(out.image_size).toBe('1024*1024')
  })
})
