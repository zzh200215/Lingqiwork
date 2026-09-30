import type { Dispatch, SetStateAction } from 'react'
import { Headphones, Podcast } from 'lucide-react'
import type { PodcastEntry } from './api'

// 双人播客面板——JSX 从 NotesPage 原样搬来（方向 6），状态由 usePodcast 持有、宿主下发。
export default function NotePodcastPanel(props: {
  files: { path: string }[]
  podSources: string[]
  setPodSources: Dispatch<SetStateAction<string[]>>
  addPodSource: (rel: string) => void
  podHost: string
  setPodHost: Dispatch<SetStateAction<string>>
  podGuest: string
  setPodGuest: Dispatch<SetStateAction<string>>
  podVoices: string[]
  generatePod: () => Promise<void>
  podBusy: boolean
  podStage: string
  podMsg: string
  podList: PodcastEntry[]
  removePod: (id: string) => Promise<void>
  podScriptId: string | null
  setPodScriptId: Dispatch<SetStateAction<string | null>>
  togglePod: () => void
}) {
  const { files, podSources, setPodSources, addPodSource, podHost, setPodHost, podGuest, setPodGuest, podVoices, generatePod, podBusy, podStage, podMsg, podList, removePod, podScriptId, setPodScriptId, togglePod } = props
  return (
          <aside className="hidden w-80 shrink-0 flex-col overflow-hidden border-l border-neutral-200/80 bg-white/60 md:flex dark:border-neutral-800/80 dark:bg-neutral-950/60">
            <div className="flex items-center justify-between border-b border-neutral-200/80 px-3 py-2.5 dark:border-neutral-800/80">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
                <Podcast className="h-4 w-4" />
                双人播客
              </h2>
              <button
                onClick={togglePod}
                className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
              >
                ×
              </button>
            </div>
            <div className="border-b border-neutral-200/80 px-3 py-3 dark:border-neutral-800/80">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">来源笔记（可合并，最多 5 篇）：</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {podSources.map((s) => (
                  <span
                    key={s}
                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-xs text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                  >
                    <span className="max-w-[180px] truncate">{s}</span>
                    <button
                      onClick={() => setPodSources((prev) => prev.filter((x) => x !== s))}
                      className="text-neutral-400 hover:text-red-500"
                      title="移除"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {podSources.length < 5 && (
                  <select
                    value=""
                    onChange={(e) => addPodSource(e.target.value)}
                    className="rounded-full border border-dashed border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 outline-none dark:border-neutral-600 dark:text-neutral-400"
                  >
                    <option value="">＋ 添加笔记…</option>
                    {files
                      .filter((f) => !podSources.includes(f.path))
                      .map((f) => (
                        <option key={f.path} value={f.path}>
                          {f.path}
                        </option>
                      ))}
                  </select>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="block text-xs text-neutral-400">
                  主持人音色
                  <select
                    value={podHost}
                    onChange={(e) => setPodHost(e.target.value)}
                    className="mt-1 w-full rounded-md border border-neutral-200 bg-white px-1.5 py-1 text-xs outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    <option value="">跟随设置</option>
                    {podVoices.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs text-neutral-400">
                  嘉宾音色
                  <select
                    value={podGuest}
                    onChange={(e) => setPodGuest(e.target.value)}
                    className="mt-1 w-full rounded-md border border-neutral-200 bg-white px-1.5 py-1 text-xs outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    <option value="">跟随设置</option>
                    {podVoices.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                onClick={generatePod}
                disabled={podBusy || !podSources.length}
                className="mt-2 w-full rounded-md bg-gradient-to-r from-amber-500 to-orange-500 px-2.5 py-1.5 text-xs font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
              >
                {podBusy ? (
                  <>
                    <Podcast className="mr-1 inline h-3 w-3" />
                    {podStage}…
                  </>
                ) : (
                  <>
                    <Podcast className="mr-1 inline h-3 w-3" />
                    生成播客
                  </>
                )}
              </button>
              {podMsg && <p className="mt-2 text-xs text-red-500">{podMsg}</p>}
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
              {podList.map((p) => (
                <div
                  key={p.id}
                  className="wb-card p-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate text-xs font-medium text-neutral-700 dark:text-neutral-200">
                        <Headphones className="h-3 w-3 shrink-0 text-neutral-400" />
                        {p.title}
                      </p>
                      <p className="mt-0.5 text-xs text-neutral-400">
                        {p.turns} 轮 · {Math.floor(p.duration_sec / 60)}分{Math.round(p.duration_sec % 60)}秒 ·{' '}
                        {p.created_at.replace('T', ' ').slice(5, 16)}
                      </p>
                    </div>
                    <button
                      onClick={() => removePod(p.id)}
                      className="shrink-0 text-neutral-400 hover:text-red-500"
                      title="删除"
                    >
                      ×
                    </button>
                  </div>
                  <audio controls preload="none" src={`/api/podcast/audio/${p.file}`} className="mt-2 h-8 w-full" />
                  <button
                    onClick={() => setPodScriptId((s) => (s === p.id ? null : p.id))}
                    className="mt-1.5 text-xs text-neutral-400 hover:text-violet-600 dark:hover:text-violet-300"
                  >
                    {podScriptId === p.id ? '收起文稿' : '查看文稿'}
                  </button>
                  {podScriptId === p.id && (
                    <div className="mt-1.5 max-h-60 space-y-1.5 overflow-y-auto">
                      {p.script.map((t, i) => (
                        <p key={i} className="text-xs leading-snug">
                          <span
                            className={`mr-1 font-medium ${
                              t.speaker === 'host' ? 'text-amber-600 dark:text-amber-400' : 'text-sky-600 dark:text-sky-400'
                            }`}
                          >
                            {t.speaker === 'host' ? '主持人' : '嘉宾'}：
                          </span>
                          <span className="text-neutral-600 dark:text-neutral-300">{t.text}</span>
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {!podList.length && (
                <p className="py-8 text-center text-xs leading-relaxed text-neutral-400">
                  把笔记变成一期 5 分钟左右的
                  <br />
                  主持人 × 嘉宾 对谈音频
                </p>
              )}
            </div>
          </aside>
  )
}
