import { useCallback, useEffect, useRef, useState } from 'react'
import Layout from './Layout'
import { api, type DirItem, type EvalItem, type EvalRun, type KgRetrieval, type KgStatus, type RepoItem } from './api'

interface KbStats {
  chunks: number
  files: number
  watcher: string
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

export default function KbPage() {
  const [tab, setTab] = useState<'index' | 'repos' | 'dirs' | 'eval' | 'kg'>('index')
  const [stats, setStats] = useState<KbStats | null>(null)
  const [files, setFiles] = useState<{ vault_dir: string; files: string[] } | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [uploadMsg, setUploadMsg] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [clipUrl, setClipUrl] = useState('')
  const [clipMsg, setClipMsg] = useState('')
  const [clipping, setClipping] = useState(false)
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
    setEvalMsg('评估中…（每题一次检索' + (judge ? ' + 两次模型调用' : '') + '，请稍候）')
    try {
      const r = await api.runEval(evalTopK ? Number(evalTopK) : null, judge)
      setEvalMsg(
        `✓ 第 ${r.id} 次评估：Hit@1 ${pct(r.hit1)} · Hit@3 ${pct(r.hit3)} · MRR ${r.mrr}` +
          (r.faithfulness !== null ? ` · 忠实度 ${r.faithfulness}/5` : '（未判分）') +
          ` · ${r.seconds}s`
      )
      setOpenRun(r)
      await refreshEval()
    } catch (e) {
      setEvalMsg(`❌ ${String(e)}`)
    } finally {
      setRunning(false)
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
    const [s, f] = await Promise.all([
      fetch('/api/kb/stats').then((r) => r.json()),
      fetch('/api/kb/files').then((r) => r.json()),
    ])
    setStats(s)
    setFiles(f)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function uploadFiles(list: FileList | File[]) {
    setUploadMsg('')
    for (const file of Array.from(list)) {
      const fd = new FormData()
      fd.append('file', file)
      try {
        const r = await fetch('/api/kb/upload', { method: 'POST', body: fd })
        const data = await r.json()
        if (!r.ok) throw new Error(data.detail || data.message || '上传失败')
        setUploadMsg((prev) => `${prev}${prev ? '\n' : ''}✅ ${data.filename} → ${data.chunks} 块`)
      } catch (e) {
        setUploadMsg((prev) => `${prev}${prev ? '\n' : ''}❌ ${file.name}: ${String(e)}`)
      }
    }
    await refresh()
  }

  async function reindex() {
    setBusy(true)
    setMessage('索引中…（首次会下载 embedding 模型，约 100MB）')
    try {
      const r = await fetch('/api/kb/reindex', { method: 'POST' })
      const data = await r.json()
      setMessage(
        `完成：${data.files} 个文件 / ${data.chunks} 个块 / ${data.seconds}s` +
          (data.pruned?.length ? ` / 清理已删除来源: ${data.pruned.join(', ')}` : '') +
          (data.errors.length ? ` / 错误: ${data.errors.join('; ')}` : '')
      )
      await refresh()
    } catch (e) {
      setMessage(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function clip() {
    const url = clipUrl.trim()
    if (!url || clipping) return
    setClipping(true)
    setClipMsg('')
    try {
      const r = await api.clipUrl(url)
      setClipMsg(`✅ ${r.title} → ${r.filename}（${r.chars} 字 / ${r.chunks} 块）`)
      setClipUrl('')
      await refresh()
    } catch (e) {
      setClipMsg(`❌ ${String(e)}`)
    } finally {
      setClipping(false)
    }
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

  return (
    <Layout page="kb">
      <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">知识库</h1>
        <div className="flex gap-1 rounded-md bg-neutral-100 p-1 text-sm dark:bg-neutral-900">
          {([['index', '索引与检索'], ['repos', '代码仓库'], ['dirs', '本地目录'], ['eval', '评估'], ['kg', '知识图谱']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded px-3 py-1 transition-colors ${
                tab === key
                  ? 'bg-white font-medium shadow-sm dark:bg-neutral-800'
                  : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'index' && (
        <>

      {/* Status */}
      <section className="mb-6 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex items-center justify-between">
          <div className="text-sm text-neutral-600 dark:text-neutral-300">
            <span className="font-medium">{stats?.files ?? '–'}</span> 个文件 ·{' '}
            <span className="font-medium">{stats?.chunks ?? '–'}</span> 个块 · 监听:{' '}
            <span className={stats?.watcher === 'running' ? 'text-green-600' : 'text-neutral-400'}>
              {stats?.watcher ?? '…'}
            </span>
          </div>
          <button
            onClick={reindex}
            disabled={busy}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            全量重建索引
          </button>
        </div>
        <p className="mt-2 break-all text-xs text-neutral-400">vault 目录：{files?.vault_dir}</p>
        {files && files.files.length > 0 && (
          <ul className="mt-2 max-h-40 overflow-y-auto text-xs text-neutral-500">
            {files.files.map((f) => (
              <li key={f}>· {f}</li>
            ))}
          </ul>
        )}
        {message && <p className="mt-2 text-xs text-neutral-500">{message}</p>}
      </section>

      {/* Upload */}
      <section className="mb-6">
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
          className={`cursor-pointer rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors ${
            dragOver
              ? 'border-neutral-500 bg-neutral-100 dark:bg-neutral-900'
              : 'border-neutral-300 text-neutral-500 hover:border-neutral-400 dark:border-neutral-700'
          }`}
        >
          拖 PDF / Word / Markdown / TXT 到此处，或点击选择文件（自动分词入库）
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".md,.markdown,.txt,.pdf,.docx"
            className="hidden"
            onChange={(e) => e.target.files && uploadFiles(e.target.files)}
          />
        </div>
        {uploadMsg && (
          <pre className="mt-2 whitespace-pre-wrap rounded-md bg-neutral-100 p-2 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
            {uploadMsg}
          </pre>
        )}
      </section>

      {/* Web clipper */}
      <section className="mb-6 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="mb-3 font-medium">🌐 网页剪藏</h2>
        <p className="-mt-1 mb-2 text-xs leading-relaxed text-neutral-400">
          粘贴 URL，抓取正文存为 Markdown 到 vault/clippings/ 并自动索引。
        </p>
        <div className="flex gap-2">
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
      </section>

      {/* Search debug */}
      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="mb-3 font-medium">检索调试</h2>
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
              <div key={h.id} className="rounded-md bg-neutral-100 p-3 text-sm dark:bg-neutral-900">
                <div className="mb-1 flex items-center justify-between text-xs text-neutral-500">
                  <span>
                    {h.source} · chunk {h.chunk}
                    {h.channels && (
                      <span className="ml-2 inline-flex gap-1">
                        {h.channels.includes('vec') && (
                          <span className="rounded bg-violet-100 px-1 py-px text-[10px] text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                            向量
                          </span>
                        )}
                        {h.channels.includes('bm25') && (
                          <span className="rounded bg-sky-100 px-1 py-px text-[10px] text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                            BM25
                          </span>
                        )}
                        {h.channels.includes('rerank') && (
                          <span className="rounded bg-amber-100 px-1 py-px text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                            精排
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span>score {h.score}</span>
                    {h.source?.endsWith('.md') && (
                      <a
                        href={`/notes.html?path=${encodeURIComponent(h.source)}`}
                        className="text-violet-500 transition-colors hover:text-violet-700 hover:underline dark:text-violet-400"
                      >
                        打开
                      </a>
                    )}
                  </span>
                </div>
                <p className="whitespace-pre-wrap leading-relaxed">{h.text}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="mt-6 text-xs leading-relaxed text-neutral-400">
        把 .md / .txt / .pdf / .docx 放进 vault 目录即可自动索引；「全量重建」手动触发一遍。对话页打开「知识库(RAG)」开关即可在聊天中引用。
      </p>
        </>
      )}

      {tab === 'repos' && (
        <>
          <section className="mb-6 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h2 className="mb-2 text-sm font-medium">添加仓库</h2>
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
            <h2 className="mb-2 text-sm font-medium">已索引仓库（{repos.length}）</h2>
            {repos.length === 0 ? (
              <p className="text-xs text-neutral-400">还没有仓库。索引后代码和文档都能在对话里被 RAG 检索到。</p>
            ) : (
              <ul className="space-y-2">
                {repos.map((r) => (
                  <li
                    key={r.name}
                    className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{r.name}</span>
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
                        <div className="truncate text-xs text-neutral-400">{r.url}</div>
                        <div className="mt-1 text-xs text-neutral-500">
                          {r.files ?? '–'} 个文件 · {r.chunks ?? '–'} 个块
                          {r.last_synced ? ` · 上次同步 ${r.last_synced.replace('T', ' ')}` : ''}
                        </div>
                        {r.errors && r.errors.length > 0 && (
                          <div className="mt-1 text-xs text-red-500">
                            {r.errors.length} 个文件失败：{r.errors[0]}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          onClick={() => syncRepo(r.name)}
                          disabled={!!repoBusy}
                          className="rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-neutral-700"
                        >
                          {repoBusy === r.name ? '…' : '同步'}
                        </button>
                        <button
                          onClick={() => removeRepo(r.name)}
                          disabled={!!repoBusy}
                          className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-red-600 disabled:opacity-40 dark:border-neutral-700"
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
          <section className="mb-6 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h2 className="mb-2 text-sm font-medium">添加本地目录</h2>
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
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium">已索引目录（{dirs.length}）</h2>
              <span className="text-xs text-neutral-400">
                实时监听：{' '}
                <span className={dirWatcher === 'running' ? 'text-green-600' : 'text-neutral-400'}>
                  {dirWatcher || '…'}
                </span>
              </span>
            </div>
            {dirs.length === 0 ? (
              <p className="text-xs text-neutral-400">
                还没有目录。注册后里面的文档就能在对话里被 RAG 检索到，且文件改动实时同步。
              </p>
            ) : (
              <ul className="space-y-2">
                {dirs.map((d) => (
                  <li
                    key={d.name}
                    className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">📁 {d.name}</span>
                          {!d.enabled && <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">已停用</span>}
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
                        <div className="mt-1 text-xs text-neutral-500">
                          {d.enabled ? `${d.files ?? '–'} 个文件 · ${d.chunks ?? '–'} 个块` : '未索引'}
                          {d.last_synced ? ` · 上次同步 ${d.last_synced.replace('T', ' ')}` : ''}
                        </div>
                        {d.errors && d.errors.length > 0 && (
                          <div className="mt-1 text-xs text-red-500">
                            {d.errors.length} 个文件失败：{d.errors[0]}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          onClick={() => syncDir(d.name)}
                          disabled={!!dirBusy || !d.enabled}
                          className="rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-neutral-700"
                        >
                          {dirBusy === d.name ? '…' : '同步'}
                        </button>
                        <button
                          onClick={() => toggleDir(d)}
                          disabled={!!dirBusy}
                          className="rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-neutral-700"
                        >
                          {d.enabled ? '停用' : '启用'}
                        </button>
                        <button
                          onClick={() => removeDir(d.name)}
                          disabled={!!dirBusy}
                          className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-red-600 disabled:opacity-40 dark:border-neutral-700"
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
          {/* Eval set */}
          <section className="mb-6 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h2 className="mb-1 font-medium">评估集 · {evalItems.length} 题</h2>
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
                  <option key={f} value={f} />
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
          <section className="mb-6 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
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
            {evalMsg && <p className="mt-2 whitespace-pre-wrap text-xs text-neutral-500">{evalMsg}</p>}
          </section>

          {/* History */}
          <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h2 className="mb-3 font-medium">分数趋势 · 最近 {runs.length} 次</h2>
            {!runs.length && <p className="text-sm text-neutral-400">还没有评估记录，先添加问题再运行评估。</p>}
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
                        <td className="py-1.5 pr-3">{pct(r.hit1)}</td>
                        <td className="py-1.5 pr-3">{pct(r.hit3)}</td>
                        <td className="py-1.5 pr-3">{pct(r.hitk)}</td>
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
          <section className="mb-6 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-medium">知识图谱（本地 Neo4j）</h2>
              {kg && (
                <span className={`text-xs ${kg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-400'}`}>
                  {kg.ok
                    ? `已连接 · 实体 ${kg.entities ?? 0} / 关系 ${kg.relations ?? 0} / 文件 ${kg.files ?? 0}`
                    : '未连接'}
                </span>
              )}
            </div>
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
          <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h2 className="mb-3 font-medium">检索测试</h2>
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
    </Layout>
  )
}
