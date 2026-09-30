import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Brain,
  Coins,
  Settings,
} from 'lucide-react'
import { api, type CostSummary, type ModelProbe, type ProviderConfig } from './api'
import { inputCls, type WorkbenchPrefs } from './settingsShared'
import SettingsTasks from './SettingsTasks'
import SettingsAgents from './SettingsAgents'
import SettingsEval from './SettingsEval'
import SettingsMcp from './SettingsMcp'
import SettingsContent from './SettingsContent'
import SettingsData from './SettingsData'
import SettingsAutomationPrefs from './SettingsAutomationPrefs'
import SettingsWebsearch from './SettingsWebsearch'
import SettingsPrompts from './SettingsPrompts'
import SettingsSkills from './SettingsSkills'
import { SETTING_SECTIONS, type SettingSection } from './routes'


const EMPTY = { name: '', kind: 'openai' as 'openai' | 'anthropic', base_url: '', api_key: '', models: '', enabled: true }


// 分区清单（通用 / 模型 / 智能体 / 自动化 / 内容生成 / 数据 / MCP）**搬到 `routes.tsx` 了**：
// 侧栏要摆它、这一页要按它切，两处各写一份的那天就会出现「侧栏七项、页面里六项」。
// 2026-09-18 导航改版：页面里那个左侧竖排也删了，当前分区由 `?section=` 驱动。

export default function SettingsPage() {
  const [searchParams] = useSearchParams()
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [probes, setProbes] = useState<Record<number, ModelProbe[]>>({})
  const [probing, setProbing] = useState<number | null>(null)
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [draft, setDraft] = useState({ ...EMPTY })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [error, setError] = useState('')
  /** **取数失败**（不是「你填错了」）。这一页挂载时并发拉十几样东西，各自 catch——
   *  原来全是 `.catch(() => {})`，于是拉不到就摆一个空区，看起来像「你还没配」。
   *  「读不到」与「没有」是两件事（工作页那条纪律，这一页此前没跟上）。
   *
   *  存**列表**而不是一个字符串：11 个请求可能一起挂，合成一句话才看得清。 */
  const [loadErrs, setLoadErrs] = useState<string[]>([])
  /** 一条取数失败记下来（**去重**：同一件事只记一次，重试成功也不会留陈旧的）。
   *  `what` 是给人看的名字（「记忆」「备份」…），`e` 是抛出来的东西。 */
  const failLoad = useCallback((what: string, e: unknown) => {
    const raw = e instanceof Error ? e.message : String(e)
    // 后端那句人话在 `503: {"detail":"…"}` 里——与 `workData.humanErr` 同一条规矩
    const m = raw.match(/\{"detail":"([\s\S]*?)"\}/)
    let msg = raw
    if (m) {
      try {
        msg = JSON.parse(`"${m[1]}"`) as string
      } catch {
        msg = m[1]
      }
    }
    const line = `${what}：${msg}`
    setLoadErrs((cur) => (cur.includes(line) ? cur : [...cur, line]))
  }, [])

  const [prefs, setPrefs] = useState<WorkbenchPrefs | null>(null)
  const [prefsSaved, setPrefsSaved] = useState(false)

  const [ttsVoices, setTtsVoices] = useState<string[]>([])


  const refresh = useCallback(async () => {
    try {
      setProviders(await api.listProviders())
      const p = await fetch('/api/settings/prefs').then((r) => r.json())
      setPrefs({
        system_prompt: p.system_prompt || '',
        rag_top_k: p.rag_top_k ?? 5,
        hybrid_search: p.hybrid_search ?? true,
        rerank_enabled: p.rerank_enabled ?? true,
        full_context: p.full_context ?? true,
        full_context_max_chars: p.full_context_max_chars ?? 4000,
        digest_enabled: p.digest_enabled ?? false,
        digest_time: p.digest_time || '09:00',
        memory_enabled: p.memory_enabled ?? true,
        automemory_enabled: p.automemory_enabled ?? false,
        memory_tidy_enabled: p.memory_tidy_enabled ?? false,
        memory_tidy_time: p.memory_tidy_time || '03:30',
        asr_model: p.asr_model || 'small',
        asr_language: p.asr_language || 'auto',
        tts_voice: p.tts_voice || 'zh-CN-XiaoxiaoNeural',
        tts_engine: p.tts_engine || 'edge',
        tts_auto: p.tts_auto ?? false,
        podcast_host_voice: p.podcast_host_voice || 'zh-CN-YunxiNeural',
        podcast_guest_voice: p.podcast_guest_voice || 'zh-CN-XiaoxiaoNeural',
        podcast_daily_enabled: p.podcast_daily_enabled ?? false,
        artifacts_enabled: p.artifacts_enabled ?? false,
        artifacts_timeout: p.artifacts_timeout ?? 30,
        desktop_notify: p.desktop_notify ?? true,
        backup_enabled: p.backup_enabled ?? false,
        backup_time: p.backup_time || '03:00',
        backup_keep: p.backup_keep ?? 7,
        backup_dir: p.backup_dir || '',
        image_enabled: p.image_enabled ?? true,
        image_api: p.image_api || 'dashscope',
        image_provider: p.image_provider || '',
        image_model: p.image_model || 'qwen-image-3.0',
        image_size: p.image_size || '1024*1024',
        websearch_api: p.websearch_api || '',
        websearch_api_key: p.websearch_api_key || '',
        feeds_enabled: p.feeds_enabled ?? false,
        feeds_time: p.feeds_time || '08:00',
        smtp_host: p.smtp_host || '',
        smtp_port: p.smtp_port ?? 587,
        smtp_user: p.smtp_user || '',
        smtp_password: p.smtp_password || '',
        smtp_from: p.smtp_from || '',
        smtp_to: p.smtp_to || '',
        smtp_tls: p.smtp_tls ?? true,
        email_on_digest: p.email_on_digest ?? false,
        email_on_feeds: p.email_on_feeds ?? false,
        cards_new_per_day: p.cards_new_per_day ?? 20,
        cards_review_per_day: p.cards_review_per_day ?? 200,
      })
      // 这一批是**并发拉、各自坏**的取数。原来全是 `.catch(() => {})`——拉不到就摆一个空区，
      // 看起来像「你还没配」。现在每一样都报自己的名字，页级失败条汇总。
      api.ttsVoices().then((r) => setTtsVoices(r.voices)).catch((e) => failLoad('音色', e))
    } catch (e) {
      setError(String(e))
    }
  }, [failLoad])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function savePrefs() {
    if (!prefs) return
    await fetch('/api/settings/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_prompt: prefs.system_prompt,
        rag_top_k: Number(prefs.rag_top_k) || 5,
        hybrid_search: prefs.hybrid_search,
        rerank_enabled: prefs.rerank_enabled,
        full_context: prefs.full_context,
        full_context_max_chars: Number(prefs.full_context_max_chars) || 4000,
        digest_enabled: prefs.digest_enabled,
        digest_time: /^([01]?\d|2[0-3]):[0-5]\d$/.test(prefs.digest_time.trim())
          ? prefs.digest_time.trim()
          : '09:00',
        memory_enabled: prefs.memory_enabled,
        automemory_enabled: prefs.automemory_enabled,
        memory_tidy_enabled: prefs.memory_tidy_enabled,
        memory_tidy_time: /^([01]?\d|2[0-3]):[0-5]\d$/.test(prefs.memory_tidy_time.trim())
          ? prefs.memory_tidy_time.trim()
          : '03:30',
        asr_model: prefs.asr_model,
        asr_language: prefs.asr_language,
        tts_voice: prefs.tts_voice,
        tts_engine: prefs.tts_engine,
        tts_auto: prefs.tts_auto,
        podcast_host_voice: prefs.podcast_host_voice,
        podcast_guest_voice: prefs.podcast_guest_voice,
        podcast_daily_enabled: prefs.podcast_daily_enabled,
        artifacts_enabled: prefs.artifacts_enabled,
        artifacts_timeout: prefs.artifacts_timeout,
        desktop_notify: prefs.desktop_notify,
        backup_enabled: prefs.backup_enabled,
        backup_time: /^([01]?\d|2[0-3]):[0-5]\d$/.test(prefs.backup_time.trim())
          ? prefs.backup_time.trim()
          : '03:00',
        backup_keep: Math.max(1, Number(prefs.backup_keep) || 7),
        backup_dir: prefs.backup_dir.trim(),
        image_enabled: prefs.image_enabled,
        image_api: prefs.image_api,
        image_provider: prefs.image_provider.trim(),
        image_model: prefs.image_model.trim() || 'qwen-image-3.0',
        image_size: prefs.image_size.trim() || '1024*1024',
        websearch_api: prefs.websearch_api,
        websearch_api_key: prefs.websearch_api_key.trim(),
        feeds_enabled: prefs.feeds_enabled,
        feeds_time: /^([01]?\d|2[0-3]):[0-5]\d$/.test(prefs.feeds_time.trim())
          ? prefs.feeds_time.trim()
          : '08:00',
        smtp_host: prefs.smtp_host.trim(),
        smtp_port: Number(prefs.smtp_port) || 587,
        smtp_user: prefs.smtp_user.trim(),
        smtp_password: prefs.smtp_password,
        smtp_from: prefs.smtp_from.trim(),
        smtp_to: prefs.smtp_to.trim(),
        smtp_tls: prefs.smtp_tls,
        email_on_digest: prefs.email_on_digest,
        email_on_feeds: prefs.email_on_feeds,
        cards_new_per_day: Math.max(0, Math.min(500, Number(prefs.cards_new_per_day) || 0)),
        cards_review_per_day: Math.max(0, Math.min(500, Number(prefs.cards_review_per_day) || 0)),
      }),
    })
    setPrefsSaved(true)
    setTimeout(() => setPrefsSaved(false), 1500)
  }

  // ---- provider CRUD ----

  async function save() {
    if (!draft.name.trim()) {
      setError('名称必填')
      return
    }
    const payload = {
      name: draft.name.trim(),
      kind: draft.kind,
      base_url: draft.base_url.trim(),
      api_key: draft.api_key.trim(),
      models: draft.models
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
      enabled: draft.enabled,
    }
    try {
      if (editingId) await api.updateProvider(editingId, payload)
      else await api.createProvider(payload)
      setDraft({ ...EMPTY })
      setEditingId(null)
      setError('')
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  async function remove(id: number) {
    if (!confirm('删除该 provider？')) return
    await api.deleteProvider(id)
    await refresh()
  }

  // 模型可用性探测：模型顺序决定所有自动化功能用哪一个，探测结果会让
  // default_model_id() 自动跳过打不通的那些。名字避开已有的 MCP `probe` state
  async function runProbe(id: number) {
    setProbing(id)
    setError('')
    try {
      const r = await api.probeProvider(id)
      setProbes((p) => ({ ...p, [id]: r.results }))
      setDefaultModel(r.default_model)
    } catch (e) {
      setError(String(e))
    } finally {
      setProbing(null)
    }
  }

  function startEdit(p: ProviderConfig) {
    setEditingId(p.id)
    setDraft({
      name: p.name,
      kind: p.kind,
      base_url: p.base_url,
      api_key: '',
      models: p.models.join(', '),
      enabled: p.enabled,
    })
  }

  // 当前分区由 URL 决定（侧栏是唯一入口）：`/settings?section=models`。
  // 没写或写了个不认识的词 → 「通用」，与侧栏 `navState` 的默认一致。
  const sectionParam = searchParams.get('section')
  const section: SettingSection =
    SETTING_SECTIONS.find((s) => s.key === sectionParam)?.key ?? 'general'

  // 用量与成本：以前只有聊天与定时任务记账，其余路径一点都看不见
  const [cost, setCost] = useState<CostSummary | null>(null)

  useEffect(() => {
    if (section !== 'models' || cost) return
    api.costSummary(30).then(setCost).catch((e) => failLoad('用量与成本', e))
  }, [section, cost])


  return (
    <>
      <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">设置</h1>
      </div>

      {/* 左侧那排分区（通用/模型/…/MCP）**搬到侧栏**了（2026-09-18 导航改版）：
          同一件事不留两个入口。当前分区仍然走 `?section=`，旧书签照用。
          版面因此从「页内两栏」变成整幅——所以下面那层 flex 一起去掉。 */}
      <main className="min-w-0">
      {/* 页级取数失败条（**不按分区门控**：这一页挂载时拉十几样东西，
          任何一样挂了都该说一句，而不是在别的分区里悄悄摆一个空区）。
          「读不到」与「没有」是两件事——这一页此前把前者讲成了后者。 */}
      {loadErrs.length ? (
        <div
          data-settings-err
          className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 dark:border-rose-900 dark:bg-rose-950/40"
        >
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 text-sm text-rose-700 dark:text-rose-300">
              有 {loadErrs.length} 样没读出来 —— 下面那些区里空着的地方，可能是这个原因：
            </span>
            <button
              onClick={() => setLoadErrs([])}
              className="shrink-0 text-xs text-rose-500 underline hover:text-rose-700 dark:hover:text-rose-200"
            >
              知道了
            </button>
          </div>
          <ul className="mt-1 space-y-0.5">
            {loadErrs.map((e) => (
              <li key={e} className="break-words text-xs text-rose-600 dark:text-rose-400">
                {e}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {/* General preferences */}
      {section === 'general' && !prefs && (
        <p className="py-8 text-sm text-neutral-400">加载中…</p>
      )}
      {section === 'general' && prefs && (
        <section className="mb-6 wb-card p-5">
          <h2 className="mb-4 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300"><Settings className="h-3.5 w-3.5" /></span></h2>
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              系统提示词（每次对话都会作为 system 消息注入）
              <textarea
                value={prefs.system_prompt}
                onChange={(e) => setPrefs({ ...prefs, system_prompt: e.target.value })}
                rows={3}
                placeholder="例如：你是一个简洁的中文助手，回答尽量给出要点式结构。"
                className={`${inputCls} resize-y`}
              />
            </label>
            <label className="flex w-48 flex-col gap-1 text-sm">
              RAG 检索片段数 (top_k)
              <input
                type="number"
                min={1}
                max={20}
                value={prefs.rag_top_k}
                onChange={(e) => setPrefs({ ...prefs, rag_top_k: Number(e.target.value) })}
                className={inputCls}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.hybrid_search}
                onChange={(e) => setPrefs({ ...prefs, hybrid_search: e.target.checked })}
              />
              混合检索（BM25 关键词 + 向量语义，RRF 融合；关闭则仅向量检索）
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.rerank_enabled}
                onChange={(e) => setPrefs({ ...prefs, rerank_enabled: e.target.checked })}
              />
              Rerank 精排（bge-reranker-base 交叉编码器重排序，更准但检索稍慢；本地模型已缓存）
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.full_context}
                onChange={(e) => setPrefs({ ...prefs, full_context: e.target.checked })}
              />
              全上下文模式（命中的短文档整篇注入，不只给切块片段）
            </label>
            {prefs.full_context && (
              <label className="ml-6 flex items-center gap-2 text-sm">
                <span className="shrink-0 text-neutral-500">整篇注入上限（字符）</span>
                <input
                  type="number"
                  min={500}
                  max={20000}
                  step={500}
                  value={prefs.full_context_max_chars}
                  onChange={(e) =>
                    setPrefs({ ...prefs, full_context_max_chars: Number(e.target.value) })
                  }
                  className={`${inputCls} max-w-[120px]`}
                />
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.memory_enabled}
                onChange={(e) => setPrefs({ ...prefs, memory_enabled: e.target.checked })}
              />
              长期记忆（把已记住的用户事实注入每次对话；关闭后模型也不能读写记忆）
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.automemory_enabled}
                onChange={(e) => setPrefs({ ...prefs, automemory_enabled: e.target.checked })}
              />
              自动记忆（每轮对话结束后让模型自主判断是否值得记住，开销：每轮一次轻量调用）
            </label>
            {/* checkbox 和说明走两列：说明文字长，如果和时间框挤在同一行文字流里，
                时间框会被 flex 拉宽到整行（实测），看起来像凭空浮在右边。
                grid 而不是 flex+min-w-0：文字列缩到 0 时会竖成一列字（实测）。 */}
            <label className="grid grid-cols-[1.5rem_1fr_auto] items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mx-auto mt-1"
                checked={prefs.memory_tidy_enabled}
                onChange={(e) => setPrefs({ ...prefs, memory_tidy_enabled: e.target.checked })}
              />
              <span>
                睡眠期整理（每天凌晨自动合并语义重复的记忆，只在发现重复时才调用模型）
              </span>
              <input
                type="time"
                value={prefs.memory_tidy_time}
                disabled={!prefs.memory_tidy_enabled}
                onChange={(e) => setPrefs({ ...prefs, memory_tidy_time: e.target.value })}
                className={`${inputCls} w-28 disabled:opacity-40`}
              />
            </label>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                语音识别模型（本地 faster-whisper，首次使用时下载）
                <select
                  value={prefs.asr_model}
                  onChange={(e) => setPrefs({ ...prefs, asr_model: e.target.value })}
                  className={`${inputCls} w-52`}
                >
                  <option value="tiny">tiny — 最快，中文一般（75MB）</option>
                  <option value="base">base — 快（145MB）</option>
                  <option value="small">small — 推荐（480MB）</option>
                  <option value="medium">medium — 最准（1.5GB）</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                说话语言
                <select
                  value={prefs.asr_language}
                  onChange={(e) => setPrefs({ ...prefs, asr_language: e.target.value })}
                  className={`${inputCls} w-52`}
                >
                  <option value="auto">自动检测</option>
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                  <option value="ja">日本語</option>
                </select>
              </label>
              <span className="pb-2 text-xs text-neutral-400">聊天输入框旁点 🎤 即可语音输入，音频不出本机</span>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                播报音色
                <select
                  value={prefs.tts_voice}
                  onChange={(e) => setPrefs({ ...prefs, tts_voice: e.target.value })}
                  className={`${inputCls} w-60`}
                >
                  {(ttsVoices.length ? ttsVoices : ['zh-CN-XiaoxiaoNeural']).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                播报引擎
                <select
                  value={prefs.tts_engine}
                  onChange={(e) => setPrefs({ ...prefs, tts_engine: e.target.value })}
                  className={`${inputCls} w-72`}
                >
                  <option value="edge">edge-tts — 微软神经音色，自然（联网）</option>
                  <option value="sapi">Windows 本地语音 — 离线可用（音色较机械）</option>
                </select>
              </label>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={prefs.tts_auto}
                  onChange={(e) => setPrefs({ ...prefs, tts_auto: e.target.checked })}
                />
                回答完成后自动朗读
              </label>
              <span className="pb-2 text-xs text-neutral-400">悬停 AI 回答点 🔊 播报；edge 失败自动回退本地语音</span>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                播客 · 主持人音色
                <select
                  value={prefs.podcast_host_voice}
                  onChange={(e) => setPrefs({ ...prefs, podcast_host_voice: e.target.value })}
                  className={`${inputCls} w-60`}
                >
                  {(ttsVoices.length ? ttsVoices : ['zh-CN-YunxiNeural']).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                播客 · 嘉宾音色
                <select
                  value={prefs.podcast_guest_voice}
                  onChange={(e) => setPrefs({ ...prefs, podcast_guest_voice: e.target.value })}
                  className={`${inputCls} w-60`}
                >
                  {(ttsVoices.length ? ttsVoices : ['zh-CN-XiaoxiaoNeural']).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <span className="pb-2 text-xs text-neutral-400">
                笔记页 🎙 播客按钮把笔记变成双人对谈音频；两个音色选不同的才有对话感
              </span>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.desktop_notify}
                onChange={(e) => setPrefs({ ...prefs, desktop_notify: e.target.checked })}
              />
              任务桌面通知（定时/自动任务失败时弹 Windows 通知；智能体任务完成也通知）
            </label>
            {/* 同「睡眠期整理」：grid 三列，开关列 / 说明列 / 时间+备注列 */}
            <div className="grid grid-cols-[1.5rem_1fr_auto] items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.digest_enabled}
                id="digest-toggle"
                hidden
                onChange={(e) => setPrefs({ ...prefs, digest_enabled: e.target.checked })}
              />
              <button
                type="button"
                onClick={() => setPrefs({ ...prefs, digest_enabled: !prefs.digest_enabled })}
                role="switch"
                aria-checked={prefs.digest_enabled}
                className={`relative mx-auto mt-0.5 h-5 w-9 rounded-full transition-colors ${
                  prefs.digest_enabled ? 'bg-violet-600' : 'bg-neutral-300 dark:bg-neutral-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                    prefs.digest_enabled ? 'left-[18px]' : 'left-0.5'
                  }`}
                />
              </button>
              <span>每日定时笔记摘要</span>
              <span className="flex items-center gap-2">
                <input
                  type="time"
                  value={prefs.digest_time}
                  disabled={!prefs.digest_enabled}
                  onChange={(e) => setPrefs({ ...prefs, digest_time: e.target.value })}
                  className={`${inputCls} w-28 disabled:opacity-40`}
                />
                <span className="whitespace-nowrap text-xs text-neutral-400">写入 vault/digests/，自动进入知识库索引</span>
              </span>
            </div>
            <div className="flex items-center gap-3 pl-12">
              <input
                type="checkbox"
                checked={prefs.podcast_daily_enabled}
                disabled={!prefs.digest_enabled}
                onChange={(e) => setPrefs({ ...prefs, podcast_daily_enabled: e.target.checked })}
                className="accent-violet-600"
              />
              <span className={`text-sm ${prefs.digest_enabled ? '' : 'opacity-40'}`}>摘要生成后自动转为一期双人播客</span>
              <span className="text-xs text-neutral-400">
                每天定时把摘要读成音频，出现在笔记页 🎙 播客列表（标题「笔记简报 · 日期」）
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={savePrefs}
                className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm shadow-violet-300 transition-all hover:brightness-110"
              >
                {prefsSaved ? '✓ 已保存（定时任务即时生效）' : '保存通用设置'}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Artifacts 轻执行 + 图片生成：两张卡整体在 SettingsContent */}
      {section === 'content' && prefs && (
        <SettingsContent
          prefs={prefs}
          setPrefs={setPrefs}
          savePrefs={savePrefs}
          prefsSaved={prefsSaved}
          providers={providers}
          failLoad={failLoad}
        />
      )}

      {/* 备份与恢复：整体在 SettingsData */}
      {section === 'data' && prefs && (
        <SettingsData prefs={prefs} setPrefs={setPrefs} failLoad={failLoad} />
      )}

      {/* 复习卡片 / RSS 订阅 / 邮件推送：三张卡整体在 SettingsAutomationPrefs */}
      {section === 'automation' && prefs && (
        <SettingsAutomationPrefs
          prefs={prefs}
          setPrefs={setPrefs}
          savePrefs={savePrefs}
          prefsSaved={prefsSaved}
          failLoad={failLoad}
        />
      )}

      {/* Scheduled tasks */}
      {section === 'automation' && <SettingsTasks providers={providers} failLoad={failLoad} />}
      {/* Existing providers */}
      {section === 'models' && cost && (
        <section className="mb-6 wb-card p-5">
          <h2 className="mb-1 flex items-center gap-2 font-semibold">
            <span className="wb-chip h-6 w-6 rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300"><Coins className="h-3.5 w-3.5" /></span>
          </h2>
          <p className="mb-4 text-xs leading-relaxed text-neutral-500">
            最近 {cost.days} 天。聊天与定时任务各自记账；其余路径（研究 / 产出 / 复盘 / 方案 /
            对质 / 教学 / 圆桌 / 播客 / 卡片 / 记忆整理）走统一账本——以前它们一点都看不见。
            填了模型价格才会给金额，否则只显示 token。
          </p>
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3 pb-4">
            <div>
              <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">
                {cost.total_tokens.toLocaleString()}
              </p>
              <p className="text-xs text-neutral-500">总 token</p>
            </div>
            <div>
              <p className="text-lg font-semibold text-neutral-700 dark:text-neutral-200">
                {cost.total_tokens_in.toLocaleString()} / {cost.total_tokens_out.toLocaleString()}
              </p>
              <p className="text-xs text-neutral-500">输入 / 输出</p>
            </div>
            <div>
              <p className="text-lg font-semibold text-neutral-700 dark:text-neutral-200">
                {cost.chat_calls} · {cost.task_runs} · {cost.ledger_calls}
              </p>
              <p className="text-xs text-neutral-500">聊天 / 定时任务 / 其他路径</p>
            </div>
          </div>

          {Object.keys(cost.by_kind).length > 0 ? (
            <div className="pb-4">
              <p className="pb-1 text-xs font-medium text-neutral-500">按操作（钱花在哪）</p>
              <table className="w-full text-xs">
                <tbody>
                  {Object.entries(cost.by_kind)
                    .sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out))
                    .map(([kind, r]) => (
                      <tr key={kind} className="border-t border-neutral-100 dark:border-neutral-800">
                        <td className="py-1 pr-3 text-neutral-600 dark:text-neutral-300">{kind}</td>
                        <td className="py-1 pr-3 text-right">{r.calls} 次</td>
                        <td className="py-1 text-right text-neutral-500">
                          {(r.in + r.out).toLocaleString()} tok
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {cost.by_day.length > 0 ? (
            <div>
              <p className="pb-1 text-xs font-medium text-neutral-500">按天</p>
              <div className="flex h-16 items-end gap-0.5">
                {(() => {
                  const days = cost.by_day.slice(-30)
                  const peak = Math.max(...days.map(([, t]) => t), 1)
                  return days.map(([day, tokens]) => (
                    <div
                      key={day}
                      title={`${day}：${tokens.toLocaleString()} tok`}
                      className="min-w-0 flex-1 rounded-t bg-violet-400 dark:bg-violet-500"
                      style={{ height: `${Math.max(2, (tokens / peak) * 100)}%` }}
                    />
                  ))
                })()}
              </div>
            </div>
          ) : null}
        </section>
      )}

      {section === 'models' && (
      <section className="mb-6 flex flex-col gap-3 wb-card p-5">
        <h2 className="flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300"><Brain className="h-3.5 w-3.5" /></span></h2>
        <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
          「测一下」会给这个 provider 的每个模型各打一次最小请求，逐个标出可用还是打不通。
          <b>模型顺序有意义</b>：所有自动化功能（每日提醒、每周补讲、每日摘要、零柒问候、自动记忆、图谱抽取）
          用的是第一个能打通的模型，探测失败的会被自动跳过。
        </p>
        {providers.map((p) => (
          <div
            key={p.id}
            className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800"
          >
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                    {p.kind}
                  </span>
                  {!p.enabled && <span className="text-xs text-red-500">已禁用</span>}
                </div>
                <div className="truncate text-xs text-neutral-500">
                  {p.models.join(', ') || '无模型'} {p.base_url && `· ${p.base_url}`}
                </div>
              </div>
              <div className="flex shrink-0 gap-2 text-sm">
                <button
                  onClick={() => void runProbe(p.id)}
                  disabled={probing === p.id}
                  className="text-violet-600 hover:text-violet-800 disabled:opacity-50 dark:text-violet-300"
                >
                  {probing === p.id ? '测试中…' : '测一下'}
                </button>
                <button onClick={() => startEdit(p)} className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
                  编辑
                </button>
                <button onClick={() => remove(p.id)} className="text-red-400 hover:text-red-600">
                  删除
                </button>
              </div>
            </div>
            {probes[p.id] && (
              <div className="mt-2.5 space-y-1 border-t border-neutral-200/80 pt-2.5 dark:border-neutral-800/80">
                {probes[p.id].map((r) => (
                  <div key={r.model_id} className="flex items-center gap-2 text-xs">
                    <span
                      className={`rounded px-1.5 py-0.5 ${
                        r.ok
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
                          : 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300'
                      }`}
                    >
                      {r.ok ? '可用' : r.code || '打不通'}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {r.model_id.split('/').slice(1).join('/')}
                    </span>
                    {r.ok && <span className="text-neutral-400">{r.ms}ms</span>}
                    {!r.ok && r.message && (
                      <span className="min-w-0 max-w-[45%] truncate text-neutral-400" title={r.message}>
                        {r.message}
                      </span>
                    )}
                  </div>
                ))}
                {defaultModel && (
                  <p className="pt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    自动化功能将使用：
                    <span className="font-mono text-neutral-700 dark:text-neutral-200">
                      {defaultModel}
                    </span>
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
        {!providers.length && <p className="text-sm text-neutral-400">尚未配置任何 provider</p>}
      </section>
      )}

      {/* Persistent memory */}
      {section === 'agents' && (
      <>
      {/* 体检 / 竞技场 / 质量+标尺+回合台账 / 教学画像 / 记忆：六卡整体在 SettingsEval */}
      <SettingsEval failLoad={failLoad} />

      {/* Agent presets */}
      <SettingsAgents providers={providers} failLoad={failLoad} setError={setError} />

      {/* Prompt library */}
      <SettingsPrompts failLoad={failLoad} setError={setError} />

      {/* Agent Skills */}
      <SettingsSkills failLoad={failLoad} />
      </>
      )}

      {/* Provider editor */}
      {section === 'models' && (
      <section className="mb-6 wb-card p-5">
        <h2 className="mb-4 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300"><Brain className="h-3.5 w-3.5" /></span> {editingId ? `编辑 ${draft.name}` : '新增 Provider'}</h2>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1 text-sm">
            名称（用于 model_id 前缀）
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="deepseek" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            协议类型
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'openai' | 'anthropic' })} className={inputCls}>
              <option value="openai">OpenAI 兼容（deepseek/qwen/moonshot/ollama…）</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Base URL（openai 兼容时必填官方地址以外的服务）
            <input value={draft.base_url} onChange={(e) => setDraft({ ...draft, base_url: e.target.value })} placeholder="https://api.deepseek.com/v1" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            API Key {editingId && '(留空保持不变)'}
            <input type="password" value={draft.api_key} onChange={(e) => setDraft({ ...draft, api_key: e.target.value })} className={inputCls} />
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-sm">
            模型列表（逗号或换行分隔）
            <textarea
              value={draft.models}
              onChange={(e) => setDraft({ ...draft, models: e.target.value })}
              rows={2}
              placeholder="deepseek-chat, deepseek-reasoner"
              className={inputCls}
            />
          </label>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            启用
          </label>
          <div className="flex gap-2">
            {editingId && (
              <button
                onClick={() => {
                  setEditingId(null)
                  setDraft({ ...EMPTY })
                  setError('')
                }}
                className="rounded-md px-4 py-1.5 text-sm text-neutral-500"
              >
                取消
              </button>
            )}
            <button onClick={save} className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110">
              {editingId ? '保存修改' : '添加'}
            </button>
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
      </section>
      )}

      {/* MCP tools */}
      {section === 'mcp' && (
      <>
      {prefs && <SettingsWebsearch prefs={prefs} setPrefs={setPrefs} />}
      {/* MCP server 清单 + 编辑器 + 页尾提示：整体在 SettingsMcp */}
      <SettingsMcp failLoad={failLoad} />

      </>
      )}

      </main>
      </div>
    </>
  )
}