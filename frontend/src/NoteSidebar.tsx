import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileText, Sparkles } from 'lucide-react'
import VoiceTriage from './VoiceTriage'
import { api, type NoteSearchHit, type VoicePending } from './api'
import { ago } from './reltime'
import type { NoteFile } from './NotesPage'

// 文件列表侧栏——从 NotesPage 抽出（方向 6）。列表/全文搜索/简报/语音备忘分诊
// 只服务这一栏，随栏自含；打开/删除/新建/从材料生成四件事由宿主做、经 props 进来。
// 侧栏恒挂载（窄屏只是 CSS 藏起），挂载取数语义与抽出前一致。
export default function NoteSidebar(props: {
  files: NoteFile[]
  activePath: string | null
  openNote: (path: string) => Promise<void>
  removeNote: (path: string) => Promise<void>
  newNote: () => void | Promise<void>
  composeNote: () => Promise<void>
  composeBusy: boolean
  composeMsg: string
}) {
  const { files, activePath, openNote, removeNote, newNote, composeNote, composeBusy, composeMsg } = props
  const [searchQ, setSearchQ] = useState('')
  const [searchHits, setSearchHits] = useState<NoteSearchHit[]>([])
  const [briefing, setBriefing] = useState<string | null>(null)
  // 那一问的载荷（`null` = 还没读到 / 读不到 → 那一块不渲染）
  const [voice, setVoice] = useState<VoicePending | null>(null)

  // 那一问（R2 · PLAN5 §3）：还没归类的语音备忘。**拉取式**——页面打开时取一次，
  // 回答完一份再取一次；失败就整块不渲染（增强不挡路，§4-9）。
  const refreshVoice = useCallback(() => {
    api.voiceNotes().then(setVoice).catch(() => setVoice(null))
  }, [])

  // 零柒口吻的笔记简报（轻量、不阻塞列表）
  useEffect(() => {
    api.notesBriefing().then((b) => setBriefing(b.text)).catch(() => {})
  }, [])

  // 列表按修改时间分组：今天 / 本周 / 更早
  const groupedFiles = useMemo(() => {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const weekStart = new Date(todayStart.getTime() - 6 * 86400_000)
    const groups: { label: string; items: NoteFile[] }[] = [
      { label: '今天', items: [] },
      { label: '本周', items: [] },
      { label: '更早', items: [] },
    ]
    for (const f of files) {
      const d = new Date(f.mtime * 1000)
      if (d >= todayStart) groups[0].items.push(f)
      else if (d >= weekStart) groups[1].items.push(f)
      else groups[2].items.push(f)
    }
    return groups.filter((g) => g.items.length > 0)
  }, [files])

  // 相对时间文案。**7 天以内**走全站通用的 `ago`；更早的换成绝对日期——
  // 这一页按今天/本周/更早分组，「23 天前」在这里不如一个日期有用。
  function relTime(ts: number) {
    const days = Math.floor((Date.now() - ts * 1000) / 86400000)
    return days < 7 ? ago(ts) : new Date(ts * 1000).toLocaleDateString()
  }

  // debounced full-text search across vault
  useEffect(() => {
    const q = searchQ.trim()
    if (!q) {
      setSearchHits([])
      return
    }
    const t = window.setTimeout(() => {
      api.searchNotes(q).then((r) => setSearchHits(r.hits)).catch(() => setSearchHits([]))
    }, 300)
    return () => window.clearTimeout(t)
  }, [searchQ])

  return (
        <div className="hidden w-56 shrink-0 flex-col overflow-hidden border-r border-neutral-200/80 md:flex dark:border-neutral-800/80">
          <div className="flex items-center justify-between px-3 py-3">
            <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">我的笔记</h2>
            <button
              onClick={newNote}
              className="wb-btn-primary px-2 py-1 text-xs"
            >
              ＋ 新建
            </button>
          </div>
          <div className="px-3 pb-2">
            <button
              onClick={() => void composeNote()}
              disabled={composeBusy}
              title="从你自己的材料（知识库 / 长期记忆 / 日记）生成一篇笔记"
              className="w-full rounded-md wb-btn-ghost px-2 py-1 text-xs"
            >
              {composeBusy ? (
                <>
                  <Sparkles className="mr-1 inline h-3 w-3" />
                  生成中…
                </>
              ) : (
                <>
                  <Sparkles className="mr-1 inline h-3 w-3" />
                  从我的材料生成
                </>
              )}
            </button>
            <p className="pt-1 text-xs leading-relaxed text-neutral-400">
              {composeMsg || 'vault 全部 .md · 自动进 RAG 索引'}
            </p>
          </div>
          {briefing && (
            <p className="mx-3 mb-2 rounded-lg bg-violet-50/80 px-2.5 py-2 text-xs leading-relaxed text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
              {briefing}
            </p>
          )}
          <div className="px-2 pb-2">
            <input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="全文搜索笔记…"
              className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs outline-none transition-colors focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-3">
            {/* 那一问（R2 · PLAN5 §3）：语音备忘是材料还是工作留痕。搜索时让位给结果 */}
            {searchQ.trim() ? null : (
              <VoiceTriage v={voice} onChanged={refreshVoice} onOpen={(p) => void openNote(p)} />
            )}
            {searchQ.trim() ? (
              <>
                <p className="px-2 pb-1 text-xs uppercase tracking-wider text-neutral-400">
                  {searchHits.length} 个命中
                </p>
                {searchHits.map((h) => (
                  <button
                    key={h.path}
                    onClick={() => openNote(h.path)}
                    className="mb-1 block w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800/70"
                  >
                    <span className="block truncate text-xs font-medium text-neutral-700 dark:text-neutral-200">
                      <FileText className="mr-1 inline h-3 w-3 text-neutral-400" />
                      {h.path}
                      <span className="ml-1 text-xs text-violet-500">×{h.count}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-neutral-400">
                      {h.excerpt}
                    </span>
                  </button>
                ))}
                {!searchHits.length && (
                  <p className="px-2 py-4 text-xs text-neutral-400">没有匹配的笔记内容</p>
                )}
              </>
            ) : (
              <>
                {groupedFiles.map((g) => (
                  <div key={g.label} className="mb-1">
                    <p className="px-2 pb-0.5 pt-2 text-xs font-medium uppercase tracking-wider text-neutral-400">
                      {g.label}
                    </p>
                    {g.items.map((f) => (
                      <div
                        key={f.path}
                        className={`group flex items-center justify-between rounded-lg px-2 py-1.5 text-sm transition-colors ${
                          activePath === f.path
                            ? 'bg-violet-100 font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
                            : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200'
                        }`}
                      >
                        <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => openNote(f.path)}>
                          <FileText className="h-3 w-3 shrink-0 text-neutral-400" />
                          <span className="truncate">{f.path}</span>
                        </button>
                        <span className="ml-1 shrink-0 text-xs text-neutral-400">{relTime(f.mtime)}</span>
                        <button
                          onClick={() => removeNote(f.path)}
                          className="ml-1 shrink-0 text-neutral-400 opacity-60 transition-[color,opacity] hover:text-red-500 hover:opacity-100 focus-visible:opacity-100"
                          title="删除"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
                {!files.length && (
                  <p className="px-2 py-4 text-xs leading-relaxed text-neutral-400">
                    还没有笔记 — 点右上「＋ 新建」开始
                  </p>
                )}
              </>
            )}
          </div>
        </div>
  )
}
