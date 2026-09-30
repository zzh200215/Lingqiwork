// automation 分区的三张偏好卡（方向 6 第十五刀，2026-09-30 自 SettingsPage 拆出）：
// 复习卡片每日上限 / RSS 订阅 / 邮件推送。执行卡（SettingsTasks）另文件同区。
// 状态与处理器自含，挂载时自拉订阅列表，失败走 failLoad；
// 保存按钮走 props 传入的 savePrefs（页面级，general 大卡共用同一个保存动作）。
import { useEffect, useState } from 'react'
import { Layers, Mail, Rss } from 'lucide-react'
import { api, type FeedItem } from './api'
import { inputCls, type WorkbenchPrefs } from './settingsShared'

export default function SettingsAutomationPrefs({
  prefs,
  setPrefs,
  savePrefs,
  prefsSaved,
  failLoad,
}: {
  prefs: WorkbenchPrefs
  setPrefs: (p: WorkbenchPrefs) => void
  savePrefs: () => Promise<void>
  prefsSaved: boolean
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

  return (
    <>
      {/* 复习卡片 */}
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

      {/* RSS subscriptions */}
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

      {/* E-mail push */}
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
    </>
  )
}
