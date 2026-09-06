import { useCallback, useEffect, useState } from 'react'
import Layout from './Layout'
import { api, type AgentPreset, type ArenaResult, type BackupList, type FeedItem, type HealthReport, type ImageItem, type McpServer, type McpProbe, type McpView, type MemoryExpose, type MemoryItem, type MemoryTidyReport, type ModelProbe, type PromptItem, type ProviderConfig, type ScheduledTask, type SkillItem, type TaskRunItem, type TaskTool, type TutorProfile } from './api'

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fmtTime(iso: string | null): string {
  return iso ? iso.slice(5, 16).replace('T', ' ') : '—'
}

const EMPTY = { name: '', kind: 'openai' as 'openai' | 'anthropic', base_url: '', api_key: '', models: '', enabled: true }
const EMPTY_MCP: McpServer = { name: '', type: 'stdio', command: '', args: [], url: '', enabled: true }
const EMPTY_AGENT = {
  name: '',
  avatar: '🤖',
  system_prompt: '',
  model_id: '',
  use_rag: false,
  tools_enabled: true,
  enabled: true,
}

const EMPTY_TASK = {
  name: '',
  prompt: '',
  cron: '0 9 * * *',
  model_id: '',
  use_rag: false,
  tools_enabled: true,
  save_to_vault: false,
  enabled: true,
  mode: 'simple' as 'simple' | 'agent',
  tool_whitelist: '',
  max_rounds: 12,
  retry: 1,
  notify_on_error: false,
  trigger_kind: 'cron' as 'cron' | 'watch',
  watch_path: '',
  chain_next_id: null as number | null,
}

const SETTING_SECTIONS = [
  { key: 'general', icon: '⚙️', label: '通用' },
  { key: 'models', icon: '🧠', label: '模型' },
  { key: 'agents', icon: '🤖', label: '智能体' },
  { key: 'automation', icon: '⏰', label: '自动化' },
  { key: 'content', icon: '🎨', label: '内容生成' },
  { key: 'data', icon: '💾', label: '数据' },
  { key: 'mcp', icon: '🔌', label: 'MCP' },
] as const

type SectionKey = (typeof SETTING_SECTIONS)[number]['key']

export default function SettingsPage() {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [probes, setProbes] = useState<Record<number, ModelProbe[]>>({})
  const [probing, setProbing] = useState<number | null>(null)
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [draft, setDraft] = useState({ ...EMPTY })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [error, setError] = useState('')
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

  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [taskDraft, setTaskDraft] = useState({ ...EMPTY_TASK })
  const [taskEditId, setTaskEditId] = useState<number | null>(null)
  const [taskNl, setTaskNl] = useState('')
  const [taskBusy, setTaskBusy] = useState('')  // 'parse' | 'run-<id>' | ''
  const [taskMsg, setTaskMsg] = useState('')
  const [taskTools, setTaskTools] = useState<TaskTool[]>([])
  const [taskRuns, setTaskRuns] = useState<Record<number, TaskRunItem[]>>({})

  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [tutorProfile, setTutorProfile] = useState<TutorProfile | null>(null)
  const [memInput, setMemInput] = useState('')
  const [memEditId, setMemEditId] = useState<number | null>(null)
  const [memEditContent, setMemEditContent] = useState('')
  const [memMsg, setMemMsg] = useState('')
  const [memExpose, setMemExpose] = useState<MemoryExpose | null>(null)
  const [tidyBusy, setTidyBusy] = useState(false)
  const [tidyReport, setTidyReport] = useState<MemoryTidyReport | null>(null)
  const [ttsVoices, setTtsVoices] = useState<string[]>([])

  const [agents, setAgents] = useState<AgentPreset[]>([])
  const [agentDraft, setAgentDraft] = useState({ ...EMPTY_AGENT })
  const [agentEditId, setAgentEditId] = useState<number | null>(null)

  const [mcpView, setMcpView] = useState<McpView | null>(null)
  const [mcpDraft, setMcpDraft] = useState<McpServer>({ ...EMPTY_MCP })
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpEditIdx, setMcpEditIdx] = useState<number | null>(null)
  const [probe, setProbe] = useState<Record<string, McpProbe | 'loading'>>({})
  const [mcpError, setMcpError] = useState('')

  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [promptDraft, setPromptDraft] = useState({ title: '', content: '' })
  const [promptEditId, setPromptEditId] = useState<number | null>(null)

  const [skillItems, setSkillItems] = useState<SkillItem[]>([])
  const [skillUrl, setSkillUrl] = useState('')
  const [skillBusy, setSkillBusy] = useState(false)
  const [skillMsg, setSkillMsg] = useState('')
  const [skillContent, setSkillContent] = useState<Record<string, string>>({})

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
      api.listMemories().then(setMemories).catch(() => {})
      api.tutorProfile().then(setTutorProfile).catch(() => {})
      api.getMemoryTidy().then((s) => setTidyReport(s.report)).catch(() => {})
      api.ttsVoices().then((r) => setTtsVoices(r.voices)).catch(() => {})
      api.listAgents().then(setAgents).catch(() => {})
      api.listPrompts().then(setPrompts).catch(() => {})
      api.listBackups().then(setBackups).catch(() => {})
      api.listTasks().then(setTasks).catch(() => {})
      api.listTaskTools().then(setTaskTools).catch(() => {})
      api.listSkills().then((r) => setSkillItems(r.skills)).catch(() => {})
      api.listImages().then((r) => setImages(r.images)).catch(() => {})
      api.listFeeds().then((r) => {
        setFeeds(r.feeds)
        setFeedsNextRun(r.next_run)
      }).catch(() => {})
    } catch (e) {
      setError(String(e))
    }
  }, [])

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
    api.listBackups().then(setBackups).catch(() => {})
    api.listFeeds().then((r) => setFeeds(r.feeds)).catch(() => {})
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

  // ---- scheduled tasks ----

  async function saveTask() {
    if (!taskDraft.name.trim() || !taskDraft.prompt.trim()) {
      setTaskMsg('✗ 任务名和指令都必填')
      return
    }
    if (taskDraft.trigger_kind === 'watch' && !taskDraft.watch_path.trim()) {
      setTaskMsg('✗ 文件变化触发需要填写监听路径（留空表示整个 vault 可直接选 cron）')
      return
    }
    const payload = {
      ...taskDraft,
      name: taskDraft.name.trim(),
      prompt: taskDraft.prompt.trim(),
      cron: taskDraft.cron.trim(),
      watch_path: taskDraft.watch_path.trim(),
    }
    try {
      if (taskEditId != null) await api.updateTask(taskEditId, payload)
      else await api.createTask(payload)
      setTaskDraft({ ...EMPTY_TASK })
      setTaskEditId(null)
      setTaskMsg('')
      setTasks(await api.listTasks())
    } catch (e) {
      setTaskMsg(`✗ ${String(e)}`)
    }
  }

  function editTask(t: ScheduledTask) {
    setTaskEditId(t.id)
    setTaskMsg('')
    setTaskDraft({
      name: t.name,
      prompt: t.prompt,
      cron: t.cron,
      model_id: t.model_id,
      use_rag: t.use_rag,
      tools_enabled: t.tools_enabled,
      save_to_vault: t.save_to_vault,
      enabled: t.enabled,
      mode: t.mode || 'simple',
      tool_whitelist: t.tool_whitelist || '',
      max_rounds: t.max_rounds || 12,
      retry: t.retry ?? 1,
      notify_on_error: !!t.notify_on_error,
      trigger_kind: t.trigger_kind || 'cron',
      watch_path: t.watch_path || '',
      chain_next_id: t.chain_next_id,
    })
  }

  function toggleTaskTool(name: string) {
    const selected = taskDraft.tool_whitelist.split(',').map((s) => s.trim()).filter(Boolean)
    const next = selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]
    setTaskDraft({ ...taskDraft, tool_whitelist: next.join(',') })
  }

  function taskToolChecked(name: string): boolean {
    // empty whitelist = no restriction (all tools on)
    if (!taskDraft.tool_whitelist.trim()) return false
    return taskDraft.tool_whitelist.split(',').map((s) => s.trim()).includes(name)
  }

  async function loadRuns(t: ScheduledTask) {
    if (taskRuns[t.id]) return
    setTaskRuns((m) => ({ ...m, [t.id]: [] }))
    try {
      const runs = await api.listTaskRuns(t.id)
      setTaskRuns((m) => ({ ...m, [t.id]: runs }))
    } catch {
      setTaskRuns((m) => {
        const copy = { ...m }
        delete copy[t.id]
        return copy
      })
    }
  }

  function chainName(id: number | null | undefined): string {
    if (id == null) return ''
    return tasks.find((x) => x.id === id)?.name || `#${id}`
  }

  async function removeTask(t: ScheduledTask) {
    if (!window.confirm(`删除定时任务「${t.name}」？历史会话不会被删除。`)) return
    await api.deleteTask(t.id).catch((e) => setTaskMsg(`✗ ${String(e)}`))
    if (taskEditId === t.id) {
      setTaskEditId(null)
      setTaskDraft({ ...EMPTY_TASK })
    }
    setTasks(await api.listTasks())
  }

  async function toggleTask(t: ScheduledTask) {
    await api.updateTask(t.id, { enabled: !t.enabled }).catch((e) => setTaskMsg(`✗ ${String(e)}`))
    setTasks(await api.listTasks())
  }

  async function runTaskNow(t: ScheduledTask) {
    setTaskBusy(`run-${t.id}`)
    setTaskMsg('')
    try {
      const r = await api.runTask(t.id)
      setTaskMsg(
        r.status === 'ok'
          ? `✓ 「${t.name}」执行成功（${r.model_id}${r.sources ? `，引用 ${r.sources} 个片段` : ''}` +
            (r.tool_calls ? `，${r.rounds} 轮 ${r.tool_calls} 次工具调用` : '') +
            (r.vault_file ? `，已写入 ${r.vault_file}` : '') +
            '）'
          : `✗ 「${t.name}」执行失败：${r.error}`
      )
      setTasks(await api.listTasks())
      setTaskRuns((m) => {
        const copy = { ...m }
        delete copy[t.id]  // refetch on next expand
        return copy
      })
    } catch (e) {
      setTaskMsg(`✗ ${String(e)}`)
    } finally {
      setTaskBusy('')
    }
  }

  async function parseTaskNl() {
    if (!taskNl.trim()) return
    setTaskBusy('parse')
    setTaskMsg('')
    try {
      const d = await api.parseTask(taskNl.trim())
      setTaskDraft({ ...EMPTY_TASK, ...taskDraft, name: d.name, prompt: d.prompt, cron: d.cron })
      setTaskMsg(`✓ 已解析为 cron「${d.cron}」，确认后点「添加」`)
    } catch (e) {
      setTaskMsg(`✗ ${String(e)}`)
    } finally {
      setTaskBusy('')
    }
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

  // ---- persistent memory ----

  async function addMemory() {
    const content = memInput.trim()
    if (!content) return
    await api.addMemory(content)
    setMemInput('')
    setMemories(await api.listMemories())
  }

  async function removeMemory(id: number) {
    await api.deleteMemory(id)
    setMemories(await api.listMemories())
  }

  async function saveMemoryEdit() {
    if (memEditId == null) return
    const content = memEditContent.trim()
    if (!content) return
    try {
      await api.updateMemory(memEditId, content)
      setMemEditId(null)
      setMemMsg('')
      setMemories(await api.listMemories())
    } catch (e) {
      setMemMsg(`✗ ${String(e)}`)
    }
  }

  async function clearAllMemories() {
    if (!confirm('清空全部长期记忆？')) return
    await api.clearMemories()
    setMemories(await api.listMemories())
  }

  async function runTidy() {
    if (tidyBusy) return
    setTidyBusy(true)
    try {
      const report = await api.runMemoryTidy()
      setTidyReport(report)
      setMemories(await api.listMemories())
    } catch (e) {
      setTidyReport({ ok: false, error: String(e) })
    } finally {
      setTidyBusy(false)
    }
  }

  // ---- skills ----

  async function installSkill() {
    const url = skillUrl.trim()
    if (!url || skillBusy) return
    setSkillBusy(true)
    setSkillMsg('下载并安装中…')
    try {
      const r = await api.installSkill(url)
      setSkillUrl('')
      setSkillMsg(`✓ 已安装技能「${r.name}」(${r.chars} 字)`)
      setSkillItems((await api.listSkills()).skills)
    } catch (e) {
      setSkillMsg(`✗ ${String(e)}`)
    } finally {
      setSkillBusy(false)
    }
  }

  async function removeSkill(name: string) {
    if (!confirm(`删除技能「${name}」？`)) return
    await api.deleteSkill(name).catch((e) => setSkillMsg(`✗ ${String(e)}`))
    setSkillItems((await api.listSkills()).skills)
  }

  async function viewSkill(name: string) {
    if (skillContent[name] !== undefined) return
    try {
      const r = await api.readSkill(name)
      setSkillContent((m) => ({ ...m, [name]: r.content }))
    } catch {
      setSkillContent((m) => ({ ...m, [name]: '（加载失败）' }))
    }
  }

  // ---- agent presets ----

  async function saveAgent() {
    if (!agentDraft.name.trim()) {
      setError('智能体名称必填')
      return
    }
    try {
      if (agentEditId != null) await api.updateAgent(agentEditId, agentDraft)
      else await api.createAgent(agentDraft)
      setAgentDraft({ ...EMPTY_AGENT })
      setAgentEditId(null)
      setError('')
      setAgents(await api.listAgents())
    } catch (e) {
      setError(String(e))
    }
  }

  function editAgent(a: AgentPreset) {
    setAgentEditId(a.id)
    setAgentDraft({
      name: a.name,
      avatar: a.avatar,
      system_prompt: a.system_prompt,
      model_id: a.model_id,
      use_rag: a.use_rag,
      tools_enabled: a.tools_enabled,
      enabled: a.enabled,
    })
  }

  async function removeAgent(id: number) {
    const a = agents.find((x) => x.id === id)
    if (!confirm(`删除智能体「${a?.name ?? id}」？`)) return
    await api.deleteAgent(id)
    if (agentEditId === id) {
      setAgentEditId(null)
      setAgentDraft({ ...EMPTY_AGENT })
    }
    setAgents(await api.listAgents())
  }

  // ---- prompt library ----

  async function savePrompt() {
    if (!promptDraft.title.trim()) {
      setError('提示词标题必填')
      return
    }
    try {
      if (promptEditId != null) await api.updatePrompt(promptEditId, promptDraft)
      else await api.createPrompt(promptDraft)
      setPromptDraft({ title: '', content: '' })
      setPromptEditId(null)
      setError('')
      setPrompts(await api.listPrompts())
    } catch (e) {
      setError(String(e))
    }
  }

  async function removePrompt(id: number) {
    if (!confirm('删除该提示词？')) return
    await api.deletePrompt(id)
    if (promptEditId === id) {
      setPromptEditId(null)
      setPromptDraft({ title: '', content: '' })
    }
    setPrompts(await api.listPrompts())
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

  const [section, setSection] = useState<SectionKey>('general')

  // 体检报告 + 模型竞技场（agents 页签）：进入页签时才拉取，失败静默。
  // 这两个状态必须放在 section 声明之后——useEffect 的依赖数组引用它。
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [mcpSharedCopied, setMcpSharedCopied] = useState(false)
  const [arenaPrompt, setArenaPrompt] = useState('用三句话解释什么是闭包')
  const [arenaBusy, setArenaBusy] = useState(false)
  const [arenaResults, setArenaResults] = useState<ArenaResult[] | null>(null)
  const [arenaError, setArenaError] = useState('')

  useEffect(() => {
    if (section !== 'agents' || health) return
    api.healthReport().then(setHealth).catch(() => {})
  }, [section, health])

  async function runArena() {
    if (arenaBusy || !arenaPrompt.trim()) return
    setArenaBusy(true)
    setArenaError('')
    try {
      const r = await api.arenaRun(arenaPrompt)
      setArenaResults(r.results)
    } catch (e) {
      setArenaError(e instanceof Error ? e.message : String(e))
    } finally {
      setArenaBusy(false)
    }
  }

  const inputCls =
    'w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700'

  return (
    <Layout page="settings">
      <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">设置</h1>
      </div>

      <div className="flex gap-6">
        <aside className="w-44 shrink-0">
          <nav className="sticky top-6 flex flex-col gap-1">
            {SETTING_SECTIONS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  section === s.key
                    ? 'bg-violet-100 font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
                    : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200'
                }`}
              >
                <span className="text-base leading-none">{s.icon}</span>
                {s.label}
              </button>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1">
      {/* General preferences */}
      {section === 'general' && !prefs && (
        <p className="py-8 text-sm text-neutral-400">加载中…</p>
      )}
      {section === 'general' && prefs && (
        <section className="mb-6 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
          <h2 className="mb-4 flex items-center gap-2 font-semibold"><span>⚙️</span> 通用</h2>
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
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.memory_tidy_enabled}
                onChange={(e) => setPrefs({ ...prefs, memory_tidy_enabled: e.target.checked })}
              />
              睡眠期整理（每天凌晨自动合并语义重复的记忆，只在发现重复时才调用模型）
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
            <div className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefs.digest_enabled}
                id="digest-toggle"
                hidden
                className="peer/digest"
                onChange={(e) => setPrefs({ ...prefs, digest_enabled: e.target.checked })}
              />
              <button
                type="button"
                onClick={() => setPrefs({ ...prefs, digest_enabled: !prefs.digest_enabled })}
                role="switch"
                aria-checked={prefs.digest_enabled}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  prefs.digest_enabled ? 'bg-violet-600' : 'bg-neutral-300 dark:bg-neutral-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                    prefs.digest_enabled ? 'left-[18px]' : 'left-0.5'
                  }`}
                />
              </button>
              每日定时笔记摘要
              <input
                type="time"
                value={prefs.digest_time}
                disabled={!prefs.digest_enabled}
                onChange={(e) => setPrefs({ ...prefs, digest_time: e.target.value })}
                className={`${inputCls} w-28 disabled:opacity-40`}
              />
              <span className="text-xs text-neutral-400">写入 vault/digests/，自动进入知识库索引</span>
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
        <section className="mb-6 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span>⚡</span> 轻执行 Artifacts</h2>
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
        <section className="mb-6 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span>🖼️</span> 图片生成</h2>
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
                        className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 rounded-full bg-red-500 text-xs leading-5 text-white group-hover:block"
                      >
                        ×
                      </button>
                      <span className="mt-1 block w-24 truncate text-[10px] text-neutral-400">
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
        <section className="mb-6 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span>💾</span> 备份与恢复</h2>
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
        <section className="mb-6 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span>🎴</span> 复习卡片</h2>
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
          <div className="mb-3 rounded-xl bg-neutral-100 px-3 py-2 text-xs leading-relaxed text-neutral-500 dark:bg-neutral-800/60 dark:text-neutral-400">
            复习已按 PLAN.md 第 3 节封存：不再有每日到期提醒，也不再有每周补讲。
            页面还在 <code>/review.html</code>，你自己想开就开；它不会再主动找你。
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
        <section className="mb-6 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span>📡</span> RSS 订阅</h2>
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
        <section className="mb-6 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span>📧</span> 邮件推送</h2>
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
      {section === 'automation' && (
      <section className="mb-6 flex flex-col gap-3 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="flex items-center gap-2 font-semibold"><span>⏰</span> 定时任务</h2>
        <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
          三种玩法：① 简单执行——到点跑一条指令（可带知识库与工具）；② 自主智能体——给目标让它多轮调用工具干到完成，全程留执行日志；
          ③ 任务链——上游任务的产出自动交给下游继续处理（经 vault/tasks/handoff/ 交接，可人工干预）。触发支持 cron 或 vault
          文件变化。时间用 5 段 crontab：<code className="text-neutral-500">分 时 日 月 周</code>（本地时区）。
        </p>
        {tasks.map((t) => (
          <div
            key={t.id}
            className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.mode === 'agent' ? '🤖' : t.trigger_kind === 'watch' ? '📁' : '⏰'} {t.name}</span>
                  {t.mode === 'agent' && (
                    <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-600 dark:bg-violet-950 dark:text-violet-300">
                      自主智能体
                    </span>
                  )}
                  {t.trigger_kind === 'watch' ? (
                    <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                      📁 监听 {t.watch_path || '/'}
                    </code>
                  ) : (
                    <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                      {t.cron}
                    </code>
                  )}
                  {t.chain_next_id != null && (
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                      → {chainName(t.chain_next_id)}
                    </span>
                  )}
                  {t.running && (
                    <span className="animate-pulse rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-600 dark:bg-violet-950 dark:text-violet-300">
                      运行中…
                    </span>
                  )}
                  {!t.enabled && <span className="text-xs text-red-500">已停用</span>}
                  {t.last_status === 'ok' && !t.running && <span className="text-xs text-emerald-500">上次 ✓</span>}
                  {t.last_status === 'error' && <span className="text-xs text-red-500">上次 ✗</span>}
                </div>
                <div className="truncate text-xs text-neutral-500">{t.prompt}</div>
                <div className="mt-0.5 text-xs text-neutral-400">
                  {t.trigger_kind === 'watch'
                    ? `文件变化触发${t.watch_path ? ` · ${t.watch_path}` : ' · 整个 vault'}`
                    : `下次 ${t.enabled ? fmtTime(t.next_run) : '—'}`}
                  {' · '}上次 {fmtTime(t.last_run)}
                  {t.model_id && ` · ${t.model_id}`}
                  {t.use_rag && ' · RAG'}
                  {t.mode === 'agent' ? ` · 智能体 ≤${t.max_rounds} 轮` : !t.tools_enabled && ' · 无工具'}
                  {t.save_to_vault && ' · 写入 vault'}
                  {(t.retry ?? 0) > 0 && ` · 失败重试 ${t.retry}`}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-2 text-sm">
                <button
                  onClick={() => runTaskNow(t)}
                  disabled={taskBusy === `run-${t.id}`}
                  className="text-violet-600 hover:underline disabled:opacity-50 dark:text-violet-300"
                >
                  {taskBusy === `run-${t.id}` ? '运行中…' : '立即运行'}
                </button>
                {t.conversation_id && (
                  <a href={`/?conv=${t.conversation_id}`} className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
                    会话
                  </a>
                )}
                <button onClick={() => toggleTask(t)} className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
                  {t.enabled ? '停用' : '启用'}
                </button>
                <button onClick={() => editTask(t)} className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
                  编辑
                </button>
                <button onClick={() => removeTask(t)} className="text-red-400 hover:text-red-600">
                  删除
                </button>
              </div>
            </div>
            {t.last_result && (
              <details className="mt-2 text-xs text-neutral-500">
                <summary className="cursor-pointer select-none">上次结果</summary>
                <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-3 leading-relaxed dark:bg-neutral-900">
                  {t.last_result}
                </pre>
              </details>
            )}
            <details
              className="mt-2 text-xs text-neutral-500"
              onToggle={(e) => {
                if ((e.target as HTMLDetailsElement).open) void loadRuns(t)
              }}
            >
              <summary className="cursor-pointer select-none">运行记录</summary>
              <div className="mt-2 space-y-1.5">
                {(taskRuns[t.id] || []).map((r) => (
                  <details key={r.id} className="rounded-md bg-neutral-50 px-2.5 py-1.5 dark:bg-neutral-900">
                    <summary className="flex cursor-pointer flex-wrap select-none items-center gap-2">
                      <span
                        className={
                          r.status === 'ok' ? 'text-emerald-600' : r.status === 'running' ? 'text-amber-500' : 'text-red-500'
                        }
                      >
                        {r.status === 'ok' ? '✓' : r.status === 'running' ? '…' : '✗'}
                      </span>
                      <span>{fmtTime(r.started_at)}</span>
                      <span className="text-neutral-400">
                        {r.trigger === 'chain'
                          ? `链 · 来自 ${chainName(r.upstream_task_id)}`
                          : { cron: '定时', manual: '手动', watch: '文件变化' }[r.trigger] || r.trigger}
                      </span>
                      {r.tool_calls > 0 && (
                        <span className="text-neutral-400">
                          {r.rounds} 轮 · {r.tool_calls} 次工具调用
                        </span>
                      )}
                      {r.status === 'error' && <span className="truncate text-red-400">{r.error}</span>}
                    </summary>
                    {r.log.length > 0 && (
                      <div className="mt-1.5 space-y-1">
                        {r.log.map((entry, i) => (
                          <div key={i} className="rounded bg-white px-2 py-1 dark:bg-neutral-800">
                            <div className="font-mono">{entry.ok ? '🔧' : '⚠️'} {entry.tool}</div>
                            <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-neutral-400">
                              {JSON.stringify(entry.args)}
                            </pre>
                            <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-neutral-500">{entry.result}</pre>
                          </div>
                        ))}
                      </div>
                    )}
                    {r.status === 'ok' && r.answer && (
                      <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap text-neutral-500">{r.answer}</pre>
                    )}
                  </details>
                ))}
                {taskRuns[t.id] && taskRuns[t.id].length === 0 && <p className="text-neutral-400">还没有运行记录</p>}
                {!taskRuns[t.id] && <p className="text-neutral-400">加载中…</p>}
              </div>
            </details>
          </div>
        ))}
        {!tasks.length && <p className="text-sm text-neutral-400">还没有定时任务</p>}
        <div className="rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
          <h3 className="mb-3 text-sm font-medium">
            {taskEditId != null ? `编辑「${taskDraft.name}」` : '新增定时任务'}
          </h3>
          <label className="flex flex-col gap-1 text-sm">
            用中文描述（模型帮你转成 cron 并起草指令）
            <div className="flex gap-2">
              <input
                value={taskNl}
                onChange={(e) => setTaskNl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void parseTaskNl()
                  }
                }}
                placeholder="每天早上 8 点帮我总结知识库新增内容"
                className={`${inputCls} flex-1`}
              />
              <button
                onClick={parseTaskNl}
                disabled={taskBusy === 'parse' || !taskNl.trim()}
                className="shrink-0 rounded-md border border-violet-500 px-3 py-1.5 text-sm font-medium text-violet-600 transition-colors hover:bg-violet-50 disabled:opacity-50 dark:text-violet-300 dark:hover:bg-violet-950"
              >
                {taskBusy === 'parse' ? '解析中…' : '解析'}
              </button>
            </div>
          </label>
          <div className="mt-3 grid grid-cols-[1fr_150px_210px] gap-4">
            <label className="flex flex-col gap-1 text-sm">
              任务名
              <input
                value={taskDraft.name}
                onChange={(e) => setTaskDraft({ ...taskDraft, name: e.target.value })}
                placeholder="知识库日报"
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              cron
              <input
                value={taskDraft.cron}
                onChange={(e) => setTaskDraft({ ...taskDraft, cron: e.target.value })}
                placeholder="0 9 * * *"
                className={`${inputCls} font-mono`}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              执行模式
              <select
                value={taskDraft.mode}
                onChange={(e) => setTaskDraft({ ...taskDraft, mode: e.target.value as 'simple' | 'agent' })}
                className={inputCls}
              >
                <option value="simple">简单执行</option>
                <option value="agent">自主智能体</option>
              </select>
            </label>
          </div>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            指令（{taskDraft.mode === 'agent' ? '给智能体的目标，它会自己决定调用哪些工具' : '到点发给模型的内容'}）
            <textarea
              value={taskDraft.prompt}
              onChange={(e) => setTaskDraft({ ...taskDraft, prompt: e.target.value })}
              rows={3}
              placeholder={taskDraft.mode === 'agent' ? '整理 vault/tasks/ 下最近生成的日报，把要点合并成一篇周报写到 vault/reports/。' : '总结我知识库里最近新增或修改的内容，按主题归纳要点。'}
              className={`${inputCls} resize-y`}
            />
          </label>
          {taskDraft.mode === 'agent' && (
            <div className="mt-3 grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1 text-sm">
                工具循环轮数上限（1-30）
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={taskDraft.max_rounds}
                  onChange={(e) => setTaskDraft({ ...taskDraft, max_rounds: Number(e.target.value) || 12 })}
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                失败自动重试次数（0-3）
                <input
                  type="number"
                  min={0}
                  max={3}
                  value={taskDraft.retry}
                  onChange={(e) => setTaskDraft({ ...taskDraft, retry: Number(e.target.value) || 0 })}
                  className={inputCls}
                />
              </label>
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              模型（留空 = 第一个启用的 provider）
              <select
                value={taskDraft.model_id}
                onChange={(e) => setTaskDraft({ ...taskDraft, model_id: e.target.value })}
                className={inputCls}
              >
                <option value="">自动选择</option>
                {providers
                  .flatMap((p) => (p.enabled ? p.models.map((m) => `${p.name}/${m}`) : []))
                  .map((mid) => (
                    <option key={mid} value={mid}>
                      {mid}
                    </option>
                  ))}
              </select>
            </label>
            <div className="flex flex-col justify-end gap-2 pb-1 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={taskDraft.use_rag}
                  onChange={(e) => setTaskDraft({ ...taskDraft, use_rag: e.target.checked })}
                />
                检索知识库(RAG)
              </label>
              {taskDraft.mode === 'simple' && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={taskDraft.tools_enabled}
                    onChange={(e) => setTaskDraft({ ...taskDraft, tools_enabled: e.target.checked })}
                  />
                  允许使用工具（联网/读写 vault…）
                </label>
              )}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={taskDraft.save_to_vault}
                  onChange={(e) => setTaskDraft({ ...taskDraft, save_to_vault: e.target.checked })}
                />
                结果写入 vault/tasks/（自动进索引）
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={taskDraft.notify_on_error}
                  onChange={(e) => setTaskDraft({ ...taskDraft, notify_on_error: e.target.checked })}
                />
                失败时邮件通知（需配置 SMTP）
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={taskDraft.enabled}
                  onChange={(e) => setTaskDraft({ ...taskDraft, enabled: e.target.checked })}
                />
                启用
              </label>
            </div>
          </div>
          {(taskDraft.mode === 'agent' || taskDraft.tools_enabled) && taskTools.length > 0 && (
            <div className="mt-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
              <div className="flex flex-wrap items-center justify-between gap-1">
                <span className="text-sm">工具白名单</span>
                <span className="text-xs text-neutral-400">
                  不勾选 = 全部可用；任务无人值守，建议只留必需工具
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5 md:grid-cols-3">
                {taskTools.map((tool) => (
                  <label key={tool.name} className="flex min-w-0 items-center gap-1.5 text-xs" title={tool.description}>
                    <input
                      type="checkbox"
                      checked={taskToolChecked(tool.name)}
                      onChange={() => toggleTaskTool(tool.name)}
                    />
                    <span className="truncate font-mono">{tool.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="mt-3 grid grid-cols-[160px_1fr] gap-4">
            <label className="flex flex-col gap-1 text-sm">
              触发方式
              <select
                value={taskDraft.trigger_kind}
                onChange={(e) => setTaskDraft({ ...taskDraft, trigger_kind: e.target.value as 'cron' | 'watch' })}
                className={inputCls}
              >
                <option value="cron">定时（cron）</option>
                <option value="watch">文件变化</option>
              </select>
            </label>
            {taskDraft.trigger_kind === 'watch' ? (
              <label className="flex flex-col gap-1 text-sm">
                监听路径（vault 内相对路径，目录或单个文件）
                <input
                  value={taskDraft.watch_path}
                  onChange={(e) => setTaskDraft({ ...taskDraft, watch_path: e.target.value })}
                  placeholder="如 feeds/ 或 notes/日记.md"
                  className={`${inputCls} font-mono`}
                />
                <span className="text-xs text-neutral-400">
                  文件新增/修改后自动运行；同一任务 90 秒冷却，任务自己写入的文件不会再次触发自己
                </span>
              </label>
            ) : (
              <div className="flex flex-col justify-end pb-1.5 text-xs text-neutral-400">
                5 段 crontab：分 时 日 月 周（本地时区）；不想等固定时刻可改用「文件变化」触发
              </div>
            )}
          </div>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            下游任务（任务链：本任务成功后，产出经 vault/tasks/handoff/ 自动交给下游继续处理）
            <select
              value={taskDraft.chain_next_id ?? ''}
              onChange={(e) =>
                setTaskDraft({ ...taskDraft, chain_next_id: e.target.value === '' ? null : Number(e.target.value) })
              }
              className={inputCls}
            >
              <option value="">无（不链接下游）</option>
              {tasks
                .filter((x) => x.id !== taskEditId)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="mt-4 flex justify-end gap-2">
            {taskEditId != null && (
              <button
                onClick={() => {
                  setTaskEditId(null)
                  setTaskDraft({ ...EMPTY_TASK })
                }}
                className="rounded-md px-4 py-1.5 text-sm text-neutral-500"
              >
                取消
              </button>
            )}
            <button
              onClick={saveTask}
              className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110"
            >
              {taskEditId != null ? '保存修改' : '添加'}
            </button>
          </div>
        </div>
        {taskMsg && <div className="text-xs text-neutral-600 dark:text-neutral-300">{taskMsg}</div>}
      </section>
      )}

      {/* Existing providers */}
      {section === 'models' && (
      <section className="mb-6 flex flex-col gap-3 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="flex items-center gap-2 font-semibold"><span>🧠</span> 模型 Provider</h2>
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
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
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
                  <p className="pt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
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
      {/* 体检报告：自检 + 备份 + 索引 + 任务失败 + 整理员，一页看全 */}
      <section className="mb-6 flex flex-col gap-3 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="flex items-center gap-2 font-semibold"><span>🩺</span> 体检报告</h2>
        {!health ? (
          <p className="text-xs text-neutral-400">正在体检…</p>
        ) : (
          <ul className="space-y-1.5 text-xs leading-relaxed">
            <li>
              {health.self.default_model_broken
                ? <span className="text-rose-600 dark:text-rose-400">⚠️ 默认模型不可用：{health.self.default_model}</span>
                : <span className="text-emerald-600 dark:text-emerald-400">✅ 默认模型 {health.self.default_model || '（未配置）'}</span>}
              {health.self.models_broken.length > 0 && (
                <span className="text-amber-600 dark:text-amber-400">
                  {' '}· 另有 {health.self.models_broken.length} 个模型探测失败
                </span>
              )}
            </li>
            <li>
              {health.self.jobs_failing.length > 0
                ? <span className="text-amber-600 dark:text-amber-400">⚠️ 后台作业连续失败：{health.self.jobs_failing.map((j) => `${j.job_id}×${j.fails}`).join('、')}</span>
                : <span className="text-emerald-600 dark:text-emerald-400">✅ 后台作业全部正常（{health.self.jobs_live}/{health.self.jobs_total} 在跑）</span>}
            </li>
            <li>
              {health.backups.count > 0
                ? <span className="text-emerald-600 dark:text-emerald-400">✅ 最近备份 {fmtTime(health.backups.latest_at)}（共 {health.backups.count} 份）</span>
                : <span className="text-amber-600 dark:text-amber-400">⚠️ 还没有备份——备份是唯一不可重建资产的安全网</span>}
            </li>
            <li>
              <span className="text-neutral-500">📚 索引：{health.kb.indexer?.chunks ?? 0} 块 / {health.kb.indexer?.files ?? 0} 个来源</span>
            </li>
            <li>
              {health.tasks_failing.length > 0
                ? <span className="text-amber-600 dark:text-amber-400">⚠️ 定时任务上次失败：{health.tasks_failing.map((t) => t.name).join('、')}</span>
                : <span className="text-emerald-600 dark:text-emerald-400">✅ 定时任务没有失败记录</span>}
            </li>
            <li>
              <span className="text-neutral-500">
                🧹 记忆整理员：{health.tidy && (health.tidy as { ran_at?: string }).ran_at
                  ? `上次整理 ${(health.tidy as { ran_at?: string }).ran_at?.slice(0, 16).replace('T', ' ')}`
                  : '还没跑过（夜间自动或手动触发）'}
              </span>
            </li>
          </ul>
        )}
      </section>

      {/* MCP server（能力开放）：把工作台的读状态开放给外部 MCP 客户端 */}
      <section className="mb-6 flex flex-col gap-3 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="flex items-center gap-2 font-semibold"><span>🔌</span> MCP 服务器（对外只读）</h2>
        <p className="text-xs leading-relaxed text-neutral-500">
          外部 MCP 客户端（Claude Desktop 等）可以连进来查你的知识库、对话/教学历史、长期记忆、学习画像和今日建议。
          端点只绑本机（127.0.0.1），且全部是<strong>读</strong>操作——外部工具看工作台，改动仍走工作台自己的界面。
        </p>
        <div className="flex items-center gap-2 text-xs">
          <code className="rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-800">{window.location.origin}/mcp</code>
          <button
            onClick={() => {
              const cfg = JSON.stringify(
                { mcpServers: { 'ai-workbench': { type: 'http', url: `${window.location.origin}/mcp` } } },
                null,
                2,
              )
              void navigator.clipboard.writeText(cfg).then(() => {
                setMcpSharedCopied(true)
                setTimeout(() => setMcpSharedCopied(false), 2000)
              })
            }}
            className="rounded-full border border-neutral-300 px-2.5 py-0.5 transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:hover:border-violet-500 dark:hover:text-violet-300"
          >
            {mcpSharedCopied ? '✓ 已复制' : '复制客户端配置'}
          </button>
        </div>
        <p className="text-xs text-neutral-400">
          工具：search_knowledge · search_history · get_user_memory · get_learning_profile · get_today_briefing
        </p>
      </section>

      {/* 模型竞技场：同一段 prompt 打到所有已启用 provider 并排对比 */}
      <section className="mb-6 flex flex-col gap-3 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="flex items-center gap-2 font-semibold"><span>🏟️</span> 模型竞技场</h2>
        <p className="text-xs text-neutral-500">
          同一段话并行发给每个已启用的 provider，并排看回答、耗时和错误——也是降级链候选的检阅台。
        </p>
        <textarea
          value={arenaPrompt}
          onChange={(e) => setArenaPrompt(e.target.value)}
          rows={2}
          className="w-full resize-y rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <div>
          <button
            onClick={() => void runArena()}
            disabled={arenaBusy || !arenaPrompt.trim()}
            className="rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
          >
            {arenaBusy ? '各家思考中…' : '开始对比'}
          </button>
        </div>
        {arenaError && <p className="text-xs text-rose-600 dark:text-rose-400">{arenaError}</p>}
        {arenaResults && arenaResults.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {arenaResults.map((r) => (
              <div key={r.label} className={`rounded-xl border p-3 text-xs leading-relaxed ${
                r.ok
                  ? 'border-neutral-200 dark:border-neutral-800'
                  : 'border-rose-300 bg-rose-50 dark:border-rose-500/40 dark:bg-rose-500/10'
              }`}>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="font-mono font-medium text-neutral-700 dark:text-neutral-200">{r.label}</span>
                  <span className={r.ok ? 'text-neutral-400' : 'text-rose-600 dark:text-rose-400'}>
                    {r.ok ? `${r.seconds}s` : `失败 · ${r.seconds}s`}
                  </span>
                </div>
                <p className={`whitespace-pre-wrap ${r.ok ? 'text-neutral-600 dark:text-neutral-300' : 'text-rose-600 dark:text-rose-300'}`}>
                  {r.ok ? r.text : r.error}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {tutorProfile && (tutorProfile.known.length > 0 || tutorProfile.half.length > 0 || tutorProfile.preferences.length > 0) ? (
        <section className="mb-6 flex flex-col gap-2 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
          <h2 className="flex items-center gap-2 font-semibold"><span>🎓</span> 学习画像</h2>
          <p className="text-xs text-neutral-500">
            自动汇总自教学记录，注入教学提示词校准讲解深度。是派生的记录，不能手改；教学页里它会自己更新。
          </p>
          {tutorProfile.known.length > 0 ? (
            <p className="text-sm text-neutral-700 dark:text-neutral-200">
              <span className="text-neutral-400">已说通（{tutorProfile.known.length}）：</span>
              {tutorProfile.known.join('、')}
            </p>
          ) : null}
          {tutorProfile.half.length > 0 ? (
            <p className="text-sm text-neutral-700 dark:text-neutral-200">
              <span className="text-neutral-400">半懂（{tutorProfile.half.length}）：</span>
              {tutorProfile.half.join('、')}
            </p>
          ) : null}
          {tutorProfile.preferences.length > 0 ? (
            <p className="text-sm text-neutral-700 dark:text-neutral-200">
              <span className="text-neutral-400">偏好与习惯：</span>
              {tutorProfile.preferences.map((p) => p.content).join('；')}
            </p>
          ) : null}
        </section>
      ) : null}
      <section className="mb-6 flex flex-col gap-3 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold"><span>💭</span> 长期记忆</h2>
          {memories.length > 0 && (
            <button onClick={clearAllMemories} className="text-xs text-red-400 hover:text-red-600">
              清空全部
            </button>
          )}
        </div>
        <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
          模型在对话中可通过 memory_save 自动记住你的偏好与背景；开启「自动记忆」后每轮对话结束还会自主判断是否值得记住（带 🤖
          徽标）。注入对话时，记忆条数多会按当前问题相关性选取；保存时相似内容自动去重。「整理重复记忆」会把跨会话积累的近似表述交给模型合并成一条（合并前先经模型确认确为同一事实）。可编辑。
        </p>
        {memories.map((m) => (
          <div
            key={m.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 px-4 py-2.5 dark:border-neutral-800"
          >
            {memEditId === m.id ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  value={memEditContent}
                  onChange={(e) => setMemEditContent(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void saveMemoryEdit()
                    } else if (e.key === 'Escape') {
                      setMemEditId(null)
                    }
                  }}
                  autoFocus
                  className={`${inputCls} flex-1`}
                />
                <button onClick={saveMemoryEdit} className="shrink-0 text-sm text-violet-600 hover:underline dark:text-violet-300">
                  保存
                </button>
                <button onClick={() => setMemEditId(null)} className="shrink-0 text-sm text-neutral-400">
                  取消
                </button>
              </div>
            ) : (
              <>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                  {m.kind && m.kind !== 'fact' && (
                    <span
                      title={m.kind === 'preference' ? '稳定偏好：决定口吻与推荐' : '周期性习惯：决定何时别打扰'}
                      className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                    >
                      {m.kind === 'preference' ? '偏好' : '习惯'}
                    </span>
                  )}
                  {m.source === 'auto' && (
                    <span
                      title="由自动记忆从对话中提取"
                      className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-600 dark:bg-violet-950 dark:text-violet-300"
                    >
                      🤖 自动
                    </span>
                  )}
                  <span className="min-w-0 truncate">{m.content}</span>
                </span>
                <div className="flex shrink-0 gap-2 text-sm">
                  <button
                    onClick={() => {
                      setMemEditId(m.id)
                      setMemEditContent(m.content)
                      setMemMsg('')
                    }}
                    className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                  >
                    编辑
                  </button>
                  <button onClick={() => removeMemory(m.id)} className="text-red-400 hover:text-red-600">
                    删除
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {memMsg && <div className="text-xs text-red-500">{memMsg}</div>}
        {!memories.length && <p className="text-sm text-neutral-400">还没有记忆 — 对话中告诉模型「记住我喜欢…」试试</p>}
        <div className="flex gap-2">
          <input
            value={memInput}
            onChange={(e) => setMemInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addMemory()}
            placeholder="手动添加一条记忆，如：我常用 Python 写脚本"
            className={`${inputCls} flex-1`}
          />
          <button
            onClick={addMemory}
            disabled={!memInput.trim()}
            className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
          >
            添加
          </button>
        </div>
        {/* tidy: sleep-time consolidation */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={runTidy}
            disabled={tidyBusy || memories.length < 2}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-neutral-700"
          >
            {tidyBusy ? '整理中…' : '整理重复记忆'}
          </button>
          {tidyReport && (
            <span className="text-xs text-neutral-400">
              {tidyReport.ok
                ? tidyReport.merged
                  ? `上次整理：合并 ${tidyReport.merged} 组重复（${tidyReport.before} → ${tidyReport.after} 条）`
                  : tidyReport.message || '上次整理：没有发现可合并的重复'
                : `整理失败：${tidyReport.error || '未知错误'}`}
            </span>
          )}
        </div>
        {tidyReport?.details?.length ? (
          <details className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <summary className="cursor-pointer text-xs text-neutral-500">查看合并明细</summary>
            <ul className="mt-2 space-y-1.5">
              {tidyReport.details.map((d, i) => (
                <li key={i} className="text-xs leading-relaxed text-neutral-400">
                  {d.from.map((f, j) => (
                    <span key={j}>
                      {j > 0 && <span className="text-neutral-300 dark:text-neutral-600"> ＋ </span>}
                      {f}
                    </span>
                  ))}
                  <span className="text-violet-500"> → {d.into}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <details
          className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
          onToggle={(e) => {
            if ((e.target as HTMLDetailsElement).open && !memExpose) {
              api.getMemoryExpose().then(setMemExpose).catch(() => {})
            }
          }}
        >
          <summary className="cursor-pointer select-none text-xs font-medium text-neutral-600 dark:text-neutral-300">
            开放给其他 AI 工具（MCP）— 让 Claude Desktop / Cursor 共享这份记忆
          </summary>
          {memExpose ? (
            <div className="mt-2">
              <p className="text-xs leading-relaxed text-neutral-400">
                把下面这段加进对应客户端的 MCP 配置（如 Claude Desktop 的 claude_desktop_config.json）。走 stdio，数据全程本机。
              </p>
              <pre className="mt-2 overflow-auto rounded-md bg-neutral-50 p-3 text-xs leading-relaxed dark:bg-neutral-900">
                {memExpose.snippet_json}
              </pre>
              <button
                onClick={() => navigator.clipboard.writeText(memExpose.snippet_json)}
                className="mt-2 rounded-md border border-neutral-300 px-2.5 py-1 text-xs dark:border-neutral-700"
              >
                复制配置
              </button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-neutral-400">展开时加载…</p>
          )}
        </details>
      </section>

      {/* Agent presets */}
      <section className="mb-6 flex flex-col gap-3 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="flex items-center gap-2 font-semibold"><span>🤖</span> 智能体预设</h2>
        <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
          把人设提示词、模型、RAG/工具开关打包成命名预设，对话页顶部一键切换。
        </p>
        {agents.map((a) => (
          <div
            key={a.id}
            className="flex items-start justify-between rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span>{a.avatar}</span>
                <span className="font-medium">{a.name}</span>
                {!a.enabled && <span className="text-xs text-red-500">已禁用</span>}
              </div>
              <div className="truncate text-xs text-neutral-500">
                {a.system_prompt || '(无人设提示词)'}
                {a.model_id && ` · 模型 ${a.model_id}`}
                {a.use_rag && ' · RAG'}
                {!a.tools_enabled && ' · 无工具'}
              </div>
            </div>
            <div className="flex shrink-0 gap-2 text-sm">
              <button onClick={() => editAgent(a)} className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
                编辑
              </button>
              <button onClick={() => removeAgent(a.id)} className="text-red-400 hover:text-red-600">
                删除
              </button>
            </div>
          </div>
        ))}
        {!agents.length && <p className="text-sm text-neutral-400">还没有智能体预设</p>}

        <div className="rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
          <h3 className="mb-3 text-sm font-medium">
            {agentEditId != null ? `编辑「${agentDraft.name}」` : '新增智能体'}
          </h3>
          <div className="grid grid-cols-[80px_1fr] gap-4">
            <label className="flex flex-col gap-1 text-sm">
              头像
              <input
                value={agentDraft.avatar}
                onChange={(e) => setAgentDraft({ ...agentDraft, avatar: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              名称
              <input
                value={agentDraft.name}
                onChange={(e) => setAgentDraft({ ...agentDraft, name: e.target.value })}
                placeholder="写作教练 / 代码审查员…"
                className={inputCls}
              />
            </label>
          </div>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            人设系统提示词（会叠加到全局系统提示词之后）
            <textarea
              value={agentDraft.system_prompt}
              onChange={(e) => setAgentDraft({ ...agentDraft, system_prompt: e.target.value })}
              rows={3}
              placeholder="例如：你是一位严格的代码审查员，只指出问题并给出修复建议，语气直接。"
              className={`${inputCls} resize-y`}
            />
          </label>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              固定模型（留空 = 会话当前模型）
              <select
                value={agentDraft.model_id}
                onChange={(e) => setAgentDraft({ ...agentDraft, model_id: e.target.value })}
                className={inputCls}
              >
                <option value="">跟随会话</option>
                {providers.flatMap((p) =>
                  p.enabled ? p.models.map((m) => `${p.name}/${m}`) : []
                ).map((mid) => (
                  <option key={mid} value={mid}>
                    {mid}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col justify-end gap-2 pb-1 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={agentDraft.use_rag}
                  onChange={(e) => setAgentDraft({ ...agentDraft, use_rag: e.target.checked })}
                />
                默认开启知识库(RAG)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={agentDraft.tools_enabled}
                  onChange={(e) => setAgentDraft({ ...agentDraft, tools_enabled: e.target.checked })}
                />
                允许使用工具
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={agentDraft.enabled}
                  onChange={(e) => setAgentDraft({ ...agentDraft, enabled: e.target.checked })}
                />
                启用
              </label>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            {agentEditId != null && (
              <button
                onClick={() => {
                  setAgentEditId(null)
                  setAgentDraft({ ...EMPTY_AGENT })
                }}
                className="rounded-md px-4 py-1.5 text-sm text-neutral-500"
              >
                取消
              </button>
            )}
            <button
              onClick={saveAgent}
              className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110"
            >
              {agentEditId != null ? '保存修改' : '添加'}
            </button>
          </div>
        </div>
      </section>

      {/* Prompt library */}
      <section className="mb-6 flex flex-col gap-3 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="flex items-center gap-2 font-semibold"><span>📝</span> 提示词库</h2>
        <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
          常用提示词存成模板，对话页输入框敲 <code className="text-neutral-500">/</code> 即可唤起。
          内容支持 <code className="text-neutral-500">{'{变量}'}</code> 占位符，使用时会逐个询问填入。
        </p>
        {prompts.map((p) => (
          <div
            key={p.id}
            className="flex items-start justify-between rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800"
          >
            <div className="min-w-0">
              <span className="font-medium">/{p.title}</span>
              <div className="truncate text-xs text-neutral-500">{p.content}</div>
            </div>
            <div className="flex shrink-0 gap-2 text-sm">
              <button
                onClick={() => {
                  setPromptEditId(p.id)
                  setPromptDraft({ title: p.title, content: p.content })
                }}
                className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
              >
                编辑
              </button>
              <button onClick={() => removePrompt(p.id)} className="text-red-400 hover:text-red-600">
                删除
              </button>
            </div>
          </div>
        ))}
        {!prompts.length && <p className="text-sm text-neutral-400">还没有提示词模板</p>}

        <div className="rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
          <h3 className="mb-3 text-sm font-medium">
            {promptEditId != null ? `编辑「${promptDraft.title}」` : '新增提示词'}
          </h3>
          <label className="flex flex-col gap-1 text-sm">
            标题（对话页输入 / 后按此匹配）
            <input
              value={promptDraft.title}
              onChange={(e) => setPromptDraft({ ...promptDraft, title: e.target.value })}
              placeholder="翻译成英文 / 周报生成…"
              className={inputCls}
            />
          </label>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            提示词内容（{'{变量}'} 会在使用时询问）
            <textarea
              value={promptDraft.content}
              onChange={(e) => setPromptDraft({ ...promptDraft, content: e.target.value })}
              rows={3}
              placeholder={'把下面的内容翻译成英文，保留代码块：\n\n{内容}'}
              className={`${inputCls} resize-y`}
            />
          </label>
          <div className="mt-4 flex justify-end gap-2">
            {promptEditId != null && (
              <button
                onClick={() => {
                  setPromptEditId(null)
                  setPromptDraft({ title: '', content: '' })
                }}
                className="rounded-md px-4 py-1.5 text-sm text-neutral-500"
              >
                取消
              </button>
            )}
            <button
              onClick={savePrompt}
              className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110"
            >
              {promptEditId != null ? '保存修改' : '添加'}
            </button>
          </div>
        </div>
      </section>

      {/* Agent Skills */}
      <section className="mb-6 flex flex-col gap-3 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="flex items-center gap-2 font-semibold"><span>🧩</span> 技能 Skills</h2>
        <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
          SKILL.md 指令包：frontmatter 写 name/description（何时使用），正文是完整指导。对话时注入技能清单，模型判断相关就自动加载全文执行。
          技能存于 skills/ 目录，也可直接手动放文件夹进去。
        </p>
        {skillItems.map((s) => (
          <div key={s.name} className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">🧩 {s.name}</span>
                  {s.model && <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">{s.model}</code>}
                  {s.tools && <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">工具: {s.tools}</code>}
                  <span className="text-xs text-neutral-400">{s.chars} 字 · {s.files.length} 个文件</span>
                </div>
                <div className="mt-0.5 text-xs text-neutral-500">{s.description}</div>
              </div>
              <button onClick={() => removeSkill(s.name)} className="shrink-0 text-sm text-red-400 hover:text-red-600">
                删除
              </button>
            </div>
            <details
              className="mt-2 text-xs text-neutral-500"
              onToggle={(e) => {
                if ((e.target as HTMLDetailsElement).open) void viewSkill(s.name)
              }}
            >
              <summary className="cursor-pointer select-none">查看内容</summary>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-3 leading-relaxed dark:bg-neutral-900">
                {skillContent[s.name] ?? '加载中…'}
              </pre>
            </details>
          </div>
        ))}
        {!skillItems.length && <p className="text-sm text-neutral-400">还没有技能</p>}
        <div className="flex gap-2">
          <input
            value={skillUrl}
            onChange={(e) => setSkillUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && installSkill()}
            placeholder="粘贴 GitHub 上的 SKILL.md 地址（blob 或 raw 链接均可）"
            className={`${inputCls} flex-1`}
          />
          <button
            onClick={installSkill}
            disabled={skillBusy || !skillUrl.trim()}
            className="shrink-0 rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
          >
            {skillBusy ? '安装中…' : '从 URL 安装'}
          </button>
        </div>
        {skillMsg && <div className="text-xs text-neutral-600 dark:text-neutral-300">{skillMsg}</div>}
      </section>
      </>
      )}

      {/* Provider editor */}
      {section === 'models' && (
      <section className="mb-6 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="mb-4 flex items-center gap-2 font-semibold"><span>🧠</span> {editingId ? `编辑 ${draft.name}` : '新增 Provider'}</h2>
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
      <section className="mb-6 flex flex-col gap-3 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold"><span>🔌</span> MCP 工具服务器</h2>
          <span className="text-xs text-neutral-400">{activeToolCount} 个可用工具</span>
        </div>
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
      <section className="rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="mb-4 flex items-center gap-2 font-semibold"><span>🔌</span> {mcpEditIdx != null ? `编辑 ${mcpDraft.name}` : '新增 MCP Server'}</h2>
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
      </div>
    </Layout>
  )
}