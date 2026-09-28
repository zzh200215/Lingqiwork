import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ClipboardCheck,
  type LucideIcon,
  FolderOpen,
  GitBranch,
  GraduationCap,
  Library,
  Play,
  Plus,
  Search,
  TrendingUp,
  Upload,
  Waypoints,
  Wrench,
} from 'lucide-react'
import { api, type DirItem, type EvalItem, type EvalRun, type KgRetrieval, type KgStatus, type RepoItem } from './api'
import BookmarkletLink from './BookmarkletLink'
import EmptyHint from './EmptyHint'
import RunPanel from './RunPanel'
import { buildBookmarklet, parseClipParams, shouldAutoClose } from './capture'

/** 五个页签各自的线性图标（emoji 从 chrome 退役） */
const KB_TAB_ICON: Record<'index' | 'repos' | 'dirs' | 'eval' | 'kg', LucideIcon> = {
  index: Search,
  repos: GitBranch,
  dirs: FolderOpen,
  eval: ClipboardCheck,
  kg: Waypoints,
}

interface KbStats {
  chunks: number
  files: number
  watcher: string
  /** 当前切法版本；块元数据里带着它 */
  chunker: number
  /** 用旧切法切出来的块数。不为 0 就说明该重建索引了 */
  stale: number
  /** 当前 embedding 模型名 */
  embed_model: string
  /** 用别的模型 embed 的块数。同一余弦空间里混两个模型，相似度没有意义——必须重建 */
  stale_embed: number
  /** 还没有内容哈希的块数（哈希是后加的）。不为 0 只说明漂移检查覆盖不全 */
  unhashed: number
}

interface Hit {
  id: string
  text: string
  source: string | null
  title: string | null
  chunk: number | null
  score: number
  channels?: string[]
}

const pct = (v: number) => `${Math.round(v * 100)}%`

const fileIcon = (name: string) => {
  const ext = (name.toLowerCase().split('.').pop() || '').trim()
  if (ext === 'pdf') return '📕'
  if (ext === 'md' || ext === 'markdown') return '📝'
  if (ext === 'docx' || ext === 'doc') return '📘'
  if (ext === 'txt') return '📄'
  return '📎'
}

const fmtSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const fmtTime = (ts: number) => {
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const scoreColor = (s: number) => (s >= 0.7 ? 'bg-emerald-500' : s >= 0.4 ? 'bg-amber-500' : 'bg-neutral-400')

const hitColor = (v: number) =>
  v >= 0.8
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
    : v >= 0.5
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
      : 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'

export default function KbPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab] = useState<'index' | 'repos' | 'dirs' | 'eval' | 'kg'>('index')
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

  // --- repos tab ---
  const [repos, setRepos] = useState<RepoItem[]>([])
  const [reposDir, setReposDir] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [repoName, setRepoName] = useState('')
  const [repoBusy, setRepoBusy] = useState('')
  const [repoMsg, setRepoMsg] = useState('')

  const refreshRepos = useCallback(async () => {
    const r = await api.listRepos()
    setRepos(r.repos)
    setReposDir(r.dir)
  }, [])

  useEffect(() => {
    if (tab === 'repos') refreshRepos()
  }, [tab, refreshRepos])

  async function addRepo() {
    const url = repoUrl.trim()
    if (!url || repoBusy) return
    setRepoBusy('clone')
    setRepoMsg('克隆并索引中，大仓库可能要几分钟…')
    try {
      const r = await api.cloneRepo(url, repoName.trim() || undefined)
      setRepoUrl('')
      setRepoName('')
      setRepoMsg(
        `${r.name}: ${r.files} 个文件 / ${r.chunks} 个块，${r.seconds}s${r.truncated ? '（已达文件上限，只索引了前一批）' : ''}`
      )
      await refreshRepos()
    } catch (e) {
      setRepoMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setRepoBusy('')
    }
  }

  async function syncRepo(name: string) {
    if (repoBusy) return
    setRepoBusy(name)
    setRepoMsg(`同步 ${name}…`)
    try {
      const r = await api.syncRepo(name)
      setRepoMsg(`${name}: ${r.files} 个文件 / ${r.chunks} 个块${r.pruned ? `，清理 ${r.pruned} 个已删文件` : ''}，${r.seconds}s`)
      await refreshRepos()
    } catch (e) {
      setRepoMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setRepoBusy('')
    }
  }

  async function removeRepo(name: string) {
    if (repoBusy || !confirm(`删除仓库 ${name}？会移除克隆目录和它的索引。`)) return
    setRepoBusy(name)
    try {
      const r = await api.deleteRepo(name)
      setRepoMsg(`已删除 ${name}（移除 ${r.sources_removed} 个索引文件）`)
      await refreshRepos()
    } catch (e) {
      setRepoMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setRepoBusy('')
    }
  }

  // --- dirs (local folders) tab ---
  const [dirs, setDirs] = useState<DirItem[]>([])
  const [dirWatcher, setDirWatcher] = useState('')
  const [dirName, setDirName] = useState('')
  const [dirPath, setDirPath] = useState('')
  const [dirBusy, setDirBusy] = useState('')
  const [dirMsg, setDirMsg] = useState('')

  const refreshDirs = useCallback(async () => {
    const r = await api.listDirs()
    setDirs(r.dirs)
    setDirWatcher(r.watcher)
  }, [])

  useEffect(() => {
    if (tab === 'dirs') refreshDirs()
  }, [tab, refreshDirs])

  async function addDir() {
    const name = dirName.trim()
    const path = dirPath.trim()
    if (!name || !path || dirBusy) return
    setDirBusy('add')
    setDirMsg('扫描并索引中，大目录可能要一会儿…')
    try {
      const r = await api.addDir(name, path)
      setDirName('')
      setDirPath('')
      setDirMsg(
        `${r.name}: ${r.files ?? 0} 个文件 / ${r.chunks ?? 0} 个块，${r.seconds ?? '–'}s` +
          (r.truncated ? '（已达文件上限，只索引了前一批）' : '')
      )
      await refreshDirs()
    } catch (e) {
      setDirMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDirBusy('')
    }
  }

  async function syncDir(name: string) {
    if (dirBusy) return
    setDirBusy(name)
    setDirMsg(`同步 ${name}…`)
    try {
      const r = await api.syncDir(name)
      setDirMsg(`${name}: ${r.files ?? 0} 个文件 / ${r.chunks ?? 0} 个块${r.pruned ? `，清理 ${r.pruned} 个已删文件` : ''}，${r.seconds ?? '–'}s`)
      await refreshDirs()
    } catch (e) {
      setDirMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDirBusy('')
    }
  }

  async function toggleDir(d: DirItem) {
    if (dirBusy) return
    setDirBusy(d.name)
    try {
      await api.toggleDir(d.name, !d.enabled)
      await refreshDirs()
    } catch (e) {
      setDirMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDirBusy('')
    }
  }

  async function removeDir(name: string) {
    if (dirBusy || !confirm(`停止索引本地目录 ${name}？只移除索引，不会删除你的文件。`)) return
    setDirBusy(name)
    try {
      const r = await api.deleteDir(name)
      setDirMsg(`已移除 ${name}（清理 ${r.sources_removed} 个索引文件，原文件保留）`)
      await refreshDirs()
    } catch (e) {
      setDirMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDirBusy('')
    }
  }

  // --- eval tab ---
  const [evalItems, setEvalItems] = useState<EvalItem[]>([])
  const [runs, setRuns] = useState<EvalRun[]>([])
  const [draft, setDraft] = useState({ question: '', expected_source: '', note: '' })
  const [editId, setEditId] = useState<number | null>(null)
  const [evalTopK, setEvalTopK] = useState('')
  const [judge, setJudge] = useState(true)
  const [running, setRunning] = useState(false)
  const [evalMsg, setEvalMsg] = useState('')
  const [evalStopping, setEvalStopping] = useState(false)
  const evalAbort = useRef<AbortController | null>(null)
  const [openRun, setOpenRun] = useState<EvalRun | null>(null)

  // --- knowledge-graph tab ---
  const [kg, setKg] = useState<KgStatus | null>(null)
  const [kgForm, setKgForm] = useState({ uri: 'bolt://localhost:7687', user: 'neo4j', password: '', enabled: false })
  const [kgBusy, setKgBusy] = useState('')
  const [kgMsg, setKgMsg] = useState('')
  const [kgQ, setKgQ] = useState('')
  const [kgResult, setKgResult] = useState<KgRetrieval | null>(null)

  const refreshKg = useCallback(async () => {
    const s = await api.getKgStatus()
    setKg(s)
    setKgForm((f) => ({ ...f, uri: s.uri, user: s.user, enabled: s.enabled }))
  }, [])

  useEffect(() => {
    if (tab === 'kg') refreshKg()
  }, [tab, refreshKg])

  async function saveKg() {
    if (kgBusy) return
    setKgBusy('save')
    setKgMsg('')
    try {
      const r = await api.saveKgConfig({ ...kgForm, password: kgForm.password })
      setKgForm((f) => ({ ...f, password: '' }))
      setKgMsg(`已连接 · 实体 ${r.entities ?? 0} / 关系 ${r.relations ?? 0} / 文件 ${r.files ?? 0}`)
      await refreshKg()
    } catch (e) {
      setKgMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setKgBusy('')
    }
  }

  async function buildKg() {
    if (kgBusy) return
    setKgBusy('build')
    setKgMsg('抽取中：每个文件一次模型调用，请稍候…')
    try {
      const r = await api.buildKg(8)
      const failNote = r.failed.length ? `，失败 ${r.failed.length} 个（${r.failed[0].error.slice(0, 80)}）` : ''
      setKgMsg(`本轮抽取 ${r.extracted} 个文件（${r.unchanged} 个未变化跳过）${failNote}。文件较多时可多次点击继续。`)
      await refreshKg()
    } catch (e) {
      setKgMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setKgBusy('')
    }
  }

  async function queryKg() {
    if (!kgQ.trim() || kgBusy) return
    setKgBusy('query')
    setKgResult(null)
    try {
      setKgResult(await api.queryKg(kgQ.trim(), 6))
    } catch (e) {
      setKgMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setKgBusy('')
    }
  }

  async function clearKg() {
    if (!confirm('清空知识图谱中的全部实体与关系？（不影响笔记本体）')) return
    setKgBusy('clear')
    try {
      await api.clearKg()
      setKgMsg('图谱已清空')
      await refreshKg()
    } catch (e) {
      setKgMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setKgBusy('')
    }
  }

  const refreshEval = useCallback(async () => {
    const [i, r] = await Promise.all([api.listEvalItems(), api.listEvalRuns()])
    setEvalItems(i)
    setRuns(r)
  }, [])

  useEffect(() => {
    if (tab === 'eval') refreshEval()
  }, [tab, refreshEval])

  async function saveEvalItem() {
    if (!draft.question.trim()) return
    try {
      if (editId) await api.updateEvalItem(editId, draft)
      else await api.createEvalItem(draft)
      setDraft({ question: '', expected_source: '', note: '' })
      setEditId(null)
      setEvalMsg('')
      await refreshEval()
    } catch (e) {
      setEvalMsg(`❌ ${String(e)}`)
    }
  }

  async function removeEvalItem(id: number) {
    if (!window.confirm('删除这条评估问题？')) return
    await api.deleteEvalItem(id)
    if (editId === id) {
      setEditId(null)
      setDraft({ question: '', expected_source: '', note: '' })
    }
    await refreshEval()
  }

  async function runEvalNow() {
    setRunning(true)
    setEvalStopping(false)
    const controller = new AbortController()
    evalAbort.current = controller
    setEvalMsg('评估中…（每题一次检索' + (judge ? ' + 两次模型调用' : '') + '，请稍候）')
    try {
      const r = await api.runEval(evalTopK ? Number(evalTopK) : null, judge, controller.signal)
      setEvalMsg(
        (r.stopped ? '⚠️ 已按「停止」提前收工（跳过的用例不计入指标）：' : '✓ 第 ' + r.id + ' 次评估：') +
          `Hit@1 ${pct(r.hit1)} · Hit@3 ${pct(r.hit3)} · MRR ${r.mrr}` +
          (r.faithfulness !== null ? ` · 忠实度 ${r.faithfulness}/5` : '（未判分）') +
          ` · ${r.seconds}s`
      )
      setOpenRun(r)
      await refreshEval()
    } catch (e) {
      setEvalMsg(`❌ ${String(e)}`)
    } finally {
      if (evalAbort.current === controller) evalAbort.current = null
      setRunning(false)
      setEvalStopping(false)
    }
  }

  async function toggleRunDetail(run: EvalRun) {
    if (openRun?.id === run.id) {
      setOpenRun(null)
      return
    }
    setOpenRun(await api.getEvalRun(run.id))
  }

  async function removeRun(id: number) {
    await api.deleteEvalRun(id)
    if (openRun?.id === id) setOpenRun(null)
    await refreshEval()
  }

  const refresh = useCallback(async () => {
    const [s, f, reposR, dirsR] = await Promise.all([
      fetch('/api/kb/stats').then((r) => r.json()),
      fetch('/api/kb/files').then((r) => r.json()),
      api.listRepos(),
      api.listDirs(),
    ])
    setStats(s)
    setFiles(f)
    setRepos(reposR.repos)
    setDirs(dirsR.dirs)
    const all = (f.files as { path: string }[]).map((x) => x.path)
    setOverview({
      notes: all.filter((p) => !p.startsWith('clippings/')).length,
      clippings: all.filter((p) => p.startsWith('clippings/')).length,
      repos: reposR.repos.length,
      dirs: dirsR.dirs.length,
    })
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

  const box = 'rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700'

  const srcTotal = overview ? overview.notes + overview.clippings + overview.repos + overview.dirs : 0
  const reposTotalFiles = repos.reduce((s, r) => s + (r.files ?? 0), 0)
  const reposTotalChunks = repos.reduce((s, r) => s + (r.chunks ?? 0), 0)
  const dirsTotalFiles = dirs.reduce((s, d) => s + (d.enabled ? (d.files ?? 0) : 0), 0)
  const dirsTotalChunks = dirs.reduce((s, d) => s + (d.enabled ? (d.chunks ?? 0) : 0), 0)

  return (
    <>
      <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">知识库</h1>
          <p className="mt-0.5 text-xs text-neutral-400">管理 RAG 的知识来源：文档、仓库、目录与图谱</p>
        </div>
        {/* 几个分页签排成一行，加起来比窄窗格宽。给个横向滚动，
            不然窄的那几页签直接被裁掉、点都点不到。 */}
        <div className="flex gap-1 overflow-x-auto rounded-md bg-neutral-100 p-1 text-sm dark:bg-neutral-900">
          {([
            ['index', '索引与检索', undefined as number | undefined],
            ['repos', '代码仓库', repos.length],
            ['dirs', '本地目录', dirs.length],
            ['eval', '评估', evalItems.length],
            ['kg', '图谱', undefined as number | undefined],
          ] as const).map(([key, label, count]) => {
            const Icon = KB_TAB_ICON[key]
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex items-center gap-1.5 rounded px-3 py-1 transition-colors ${
                  tab === key
                    ? 'bg-white font-medium dark:bg-neutral-800'
                    : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
                {count != null && count > 0 && (
                  <span
                    className={`rounded-full px-1.5 text-xs leading-4 ${
                      tab === key
                        ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-300'
                        : 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {tab === 'index' && (
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
                onClick={() => setTab('repos')}
                className="flex items-center gap-1.5 rounded-md text-left text-neutral-600 transition-colors hover:text-sky-600 dark:text-neutral-300 dark:hover:text-sky-400"
                title="管理代码仓库"
              >
                <span className="h-2 w-2 rounded-full bg-sky-500" />仓库 {overview.repos} →
              </button>
              <button
                onClick={() => setTab('dirs')}
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
                className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:from-neutral-200 disabled:to-neutral-200 disabled:text-neutral-400 dark:disabled:from-neutral-800 dark:disabled:to-neutral-800"
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
                  className="cursor-grab rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1 text-xs font-medium text-white active:cursor-grabbing"
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
      )}

      {tab === 'repos' && (
        <>
          <section className="wb-card-hero mb-6 rounded-lg p-5">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div className="flex items-end gap-6">
                <div>
                  <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{repos.length}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">已索引仓库</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{reposTotalFiles}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">文件</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{reposTotalChunks}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">块</p>
                </div>
              </div>
              <span className="ml-auto text-xs text-neutral-400">
                来源标记 <code className="text-neutral-500">repos/名字/路径</code>
              </span>
            </div>
          </section>

          <section className="mb-6 wb-card p-5">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              <span><GitBranch className="h-4 w-4" /></span> 添加代码仓库
            </h2>
            <div className="flex flex-wrap gap-2">
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addRepo()}
                placeholder="https://github.com/user/repo.git"
                className={`${box} min-w-[280px] flex-1`}
              />
              <input
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                placeholder="本地名（留空自动取仓库名）"
                className={`${box} w-52`}
              />
              <button
                onClick={addRepo}
                disabled={!!repoBusy || !repoUrl.trim()}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
              >
                {repoBusy === 'clone' ? '克隆中…' : '克隆并索引'}
              </button>
            </div>
            <p className="mt-2 text-xs text-neutral-400">
              浅克隆（--depth 1）到 {reposDir || 'data/repos'}，索引文档与源码（单文件 ≤200KB，最多 1500 个文件，跳过
              node_modules/dist/.git 等目录）。私有仓库需本机 git 已配置凭据。
            </p>
            {repoMsg && <p className="mt-2 text-xs text-neutral-500">{repoMsg}</p>}
          </section>

          <section className="mb-6">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              <span><GitBranch className="h-4 w-4" /></span> 已索引仓库
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-500 dark:bg-neutral-800">
                {repos.length}
              </span>
            </h2>
            {repos.length === 0 ? (
              <EmptyHint
                pad="sm"
                title="还没有仓库。"
                hint="索引后代码和文档都能在对话里被 RAG 检索到。"
              />
            ) : (
              <ul className="space-y-2">
                {repos.map((r) => (
                  <li
                    key={r.name}
                    className="wb-card wb-card-hover flex items-center gap-4 p-4 text-sm"
                  >
                    <div className="wb-chip h-10 w-10 bg-violet-100 text-violet-600 dark:bg-violet-900/40 dark:text-violet-300">
                      <GitBranch className="h-[18px] w-[18px]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-neutral-800 dark:text-neutral-100">{r.name}</span>
                        {!r.cloned && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                            目录缺失
                          </span>
                        )}
                        {r.truncated && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                            已截断
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-xs text-neutral-400">{r.url}</div>
                      <div className="mt-0.5 text-xs text-neutral-400">
                        {r.last_synced ? `上次同步 ${r.last_synced.replace('T', ' ')}` : '尚未同步'}
                      </div>
                      {r.errors && r.errors.length > 0 && (
                        <div className="mt-0.5 text-xs text-red-500">{r.errors.length} 个文件失败：{r.errors[0]}</div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-5">
                      <div className="text-right">
                        <p className="text-lg font-semibold leading-none text-neutral-800 dark:text-neutral-100">{r.files ?? '–'}</p>
                        <p className="mt-1 text-xs text-neutral-400">文件</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-semibold leading-none text-neutral-800 dark:text-neutral-100">{r.chunks ?? '–'}</p>
                        <p className="mt-1 text-xs text-neutral-400">块</p>
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => {
                            // 代码库陪读：深链开一场教学会话，取材限定在这个仓库里
                            navigate(
                              `/tutor?new=${encodeURIComponent(
                                `跟我读 ${r.name} 这个仓库的代码结构`
                              )}&repo=${encodeURIComponent(r.name)}`
                            )
                          }}
                          className="rounded-md border border-violet-400 px-2.5 py-1 text-xs text-violet-600 dark:border-violet-500 dark:text-violet-300"
                        >
                          <GraduationCap className="mr-1 inline h-3 w-3" />
                          陪读
                        </button>
                        <button
                          onClick={() => syncRepo(r.name)}
                          disabled={!!repoBusy}
                          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs disabled:opacity-40 dark:border-neutral-700"
                        >
                          {repoBusy === r.name ? '…' : '同步'}
                        </button>
                        <button
                          onClick={() => removeRepo(r.name)}
                          disabled={!!repoBusy}
                          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-red-600 disabled:opacity-40 dark:border-neutral-700"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="mt-6 text-xs leading-relaxed text-neutral-400">
            仓库索引的来源标记为 <code>repos/名字/路径</code>，与 vault 文件区分；vault「全量重建」不会误删它们，仓库文件的增删由「同步」处理。
          </p>
        </>
      )}

      {tab === 'dirs' && (
        <>
          <section className="wb-card-hero mb-6 rounded-lg p-5">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div className="flex items-end gap-6">
                <div>
                  <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{dirs.length}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">已索引目录</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{dirsTotalFiles}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">文件</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{dirsTotalChunks}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">块</p>
                </div>
              </div>
              <span className="ml-auto flex items-center gap-2 text-xs text-neutral-400">
                实时监听：
                <span className={dirWatcher === 'running' ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-400'}>
                  {dirWatcher || '…'}
                </span>
              </span>
            </div>
          </section>

          <section className="mb-6 wb-card p-5">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              <span><FolderOpen className="h-4 w-4" /></span> 添加本地目录
            </h2>
            <div className="flex flex-wrap gap-2">
              <input
                value={dirName}
                onChange={(e) => setDirName(e.target.value)}
                placeholder="名称（如 docs）"
                className={`${box} w-44`}
              />
              <input
                value={dirPath}
                onChange={(e) => setDirPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addDir()}
                placeholder="绝对路径，如 D:\docs 或 C:\Users\you\Documents"
                className={`${box} min-w-[280px] flex-1`}
              />
              <button
                onClick={addDir}
                disabled={!!dirBusy || !dirName.trim() || !dirPath.trim()}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
              >
                {dirBusy === 'add' ? '索引中…' : '扫描并索引'}
              </button>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-neutral-400">
              把 vault 之外的本地文件夹接入 RAG（文档/源码/文本，单文件 ≤500KB，最多 3000 个，跳过 node_modules/.git
              等）。文件新增或修改会自动重新索引；来源标记为 <code>dirs/名称/路径</code>，不会出现在笔记列表里，也不进备份。
            </p>
            {dirMsg && <p className="mt-2 text-xs text-neutral-500">{dirMsg}</p>}
          </section>

          <section className="mb-6">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                <span><FolderOpen className="h-4 w-4" /></span> 已索引目录
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-500 dark:bg-neutral-800">
                  {dirs.length}
                </span>
              </h2>
            </div>
            {dirs.length === 0 ? (
              <EmptyHint
                pad="sm"
                title="还没有目录。"
                hint="注册后里面的文档就能在对话里被 RAG 检索到，且文件改动实时同步。"
              />
            ) : (
              <ul className="space-y-2">
                {dirs.map((d) => (
                  <li
                    key={d.name}
                    className="wb-card wb-card-hover flex items-center gap-4 p-4 text-sm"
                  >
                    <div className="wb-chip h-10 w-10 bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300">
                      <FolderOpen className="h-[18px] w-[18px]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-neutral-800 dark:text-neutral-100">{d.name}</span>
                        {!d.enabled && (
                          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                            已停用
                          </span>
                        )}
                        {!d.exists && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                            目录缺失
                          </span>
                        )}
                        {d.truncated && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                            已截断
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-xs text-neutral-400">{d.path}</div>
                      <div className="mt-0.5 text-xs text-neutral-400">
                        {d.last_synced ? `上次同步 ${d.last_synced.replace('T', ' ')}` : '尚未同步'}
                      </div>
                      {d.errors && d.errors.length > 0 && (
                        <div className="mt-0.5 text-xs text-red-500">{d.errors.length} 个文件失败：{d.errors[0]}</div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-5">
                      <div className="text-right">
                        <p className="text-lg font-semibold leading-none text-neutral-800 dark:text-neutral-100">
                          {d.enabled ? (d.files ?? '–') : '—'}
                        </p>
                        <p className="mt-1 text-xs text-neutral-400">文件</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-semibold leading-none text-neutral-800 dark:text-neutral-100">
                          {d.enabled ? (d.chunks ?? '–') : '—'}
                        </p>
                        <p className="mt-1 text-xs text-neutral-400">块</p>
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => syncDir(d.name)}
                          disabled={!!dirBusy || !d.enabled}
                          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs disabled:opacity-40 dark:border-neutral-700"
                        >
                          {dirBusy === d.name ? '…' : '同步'}
                        </button>
                        <button
                          onClick={() => toggleDir(d)}
                          disabled={!!dirBusy}
                          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs disabled:opacity-40 dark:border-neutral-700"
                        >
                          {d.enabled ? '停用' : '启用'}
                        </button>
                        <button
                          onClick={() => removeDir(d.name)}
                          disabled={!!dirBusy}
                          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-red-600 disabled:opacity-40 dark:border-neutral-700"
                        >
                          移除
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="mt-6 text-xs leading-relaxed text-neutral-400">
            停用会清掉该目录的索引（原文件不动），重新启用自动全量重扫；移除同时删除配置项。实时监听在服务重启后自动恢复。
          </p>
        </>
      )}

      {tab === 'eval' && (
        <>
          <section className="wb-card-hero mb-6 rounded-lg p-5">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div className="flex items-end gap-6">
                <div>
                  <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{evalItems.length}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">评估集题目</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{runs.length}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">评估次数</p>
                </div>
                {runs.length > 0 && (
                  <div>
                    <p className={`text-2xl font-bold ${hitColor(runs[0].hit1)}`}>{pct(runs[0].hit1)}</p>
                    <p className="mt-0.5 text-xs text-neutral-500">最近 Hit@1</p>
                  </div>
                )}
              </div>
              <span className="ml-auto text-xs text-neutral-400">改了 top_k / rerank 后重跑即可对比效果</span>
            </div>
          </section>

          {/* Eval set */}
          <section className="mb-6 wb-card p-5">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              <span><ClipboardCheck className="h-4 w-4" /></span> 评估集
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-500 dark:bg-neutral-800">
                {evalItems.length} 题
              </span>
            </h2>
            <p className="mb-3 text-xs leading-relaxed text-neutral-400">
              每题写一个问题 + 期望检索到的文件，跑一次就能量化 Hit@k / MRR；开启判分再让模型给回答忠实度打 0-5 分。改了 rerank / top_k 后重跑即可对比。
            </p>
            {evalItems.length > 0 && (
              <ul className="mb-3 flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
                {evalItems.map((it) => (
                  <li key={it.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate">{it.question}</p>
                      <p className="mt-0.5 truncate text-xs text-neutral-400">
                        期望 <code className="text-neutral-500">{it.expected_source || '（未标注）'}</code>
                        {it.note && ` · ${it.note}`}
                      </p>
                    </div>
                    <span className="flex shrink-0 gap-2 text-xs">
                      <button
                        onClick={() => {
                          setEditId(it.id)
                          setDraft({ question: it.question, expected_source: it.expected_source, note: it.note })
                        }}
                        className="text-neutral-500 hover:underline"
                      >
                        编辑
                      </button>
                      <button onClick={() => removeEvalItem(it.id)} className="text-red-500 hover:underline">
                        删除
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
              <p className="text-xs font-medium text-neutral-500">
                {editId ? '编辑第 ' + editId + ' 题' : '新增问题'}
              </p>
              <input
                value={draft.question}
                onChange={(e) => setDraft({ ...draft, question: e.target.value })}
                placeholder="问题，例如：RAG 的检索流程分哪几步？"
                className={box}
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={draft.expected_source}
                  onChange={(e) => setDraft({ ...draft, expected_source: e.target.value })}
                  placeholder="期望命中文件（可填文件名）"
                  list="vault-files"
                  className={box}
                />
                <input
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                  placeholder="备注（可选）"
                  className={box}
                />
              </div>
              <datalist id="vault-files">
                {(files?.files ?? []).map((f) => (
                  <option key={f.path} value={f.path} />
                ))}
              </datalist>
              <div className="flex gap-2">
                <button
                  onClick={saveEvalItem}
                  disabled={!draft.question.trim()}
                  className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
                >
                  {editId ? '保存修改' : '添加'}
                </button>
                {editId && (
                  <button
                    onClick={() => {
                      setEditId(null)
                      setDraft({ question: '', expected_source: '', note: '' })
                    }}
                    className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
                  >
                    取消
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* Run */}
          <section className="mb-6 wb-card p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              <span><Play className="h-4 w-4" /></span> 运行评估
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={runEvalNow}
                disabled={running || !evalItems.length}
                className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:from-neutral-200 disabled:to-neutral-200 disabled:text-neutral-400 dark:disabled:from-neutral-800 dark:disabled:to-neutral-800"
              >
                {running ? '评估中…' : '运行评估'}
              </button>
              <label className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
                top_k
                <input
                  value={evalTopK}
                  onChange={(e) => setEvalTopK(e.target.value.replace(/\D/g, ''))}
                  placeholder="默认"
                  className={`${box} w-16`}
                />
              </label>
              <label className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
                <input type="checkbox" checked={judge} onChange={(e) => setJudge(e.target.checked)} />
                用模型判忠实度（每题多 2 次调用）
              </label>
            </div>
            {running ? (
              <RunPanel
                phase="planning"
                tone="violet"
                icon="📊"
                title="运行评估"
                status={
                  evalStopping
                    ? '正在停…（已开跑的那条跑完，没轮到的跳过）'
                    : evalMsg || undefined
                }
                onCancel={() => {
                  void api.cancelEvalRun().then((r) => {
                    if (r.stopped) setEvalStopping(true)
                  })
                }}
              />
            ) : (
              evalMsg && (
                <p className="mt-2 whitespace-pre-wrap text-xs text-neutral-500">{evalMsg}</p>
              )
            )}
          </section>

          {/* History */}
          <section className="wb-card p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              <span><TrendingUp className="h-4 w-4" /></span> 分数趋势
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-500 dark:bg-neutral-800">
                最近 {runs.length} 次
              </span>
            </h2>
            {!runs.length && (
              <EmptyHint
                pad="sm"
                title="还没有评估记录。"
                hint="先添加问题再运行评估。"
              />
            )}
            {runs.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-neutral-400">
                    <tr>
                      <th className="py-1 pr-3 font-normal">时间</th>
                      <th className="py-1 pr-3 font-normal">配置</th>
                      <th className="py-1 pr-3 font-normal">Hit@1</th>
                      <th className="py-1 pr-3 font-normal">Hit@3</th>
                      <th className="py-1 pr-3 font-normal">Hit@k</th>
                      <th className="py-1 pr-3 font-normal">MRR</th>
                      <th className="py-1 pr-3 font-normal">忠实度</th>
                      <th className="py-1 font-normal"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                    {runs.map((r) => (
                      <tr key={r.id} className={openRun?.id === r.id ? 'bg-neutral-50 dark:bg-neutral-900/60' : ''}>
                        <td className="py-1.5 pr-3 text-xs text-neutral-500">
                          {(r.created_at ?? '').slice(5, 16).replace('T', ' ')}
                        </td>
                        <td className="py-1.5 pr-3 text-xs text-neutral-500">
                          k={r.top_k}
                          {r.hybrid ? ' · 混合' : ' · 纯向量'}
                          {r.rerank ? ' · 精排' : ''}
                        </td>
                        <td className="py-1.5 pr-3">
                          <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${hitColor(r.hit1)}`}>{pct(r.hit1)}</span>
                        </td>
                        <td className="py-1.5 pr-3">
                          <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${hitColor(r.hit3)}`}>{pct(r.hit3)}</span>
                        </td>
                        <td className="py-1.5 pr-3">
                          <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${hitColor(r.hitk)}`}>{pct(r.hitk)}</span>
                        </td>
                        <td className="py-1.5 pr-3">{r.mrr.toFixed(3)}</td>
                        <td className="py-1.5 pr-3">{r.faithfulness === null ? '—' : `${r.faithfulness}/5`}</td>
                        <td className="py-1.5 text-right text-xs">
                          <button onClick={() => toggleRunDetail(r)} className="text-violet-500 hover:underline">
                            {openRun?.id === r.id ? '收起' : '明细'}
                          </button>
                          <button onClick={() => removeRun(r.id)} className="ml-2 text-red-500 hover:underline">
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {openRun?.detail && (
              <div className="mt-4 flex flex-col gap-2">
                <p className="text-xs text-neutral-400">
                  第 {openRun.id} 次明细 · {openRun.total} 题 · {openRun.judge_model || '未判分'} · {openRun.seconds}s
                </p>
                {openRun.detail.map((d) => (
                  <div key={d.id} className="rounded-md bg-neutral-100 p-3 text-sm dark:bg-neutral-900">
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 flex-1">{d.question}</p>
                      <span className="flex shrink-0 items-center gap-2 text-xs">
                        <span
                          className={`rounded px-1.5 py-px ${
                            d.rank === 1
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                              : d.rank
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                                : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                          }`}
                        >
                          {d.expected_source ? (d.rank ? `第 ${d.rank} 位命中` : '未命中') : '未标注'}
                        </span>
                        {d.score !== null && <span className="text-neutral-500">忠实度 {d.score}/5</span>}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-neutral-400">
                      期望 {d.expected_source || '—'} · 检索到 {d.hits.filter(Boolean).join(' , ') || '（无）'}
                    </p>
                    {d.reason && <p className="mt-1 text-xs text-neutral-500">判分理由：{d.reason}</p>}
                    {d.error && <p className="mt-1 text-xs text-red-500">{d.error}</p>}
                    {d.answer && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-neutral-500">查看回答</summary>
                        <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
                          {d.answer}
                        </pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {tab === 'kg' && (
        <>
          <section className="wb-card-hero mb-6 rounded-lg p-5">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div className="flex items-end gap-6">
                <div>
                  <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{kg?.entities ?? 0}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">实体</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{kg?.relations ?? 0}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">关系</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-neutral-800 dark:text-neutral-100">{kg?.files ?? 0}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">文件</p>
                </div>
              </div>
              {kg && (
                <span
                  className={`ml-auto flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${
                    kg.ok
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                      : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full ${kg.ok ? 'bg-emerald-500' : 'bg-neutral-400'}`} />
                  {kg.ok ? '已连接' : '未连接'}
                </span>
              )}
            </div>
          </section>

          <section className="mb-6 wb-card p-5">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              <span><Waypoints className="h-4 w-4" /></span> 知识图谱配置
              <span className="text-xs font-normal text-neutral-400">本地 Neo4j</span>
            </h2>
            <p className="-mt-1 mb-3 text-xs leading-relaxed text-neutral-400">
              用模型从笔记中抽取实体与关系，存入你本机的 Neo4j（实体标签 KgEntity，不影响库里已有数据）。开启后聊天里勾选知识库检索时会叠加「向量匹配实体 → 一跳扩展」的图谱上下文。构建按文件增量抽取，文件多时可多次点击。
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                Bolt 地址
                <input
                  value={kgForm.uri}
                  onChange={(e) => setKgForm({ ...kgForm, uri: e.target.value })}
                  placeholder="bolt://localhost:7687"
                  className={`${box} w-64`}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                用户名
                <input
                  value={kgForm.user}
                  onChange={(e) => setKgForm({ ...kgForm, user: e.target.value })}
                  className={`${box} w-32`}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                密码{kg?.password_set ? '（已保存，留空则不修改）' : ''}
                <input
                  type="password"
                  value={kgForm.password}
                  onChange={(e) => setKgForm({ ...kgForm, password: e.target.value })}
                  className={`${box} w-44`}
                />
              </label>
              <label className="flex items-center gap-2 pb-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={kgForm.enabled}
                  onChange={(e) => setKgForm({ ...kgForm, enabled: e.target.checked })}
                />
                启用图谱检索
              </label>
              <button
                onClick={saveKg}
                disabled={kgBusy !== ''}
                className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
              >
                {kgBusy === 'save' ? '连接中…' : '保存并测试连接'}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={buildKg}
                disabled={kgBusy !== '' || !kg?.ok || !kg?.enabled}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-neutral-700"
              >
                {kgBusy === 'build' ? '抽取中…' : '构建图谱（增量 8 个文件）'}
              </button>
              <button
                onClick={clearKg}
                disabled={kgBusy !== '' || !kg?.ok}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-red-400 hover:text-red-600 disabled:opacity-40 dark:border-neutral-700"
              >
                清空图谱
              </button>
              {kgMsg && <span className="text-xs text-neutral-400">{kgMsg}</span>}
            </div>
          </section>
          <section className="wb-card p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              <span><Search className="h-4 w-4" /></span> 图谱检索测试
            </h2>
            <div className="flex gap-2">
              <input
                value={kgQ}
                onChange={(e) => setKgQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && queryKg()}
                placeholder="输入一个问题，看图谱能匹配到哪些实体与关系"
                className={`${box} flex-1`}
              />
              <button
                onClick={queryKg}
                disabled={kgBusy !== '' || !kg?.ok || !kgQ.trim()}
                className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
              >
                {kgBusy === 'query' ? '检索中…' : '检索'}
              </button>
            </div>
            {kgResult && (
              <div className="mt-3 space-y-2">
                <p className="text-xs font-medium text-neutral-500">实体（{kgResult.entities.length}）</p>
                {kgResult.entities.map((e) => (
                  <div key={e.name} className="rounded-md bg-neutral-50 p-2 text-xs dark:bg-neutral-900">
                    <span className="font-medium">{e.name}</span>
                    <span className="ml-2 text-neutral-400">相似度 {e.score}</span>
                    {e.description && <p className="mt-0.5 text-neutral-500">{e.description}</p>}
                  </div>
                ))}
                {kgResult.relations.length > 0 && (
                  <>
                    <p className="text-xs font-medium text-neutral-500">关系（{kgResult.relations.length}）</p>
                    {kgResult.relations.slice(0, 12).map((r, i) => (
                      <p key={i} className="text-xs text-neutral-500">
                        {r.src} —<span className="text-violet-500">{r.type}</span>→ {r.dst}
                        {r.description && <span className="text-neutral-400">：{r.description}</span>}
                      </p>
                    ))}
                  </>
                )}
                {!kgResult.entities.length && <p className="text-xs text-neutral-400">没有匹配到实体 — 先构建图谱，或换个说法试试</p>}
              </div>
            )}
          </section>
        </>
      )}
      </div>
    </>
  )
}
