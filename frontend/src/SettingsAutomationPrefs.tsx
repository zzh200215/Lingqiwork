// automation 分区的三组偏好（方向 6 第十五刀拆出，2026-10-02 设置中心改版）：
// 复习卡片每日上限 / RSS 订阅 / 邮件推送。执行卡（SettingsTasks）另文件同区。
// 订阅清单挂载时自拉，失败走 failLoad；偏好编辑走页面级自动保存——
// 原来每组一个「保存设置」按钮，现在改动即生效，按钮退场。
import { useEffect, useState } from 'react'
import { api, type FeedItem } from './api'
import { inputCls, type WorkbenchPrefs } from './settingsShared'
import { askConfirm, SettingGroup, SettingRow, SettingSwitch } from './SettingsUI'

export default function SettingsAutomationPrefs({
  prefs,
  setPrefs,
  failLoad,
}: {
  prefs: WorkbenchPrefs
  setPrefs: (p: WorkbenchPrefs) => void
  failLoad: (what: string, e: unknown) => void
}) {

  const [feeds, setFeeds] = useState<FeedItem[]>([])
  const [feedsNextRun, setFeedsNextRun] = useState<string | null>(null)
  const [feedUrl, setFeedUrl] = useState('')
  const [feedName, setFeedName] = useState('')
  const [feedBusy, setFeedBusy] = useState('')
  const [feedMsg, setFeedMsg] = useState('')
  const [mailBusy, setMailBusy] = useState(false)
  const [mailMsg, setMailMsg] = useState('')

  useEffect(() => {
    api.listFeeds().then((r) => {
      setFeeds(r.feeds)
      setFeedsNextRun(r.next_run)
    }).catch((e) => failLoad('订阅', e))
  }, [])

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
    if (
      !(await askConfirm({
        title: `删除订阅 ${name}？`,
        description: '已抓取的笔记文件保留在 vault/feeds/。',
        confirmLabel: '删除',
      }))
    )
      return
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

  return (
    <div className="flex flex-col gap-4">
      {/* 复习卡片 */}
      <SettingGroup
        title="复习卡片"
        description="每日上限不是为了省时间，是为了别让积压把人劝退——某天出了两百张卡，第二天被队列砸懵就再也不打开了。"
      >
        <SettingRow title="每天新卡上限" htmlFor="pref-cards-new">
          <input
            id="pref-cards-new"
            type="number"
            min={0}
            max={500}
            value={prefs.cards_new_per_day}
            onChange={(e) => setPrefs({ ...prefs, cards_new_per_day: Number(e.target.value) })}
            className={`${inputCls} w-20`}
          />
        </SettingRow>
        <SettingRow title="每天复习上限" htmlFor="pref-cards-review">
          <input
            id="pref-cards-review"
            type="number"
            min={0}
            max={500}
            value={prefs.cards_review_per_day}
            onChange={(e) => setPrefs({ ...prefs, cards_review_per_day: Number(e.target.value) })}
            className={`${inputCls} w-20`}
          />
        </SettingRow>
        <div className="px-5 py-3.5">
          <p className="rounded-lg bg-neutral-100 px-3 py-2 text-xs leading-relaxed text-neutral-500 dark:bg-neutral-800/60 dark:text-neutral-400">
            复习已封存：不再有每日到期提醒，也不再有每周补讲。
            页面还在导航里的「今日」，你自己想开就开；它不会再主动找你。
          </p>
        </div>
      </SettingGroup>

      {/* RSS subscriptions */}
      <SettingGroup
        title="RSS 订阅"
        description="抓到的新条目按月追加到 vault/feeds/，自动进 RAG 索引——再配一个定时任务（如「总结 feeds 目录里今天的新内容」）就是每日情报简报。同一条目只写一次。"
      >
        <SettingRow title="每日自动抓取">
          <div className="flex items-center gap-2.5">
            {feedsNextRun && (
              <span className="text-xs text-neutral-400">下次 {feedsNextRun.replace('T', ' ')}</span>
            )}
            <input
              type="time"
              value={prefs.feeds_time}
              disabled={!prefs.feeds_enabled}
              onChange={(e) => setPrefs({ ...prefs, feeds_time: e.target.value })}
              className={`${inputCls} w-28 disabled:opacity-40`}
            />
            <SettingSwitch
              checked={prefs.feeds_enabled}
              onChange={(v) => setPrefs({ ...prefs, feeds_enabled: v })}
              ariaLabel="每日自动抓取"
            />
          </div>
        </SettingRow>
        {/* 添加订阅：一行表单（URL + 名称 + 动作），加订阅是动作不是设置 */}
        <div className="flex flex-wrap items-end gap-2 px-5 py-3.5">
          <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">添加订阅</span>
            <input
              value={feedUrl}
              onChange={(e) => setFeedUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addFeed()}
              placeholder="https://example.com/feed.xml"
              className={inputCls}
            />
          </label>
          <label className="flex w-44 flex-col gap-1 text-sm">
            <span className="text-xs text-neutral-500">名称（留空用源标题）</span>
            <input
              value={feedName}
              onChange={(e) => setFeedName(e.target.value)}
              className={inputCls}
            />
          </label>
          <button
            onClick={addFeed}
            disabled={!!feedBusy || !feedUrl.trim()}
            className="wb-btn-primary px-3 py-1.5 text-sm"
          >
            {feedBusy === 'add' ? '抓取中…' : '添加'}
          </button>
          <button
            onClick={() => syncFeeds()}
            disabled={!!feedBusy || feeds.length === 0}
            className="wb-btn-secondary px-3 py-1.5 text-sm"
          >
            {feedBusy === 'all' ? '同步中…' : '立即同步全部'}
          </button>
        </div>
        {feedMsg && <p className="px-5 pb-3.5 text-xs text-neutral-500">{feedMsg}</p>}
        {feeds.length > 0 && (
          <div className="flex flex-col gap-1.5 px-5 pb-4">
            {feeds.map((f) => (
              <div
                key={f.name}
                className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{f.name}</span>
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
                    className="wb-btn-secondary px-2 py-1 text-xs"
                  >
                    {feedBusy === f.name ? '…' : '同步'}
                  </button>
                  <button
                    onClick={() => toggleFeed(f.name, f.enabled === false)}
                    className="wb-btn-secondary px-2 py-1 text-xs"
                  >
                    {f.enabled === false ? '启用' : '停用'}
                  </button>
                  <button
                    onClick={() => removeFeed(f.name)}
                    className="wb-btn-secondary px-2 py-1 text-xs text-rose-600 dark:text-rose-400"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {feeds.length === 0 && <p className="px-5 pb-4 text-xs text-neutral-400">还没有订阅。</p>}
      </SettingGroup>

      {/* E-mail push */}
      <SettingGroup
        title="邮件推送"
        description="用你自己的 SMTP 发件（密码存在本机 data/config.json，接口读取时会打码）。端口 465 走隐式 TLS，587 走 STARTTLS。"
      >
        <div className="grid gap-x-6 gap-y-3 px-5 py-3.5 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">SMTP 服务器</span>
            <input
              value={prefs.smtp_host}
              onChange={(e) => setPrefs({ ...prefs, smtp_host: e.target.value })}
              placeholder="smtp.qq.com"
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">端口</span>
            <input
              value={prefs.smtp_port}
              onChange={(e) => setPrefs({ ...prefs, smtp_port: Number(e.target.value) || 587 })}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">用户名</span>
            <input
              value={prefs.smtp_user}
              onChange={(e) => setPrefs({ ...prefs, smtp_user: e.target.value })}
              placeholder="me@example.com"
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">密码 / 授权码</span>
            <input
              type="password"
              value={prefs.smtp_password}
              onChange={(e) => setPrefs({ ...prefs, smtp_password: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">发件人</span>
            <span className="text-xs text-neutral-400">留空用用户名</span>
            <input
              value={prefs.smtp_from}
              onChange={(e) => setPrefs({ ...prefs, smtp_from: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">收件人</span>
            <span className="text-xs text-neutral-400">逗号分隔</span>
            <input
              value={prefs.smtp_to}
              onChange={(e) => setPrefs({ ...prefs, smtp_to: e.target.value })}
              className={inputCls}
            />
          </label>
        </div>
        <SettingRow title="STARTTLS">
          <SettingSwitch
            checked={prefs.smtp_tls}
            onChange={(v) => setPrefs({ ...prefs, smtp_tls: v })}
            ariaLabel="STARTTLS"
          />
        </SettingRow>
        <SettingRow title="每日笔记摘要发邮件">
          <SettingSwitch
            checked={prefs.email_on_digest}
            onChange={(v) => setPrefs({ ...prefs, email_on_digest: v })}
            ariaLabel="每日笔记摘要发邮件"
          />
        </SettingRow>
        <SettingRow title="订阅有新内容时发邮件">
          <SettingSwitch
            checked={prefs.email_on_feeds}
            onChange={(v) => setPrefs({ ...prefs, email_on_feeds: v })}
            ariaLabel="订阅有新内容时发邮件"
          />
        </SettingRow>
        <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
          <button
            onClick={sendTestMail}
            disabled={mailBusy || !prefs.smtp_host.trim()}
            className="wb-btn-ghost px-3 py-1.5 text-sm"
          >
            {mailBusy ? '发送中…' : '发送测试邮件'}
          </button>
          {mailMsg && <span className="text-xs text-neutral-500">{mailMsg}</span>}
        </div>
      </SettingGroup>
    </div>
  )
}
