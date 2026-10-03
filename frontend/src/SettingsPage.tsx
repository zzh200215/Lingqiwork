import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, type ProviderConfig } from './api'
import { prefsPayload, type WorkbenchPrefs } from './settingsShared'
import { ConfirmHost, SettingPage } from './SettingsUI'
import AppearanceSettings from './AppearanceSettings'
import SettingsGeneral from './SettingsGeneral'
import SettingsModels from './SettingsModels'
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


// 设置中心的外壳（2026-10-02 设置中心改版）：
// · 当前分区由 `?section=` 驱动（侧栏是唯一入口，地址一个没改）；
// · 每个分区进门是 SettingPage 页头（标题 + 一句说明 + 右上动作），分区清单在 `routes.tsx`；
// · 偏好（prefs）改动**自动保存**（防抖 800ms）——「改了还得记得点保存」是表单思维；
// · 取数失败走页级错误条：分区卡住 here，各分区的 UI 在 Settings* 分片文件里。
//
// 分区清单（通用 / 模型 / 智能体 / 自动化 / 内容生成 / 数据 / MCP）**在 `routes.tsx`**：
// 侧栏要摆它、这一页要按它切，两处各写一份的那天就会出现「侧栏七项、页面里六项」。

export default function SettingsPage() {
  const [searchParams] = useSearchParams()
  const [providers, setProviders] = useState<ProviderConfig[]>([])
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
  /** 自动保存的反馈状态机：idle → saving → saved（短暂展示）/ error。
   *  **失败必须说出来**——静默失败的「自动保存」比「要手动点保存」更糟，
   *  用户以为存了、实际没存。error 文案里带上「再动一项就重试」的出路。 */
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  /** 自动保存的「第一次不算」闸：refresh() 落下来那份是读到的真相，不是改动。
   *  没有它，进页即存一遍——把刚读到的原样写回去。 */
  const prefsLoaded = useRef(false)
  /** 有没有「还没落盘的改动」＋防抖计时器＋最新 prefs 的镜像：临走冲刷用（见下）。 */
  const dirtyRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const prefsRef = useRef<WorkbenchPrefs | null>(null)

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
        backup_removable: p.backup_removable ?? false,
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

  /** PUT 正文与落盘动作收在一处：平时防抖存、临走冲刷（keepalive）都走这里，
   *  清洗规矩统一用 `prefsPayload`（钉在 settingsShared 的测试里）。 */
  function putPrefs(p: WorkbenchPrefs, keepalive = false) {
    return fetch('/api/settings/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefsPayload(p)),
      keepalive,
    })
  }

  async function savePrefs() {
    if (!prefs) return
    setSaveState('saving')
    try {
      await putPrefs(prefs)
      dirtyRef.current = false
      setSaveState('saved')
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1500)
    } catch {
      setSaveState('error')
    }
  }

  // ---- 偏好自动保存（即时生效那一类）----
  // 开关 / 下拉 / 数字这类轻偏好改动后防抖 800ms 落盘。SMTP、Provider 这类要连出去
  // 试的配置仍走各自的显式动作（发送测试邮件 / 测试连接）。
  // dirtyRef 记「还有没落盘的改动」：pagehide / 切走标签时的冲刷（下面那个 effect）
  // 靠它判断要不要补发，存成功后清掉。
  useEffect(() => {
    if (!prefs) return
    if (!prefsLoaded.current) {
      prefsLoaded.current = true
      return
    }
    dirtyRef.current = true
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      if (dirtyRef.current) void savePrefs()
    }, 800)
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs])

  // 镜像最新 prefs 给冲刷用（冲刷 effect 只挂一次，不能依赖会变的闭包）
  useEffect(() => {
    prefsRef.current = prefs
  }, [prefs])

  // ---- 临走冲刷 ----
  // 防抖窗口里关标签 / 切走应用，那笔改动会跟着防抖计时器一起蒸发——
  // 在 pagehide / 转后台时把没落盘的改动用 keepalive fetch 立刻补发
  // （keepalive 允许请求在页面卸载后继续走完）。
  useEffect(() => {
    const flush = () => {
      if (!dirtyRef.current || !prefsRef.current) return
      dirtyRef.current = false
      if (timerRef.current) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      void putPrefs(prefsRef.current, true).catch(() => {
        /* 页面正在卸载，没有地方摆这条错误了 */
      })
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [])

  // 当前分区由 URL 决定（侧栏是唯一入口）：`/settings?section=models`。
  // 没写或写了个不认识的词 → 「通用」，与侧栏 `navState` 的默认一致。
  const sectionParam = searchParams.get('section')
  const section: SettingSection =
    SETTING_SECTIONS.find((s) => s.key === sectionParam)?.key ?? 'general'
  const sectionMeta = SETTING_SECTIONS.find((s) => s.key === section)!

  // 偏好驱动的那几个分区共用的保存状态提示：改了就存，不用找按钮；
  // 存不上必须看得见（rose），出路是「再动一项设置就会重试」。
  const saveHint = (
    <span
      data-prefs-save-state
      className={
        saveState === 'error'
          ? 'text-xs font-medium text-rose-600 dark:text-rose-400'
          : 'text-xs text-neutral-400 dark:text-neutral-500'
      }
    >
      {saveState === 'saved'
        ? '✓ 已保存'
        : saveState === 'saving'
          ? '保存中…'
          : saveState === 'error'
            ? '保存失败——再动一项设置就会重试'
            : '更改会自动保存'}
    </span>
  )

  return (
    <>
      <ConfirmHost />
      <div className="mx-auto max-w-4xl px-6 py-6">
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

      {error ? (
        <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      {/* 注意这里不用 <main>：Layout 的壳已经有一个 <main>（滚动容器），
          嵌两个 main 语义是错的，还曾让抽屉的滚动锁 closest('main') 错拿了这一层。 */}
      <div className="min-w-0">
        {/* 外观（皮肤 / 亮暗 / 强调色 / 自定义背景）：整体在 AppearanceSettings。
            **不挂在 `prefs` 上**——它的真值在 `ThemeProvider`（localStorage + 后端
            `/api/settings/theme`），与偏好自动保存无关；挂在上面会让
            「后端偏好拉不到」连带把换肤一起藏起来。 */}
        {section === 'appearance' && (
          <SettingPage title={sectionMeta.label} description={sectionMeta.desc}>
            <AppearanceSettings />
          </SettingPage>
        )}

        {section === 'general' && !prefs && <p className="py-8 text-sm text-neutral-400">加载中…</p>}
        {section === 'general' && prefs && (
          <SettingPage title={sectionMeta.label} description={sectionMeta.desc} actions={saveHint}>
            <SettingsGeneral prefs={prefs} setPrefs={setPrefs} ttsVoices={ttsVoices} />
          </SettingPage>
        )}

        {section === 'content' && prefs && (
          <SettingPage title={sectionMeta.label} description={sectionMeta.desc} actions={saveHint}>
            <SettingsContent
              prefs={prefs}
              setPrefs={setPrefs}
              savePrefs={savePrefs}
              providers={providers}
              failLoad={failLoad}
            />
          </SettingPage>
        )}

        {section === 'data' && prefs && (
          <SettingPage title={sectionMeta.label} description={sectionMeta.desc} actions={saveHint}>
            <SettingsData prefs={prefs} setPrefs={setPrefs} failLoad={failLoad} />
          </SettingPage>
        )}

        {section === 'automation' && prefs && (
          <SettingPage title={sectionMeta.label} description={sectionMeta.desc} actions={saveHint}>
            <div className="flex flex-col gap-4">
              {/* 复习卡片 / RSS 订阅 / 邮件推送：偏好组在 SettingsAutomationPrefs */}
              <SettingsAutomationPrefs prefs={prefs} setPrefs={setPrefs} failLoad={failLoad} />
              {/* 定时任务：清单 + 抽屉编辑器，整体在 SettingsTasks */}
              <SettingsTasks providers={providers} failLoad={failLoad} />
            </div>
          </SettingPage>
        )}

        {section === 'models' && (
          <SettingPage title={sectionMeta.label} description={sectionMeta.desc}>
            <SettingsModels providers={providers} onChanged={refresh} failLoad={failLoad} />
          </SettingPage>
        )}

        {section === 'agents' && (
          <SettingPage title={sectionMeta.label} description={sectionMeta.desc}>
            {/* 体检 / 竞技场 / 质量+标尺+回合台账 / 教学画像 / 记忆：六组整体在 SettingsEval */}
            <div className="flex flex-col gap-4">
              <SettingsEval failLoad={failLoad} />
              <SettingsAgents providers={providers} failLoad={failLoad} />
              <SettingsPrompts failLoad={failLoad} />
              <SettingsSkills failLoad={failLoad} />
            </div>
          </SettingPage>
        )}

        {section === 'mcp' && prefs && (
          <SettingPage title={sectionMeta.label} description={sectionMeta.desc} actions={saveHint}>
            <div className="flex flex-col gap-4">
              <SettingsWebsearch prefs={prefs} setPrefs={setPrefs} />
              {/* MCP server 清单 + 抽屉编辑器 + 页尾提示：整体在 SettingsMcp */}
              <SettingsMcp failLoad={failLoad} />
            </div>
          </SettingPage>
        )}
      </div>
    </div>
    </>
  )
}
