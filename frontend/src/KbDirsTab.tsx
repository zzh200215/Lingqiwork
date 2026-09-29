// 「本地目录」页签：把 vault 之外的本地文件夹接入 RAG（方向 6 第三刀自 KBPage 拆出）。
import { useCallback, useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { api, type DirItem } from './api'
import EmptyHint from './EmptyHint'
import { box, type KbCounts } from './kbShared'

interface Props {
  /** 页签是否处于激活态——只在激活时拉数据（原实现是父组件里的 if (tab === 'dirs') refreshDirs()） */
  active: boolean
  onCounts: (patch: Partial<KbCounts>) => void
}

export default function KbDirsTab({ active, onCounts }: Props) {
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
    onCounts({ dirs: r.dirs.length })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (active) refreshDirs()
  }, [active, refreshDirs])

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

  const dirsTotalFiles = dirs.reduce((s, d) => s + (d.enabled ? (d.files ?? 0) : 0), 0)
  const dirsTotalChunks = dirs.reduce((s, d) => s + (d.enabled ? (d.chunks ?? 0) : 0), 0)

  return (
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
  )
}
