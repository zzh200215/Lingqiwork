// 「索引与检索」页签：概览、上传/剪藏、文档库、检索测试、维护（方向 6 第三刀自 KBPage 拆出）。
// 剪藏深链逻辑也住在这里——书签小工具永远是 window.open 整页打开 /kb?clip=…，挂载时页签必为 index。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Library, Plus, Search, Upload, Wrench } from 'lucide-react'
import { api } from './api'
import BookmarkletLink from './BookmarkletLink'
import EmptyHint from './EmptyHint'
import RunPanel from './RunPanel'
import { buildBookmarklet, parseClipParams, shouldAutoClose } from './capture'
import { box, fileIcon, fmtSize, fmtTime, pct, scoreColor, type Hit, type KbCounts, type KbStats, type KbTab } from './kbShared'

interface Props {
  /** 把 index 页签顺带拿到的仓库/目录数量报给父级页签栏（原 refresh() 本来就会取这两份列表） */
  onCounts: (patch: Partial<KbCounts>) => void
  onGoTab: (t: KbTab) => void
}

export default function KbIndexTab({ onCounts, onGoTab }: Props) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [stats, setStats] = useState<KbStats | null>(null)
  const [drift, setDrift] = useState<{ count: number; drifted: string[] } | null>(null)
  const [files, setFiles] = useState<{ vault_dir: string; files: { path: string; size: number; mtime: number }[] } | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  // 方向 2：分钟级操作给 RunPanel + **真停止**（合作式：后端逐文件/逐用例生效）。
  // 一次性 POST 上掐请求服务端照样跑完——所以停的是「后端循环」，不是掐 fetch。
  const [reindexing, setReindexing] = useState(false)
  const [reindexStopping, setReindexStopping] = useState(false)
  const reindexAbort = useRef<AbortController | null>(null)
  const [overview, setOverview] = useState<{ notes: number; clippings: number; repos: number; dirs: number } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState<{ ok: { name: string; chunks: number }[]; fail: { name: string; err: string }[] }>({ ok: [], fail: [] })
  const [dragOver, setDragOver] = useState(false)
  const [clipUrl, setClipUrl] = useState('')
  const [clipMsg, setClipMsg] = useState('')
  const [clipping, setClipping] = useState(false)
  const [bmCopied, setBmCopied] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    const [s, f, reposR, dirsR] = await Promise.all([
      fetch('/api/kb/stats').then((r) => r.json()),
      fetch('/api/kb/files').then((r) => r.json()),
      api.listRepos(),
      api.listDirs(),
    ])
    setStats(s)
    setFiles(f)
    onCounts({ repos: reposR.repos.length, dirs: dirsR.dirs.length })
    const all = (f.files as { path: string }[]).map((x) => x.path)
    setOverview({
      notes: all.filter((p) => !p.startsWith('clippings/')).length,
      clippings: all.filter((p) => p.startsWith('clippings/')).length,
      repos: reposR.repos.length,
      dirs: dirsR.dirs.length,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function uploadFiles(list: FileList | File[]) {
    setUploaded({ ok: [], fail: [] })
    setUploading(true)
    const ok: { name: string; chunks: number }[] = []
    const fail: { name: string; err: string }[] = []
    for (const file of Array.from(list)) {
      const fd = new FormData()
      fd.append('file', file)
      try {
        const r = await fetch('/api/kb/upload', { method: 'POST', body: fd })
        const data = await r.json()
        if (!r.ok) throw new Error(data.detail || data.message || '上传失败')
        ok.push({ name: data.filename, chunks: data.chunks })
      } catch (e) {
        fail.push({ name: file.name, err: String(e) })
      }
      setUploaded({ ok: [...ok], fail: [...fail] })
    }
    setUploading(false)
    await refresh()
  }

  async function checkDrift() {
    setBusy(true)
    setDrift(null)
    try {
      setDrift(await (await fetch('/api/kb/drift')).json())
    } catch (e) {
      setMessage(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function reindex() {
    setBusy(true)
    setReindexing(true)
    setReindexStopping(false)
    const controller = new AbortController()
    reindexAbort.current = controller
    setMessage('索引中…（首次会下载 embedding 模型，约 100MB）')
    try {
      const r = await fetch('/api/kb/reindex', { method: 'POST', signal: controller.signal })
      const data = await r.json()
      setMessage(
        (data.interrupted ? '已按「停止」提前收工（已完成的块照常可检索）：' : '完成：') +
          `${data.chunks} 块 / ${data.seconds}s` +
          (data.pruned?.length ? ` / 清理已删除来源: ${data.pruned.join(', ')}` : '') +
          (data.errors.length ? ` / 错误: ${data.errors.join('; ')}` : '')
      )
      await refresh()
    } catch (e) {
      setMessage(String(e))
    } finally {
      if (reindexAbort.current === controller) reindexAbort.current = null
      setBusy(false)
      setReindexing(false)
      setReindexStopping(false)
    }
  }

  async function runClip(url: string, title?: string): Promise<boolean> {
    if (!url.trim() || clipping) return false
    setClipping(true)
    setClipMsg('')
    try {
      const r = await api.clipUrl(url.trim(), title)
      setClipMsg(`✅ ${r.title} → ${r.filename}（${r.chars} 字 / ${r.chunks} 块）`)
      setClipUrl('')
      await refresh()
      return true
    } catch (e) {
      setClipMsg(`❌ ${String(e)}`)
      return false
    } finally {
      setClipping(false)
    }
  }

  function clip() {
    void runClip(clipUrl)
  }

  // 书签小工具打开的就是这个深链（`?clip=<url>&title=<t>`）：剪完自己关掉。
  // 只有脚本开的窗口 close() 才有效——正是小工具的形态；若把链接粘进普通标签页，
  // opener 为空，结果就留在页面上给人看。
  // `done` 挡两件事：StrictMode 的双次执行，和 SPA 里 setSearchParams 引发的重渲染。
  // （小工具只会整页 window.open，所以这段逻辑跟着 index 页签住是安全的。）
  const deeplinkDone = useRef<string | null>(null)
  const clipParam = searchParams.get('clip')
  const clipTitle = searchParams.get('title') ?? ''
  useEffect(() => {
    const req = parseClipParams(searchParams.toString())
    if (!req) return
    const key = `${req.url}\u0000${req.title}`
    if (deeplinkDone.current === key) return
    deeplinkDone.current = key
    setSearchParams({}, { replace: true })
    void runClip(req.url, req.title || undefined).then((ok) => {
      if (shouldAutoClose(Boolean(window.opener), ok)) window.setTimeout(() => window.close(), 3000)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipParam, clipTitle, setSearchParams])

  // origin 是**文档属性**，不是路由属性——这里不能用 router 的东西去「转」它
  const bookmarklet = buildBookmarklet(window.location.origin)

  function copyBookmarklet() {
    navigator.clipboard.writeText(bookmarklet).then(() => {
      setBmCopied(true)
      window.setTimeout(() => setBmCopied(false), 2000)
    })
  }

  async function search() {
    if (!query.trim()) return
    setBusy(true)
    try {
      const r = await fetch(`/api/kb/search?q=${encodeURIComponent(query)}`)
      const data = await r.json()
      setHits(data.hits)
    } finally {
      setBusy(false)
    }
  }

  const srcTotal = overview ? overview.notes + overview.clippings + overview.repos + overview.dirs : 0

  return (
    <>
      {/* 概览卡 */}
      <section className="wb-card-hero mb-6 rounded-lg p-5">
        <div className="flex flex-wrap items-center gap-x-10 gap-y-4">
          <div className="flex items-end gap-8">
            <div>
              <p className="text-3xl font-bold text-neutral-800 dark:text-neutral-100">{stats?.files ?? '–'}</p>
              <p className="mt-0.5 text-xs text-neutral-500">已索引文件</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-neutral-800 dark:text-neutral-100">{stats?.chunks ?? '–'}</p>
              <p className="mt-0.5 text-xs text-neutral-500">向量块</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2 rounded-full border border-neutral-200 bg-white/70 px-3 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-800/60">
            <span className={`h-2 w-2 rounded-full ${stats?.watcher === 'running' ? 'bg-emerald-500' : 'bg-neutral-400'}`} />
            <span className="text-neutral-600 dark:text-neutral-300">
              监听 {stats?.watcher === 'running' ? '运行中' : stats?.watcher ?? '…'}
            </span>
          </div>
        </div>

        {stats && stats.stale_embed > 0 ? (
          <div className="mt-4 rounded-md border border-rose-200 bg-rose-50/70 px-3 py-2 text-xs text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
            有 {stats.stale_embed} 个块是用别的 embedding 模型建出来的。两个模型的向量在同一余弦空间里
            没有可比性——检索到的相似度是噪声，不是「稍微不准」。
            <br />
            当前模型：{stats.embed_model}。点「全量重建索引」全部重算一遍。
          </div>
        ) : null}

        {stats && stats.stale > 0 ? (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            有 {stats.stale} 个块是用旧切法切出来的——块的边界已经变了，旧块会和新块混在一起被检索到。
            <br />
            vault 里的：「全量重建索引」；repos / dirs 里的不会被它带上，要在下面各自那一行点「同步」。
          </div>
        ) : null}

        {stats && stats.unhashed > 0 && stats.stale === 0 && stats.stale_embed === 0 ? (
          <div className="mt-4 rounded-md border border-neutral-200 bg-neutral-50/70 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-400">
            {stats.unhashed} 个块还没有内容哈希（哈希是后加的），「检查内容漂移」暂时覆盖不到它们。
            重建一次索引即可，不影响检索结果。
          </div>
        ) : null}

        {overview && srcTotal > 0 && (
          <div className="mt-5 border-t border-neutral-200/70 pt-4 dark:border-neutral-700/50">
            <div className="flex items-center justify-between text-xs text-neutral-500">
              <span className="font-medium">来源构成</span>
              <span>共 {srcTotal} 项</span>
            </div>
            <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
              {overview.notes > 0 && <div className="bg-violet-500" style={{ width: `${(overview.notes / srcTotal) * 100}%` }} />}
              {overview.clippings > 0 && <div className="bg-fuchsia-500" style={{ width: `${(overview.clippings / srcTotal) * 100}%` }} />}
              {overview.repos > 0 && <div className="bg-sky-500" style={{ width: `${(overview.repos / srcTotal) * 100}%` }} />}
              {overview.dirs > 0 && <div className="bg-emerald-500" style={{ width: `${(overview.dirs / srcTotal) * 100}%` }} />}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <span className="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
                <span className="h-2 w-2 rounded-full bg-violet-500" />笔记 {overview.notes}
              </span>
              <span className="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
                <span className="h-2 w-2 rounded-full bg-fuchsia-500" />剪藏 {overview.clippings}
              </span>
              <button
                onClick={() => onGoTab('repos')}
                className="flex items-center gap-1.5 rounded-md text-left text-neutral-600 transition-colors hover:text-sky-600 dark:text-neutral-300 dark:hover:text-sky-400"
                title="管理代码仓库"
              >
                <span className="h-2 w-2 rounded-full bg-sky-500" />仓库 {overview.repos} →
              </button>
              <button
                onClick={() => onGoTab('dirs')}
                className="flex items-center gap-1.5 rounded-md text-left text-neutral-600 transition-colors hover:text-emerald-600 dark:text-neutral-300 dark:hover:text-emerald-400"
                title="管理本地目录"
              >
                <span className="h-2 w-2 rounded-full bg-emerald-500" />目录 {overview.dirs} →
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 添加知识 */}
      <section className="mb-6">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
          <span><Plus className="h-4 w-4" /></span> 添加知识
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files)
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`cursor-pointer rounded-lg border-2 border-dashed p-5 text-center transition-colors ${
              dragOver
                ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/30'
                : 'border-neutral-300 hover:border-violet-300 dark:border-neutral-700'
            }`}
          >
            <div className="mb-2 flex justify-center"><Upload className="h-6 w-6" /></div>
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
              {uploading ? '上传中…' : '拖拽文件到这里，或点击选择'}
            </p>
            <p className="mt-1 text-xs text-neutral-400">
              PDF · Word · Markdown · TXT · 图片（截图走本地 OCR 提成文字）
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-1.5 text-xs">
              {['📕 PDF', '📘 Word', '📝 Markdown', '📄 TXT', '🖼 截图'].map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                >
                  {t}
                </span>
              ))}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".md,.markdown,.txt,.pdf,.docx,.png,.jpg,.jpeg,.webp,.bmp,.gif"
              className="hidden"
              onChange={(e) => e.target.files && uploadFiles(e.target.files)}
            />
          </div>

          <div className="flex flex-col wb-card p-5">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xl">🌐</span>
              <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-200">网页剪藏</h3>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-neutral-400">
              粘贴 URL，抓正文存为 Markdown 到 vault/clippings/ 并自动索引。
            </p>
            <div className="mt-auto flex gap-2">
              <input
                value={clipUrl}
                onChange={(e) => setClipUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && clip()}
                placeholder="https://example.com/article"
                className={`${box} flex-1`}
              />
              <button
                onClick={clip}
                disabled={clipping || !clipUrl.trim()}
                className="wb-btn-primary px-3 py-1.5 text-sm"
              >
                {clipping ? '剪藏中…' : '剪藏'}
              </button>
            </div>
            {clipMsg && <p className="mt-2 whitespace-pre-wrap text-xs text-neutral-500">{clipMsg}</p>}

            <div className="mt-3 rounded-lg border border-dashed border-violet-300 bg-violet-50/50 p-2.5 dark:border-violet-500/30 dark:bg-violet-500/5">
              <p className="mb-2 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                把下面这个按钮<b className="font-medium">拖到书签栏</b>，以后在任意网页点它一下就能剪藏当前页（自动带 URL 和标题），不用再回来粘链接。
              </p>
              <div className="flex items-center gap-2">
                <BookmarkletLink
                  origin={window.location.origin}
                  className="wb-btn-primary cursor-grab px-3 py-1 text-xs active:cursor-grabbing"
                />
                <button
                  onClick={copyBookmarklet}
                  className="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-500 transition-colors hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
                >
                  {bmCopied ? '已复制' : '复制代码'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {(uploaded.ok.length > 0 || uploaded.fail.length > 0) && (
          <div className="mt-3 space-y-2">
            {uploaded.ok.map((u) => (
              <div
                key={u.name}
                className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm dark:border-emerald-900/50 dark:bg-emerald-950/30"
              >
                <span>{fileIcon(u.name)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-800 dark:text-emerald-200">
                  {u.name}
                </span>
                <span className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400">{u.chunks} 块</span>
                <span className="text-emerald-600 dark:text-emerald-400">✓</span>
              </div>
            ))}
            {uploaded.fail.map((f) => (
              <div
                key={f.name}
                className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm dark:border-rose-900/50 dark:bg-rose-950/30"
              >
                <span>❌</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-rose-800 dark:text-rose-200">{f.name}</span>
                <span className="shrink-0 max-w-[40%] truncate text-xs text-rose-500">{f.err}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 文档库 */}
      <section className="mb-6 wb-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
            <span><Library className="h-4 w-4" /></span> 文档库
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-500 dark:bg-neutral-800">
              {files?.files.length ?? 0}
            </span>
          </h2>
          <span className="max-w-[55%] truncate text-xs text-neutral-400">vault 目录：{files?.vault_dir}</span>
        </div>
        {/* 表格不会缩到内容以下（路径那一列就有三百来像素）。给个横向滚动，
            别用 overflow-hidden——那样窄窗格里直接切掉，看不到也点不着。 */}
        {files && files.files.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-neutral-100 dark:border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-50 text-xs text-neutral-400 dark:bg-neutral-900/60">
                <tr>
                  <th className="px-3 py-2 font-normal">文件</th>
                  <th className="px-3 py-2 font-normal">大小</th>
                  <th className="px-3 py-2 font-normal">修改时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {files.files.map((f) => (
                  <tr key={f.path} className="transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900/40">
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <span>{fileIcon(f.path)}</span>
                        <span className="min-w-0 truncate font-mono text-xs text-neutral-700 dark:text-neutral-200">{f.path}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-500">{fmtSize(f.size)}</td>
                    <td className="px-3 py-2 text-xs text-neutral-500">{fmtTime(f.mtime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyHint
            pad="sm"
            title="vault 里还没有可索引的文件。"
            hint="上传或放进文档即可自动入库。"
          />
        )}
      </section>

      {/* 检索测试 */}
      <section className="mb-6 wb-card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
          <span><Search className="h-4 w-4" /></span> 检索测试
        </h2>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
            placeholder="输入查询，看命中哪些块"
            className={`${box} flex-1`}
          />
          <button
            onClick={search}
            disabled={busy || !query.trim()}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-neutral-700"
          >
            搜索
          </button>
        </div>
        {hits && (
          <div className="mt-4 flex flex-col gap-3">
            {!hits.length && <p className="text-sm text-neutral-400">无命中（索引为空或无相关内容）</p>}
            {hits.map((h) => (
              <div key={h.id} className="rounded-lg border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900/60">
                <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-neutral-500">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span>{fileIcon(h.source || '')}</span>
                    <span className="truncate font-mono text-neutral-600 dark:text-neutral-300">{h.source || '—'}</span>
                    {h.chunk != null && <span className="shrink-0 text-neutral-400">· chunk {h.chunk}</span>}
                    {h.channels && (
                      <span className="ml-1 inline-flex shrink-0 gap-1">
                        {h.channels.includes('vec') && (
                          <span className="rounded bg-violet-100 px-1 py-px text-xs text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                            向量
                          </span>
                        )}
                        {h.channels.includes('bm25') && (
                          <span className="rounded bg-sky-100 px-1 py-px text-xs text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                            BM25
                          </span>
                        )}
                        {h.channels.includes('rerank') && (
                          <span className="rounded bg-amber-100 px-1 py-px text-xs text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                            精排
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="flex items-center gap-1.5" title={`相关性 ${h.score.toFixed(3)}`}>
                      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
                        <span className={`block h-full rounded-full ${scoreColor(h.score)}`} style={{ width: pct(h.score) }} />
                      </span>
                      <span className="font-mono">{pct(h.score)}</span>
                    </span>
                    {h.source?.endsWith('.md') && (
                      <Link
                        to={`/notes?path=${encodeURIComponent(h.source)}`}
                        className="text-violet-500 transition-colors hover:text-violet-700 hover:underline dark:text-violet-400"
                      >
                        打开
                      </Link>
                    )}
                  </span>
                </div>
                <p className="whitespace-pre-wrap leading-relaxed text-neutral-700 dark:text-neutral-200">{h.text}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 维护 */}
      <section className="wb-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
            <span><Wrench className="h-4 w-4" /></span> 维护
          </h2>
          <button
            onClick={reindex}
            disabled={busy}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            全量重建索引
          </button>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={checkDrift}
            disabled={busy}
            className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 disabled:opacity-40 dark:border-neutral-600 dark:text-neutral-300"
          >
            检查内容漂移
          </button>
          {drift ? (
            <span className={`text-xs ${drift.count ? 'text-amber-700 dark:text-amber-300' : 'text-neutral-500'}`}>
              {drift.count === 0
                ? '磁盘内容和索引一致。'
                : `${drift.count} 个来源在磁盘上变了、但索引里还是旧的：${drift.drifted.slice(0, 5).join('、')}${drift.count > 5 ? ' 等' : ''}`}
            </span>
          ) : null}
        </div>
        {reindexing ? (
          <RunPanel
            phase="planning"
            tone="amber"
            icon="🧰"
            title="全量重建索引"
            status={reindexStopping ? '正在停…（当前这个文件做完就停）' : message || undefined}
            onCancel={() => {
              void api.cancelReindex().then((r) => {
                if (r.stopped) setReindexStopping(true)
              })
            }}
          />
        ) : null}
        {message && !reindexing ? <p className="mt-2 text-xs text-neutral-500">{message}</p> : null}
        <p className="mt-3 text-xs leading-relaxed text-neutral-400">
          把 .md / .txt / .pdf / .docx 放进 vault 目录即可自动索引；「全量重建」手动触发一遍。对话页打开「知识库(RAG)」开关即可在聊天中引用。
        </p>
      </section>
    </>
  )
}
