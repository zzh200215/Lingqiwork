// 「代码仓库」页签：克隆/同步/删除 git 仓库并索引（方向 6 第三刀自 KBPage 拆出）。
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GitBranch, GraduationCap } from 'lucide-react'
import { api, type RepoItem } from './api'
import EmptyHint from './EmptyHint'
import { box, type KbCounts } from './kbShared'

interface Props {
  /** 页签是否处于激活态——只在激活时拉数据（原实现是父组件里的 if (tab === 'repos') refreshRepos()） */
  active: boolean
  onCounts: (patch: Partial<KbCounts>) => void
}

export default function KbReposTab({ active, onCounts }: Props) {
  const navigate = useNavigate()
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
    onCounts({ repos: r.repos.length })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (active) refreshRepos()
  }, [active, refreshRepos])

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

  const reposTotalFiles = repos.reduce((s, r) => s + (r.files ?? 0), 0)
  const reposTotalChunks = repos.reduce((s, r) => s + (r.chunks ?? 0), 0)

  return (
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
  )
}
