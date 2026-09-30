import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Brain,
  Coins,
  Globe,
  Image,
  Layers,
  Mail,
  Plug,
  Rss,
  Save,
  Settings,
  Zap,
} from 'lucide-react'
import { api, type BackupList, type CostSummary, type FeedItem, type ImageItem, type McpServer, type McpProbe, type McpView, type ModelProbe, type ProviderConfig } from './api'
import { fmtSize, inputCls } from './settingsShared'
import SettingsTasks from './SettingsTasks'
import SettingsAgents from './SettingsAgents'
import SettingsEval from './SettingsEval'
import SettingsPrompts from './SettingsPrompts'
import SettingsSkills from './SettingsSkills'
import { SETTING_SECTIONS, type SettingSection } from './routes'

/** A3 那一栏的**成本读数**（2026-09-22：A3 改成症状驱动，不再是「工具数 > 20」）。
 *
 *  工具定义每一轮都要重发一遍——这段话把「重发多少」念出来：总字数 + 最占地方的三个，
 *  再给一句**提示**（到 20 个工具就复看一遍）。**是提示不是及格线**：这行字里不许出现
 *  「到线 / 没到线」这种判词，`review_hint` 是提醒你看一眼，不是判你合不合格。
 *
 *  **读不到就明说读不到**（§4-8）：`undefined` 走「没拿到」，绝不当成 0 印出来——
 *  「0 字」是在说「工具定义不要钱」，而事实是这一格没读到。
 *
 *  纯函数，所以只钉它（`SettingsPage.tools.test.tsx`）：整页要拉一堆端点，
 *  而这一行的规矩只有三条——照实念、最占地方的排前面、读不到不许印 0。 */
export function toolCostLine(tools: McpView['tools']): string {
  if (!tools) return '工具定义的字数没拿到——这一格不编一个 0 出来。'
  const top = (tools.biggest ?? []).slice(0, 3)
  const body = top.map((t) => `${t.name} ${t.chars} 字`).join('、')
  // 只有一条时不能写成「最占地方的是 X」（读起来像半句话），用「是」而不是「是…的」
  const biggest = body ? `最占地方的是 ${body}。` : ''
  return `${tools.count} 个工具的说明合起来 ${tools.chars} 字：这些每一轮都重发一遍。${biggest}到 ${tools.review_hint} 个工具就复看一遍——这是提示，不是及格线。`
}

const EMPTY = { name: '', kind: 'openai' as 'openai' | 'anthropic', base_url: '', api_key: '', models: '', enabled: true }
const EMPTY_MCP: McpServer = { name: '', type: 'stdio', command: '', args: [], url: '', enabled: true }


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

  const [prefs, setPrefs] = useState<{
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
  } | null>(null)
  const [prefsSaved, setPrefsSaved] = useState(false)

  const [images, setImages] = useState<ImageItem[]>([])
  const [imgPrompt, setImgPrompt] = useState('一只戴着圆眼镜的橘猫坐在书桌前看书，暖色台灯，水彩插画风格')
  const [imgBusy, setImgBusy] = useState(false)
  const [imgMsg, setImgMsg] = useState('')

  const [backups, setBackups] = useState<BackupList | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMsg, setBackupMsg] = useState('')

  const [feeds, setFeeds] = useState<FeedItem[]>([])
  const [feedsNextRun, setFeedsNextRun] = useState<string | null>(null)
  const [feedUrl, setFeedUrl] = useState('')
  const [feedName, setFeedName] = useState('')
  const [feedBusy, setFeedBusy] = useState('')
  const [feedMsg, setFeedMsg] = useState('')
  const [mailBusy, setMailBusy] = useState(false)
  const [mailMsg, setMailMsg] = useState('')

  const [ttsVoices, setTtsVoices] = useState<string[]>([])


  const [mcpView, setMcpView] = useState<McpView | null>(null)
  const [mcpDraft, setMcpDraft] = useState<McpServer>({ ...EMPTY_MCP })
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpEditIdx, setMcpEditIdx] = useState<number | null>(null)
  const [probe, setProbe] = useState<Record<string, McpProbe | 'loading'>>({})
  const [mcpError, setMcpError] = useState('')



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
      setMcpView(await api.getMcp())
      // 这一批是**并发拉、各自坏**的取数。原来全是 `.catch(() => {})`——拉不到就摆一个空区，
      // 看起来像「你还没配」。现在每一样都报自己的名字，页级失败条汇总。
      api.ttsVoices().then((r) => setTtsVoices(r.voices)).catch((e) => failLoad('音色', e))
      api.listBackups().then(setBackups).catch((e) => failLoad('备份', e))
      api.listImages().then((r) => setImages(r.images)).catch((e) => failLoad('图片', e))
      api.listFeeds().then((r) => {
        setFeeds(r.feeds)
        setFeedsNextRun(r.next_run)
      }).catch((e) => failLoad('订阅', e))
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
    api.listBackups().then(setBackups).catch((e) => failLoad('备份', e))
    api.listFeeds().then((r) => setFeeds(r.feeds)).catch((e) => failLoad('订阅', e))
  }

  // ---- RSS feeds + e-mail ----

  async function addFeed() {
    const url = feedUrl.trim()
    if (!url || feedBusy) return
    setFeedBusy('add')
    setFeedMsg('抓取并写入 vault/feeds/ …')
    try {
      const f = await api.addFeed(url, feedName.trim() || undefined)
      setFeedUrl('')
      setFeedName('')
      setFeedMsg(`${f.name}: 新增 ${f.new ?? 0} 条（共 ${f.total ?? 0} 条）${f.written_to ? ` → ${f.written_to}` : '，无新内容'}`)
      await reloadFeeds()
    } catch (e) {
      setFeedMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setFeedBusy('')
    }
  }

  async function reloadFeeds() {
    const r = await api.listFeeds()
    setFeeds(r.feeds)
    setFeedsNextRun(r.next_run)
  }

  async function syncFeeds(name?: string) {
    if (feedBusy) return
    setFeedBusy(name || 'all')
    setFeedMsg(name ? `同步 ${name}…` : '同步全部订阅…')
    try {
      if (name) {
        const r = await api.syncFeed(name)
        setFeedMsg(`${name}: 新增 ${r.new ?? 0} 条`)
      } else {
        const r = await api.syncAllFeeds()
        setFeedMsg(`${r.feeds} 个订阅，新增 ${r.new} 条`)
      }
      await reloadFeeds()
    } catch (e) {
      setFeedMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setFeedBusy('')
    }
  }

  async function toggleFeed(name: string, enabled: boolean) {
    await api.toggleFeed(name, enabled)
    await reloadFeeds()
  }

  async function removeFeed(name: string) {
    if (!confirm(`删除订阅 ${name}？已抓取的笔记文件保留在 vault/feeds/。`)) return
    await api.deleteFeed(name)
    await reloadFeeds()
  }

  async function sendTestMail() {
    if (mailBusy) return
    setMailBusy(true)
    setMailMsg('发送中…')
    try {
      const r = await api.testMail()
      setMailMsg(`已发送给 ${r.to.join(', ')}`)
    } catch (e) {
      setMailMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setMailBusy(false)
    }
  }

  // ---- image generation ----

  async function testImage() {
    if (!prefs || imgBusy) return
    const prompt = imgPrompt.trim()
    if (!prompt) {
      setImgMsg('先写一句图片描述')
      return
    }
    setImgBusy(true)
    setImgMsg('生成中…（qwen-image 约 30-90 秒，请勿刷新）')
    try {
      await savePrefs()
      const r = await api.generateImage(prompt)
      setImgMsg(`✓ ${r.images.length} 张 · ${r.model} · ${r.size} · ${r.api}/${r.provider} · ${r.seconds}s`)
      const list = await api.listImages()
      setImages(list.images)
    } catch (e) {
      setImgMsg(String(e))
    } finally {
      setImgBusy(false)
    }
  }

  async function removeImage(name: string) {
    if (!confirm(`删除图片「${name}」？引用它的笔记/对话会显示裂图。`)) return
    try {
      await api.deleteImage(name)
      const list = await api.listImages()
      setImages(list.images)
    } catch (e) {
      setImgMsg(String(e))
    }
  }

  // ---- backups ----

  async function runBackup() {
    setBackupBusy(true)
    setBackupMsg('')
    try {
      const r = await api.runBackup()
      setBackupMsg(
        `✓ 已生成 ${r.name}（${fmtSize(r.size)}，${r.vault_files} 个笔记文件` +
          (r.pruned.length ? `，滚动清理 ${r.pruned.length} 份旧备份` : '') +
          '）'
      )
      setBackups(await api.listBackups())
    } catch (e) {
      setBackupMsg(`✗ ${String(e)}`)
    } finally {
      setBackupBusy(false)
    }
  }

  async function removeBackup(name: string) {
    if (!window.confirm(`删除备份 ${name}？此操作不可恢复。`)) return
    await api.deleteBackup(name).catch((e) => setBackupMsg(`✗ ${String(e)}`))
    setBackups(await api.listBackups())
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

  // ---- MCP server management ----

  async function saveMcp(list: McpServer[]) {
    try {
      setMcpView(await api.saveMcp(list))
      setMcpEditIdx(null)
      setMcpDraft({ ...EMPTY_MCP })
      setMcpArgs('')
      setMcpError('')
    } catch (e) {
      setMcpError(String(e))
    }
  }

  function applyMcpDraft() {
    if (!mcpDraft.name.trim()) {
      setMcpError('名称必填')
      return
    }
    const item: McpServer = {
      ...mcpDraft,
      name: mcpDraft.name.trim(),
      args: mcpArgs
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    }
    const list = mcpView?.servers ?? []
    const next =
      mcpEditIdx == null ? [...list, item] : list.map((s, i) => (i === mcpEditIdx ? item : s))
    void saveMcp(next)
  }

  function removeMcp(idx: number) {
    const list = mcpView?.servers ?? []
    if (!confirm(`删除 MCP server「${list[idx]?.name ?? ''}」？`)) return
    void saveMcp(list.filter((_, i) => i !== idx))
  }

  function editMcp(idx: number) {
    const s = mcpView?.servers[idx]
    if (!s) return
    setMcpEditIdx(idx)
    setMcpDraft({ ...s })
    setMcpArgs(s.args.join('\n'))
    setMcpError('')
  }

  async function testMcp(s: McpServer, idx: number) {
    setProbe((prev) => ({ ...prev, [String(idx)]: 'loading' }))
    const r = await api.testMcp(s).catch((e): McpProbe => ({ name: s.name, ok: false, tools: [], error: String(e) }))
    setProbe((prev) => ({ ...prev, [String(idx)]: r }))
  }

  const mcpServers = mcpView?.servers ?? []
  const activeToolCount = mcpView?.active_tools.length ?? 0

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

      {/* Artifacts light execution */}
      {section === 'content' && prefs && (
        <section className="mb-6 wb-card p-5">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300"><Zap className="h-3.5 w-3.5" /></span></h2>
          <p className="mb-4 text-xs leading-relaxed text-neutral-500">
            默认关闭。开启后聊天里的 Python / JavaScript 代码块出现「▶ 运行」按钮，HTML 代码块出现沙箱预览。
            代码在你本机以独立临时目录直接执行（Python 用工作台自带的运行环境），有超时与输出上限，但没有真正的沙箱隔离 —— 请只运行你理解用途的代码。
          </p>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.artifacts_enabled}
                onChange={(e) => setPrefs({ ...prefs, artifacts_enabled: e.target.checked })}
              />
              允许运行 AI 代码（opt-in）
            </label>
            <label className="flex flex-col gap-1 text-sm">
              单次运行超时（秒）
              <input
                type="number"
                min={1}
                max={120}
                value={prefs.artifacts_timeout}
                onChange={(e) => setPrefs({ ...prefs, artifacts_timeout: Number(e.target.value) || 30 })}
                className={`${inputCls} w-40`}
              />
            </label>
          </div>
        </section>
      )}

      {/* Image generation */}
      {section === 'content' && prefs && (
        <section className="mb-6 wb-card p-5">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-pink-100 text-pink-600 dark:bg-pink-400/15 dark:text-pink-300"><Image className="h-3.5 w-3.5" /></span></h2>
          <p className="mb-4 text-xs leading-relaxed text-neutral-500">
            开启后模型可调用 image_gen 工具作图，Notes 页也能用「🖼️ 配图」插入。生成的图片会下载到
            data/images/ 并以 /api/images/&lt;name&gt; 提供（DashScope 返回的原始链接带签名会过期）。
          </p>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-sm">
              <button
                type="button"
                onClick={() => setPrefs({ ...prefs, image_enabled: !prefs.image_enabled })}
                role="switch"
                aria-checked={prefs.image_enabled}
                aria-label="启用图片生成工具"
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  prefs.image_enabled ? 'bg-violet-600' : 'bg-neutral-300 dark:bg-neutral-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                    prefs.image_enabled ? 'left-[18px]' : 'left-0.5'
                  }`}
                />
              </button>
              把 image_gen 工具暴露给模型（关闭后仅剩 Notes/设置页手动生成）
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                接口
                <select
                  value={prefs.image_api}
                  onChange={(e) => setPrefs({ ...prefs, image_api: e.target.value })}
                  className={`${inputCls} w-52`}
                >
                  <option value="dashscope">dashscope（阿里百炼原生）</option>
                  <option value="openai">openai（/v1/images/generations）</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Provider（取其 key 与 base_url）
                <select
                  value={prefs.image_provider}
                  onChange={(e) => setPrefs({ ...prefs, image_provider: e.target.value })}
                  className={`${inputCls} w-44`}
                >
                  <option value="">第一个已启用的</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                模型
                <input
                  value={prefs.image_model}
                  onChange={(e) => setPrefs({ ...prefs, image_model: e.target.value })}
                  placeholder="qwen-image-3.0"
                  className={`${inputCls} w-44`}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                尺寸
                <input
                  value={prefs.image_size}
                  onChange={(e) => setPrefs({ ...prefs, image_size: e.target.value })}
                  placeholder="1024*1024 或 16:9"
                  className={`${inputCls} w-40`}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-[280px] flex-1 flex-col gap-1 text-sm">
                测试描述
                <input
                  value={imgPrompt}
                  onChange={(e) => setImgPrompt(e.target.value)}
                  className={inputCls}
                />
              </label>
              <button
                onClick={testImage}
                disabled={imgBusy}
                className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm shadow-violet-300 transition-all hover:brightness-110 disabled:opacity-50"
              >
                {imgBusy ? '生成中…' : prefsSaved ? '✓ 已保存设置' : '保存设置并测试生成'}
              </button>
            </div>
            {imgMsg && (
              <p
                className={`text-xs ${
                  imgMsg.startsWith('✓') ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-500'
                }`}
              >
                {imgMsg}
              </p>
            )}
            {images.length > 0 && (
              <div>
                <p className="mb-2 text-xs text-neutral-500">data/images/ · 共 {images.length} 张</p>
                <div className="flex flex-wrap gap-3">
                  {images.slice(0, 12).map((im) => (
                    <div key={im.name} className="group relative">
                      <a href={im.url} target="_blank" rel="noreferrer" title={im.name}>
                        <img
                          src={im.url}
                          alt={im.name}
                          loading="lazy"
                          className="h-24 w-24 rounded-lg border border-neutral-200 object-cover dark:border-neutral-800"
                        />
                      </a>
                      <button
                        onClick={() => removeImage(im.name)}
                        aria-label={`删除 ${im.name}`}
                        className="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full bg-red-500 text-xs leading-5 text-white opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                      >
                        ×
                      </button>
                      <span className="mt-1 block w-24 truncate text-xs text-neutral-400">
                        {fmtSize(im.bytes)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Backup & restore */}
      {section === 'data' && prefs && (
        <section className="mb-6 wb-card p-5">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"><Save className="h-3.5 w-3.5" /></span></h2>
          <p className="mb-4 text-xs text-neutral-500">
            打包 vault/（全部笔记）+ data/workbench.db（会话/记忆/配置库，一致性快照）+ data/config.json 为 zip。
            向量索引不入包，可由 vault 重建。
          </p>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.backup_enabled}
                onChange={(e) => setPrefs({ ...prefs, backup_enabled: e.target.checked })}
              />
              每日自动备份
              <input
                type="time"
                value={prefs.backup_time}
                disabled={!prefs.backup_enabled}
                onChange={(e) => setPrefs({ ...prefs, backup_time: e.target.value })}
                className={`${inputCls} w-28 disabled:opacity-40`}
              />
              <span className="ml-2 text-neutral-500">保留最近</span>
              <input
                type="number"
                min={1}
                max={99}
                value={prefs.backup_keep}
                onChange={(e) => setPrefs({ ...prefs, backup_keep: Number(e.target.value) })}
                className={`${inputCls} w-16`}
              />
              <span className="text-neutral-500">份（超出自动滚动删除）</span>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              备份目录（留空 = 项目下 backups/）
              <input
                value={prefs.backup_dir}
                onChange={(e) => setPrefs({ ...prefs, backup_dir: e.target.value })}
                placeholder={backups?.dir || 'D:\\TP\\A\\backups'}
                className={inputCls}
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={runBackup}
                disabled={backupBusy}
                className="rounded-md border border-violet-500 px-3 py-1.5 text-sm font-medium text-violet-600 transition-colors hover:bg-violet-50 disabled:opacity-50 dark:text-violet-300 dark:hover:bg-violet-950"
              >
                {backupBusy ? '打包中…' : '立即备份'}
              </button>
              <span className="text-xs text-neutral-500">
                保存路径 {backups?.dir || '—'}
                {backups?.next_run ? ` · 下次自动备份 ${backups.next_run.slice(5, 16).replace('T', ' ')}` : ''}
              </span>
            </div>
            {backupMsg && <div className="text-xs text-neutral-600 dark:text-neutral-300">{backupMsg}</div>}
            <div className="flex flex-col gap-1">
              {(backups?.backups ?? []).length === 0 && (
                <div className="text-xs text-neutral-400">还没有备份</div>
              )}
              {(backups?.backups ?? []).map((b) => (
                <div
                  key={b.name}
                  className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-1.5 text-xs dark:border-neutral-800"
                >
                  <span className="truncate font-mono">{b.name}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="text-neutral-500">{fmtSize(b.size)}</span>
                    <span className="text-neutral-400">{b.created_at.slice(0, 16).replace('T', ' ')}</span>
                    <a
                      href={api.backupDownloadUrl(b.name)}
                      className="text-violet-600 hover:underline dark:text-violet-300"
                    >
                      下载
                    </a>
                    <button onClick={() => removeBackup(b.name)} className="text-red-500 hover:underline">
                      删除
                    </button>
                  </span>
                </div>
              ))}
            </div>
            <details className="text-xs text-neutral-500">
              <summary className="cursor-pointer select-none">如何恢复？</summary>
              <p className="mt-2 leading-relaxed">{backups?.restore_hint || ''}</p>
            </details>
          </div>
        </section>
      )}

      {/* 复习卡片 */}
      {section === 'automation' && prefs && (
        <section className="mb-6 wb-card p-5">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300"><Layers className="h-3.5 w-3.5" /></span></h2>
          <p className="mb-4 text-xs leading-relaxed text-neutral-400">
            每日上限不是为了省时间，是为了别让积压把人劝退——某天出了两百张卡，第二天被队列砸懵就再也不打开了。
          </p>
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              每天新卡上限
              <input
                type="number"
                min={0}
                max={500}
                value={prefs.cards_new_per_day}
                onChange={(e) => setPrefs({ ...prefs, cards_new_per_day: Number(e.target.value) })}
                className={`${inputCls} w-20`}
              />
            </label>
            <label className="flex items-center gap-2">
              每天复习上限
              <input
                type="number"
                min={0}
                max={500}
                value={prefs.cards_review_per_day}
                onChange={(e) => setPrefs({ ...prefs, cards_review_per_day: Number(e.target.value) })}
                className={`${inputCls} w-20`}
              />
            </label>
          </div>
          <div className="mb-3 rounded-lg bg-neutral-100 px-3 py-2 text-xs leading-relaxed text-neutral-500 dark:bg-neutral-800/60 dark:text-neutral-400">
            复习已封存：不再有每日到期提醒，也不再有每周补讲。
            页面还在导航里的「今日」，你自己想开就开；它不会再主动找你。
          </div>
          <button
            onClick={savePrefs}
            className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm text-white hover:bg-violet-700"
          >
            {prefsSaved ? '已保存' : '保存'}
          </button>
        </section>
      )}

      {/* RSS subscriptions */}
      {section === 'automation' && prefs && (
        <section className="mb-6 wb-card p-5">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-orange-100 text-orange-600 dark:bg-orange-400/15 dark:text-orange-300"><Rss className="h-3.5 w-3.5" /></span></h2>
          <p className="mb-4 text-xs leading-relaxed text-neutral-400">
            抓到的新条目按月追加到 vault/feeds/，自动进 RAG 索引——再配一个定时任务（如「总结 feeds
            目录里今天的新内容」）就是每日情报简报。同一条目只写一次。
          </p>
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={prefs.feeds_enabled}
                onChange={(e) => setPrefs({ ...prefs, feeds_enabled: e.target.checked })}
              />
              每日自动抓取
            </label>
            <input
              value={prefs.feeds_time}
              onChange={(e) => setPrefs({ ...prefs, feeds_time: e.target.value })}
              placeholder="08:00"
              className={`${inputCls} w-24`}
            />
            <button
              onClick={savePrefs}
              className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110"
            >
              {prefsSaved ? '已保存' : '保存设置'}
            </button>
            {feedsNextRun && (
              <span className="text-xs text-neutral-400">下次 {feedsNextRun.replace('T', ' ')}</span>
            )}
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            <input
              value={feedUrl}
              onChange={(e) => setFeedUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addFeed()}
              placeholder="https://example.com/feed.xml"
              className={`${inputCls} min-w-[260px] flex-1`}
            />
            <input
              value={feedName}
              onChange={(e) => setFeedName(e.target.value)}
              placeholder="名称（留空用源标题）"
              className={`${inputCls} w-48`}
            />
            <button
              onClick={addFeed}
              disabled={!!feedBusy || !feedUrl.trim()}
              className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
            >
              {feedBusy === 'add' ? '抓取中…' : '添加订阅'}
            </button>
            <button
              onClick={() => syncFeeds()}
              disabled={!!feedBusy || feeds.length === 0}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-neutral-700"
            >
              {feedBusy === 'all' ? '同步中…' : '立即同步全部'}
            </button>
          </div>
          {feedMsg && <p className="mb-3 text-xs text-neutral-500">{feedMsg}</p>}
          {feeds.length === 0 ? (
            <p className="text-xs text-neutral-400">还没有订阅。</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {feeds.map((f) => (
                <li
                  key={f.name}
                  className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{f.name}</span>
                      {f.enabled === false && (
                        <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                          已停用
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-neutral-400">{f.url}</div>
                    {f.last_synced && (
                      <div className="text-xs text-neutral-500">
                        上次同步 {f.last_synced.replace('T', ' ')} · 新增 {f.new ?? 0} 条
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => syncFeeds(f.name)}
                      disabled={!!feedBusy}
                      className="rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-neutral-700"
                    >
                      {feedBusy === f.name ? '…' : '同步'}
                    </button>
                    <button
                      onClick={() => toggleFeed(f.name, f.enabled === false)}
                      className="rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
                    >
                      {f.enabled === false ? '启用' : '停用'}
                    </button>
                    <button
                      onClick={() => removeFeed(f.name)}
                      className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-red-600 dark:border-neutral-700"
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* E-mail push */}
      {section === 'automation' && prefs && (
        <section className="mb-6 wb-card p-5">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"><Mail className="h-3.5 w-3.5" /></span></h2>
          <p className="mb-4 text-xs leading-relaxed text-neutral-400">
            用你自己的 SMTP 发件（密码存在本机 data/config.json，接口读取时会打码）。端口 465 走隐式 TLS，587 走
            STARTTLS。
          </p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-neutral-500">SMTP 服务器</span>
              <input
                value={prefs.smtp_host}
                onChange={(e) => setPrefs({ ...prefs, smtp_host: e.target.value })}
                placeholder="smtp.qq.com"
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-neutral-500">端口</span>
              <input
                value={prefs.smtp_port}
                onChange={(e) => setPrefs({ ...prefs, smtp_port: Number(e.target.value) || 587 })}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-neutral-500">用户名</span>
              <input
                value={prefs.smtp_user}
                onChange={(e) => setPrefs({ ...prefs, smtp_user: e.target.value })}
                placeholder="me@example.com"
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-neutral-500">密码 / 授权码</span>
              <input
                type="password"
                value={prefs.smtp_password}
                onChange={(e) => setPrefs({ ...prefs, smtp_password: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-neutral-500">发件人（留空用用户名）</span>
              <input
                value={prefs.smtp_from}
                onChange={(e) => setPrefs({ ...prefs, smtp_from: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-neutral-500">收件人（逗号分隔）</span>
              <input
                value={prefs.smtp_to}
                onChange={(e) => setPrefs({ ...prefs, smtp_to: e.target.value })}
                className={inputCls}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={prefs.smtp_tls}
                onChange={(e) => setPrefs({ ...prefs, smtp_tls: e.target.checked })}
              />
              STARTTLS
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={prefs.email_on_digest}
                onChange={(e) => setPrefs({ ...prefs, email_on_digest: e.target.checked })}
              />
              每日笔记摘要发邮件
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={prefs.email_on_feeds}
                onChange={(e) => setPrefs({ ...prefs, email_on_feeds: e.target.checked })}
              />
              订阅有新内容时发邮件
            </label>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={savePrefs}
              className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110"
            >
              {prefsSaved ? '已保存' : '保存设置'}
            </button>
            <button
              onClick={sendTestMail}
              disabled={mailBusy || !prefs.smtp_host.trim()}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-neutral-700"
            >
              {mailBusy ? '发送中…' : '发送测试邮件'}
            </button>
            {mailMsg && <span className="text-xs text-neutral-500">{mailMsg}</span>}
          </div>
        </section>
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
      {prefs && (
      <section className="mb-6 flex flex-col gap-3 wb-card p-5">
        <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"><Globe className="h-3.5 w-3.5" /></span></h2>
        <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
          web_search 工具的搜索引擎。配置 Keenable API Key 后优先走 Keenable（稳定、带正文摘要）；
          免费爬取 Bing / DuckDuckGo 始终作为兜底。
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            搜索源
            <select
              value={prefs.websearch_api}
              onChange={(e) => setPrefs({ ...prefs, websearch_api: e.target.value })}
              className={`${inputCls} w-52`}
            >
              <option value="keenable">Keenable（搜索 API，推荐）</option>
              <option value="">免费爬取（Bing / DDG）</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Keenable API Key
            <input
              value={prefs.websearch_api_key}
              onChange={(e) => setPrefs({ ...prefs, websearch_api_key: e.target.value })}
              placeholder="keen_..."
              className={`${inputCls} w-96`}
            />
          </label>
        </div>
      </section>
      )}
      <section className="mb-6 flex flex-col gap-3 wb-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"><Plug className="h-3.5 w-3.5" /></span></h2>
          <span className="text-xs text-neutral-400">{activeToolCount} 个可用工具</span>
        </div>
        <p className="-mt-1 text-xs leading-relaxed text-neutral-400">{toolCostLine(mcpView?.tools)}</p>
        <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
          内置工具始终可用：<code className="text-neutral-500">vault_read_file</code> /{' '}
          <code className="text-neutral-500">vault_list_files</code> /{' '}
          <code className="text-neutral-500">vault_write_file</code> /{' '}
          <code className="text-neutral-500">fetch_url</code> /{' '}
          <code className="text-neutral-500">web_search</code> /{' '}
          <code className="text-neutral-500">memory_save</code> 等。配置 MCP server 可接入文件系统、浏览器、数据库等任意工具。
        </p>
        {mcpServers.map((s, i) => {
          const st = mcpView?.status[s.name]
          const pr = probe[String(i)]
          return (
            <div
              key={`${s.name}-${i}`}
              className="flex items-start justify-between rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                    {s.type}
                  </span>
                  {!s.enabled && <span className="text-xs text-red-500">已禁用</span>}
                </div>
                <div className="truncate text-xs text-neutral-500">
                  {s.type === 'sse' ? s.url : [s.command, ...s.args].join(' ')}
                </div>
                <div className="mt-1 text-xs">
                  {st ? (
                    st.ok ? (
                      <span className="text-emerald-600 dark:text-emerald-400">● 已连接 · {st.tools} 个工具</span>
                    ) : (
                      <span className="text-red-500" title={st.error ?? ''}>● 连接失败</span>
                    )
                  ) : (
                    <span className="text-neutral-400">○ 未连接</span>
                  )}
                  {'  '}
                  {pr === 'loading' && <span className="text-neutral-400">测试中…</span>}
                  {pr && pr !== 'loading' && (
                    pr.ok ? (
                      <span className="text-emerald-600 dark:text-emerald-400">测试通过：{pr.tools.join(', ') || '(无工具)'}</span>
                    ) : (
                      <span className="text-red-500">测试失败：{pr.error}</span>
                    )
                  )}
                </div>
              </div>
              <div className="flex shrink-0 gap-2 text-sm">
                <button onClick={() => testMcp(s, i)} className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
                  测试
                </button>
                <button onClick={() => editMcp(i)} className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
                  编辑
                </button>
                <button onClick={() => removeMcp(i)} className="text-red-400 hover:text-red-600">
                  删除
                </button>
              </div>
            </div>
          )
        })}
        {!mcpServers.length && (
          <p className="text-sm text-neutral-400">尚未配置任何 MCP server（可选，内置工具已可用）</p>
        )}
      </section>

      {/* MCP editor */}
      <section className="wb-card p-5">
        <h2 className="mb-4 flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"><Plug className="h-3.5 w-3.5" /></span> {mcpEditIdx != null ? `编辑 ${mcpDraft.name}` : '新增 MCP Server'}</h2>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1 text-sm">
            名称
            <input value={mcpDraft.name} onChange={(e) => setMcpDraft({ ...mcpDraft, name: e.target.value })} placeholder="filesystem" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            传输类型
            <select
              value={mcpDraft.type}
              onChange={(e) => setMcpDraft({ ...mcpDraft, type: e.target.value as 'stdio' | 'sse' })}
              className={inputCls}
            >
              <option value="stdio">stdio（本地子进程）</option>
              <option value="sse">SSE（远程服务）</option>
            </select>
          </label>
          {mcpDraft.type === 'sse' ? (
            <label className="col-span-2 flex flex-col gap-1 text-sm">
              SSE URL
              <input value={mcpDraft.url} onChange={(e) => setMcpDraft({ ...mcpDraft, url: e.target.value })} placeholder="https://example.com/mcp/sse" className={inputCls} />
            </label>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-sm">
                启动命令
                <input value={mcpDraft.command} onChange={(e) => setMcpDraft({ ...mcpDraft, command: e.target.value })} placeholder="python / npx / uvx" className={inputCls} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                参数（逗号或换行分隔）
                <textarea
                  value={mcpArgs}
                  onChange={(e) => setMcpArgs(e.target.value)}
                  rows={2}
                  placeholder={'-y @modelcontextprotocol/server-filesystem C:\\path\\to\\dir'}
                  className={inputCls}
                />
              </label>
            </>
          )}
        </div>
        <div className="mt-4 flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={mcpDraft.enabled}
              onChange={(e) => setMcpDraft({ ...mcpDraft, enabled: e.target.checked })}
            />
            启用
          </label>
          <div className="flex gap-2">
            {mcpEditIdx != null && (
              <button
                onClick={() => {
                  setMcpEditIdx(null)
                  setMcpDraft({ ...EMPTY_MCP })
                  setMcpArgs('')
                  setMcpError('')
                }}
                className="rounded-md px-4 py-1.5 text-sm text-neutral-500"
              >
                取消
              </button>
            )}
            <button onClick={applyMcpDraft} className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110">
              {mcpEditIdx != null ? '保存修改' : '添加'}
            </button>
          </div>
        </div>
        {mcpError && <p className="mt-3 text-xs text-red-500">{mcpError}</p>}
      </section>

      <p className="mt-6 text-xs leading-relaxed text-neutral-400">
        提示：模型在对话页显示为 provider名/模型名。OpenAI 兼容协议可接 DeepSeek、Qwen、Moonshot、Ollama、OpenRouter 等，填对应 base_url 即可。
        MCP server 支持 stdio 与 SSE，可在对话中让模型调用外部工具。
      </p>
      </>
      )}

      </main>
      </div>
    </>
  )
}