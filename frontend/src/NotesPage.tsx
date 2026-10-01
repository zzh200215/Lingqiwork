import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import {
  Columns2,
  Eye,
  ImagePlus,
  Layers,
  List,
  MessageSquare,
  type LucideIcon,
  Pencil,
  PenLine,
  Podcast,
  ScrollText,
  Sparkles,
} from 'lucide-react'
import CodeBlock from './CodeBlock'
import FeedbackButtons from './FeedbackButtons'
import InjectedLine from './InjectedLine'
import NoteSidebar from './NoteSidebar'
import { useNoteChat } from './useNoteChat'
import NoteChatPanel from './NoteChatPanel'
import { usePodcast } from './usePodcast'
import NotePodcastPanel from './NotePodcastPanel'
import NoteCardsPanel from './NoteCardsPanel'
import { api, streamNotesAi, type CardDraft } from './api'
import { streamCompose, type ReportDraft } from './stream'

type AiAction = 'continue' | 'polish' | 'summarize' | 'rewrite'
type ViewMode = 'edit' | 'split' | 'preview'
export interface NoteFile {
  path: string
  mtime: number
}
const ACTION_LABEL: Record<AiAction, string> = {
  continue: 'AI 续写',
  polish: 'AI 润色',
  summarize: 'AI 摘要',
  rewrite: '选区改写',
}
/** 每个动作一个线性图标——emoji 从 chrome 里退役，语义由图标承担 */
const ACTION_ICON: Record<AiAction, LucideIcon> = {
  continue: PenLine,
  polish: Sparkles,
  summarize: ScrollText,
  rewrite: Pencil,
}

interface SelRange {
  start: number
  end: number
  text: string
}

interface RewritePreview {
  start: number
  end: number
  text: string
}

const REWRITE_PRESETS: { label: string; instruction: string }[] = [
  { label: '润色', instruction: '润色这一段：修正错别字和语病，表达更流畅清晰，保持原意与篇幅。' },
  { label: '扩展', instruction: '扩写这一段：补充细节、例子或解释，使内容更充实，保持原意与语气。' },
  { label: '精简', instruction: '压缩这一段：去掉冗余重复，只保留核心要点，篇幅明显缩短。' },
  { label: '译英', instruction: '把这一段翻译成地道的英文，保持 Markdown 格式。' },
]

export default function NotesPage() {
  const [files, setFiles] = useState<NoteFile[]>([])
  const [viewMode, setViewMode] = useState<ViewMode>('edit')
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string>('')
  const [aiBusy, setAiBusy] = useState<AiAction | null>(null)
  const [error, setError] = useState('')
  const [imgBusy, setImgBusy] = useState(false)
  const [selRange, setSelRange] = useState<SelRange | null>(null)
  const [rewrite, setRewrite] = useState<RewritePreview | null>(null)
  const [cloze, setCloze] = useState<CardDraft | null>(null)
  const [clozeBusy, setClozeBusy] = useState(false)
  const [flash, setFlash] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [cardsOpen, setCardsOpen] = useState(false)
  const [composeBusy, setComposeBusy] = useState(false)
  const [composeMsg, setComposeMsg] = useState('')
  // 最近一次产出的来源信息——喂给质量闭环（这条链路此前没有任何地方记录过满不满意）
  const [composeMeta, setComposeMeta] = useState<{
    prompt_sha?: string
    model_id?: string
    filename: string
  } | null>(null)
  // S1：这次产出吃到了哪份工序（引擎匹配出来的）。手动跑引擎没有运行记录，
  // 所以它是那条路上唯一的窗口——顺带喂给这次 👍/👎（说得出来才带，说不出就是「不知道」）。
  const [composeInjected, setComposeInjected] = useState<string[]>([])
  const { chatMsgs, setChatMsgs, chatSaved, setChatSaved, chatInput, setChatInput, chatBusy, sendChat, stopChat, chatBottomRef } = useNoteChat({
    activePath,
    draft,
    setError,
  })
  const {
    podOpen,
    togglePod,
    setPodOpen,
    podSources,
    setPodSources,
    addPodSource,
    podHost,
    setPodHost,
    podGuest,
    setPodGuest,
    podVoices,
    generatePod,
    podBusy,
    podStage,
    podMsg,
    podList,
    removePod,
    podScriptId,
    setPodScriptId,
  } = usePodcast({ activePath, setChatOpen, setCardsOpen })

  const abortRef = useRef<AbortController | null>(null)
  const composeAbortRef = useRef<AbortController | null>(null)
  const saveTimer = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const cursorRef = useRef<number | null>(null)

  const [searchParams, setSearchParams] = useSearchParams()
  const pathParam = searchParams.get('path')
  // 落地时是否带着 `?path=` —— 带了就由深链 effect 开，没带才自动开第一篇。
  // 用 ref 定格初值：这个判断只该在挂载时做一次。
  const initialHadPath = useRef(!!pathParam)

  const refreshFiles = useCallback(async () => {
    const { files } = await api.listNotes()
    setFiles(files)
    return files
  }, [])


  useEffect(() => {
    refreshFiles()
      .then((fs) => {
        // 带 `?path=` 的落地交给下面那个 effect，这里别抢
        if (!initialHadPath.current && fs.length) void openNote(fs[0].path)
      })
      .catch((e) => setError(String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshFiles])

  // 深链：`/notes?path=notes/xxx.md`（RAG 引用、知识库命中、复习页都往这跳）。
  // **必须 key 在 search 上**：SPA 里同路由换 path 不会重挂这个组件，挂在 `[]` 上的
  // effect 只跑一次——从一篇笔记点向另一篇就不换文件了（MPA 时代没有的回归）。
  useEffect(() => {
    if (!pathParam) return
    void openNote(pathParam).then(() => setSearchParams({}, { replace: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathParam])




  // 标题大纲（供导航）
  const outline = useMemo(() => {
    const items: { level: number; text: string; offset: number }[] = []
    const re = /^(#{1,6})\s+(.+)$/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(draft)) !== null) {
      items.push({ level: m[1].length, text: m[2].trim(), offset: m.index })
    }
    return items
  }, [draft])

  function jumpToHeading(offset: number) {
    if (viewMode === 'preview') return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(offset, offset)
    const lines = draft.slice(0, offset).split('\n').length
    el.scrollTop = lines * 22
    setOutlineOpen(false)
  }

  const charCount = draft.length
  const wordCount = draft.replace(/\s/g, '').length
  const readMins = Math.max(1, Math.ceil(wordCount / 400))


  async function openNote(path: string) {
    if (aiBusy || imgBusy) return
    await flushSave()
    const { content } = await api.readNote(path)
    setActivePath(path)
    setDraft(content)
    setDirty(false)
    setSavedAt('')
    setError('')
    cursorRef.current = null
    setSelRange(null)
    setRewrite(null)
  }

  async function newNote() {
    if (aiBusy || imgBusy) return
    const name = window.prompt('新笔记文件名（不含 .md，将存入 notes/ 子目录）：', '')
    if (!name?.trim()) return
    const safe = name.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    const path = `notes/${safe}.md`
    if (files.some((f) => f.path === path)) {
      setError(`已存在 ${path}`)
      return
    }
    await api.saveNote(path, `# ${name.trim()}\n\n`)
    await refreshFiles()
    await openNote(path)
  }

  // 产出（学习闭环的出口）：从你自己的材料（知识库 + 长期记忆 + 近期日记）生成一篇
  // 笔记，落 vault/notes/ 并进索引，然后直接在编辑器里打开——可改，改完照常自动回索引。
  async function composeNote() {
    if (composeBusy) return
    const topic = window.prompt('从你自己的材料生成一篇笔记——想写什么话题？', '')
    if (!topic?.trim()) return
    composeAbortRef.current?.abort()
    const ctl = new AbortController()
    composeAbortRef.current = ctl
    setComposeBusy(true)
    setComposeMsg('在翻你自己的材料…')
    setComposeMeta(null)
    setComposeInjected([])
    setError('')
    try {
      const r = await streamCompose(
        topic.trim(),
        (event, data) => {
          if (event === 'skills')
            // S1：命中即注入。没命中这一帧根本不发——所以这里不会被清成「无」
            setComposeInjected(((data.skills ?? []) as unknown[]).map(String))
          else if (event === 'sources')
            setComposeMsg(
              `取到 ${(data.sources as unknown[] | undefined)?.length ?? 0} 条材料，成文中…`
            )
          else if (event === 'writing') setComposeMsg('成文中…')
          else if (event === 'draft') {
            // 产出的成品直接落盘并打开，这里没有卡片可渲染——但进度要活：
            // 字数一直在涨，比一个不动的「成文中…」诚实得多
            const d = data as unknown as ReportDraft
            const chars = d.sections.reduce((n, s) => n + s.body.length, 0)
            setComposeMsg(`成文中…（已写出 ${chars} 字）`)
          }
        },
        ctl.signal
      )
      if (!r.ok || !r.report) {
        setError(r.error ?? '产出失败')
        return
      }
      setComposeMsg('落盘…')
      const saved = await api.composeSave({
        title: r.report.title,
        sections: r.report.sections,
        used: r.report.used,
        sources: r.report.sources.map((s) => ({
          n: s.n,
          kind: s.kind,
          title: s.title,
          ref: s.ref,
        })),
      })
      await refreshFiles()
      await openNote(saved.filename)
      setComposeMeta({
        prompt_sha: r.report.prompt_sha,
        model_id: r.report.model_id,
        filename: saved.filename,
      })
      setFlash(`已产出 ${saved.filename}（${saved.chunks} 段进索引）`)
      window.setTimeout(() => setFlash(''), 6000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setComposeBusy(false)
      setComposeMsg('')
    }
  }

  async function removeNote(path: string) {
    if (!confirm(`删除笔记「${path}」？此操作不可恢复。`)) return
    await api.deleteNote(path)
    const fs = await refreshFiles()
    if (activePath === path) {
      setActivePath(null)
      setDraft('')
      setDirty(false)
    }
    if (!activePath || activePath === path) {
      if (fs.length) void openNote(fs[0].path)
    }
  }

  // 产出流在卸载时掐断
  useEffect(() => () => composeAbortRef.current?.abort(), [])

  // debounced autosave
  useEffect(() => {
    if (!activePath || !dirty) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => void flushSave(), 1200)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [draft, dirty, activePath])

  async function flushSave(content = draft, force = false) {
    if (!activePath) return
    if (!force && (!dirty || saving)) return
    setSaving(true)
    try {
      await api.saveNote(activePath, content)
      setDirty(false)
      setSavedAt(new Date().toLocaleTimeString())
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  // insert a markdown block at the caret (fallback: end of note)
  function insertAtCaret(text: string) {
    const pos = Math.min(Math.max(cursorRef.current ?? draft.length, 0), draft.length)
    const before = draft.slice(0, pos)
    const after = draft.slice(pos)
    const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
    const tail = after.startsWith('\n') ? '\n' : '\n\n'
    const block = lead + text + tail
    const caret = before.length + block.length
    setDraft(before + block + after)
    setDirty(true)
    setSelRange(null)
    cursorRef.current = caret
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(caret, caret)
    })
  }

  // generate an illustration and insert its markdown at the caret
  async function insertImage() {
    if (imgBusy || aiBusy || !activePath) return
    const input = window.prompt('配图描述（调用图片模型生成，约 30-90 秒）：', '')
    const prompt = input?.trim()
    if (!prompt) return
    setError('')
    setImgBusy(true)
    try {
      const r = await api.generateImage(prompt)
      const alt = prompt.slice(0, 60).replace(/[[\]]/g, '')
      const md = r.images.map((im) => `![${alt}](${im.url})`).join('\n')
      insertAtCaret(md)
    } catch (e) {
      setError(String(e))
    } finally {
      setImgBusy(false)
    }
  }

  function runAi(action: AiAction) {
    if (aiBusy || !activePath) return
    const content = draft.trim()
    if (!content && action !== 'continue') {
      setError('笔记为空，先写点什么')
      return
    }
    setError('')
    const controller = new AbortController()
    abortRef.current = controller
    setAiBusy(action)

    if (action === 'polish') {
      let acc = ''
      let raf = 0
      const flush = () => {
        raf = 0
        setDraft(acc)
      }
      streamNotesAi(action, content, (t) => {
        acc += t
        if (!raf) raf = requestAnimationFrame(flush)
      }, controller.signal)
        .then(async () => {
          setDraft(acc)
          setDirty(true)
          await flushSave()
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(String(e))
        })
        .finally(() => {
          if (raf) cancelAnimationFrame(raf)
          setAiBusy(null)
          abortRef.current = null
        })
    } else {
      // continue / summarize: append at cursor end after a blank line
      let acc = ''
      let base = draft
      let raf = 0
      const flush = () => {
        raf = 0
        setDraft(base + acc)
      }
      streamNotesAi(action, content, (t) => {
        acc += t
        if (!raf) raf = requestAnimationFrame(flush)
      }, controller.signal)
        .then(async () => {
          base = draft.endsWith('\n') ? draft : draft + '\n\n'
          setDraft((base + acc).replace(/\n{3,}$/, '\n\n'))
          setDirty(true)
          await flushSave()
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(String(e))
        })
        .finally(() => {
          if (raf) cancelAnimationFrame(raf)
          setAiBusy(null)
          abortRef.current = null
        })
    }
  }

  function stopAi() {
    abortRef.current?.abort()
    setAiBusy(null)
    abortRef.current = null
  }

  // ---- selection rewrite ----

  function handleSelect(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget
    cursorRef.current = el.selectionStart
    if (aiBusy === 'rewrite' || rewrite) return
    const text = el.value.slice(el.selectionStart, el.selectionEnd)
    setSelRange(text.trim() ? { start: el.selectionStart, end: el.selectionEnd, text } : null)
  }

  function runRewrite(instruction: string) {
    if (!selRange || aiBusy || !activePath) return
    setError('')
    const { start, end, text } = selRange
    const controller = new AbortController()
    abortRef.current = controller
    setAiBusy('rewrite')
    setRewrite({ start, end, text: '' })
    let acc = ''
    streamNotesAi(
      'rewrite',
      draft,
      (t) => {
        acc += t
        setRewrite((r) => (r ? { ...r, text: acc } : r))
      },
      controller.signal,
      { selection: text, instruction }
    )
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e))
        setRewrite(null)
      })
      .finally(() => {
        setAiBusy(null)
        abortRef.current = null
      })
  }

  function customRewrite() {
    const instruction = window.prompt('改写要求（对选中的文字做什么）：', '')
    if (instruction?.trim()) runRewrite(instruction.trim())
  }

  // ---- selection → cloze card (zero LLM) ----

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(''), 2500)
    return () => clearTimeout(t)
  }, [flash])

  async function makeCloze() {
    if (!selRange || !activePath || clozeBusy) return
    setClozeBusy(true)
    setError('')
    try {
      // the nearest heading above the selection is a free topic tag
      const heading = outline.filter((h) => h.offset < selRange.start).pop()
      setCloze(
        await api.makeCloze({
          text: draft,
          start: selRange.start,
          end: selRange.end,
          topic: heading?.text.slice(0, 40) ?? '',
        })
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setClozeBusy(false)
    }
  }

  async function saveCloze() {
    if (!cloze || !activePath) return
    setClozeBusy(true)
    try {
      const r = await api.saveCards({
        cards: [cloze],
        source: activePath,
        source_label: activePath,
        model_id: '',
      })
      setCloze(null)
      setSelRange(null)
      setFlash(r.added ? '🎴 已存入 1 张复习卡' : '这张卡已经有了')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setClozeBusy(false)
    }
  }

  async function applyRewrite() {
    if (!rewrite) return
    const next = draft.slice(0, rewrite.start) + rewrite.text.trim() + draft.slice(rewrite.end)
    setDraft(next)
    setDirty(true)
    setRewrite(null)
    setSelRange(null)
    await flushSave(next, true)
  }


  // Cards take a SINGLE note on purpose: merging several sources would blur
  // which file a card came from, and that link is what makes "O = open source"
  // worth having.
  function toggleCards() {
    const next = !cardsOpen
    setCardsOpen(next)
    if (next) {
      setChatOpen(false)
      setPodOpen(false)
    }
  }

  return (
    <>
      <div className="flex h-full min-h-0">
        {/* file list */}
        <NoteSidebar
          files={files}
          activePath={activePath}
          openNote={openNote}
          removeNote={removeNote}
          newNote={newNote}
          composeNote={composeNote}
          composeBusy={composeBusy}
          composeMsg={composeMsg}
        />

        {/* editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* flex-wrap：这一排全是 shrink-0 的按钮（续写/润色/配图/对话/播客…），
              加起来八百来像素。不换行的话窄窗格/窄窗口里会顶出横向滚动条。 */}
          <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200/80 bg-white/80 px-4 py-2.5 backdrop-blur dark:border-neutral-800/80 dark:bg-neutral-950/80">
            <span className="truncate font-mono text-xs text-neutral-500">
              {activePath ?? '未打开笔记'}
            </span>
            <div className="flex shrink-0 items-center overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
              {(['edit', 'split', 'preview'] as ViewMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  title={m === 'edit' ? '编辑' : m === 'split' ? '分屏' : '预览'}
                  className={`px-2 py-1 transition-colors ${
                    viewMode === m
                      ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
                      : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200'
                  }`}
                >
                  {m === 'edit' ? <Pencil className="h-4 w-4" /> : m === 'split' ? <Columns2 className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              ))}
            </div>
            <button
              onClick={() => setOutlineOpen((v) => !v)}
              title="大纲导航"
              className={`shrink-0 rounded-md border px-2 py-1 text-xs transition-colors ${
                outlineOpen
                  ? 'border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-300'
                  : 'border-neutral-200 text-neutral-500 hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400'
              }`}
            >
              <List className="mr-1 inline h-3 w-3" />
              大纲
            </button>
            {composeMeta ? (
              <>
                <InjectedLine
                  names={composeInjected}
                  className="shrink-0 text-xs text-teal-700 dark:text-teal-300"
                />
                <FeedbackButtons
                  kind="compose"
                  promptSha={composeMeta.prompt_sha}
                  modelId={composeMeta.model_id}
                  artifactRef={composeMeta.filename}
                  injected={composeInjected}
                />
              </>
            ) : null}
            <span className="ml-auto shrink-0 text-xs text-neutral-400">
              {flash ? (
                <span className="text-sky-600 dark:text-sky-300">{flash}</span>
              ) : aiBusy ? (
                `${ACTION_LABEL[aiBusy]} 中…`
              ) : imgBusy ? (
                '生成配图中…'
              ) : saving ? (
                '保存中…'
              ) : dirty ? (
                '未保存（自动保存中）'
              ) : savedAt ? (
                `✓ 已保存 ${savedAt}`
              ) : (
                ''
              )}
            </span>
            {aiBusy ? (
              <button
                onClick={stopAi}
                className="shrink-0 rounded-md border border-red-300 px-2 py-1 text-xs text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-950/30"
              >
                停止
              </button>
            ) : (
              <>
                {(['continue', 'polish', 'summarize'] as AiAction[]).map((a) => {
                  const Icon = ACTION_ICON[a]
                  return (
                    <button
                      key={a}
                      onClick={() => runAi(a)}
                      disabled={!activePath || imgBusy}
                      className="shrink-0 rounded-md border border-violet-200 px-2 py-1 text-xs text-violet-600 transition-colors hover:border-violet-400 hover:bg-violet-50 disabled:opacity-40 dark:border-violet-500/30 dark:text-violet-300 dark:hover:bg-violet-500/10"
                    >
                      <Icon className="mr-1 inline h-3 w-3" />
                      {ACTION_LABEL[a]}
                    </button>
                  )
                })}
                <button
                  onClick={insertImage}
                  disabled={!activePath || imgBusy}
                  title="按描述生成一张图片并插入光标处"
                  className="shrink-0 rounded-md border border-fuchsia-200 px-2 py-1 text-xs text-fuchsia-600 transition-colors hover:border-fuchsia-400 hover:bg-fuchsia-50 disabled:opacity-40 dark:border-fuchsia-500/30 dark:text-fuchsia-300 dark:hover:bg-fuchsia-500/10"
                >
                  {imgBusy ? (
                    <>
                      <ImagePlus className="mr-1 inline h-3 w-3" />
                      生成中…
                    </>
                  ) : (
                    <>
                      <ImagePlus className="mr-1 inline h-3 w-3" />
                      配图
                    </>
                  )}
                </button>
                <button
                  onClick={() => setChatOpen((v) => !v)}
                  disabled={!activePath}
                  title="在笔记旁与 AI 讨论当前内容"
                  className={`shrink-0 rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-40 ${
                    chatOpen
                      ? 'border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-500/50 dark:bg-sky-500/10 dark:text-sky-300'
                      : 'border-sky-200 text-sky-600 hover:border-sky-400 hover:bg-sky-50 dark:border-sky-500/30 dark:text-sky-300 dark:hover:bg-sky-500/10'
                  }`}
                >
                  <MessageSquare className="mr-1 inline h-3 w-3" />
                  对话
                </button>
                <button
                  onClick={togglePod}
                  disabled={!activePath}
                  title="把当前笔记变成一期双人播客音频"
                  className={`shrink-0 rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-40 ${
                    podOpen
                      ? 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-300'
                      : 'border-amber-200 text-amber-600 hover:border-amber-400 hover:bg-amber-50 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-500/10'
                  }`}
                >
                  <Podcast className="mr-1 inline h-3 w-3" />
                  播客
                </button>
                <button
                  onClick={toggleCards}
                  disabled={!activePath}
                  title="用当前笔记出复习卡片"
                  className={`shrink-0 rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-40 ${
                    cardsOpen
                      ? 'border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-300'
                      : 'border-violet-200 text-violet-600 hover:border-violet-400 hover:bg-violet-50 dark:border-violet-500/30 dark:text-violet-300 dark:hover:bg-violet-500/10'
                  }`}
                >
                  <Layers className="mr-1 inline h-3 w-3" />
                  出卡
                </button>
              </>
            )}
          </div>

          <div className="relative flex min-w-0 flex-1 flex-col">
            {selRange && !aiBusy && !rewrite && !cloze && (
              <div className="absolute left-1/2 top-3 z-10 flex max-w-[95%] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-full border border-violet-200 bg-white/95 px-3 py-1.5 shadow-md backdrop-blur dark:border-violet-500/40 dark:bg-neutral-900/95">
                <span className="text-xs text-neutral-500">已选 {selRange.text.length} 字</span>
                {REWRITE_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => runRewrite(p.instruction)}
                    className="rounded-full border border-violet-200 px-2 py-0.5 text-xs text-violet-600 transition-colors hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10"
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  onClick={customRewrite}
                  className="rounded-full border border-violet-200 px-2 py-0.5 text-xs text-violet-600 transition-colors hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10"
                >
                  自定义…
                </button>
                <button
                  onClick={() => void makeCloze()}
                  disabled={clozeBusy}
                  title="把选中的部分挖成填空卡（不调模型）"
                  className="rounded-full border border-sky-300 px-2 py-0.5 text-xs text-sky-600 transition-colors hover:bg-sky-50 disabled:opacity-50 dark:border-sky-500/50 dark:text-sky-300 dark:hover:bg-sky-500/10"
                >
                  <Layers className="mr-1 inline h-3 w-3" />
                  挖空
                </button>
                <button
                  onClick={() => setSelRange(null)}
                  className="text-xs text-neutral-400 hover:text-neutral-600"
                  title="取消选择"
                >
                  ×
                </button>
              </div>
            )}

            {/* Deliberately NOT routed through CardMaker's tick-and-edit gate: that
                gate exists because model output must be read before it is trusted.
                Every character here is your own note text, and the blanked front is
                shown in full below, so a second review step is pure friction. */}
            {cloze && (
              <div className="absolute left-1/2 top-3 z-10 w-[min(560px,95%)] -translate-x-1/2 rounded-md border border-sky-200 wb-float bg-white/95 p-3 shadow-lg backdrop-blur dark:border-sky-500/40 dark:bg-neutral-900/95">
                <div className="mb-1.5 flex items-center gap-2 text-xs text-neutral-500">
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">
                    填空
                  </span>
                  {cloze.topic && <span>#{cloze.topic}</span>}
                  <span className="ml-auto">挖空后的题面</span>
                </div>
                <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-2 font-mono text-[12px] leading-relaxed dark:bg-neutral-800/60">
                  {cloze.front}
                </p>
                <p className="mt-1.5 truncate text-xs text-neutral-500">
                  答案：<span className="text-neutral-700 dark:text-neutral-200">{cloze.back}</span>
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => void saveCloze()}
                    disabled={clozeBusy}
                    className="rounded-lg bg-gradient-to-r from-sky-600 to-violet-600 px-3 py-1 text-xs font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
                  >
                    存入复习
                  </button>
                  <button
                    onClick={() => setCloze(null)}
                    className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {outlineOpen && (
              <div className="absolute right-4 top-3 z-10 max-h-[70%] w-60 overflow-y-auto rounded-md border border-neutral-200 wb-float bg-white/95 p-2 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95">
                <div className="px-2 pb-1 pt-0.5 text-xs font-medium uppercase tracking-wider text-neutral-400">
                  大纲 · {outline.length} 个标题
                </div>
                {outline.length ? (
                  outline.map((h, i) => (
                    <button
                      key={i}
                      onClick={() => jumpToHeading(h.offset)}
                      className="block w-full truncate rounded-md px-2 py-1 text-left text-xs text-neutral-600 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                      style={{ paddingLeft: `${8 + (h.level - 1) * 12}px` }}
                    >
                      {h.level <= 2 ? '▎' : ''}
                      {h.text}
                    </button>
                  ))
                ) : (
                  <p className="px-2 py-2 text-xs text-neutral-400">还没有标题，用 # 开头写</p>
                )}
              </div>
            )}

            <div className="flex min-h-0 flex-1">
              {(viewMode === 'edit' || viewMode === 'split') && (
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value)
                    setDirty(true)
                    cursorRef.current = e.target.selectionStart
                    setSelRange(null)
                  }}
                  onSelect={handleSelect}
                  placeholder={
                    activePath
                      ? '用 Markdown 写作… 内容会自动保存并进入知识库索引；选中一段文字可让 AI 只改写这一段'
                      : '从左侧选择或新建一篇笔记'
                  }
                  disabled={!activePath || imgBusy || aiBusy === 'rewrite'}
                  className="min-w-0 flex-1 resize-none bg-transparent px-6 py-5 font-mono text-[14px] leading-relaxed outline-none placeholder:text-neutral-300 disabled:opacity-60 dark:placeholder:text-neutral-700"
                />
              )}
              {(viewMode === 'split' || viewMode === 'preview') && (
                <div
                  className={`min-w-0 flex-1 overflow-y-auto px-6 py-5 ${
                    viewMode === 'split' ? 'border-l border-neutral-200/80 dark:border-neutral-800/80' : ''
                  }`}
                >
                  {draft.trim() ? (
                    <div className="prose prose-neutral max-w-none text-[15px] leading-relaxed dark:prose-invert">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
                        components={{ pre: CodeBlock }}
                      >
                        {draft}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="text-sm text-neutral-400">预览会显示在这里</p>
                  )}
                </div>
              )}
            </div>

            {rewrite && (
              <div className="mx-4 mb-3 rounded-lg border border-violet-200 bg-violet-50/70 p-3 dark:border-violet-500/30 dark:bg-violet-500/10">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-violet-700 dark:text-violet-300">
                  <span>
                    <Pencil className="mr-1 inline h-3 w-3" />
                    改写预览 · 原 {rewrite.end - rewrite.start} 字 → 新 {rewrite.text.length} 字
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={applyRewrite}
                      disabled={!rewrite.text.trim()}
                      className="rounded-md bg-violet-600 px-2.5 py-1 font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-40 dark:bg-violet-500 dark:hover:bg-violet-400"
                    >
                      应用到笔记
                    </button>
                    <button
                      onClick={() => setRewrite(null)}
                      className="rounded-md px-2 py-1 text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
                    >
                      放弃
                    </button>
                  </div>
                </div>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-neutral-700 dark:text-neutral-200">
                  {rewrite.text || '…'}
                </pre>
              </div>
            )}

            {/* 字数底栏 */}
            {activePath && (
              <div className="flex items-center gap-3 border-t border-neutral-200/60 px-4 py-1 text-xs text-neutral-400 dark:border-neutral-800/60">
                <span>{charCount} 字符</span>
                <span>·</span>
                <span>{wordCount} 字</span>
                <span>·</span>
                <span>约 {readMins} 分钟读完</span>
                <span className="ml-auto">{draft.split('\n').length} 行</span>
              </div>
            )}
          </div>

          {error && (
            <p className="mx-4 mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}
        </div>

        {/* note-side chat panel */}
        {chatOpen && (
          <NoteChatPanel
            chatMsgs={chatMsgs}
            setChatMsgs={setChatMsgs}
            chatSaved={chatSaved}
            setChatSaved={setChatSaved}
            chatInput={chatInput}
            setChatInput={setChatInput}
            chatBusy={chatBusy}
            sendChat={sendChat}
            stopChat={stopChat}
            activePath={activePath}
            insertAtCaret={insertAtCaret}
            setChatOpen={setChatOpen}
            chatBottomRef={chatBottomRef}
          />
        )}
        {/* podcast panel */}
        {podOpen && (
          <NotePodcastPanel
            files={files}
            podSources={podSources}
            setPodSources={setPodSources}
            addPodSource={addPodSource}
            podHost={podHost}
            setPodHost={setPodHost}
            podGuest={podGuest}
            setPodGuest={setPodGuest}
            podVoices={podVoices}
            generatePod={generatePod}
            podBusy={podBusy}
            podStage={podStage}
            podMsg={podMsg}
            podList={podList}
            removePod={removePod}
            podScriptId={podScriptId}
            setPodScriptId={setPodScriptId}
            togglePod={togglePod}
          />
        )}
        {cardsOpen && activePath && (
          <NoteCardsPanel
            activePath={activePath}
            setCardsOpen={setCardsOpen}
            setSavedAt={setSavedAt}
          />
        )}
      </div>
    </>
  )
}
