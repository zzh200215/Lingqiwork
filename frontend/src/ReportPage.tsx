/** 报告页（方案 §8.1）——「写一个交得出去的东西」。
 *
 *  ## 它为什么是独立文件
 *
 *  这是「报告」这一个**业务域**的全部：生成面板 + 报告清单 + 阅读视图。
 *  原先它和另外四个域一起挤在 `WorkPage.tsx` 里（那个文件 1432 行），
 *  而方案 §十二 对文件结构的判据是「**单一域职责即停手**」——报告域自成一份。
 *
 *  ## 三块怎么分工
 *
 *  - **生成面板**：点页头「写一份报告」展开（`newSignal` 推信号进来，同 `PromptLibrary` 的写法）。
 *    体裁 × 读者的定义**唯一真值在后端**，这里只管渲染。
 *  - **报告清单**：页面主体。行 = 体裁徽章 + 标题/路径 + 日期 + 常显动作。
 *  - **阅读视图**：点一行进来（**页内切换，不跳路由**），三栏 = 大纲 / 正文 / 引用。
 *
 *  ## 「点开」为什么不再跳笔记页
 *
 *  原来点一行直接 `navigate('/notes?path=…')`——读一份自己刚写的东西，却被扔到编辑器里。
 *  现在清单行进阅读视图（大纲导航 + 正文 + 引用栏）；想去 vault 里改，阅读视图头上有入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, type DeliverCatalogue, type DeliverTemplate, type MaterialHit, type WorkOutput } from './api'
import AttachToThread from './AttachToThread'
import DeliverOutlineBox from './DeliverOutlineBox'
import DeliverTemplateEditor from './DeliverTemplateEditor'
import EmptyHint from './EmptyHint'
import FeedbackButtons from './FeedbackButtons'
import InjectedLine from './InjectedLine'
import { Markdown, outlineOf, reportMarkdown, SourceList, type CiteSource } from './markdown'
import { KIND_BADGE } from './OutputCard'
import RunPanel, { type RunPhase } from './RunPanel'
import { streamDeliver, type DeliverReport, type ReportDraft } from './stream'
import { humanErr } from './workData'

/** 一行的动作按钮：**常显淡色**，不是 hover 才出现。
 *  （`display:none` 的元素不在 Tab 序列里——键盘用户完全够不着，那是 WCAG 2.1.1 的失败。） */
const ROW_BTN =
  'shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 opacity-60 transition-[color,border-color,opacity] hover:border-violet-300 hover:text-violet-600 hover:opacity-100 focus-visible:opacity-100 dark:border-neutral-700 dark:text-neutral-400'

/** 清单主体的筛选分组（方案 §8.1 头部行：全部 / 研究 / 成文 / 工作流）。
 *
 *  **分组名不写死成「成文」两字一处**：它管着好几种 kind（交付/产出/方案/复盘/对质），
 *  改一种 kind 的归属只改这里一处。 */
const FILTER_GROUPS: { key: string; label: string; kinds: WorkOutput['kind'][] }[] = [
  { key: '', label: '全部', kinds: [] },
  { key: 'research', label: '研究', kinds: ['research'] },
  { key: 'writing', label: '成文', kinds: ['deliver', 'compose', 'decide', 'conflict', 'recap'] },
  { key: 'task', label: '工作流', kinds: ['task'] },
]

/** 报告标题 → 下载文件名。去掉路径分隔与 Windows 保留字符，空则退回一个通用名。 */
function fileNameOf(title: string, path: string): string {
  const base = (title || path.split('/').pop() || '报告').replace(/[\\/:*?"<>|]/g, '_').trim()
  return `${base || '报告'}.md`
}

/** 去掉文件头的 YAML front-matter。
 *
 *  交付落盘时会把体裁与读者写进文件头（M5：「这份是给谁写的」不能存完就丢）。
 *  那是**元数据**，不该出现在阅读视图的正文里，也不该被大纲当成一节。 */
function stripFrontMatter(md: string): string {
  if (!md.startsWith('---\n')) return md
  const end = md.indexOf('\n---', 3)
  if (end < 0) return md
  const nl = md.indexOf('\n', end + 1)
  return nl < 0 ? md : md.slice(nl + 1).replace(/^\n+/, '')
}

export default function ReportPage({
  newSignal,
  outputs,
  refresh,
  onError,
}: {
  /** 每次 +1 = 页头那颗「写一份报告」被点了：展开生成面板并把视线带到它上面。 */
  newSignal: number
  /** 报告清单（`/api/work/outputs`），由 `WorkPage` 的域 hook 给。 */
  outputs: WorkOutput[]
  /** 交付落盘之后刷新清单——不然刚写完的那份要等下次进页面才看得见。 */
  refresh: () => void
  /** 页级错误条（落在 `WorkPage` 顶部）。这一页自己不发错误条，只往里写。 */
  onError: (m: string) => void
}) {
  // ---------- 生成面板 ----------
  const [genOpen, setGenOpen] = useState(false)
  const [catalogue, setCatalogue] = useState<DeliverCatalogue | null>(null)
  const [genre, setGenre] = useState('')
  const [audience, setAudience] = useState('')
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  /** 交付流的**阶段**。阶段归阶段、文案归文案：六态交给 `RunPanel`，文案留给 `msg`。 */
  const [phase, setPhase] = useState<RunPhase | 'idle'>('idle')
  /** 失败原因。与 `msg` 分开：`msg` 是**过程中的状态话**，这个才是**出错了**。 */
  const [runErr, setRunErr] = useState('')
  const [pinned, setPinned] = useState<{ spec: string; title: string }[]>([])
  const [pinOpen, setPinOpen] = useState(false)
  const [pinQuery, setPinQuery] = useState('')
  const [pinHits, setPinHits] = useState<MaterialHit[]>([])
  const [pinBusy, setPinBusy] = useState(false)
  const [draft, setDraft] = useState<ReportDraft | null>(null)
  const [report, setReport] = useState<DeliverReport | null>(null)
  const [saved, setSaved] = useState('')
  /** S1：这次生成吃到了哪份工序（引擎匹配出来的）。手动这条路没有运行记录，
   *  所以它是「看不见注入」的唯一补丁——不留它，用得最多的这条路人永远不知道自己吃到了什么。 */
  const [injected, setInjected] = useState<string[]>([])
  const abort = useRef<AbortController | null>(null)

  // ---------- 提纲确认区（§8.1 长稿那一模） ----------
  /** 待确认的提纲。`null` = 还没出（或用户点了「直接写」）。 */
  const [outline, setOutline] = useState<{ title: string; sections: string[] } | null>(null)
  /** 出这份提纲时的话题。题目改了之后那份提纲就**过期**了——要说出来，不能装作还算数。 */
  const [outlineFor, setOutlineFor] = useState('')
  const [outlineBusy, setOutlineBusy] = useState(false)
  const [outlineErr, setOutlineErr] = useState('')
  /** 这一次成文用的小节（空 = 没走提纲）。
   *  用 ref 不用 state：它只在**点下去的那一刻**被读一次，而「重试」必须复用上一次那份
   *  ——放进 state 的话重试会读到一个还没提交的值。 */
  const outlineRef = useRef<string[]>([])

  // ---------- 体裁模板（§8.1 行2） ----------
  /** 开着的编辑器：`{}` = 新建，带 `id` = 改一个已有的，`null` = 收着。
   *  **它是体裁，不是别的东西**——所以存完就把它选上（你刚定义的那种体裁就是你要用的那种）。 */
  const [editing, setEditing] = useState<Partial<DeliverTemplate> | null>(null)

  // ---------- 清单 / 阅读视图 ----------
  const [filter, setFilter] = useState('')
  /** 正在阅读的那一份。**页内切换不跳路由**（方案 §8.1）。 */
  const [reading, setReading] = useState<{ o: WorkOutput; md: string; sources: CiteSource[] } | null>(null)
  const [readErr, setReadErr] = useState('')
  /** 防止连点两份时先发的请求后到、把后点的那份内容覆盖掉。 */
  const readSeq = useRef(0)
  const [copied, setCopied] = useState(false)

  // 体裁/读者拉到之后选上后端给的默认那组。
  //
  // **只在「还没选过」的时候套默认值**（`cur || default`），不用一个「跑过了」的 ref 挡：
  // 那种写法挡的是「第二次跑」，挡不住「第一次跑得比用户的手慢」——体裁列表是异步来的，
  // 用户完全可能在它到之前就点了体裁，那一刻 ref 还是 false，于是他的手被默认值盖掉。
  // 现在这样两种顺序都对，而且存完模板重拉列表时也不会把当前选中的那份顶掉。
  useEffect(() => {
    if (!catalogue) return
    setGenre((cur) => cur || catalogue.default_genre)
    setAudience((cur) => cur || catalogue.default_audience)
  }, [catalogue])

  // 体裁 × 读者是后端给的唯一真值。它拉不到时**不当成错误**：面板不显示，清单照常用。
  useEffect(() => {
    api
      .deliverGenres()
      .then(setCatalogue)
      .catch(() => {})
  }, [])

  // 「写一份报告」→ 展开面板。`newSignal` 初值是 0，所以挂载时不会自己弹开。
  useEffect(() => {
    if (!newSignal) return
    setGenOpen(true)
    window.scrollTo({ top: 0 })
  }, [newSignal])

  // 切页时掐断还在跑的生成（照 tutor 页）
  useEffect(() => () => abort.current?.abort(), [])

  const searchPin = useCallback(async () => {
    const q = pinQuery.trim()
    if (!q) return
    setPinBusy(true)
    try {
      setPinHits((await api.searchMaterial(q)).hits)
    } catch (e) {
      // 原来是 setPinHits([]) —— 界面显示「无结果」，**把请求失败伪装成「没搜到」**。
      setPinHits([])
      onError(`材料没搜成：${humanErr(e)}`)
    } finally {
      setPinBusy(false)
    }
  }, [pinQuery, onError])

  const addPin = useCallback((h: MaterialHit) => {
    if (!h.spec) return
    setPinned((cur) =>
      cur.some((p) => p.spec === h.spec) ? cur : [...cur, { spec: h.spec, title: h.title || h.spec }]
    )
    setPinOpen(false)
    setPinHits([])
    setPinQuery('')
  }, [])

  const run = useCallback(async () => {
    const t = topic.trim()
    if (!t || busy || !genre || !audience) return
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setBusy(true)
    setReport(null)
    setDraft(null)
    setSaved('')
    setInjected([])
    setRunErr('')
    setOutlineErr('')
    setMsg('取材中…')
    setPhase('planning')
    try {
      const r = await streamDeliver(
        t,
        genre,
        audience,
        (event, data) => {
          // 阶段映射照 **deliver 流真实的事件名**（stream.ts 里 gather/sources/writing/draft，
          // **没有 `plan`**——那是 research 引擎专属的）。
          if (event === 'gathering') {
            setMsg('在你自己的材料里找…')
            setPhase('planning')
          } else if (event === 'sources') {
            // 方案 §二-2：**「已找到 N 个来源」**——N 是这一帧的全部信息量。
            // 只说「材料到手」的话，这条状态行在「找到 1 条」和「找到 12 条」时一模一样。
            const n = ((data.sources ?? []) as unknown[]).length
            setMsg(`已找到 ${n} 个来源，开始写…`)
            setPhase('progress')
          } else if (event === 'skills') {
            // S1：命中即注入。只说事实——没命中这一帧根本不发
            setInjected(((data.skills ?? []) as unknown[]).map(String))
          } else if (event === 'writing') {
            setMsg('成文中…')
            setPhase('progress')
          } else if (event === 'draft') {
            // draft 一帧帧来，正文边生成边渲染；`report` 到了才算数。
            // 方案 §二-2 的**「正在写第几节」**：数得出的那一节就是**最后那一节**
            // （它正被打字机式地补全），所以报它的序号。整篇有几节要到收尾才知道，
            // 这里**不编一个分母**出来。
            const secs = (data.sections ?? []) as ReportDraft['sections']
            setMsg(secs.length ? `正在写第 ${secs.length} 节…` : '')
            setPhase('streaming')
            setDraft({ title: String(data.title ?? ''), sections: secs })
          }
        },
        ctl.signal,
        pinned.map((p) => p.spec),
        // 定稿的提纲。**空数组 = 没走提纲**（短稿一键直出，或长稿里点了「直接写」）。
        outlineRef.current
      )
      if (r.ok && r.report) {
        setReport(r.report)
        setMsg('')
        setPhase('done')
      } else {
        setMsg('')
        setRunErr(r.error || '成文失败')
        setPhase('error')
      }
    } catch (e) {
      // **取消不是失败**：用户按了「停止」，那一趟是被他自己掐掉的，
      // 不该在界面上留下一条红色错误。
      if (!ctl.signal.aborted) {
        setMsg('')
        setRunErr(e instanceof Error ? e.message : String(e))
        setPhase('error')
      } else {
        setPhase('idle')
      }
    } finally {
      setBusy(false)
    }
  }, [topic, genre, audience, busy, pinned])

  /** 停止：掐掉这一趟。**取消不是失败**——用户自己掐掉的，不留红色错误。 */
  const stopRun = useCallback(() => {
    abort.current?.abort()
    setMsg('')
    setPhase('idle')
  }, [])

  // ---------- 体裁模板（§8.1 行2） ----------

  /** 重拉体裁列表。**存/删之后必须重拉**——不然新建的那种体裁不在 chips 上，
   *  而用户刚刚才把它存进去（那种「我存的东西不见了」比报错还难查）。 */
  const reloadCatalogue = useCallback(async () => {
    try {
      setCatalogue(await api.deliverGenres())
    } catch (e) {
      onError(`体裁列表没刷新：${humanErr(e)}`)
    }
  }, [onError])

  /** 换体裁时把跟体裁绑在一起的东西一起清掉（提纲是按上一份体裁出的）。 */
  const clearOutlineFor = useCallback(() => {
    setOutline(null)
    setOutlineErr('')
    outlineRef.current = []
  }, [])

  const templateSaved = useCallback(
    async (t: DeliverTemplate) => {
      setEditing(null)
      setGenre(t.id)
      clearOutlineFor()
      await reloadCatalogue()
    },
    [reloadCatalogue, clearOutlineFor]
  )

  const templateDeleted = useCallback(
    async (id: string) => {
      setEditing(null)
      // 删掉的正是选中的那个 → 退回默认体裁。**不留在 id 上**：那个 id 已经没有定义了，
      // 留着的话下一次生成会撞一句「unknown genre」。
      if (genre === id) setGenre(catalogue?.default_genre ?? '')
      clearOutlineFor()
      await reloadCatalogue()
    },
    [genre, catalogue, reloadCatalogue, clearOutlineFor]
  )

  /** 打开编辑器改选中的那份。**当场去拉**（`/genres` 那份列表不带结构指令）——
   *  多一次请求，换的是「编辑的一定是盘上现在那一版」，不会拿着一份过期副本改。 */
  const editCurrentTemplate = useCallback(async () => {
    const id = genre
    try {
      const list = await api.deliverTemplates()
      const t = list.find((x) => x.id === id)
      if (!t) {
        onError('这份模板已经不在了——列表刚刷新过吗？')
        await reloadCatalogue()
        return
      }
      setEditing(t)
    } catch (e) {
      onError(`模板读不出来：${humanErr(e)}`)
    }
  }, [genre, onError, reloadCatalogue])

  // ---------- 提纲（§8.1 长稿那一模） ----------

  /** 出提纲：**不取材**，只问一次结构。点头之后才走 `run()` 去取材成文。 */
  const makeOutline = useCallback(async () => {
    const t = topic.trim()
    if (!t || outlineBusy || busy || !genre || !audience) return
    setOutlineBusy(true)
    setOutlineErr('')
    setOutline(null)
    try {
      const o = await api.deliverOutline({ topic: t, genre, audience })
      setOutline({ title: o.title, sections: o.sections })
      setOutlineFor(t)
    } catch (e) {
      // 出不来就说出不来。**不摆一份默认提纲顶上**——那会让人以为模型真看过他的题目。
      setOutlineErr(`提纲没出来：${humanErr(e)}`)
    } finally {
      setOutlineBusy(false)
    }
  }, [topic, genre, audience, outlineBusy, busy])

  const editSection = (i: number, text: string) =>
    setOutline((cur) =>
      cur ? { ...cur, sections: cur.sections.map((x, j) => (j === i ? text : x)) } : cur
    )
  const dropSection = (i: number) =>
    setOutline((cur) => (cur ? { ...cur, sections: cur.sections.filter((_, j) => j !== i) } : cur))
  const addSection = () =>
    setOutline((cur) => (cur ? { ...cur, sections: [...cur.sections, ''] } : cur))

  /** 「就按这个写」：把定稿的小节交给成文那一步。 */
  const writeWithOutline = () => {
    const names = (outline?.sections ?? []).map((s) => s.trim()).filter(Boolean)
    if (!names.length) {
      setOutlineErr('提纲一节都不剩了——加一节，或点「直接写」。')
      return
    }
    outlineRef.current = names
    void run()
  }

  /** 「直接写」：不要提纲，照体裁默认结构写。 */
  const writeDirect = () => {
    outlineRef.current = []
    void run()
  }

  const save = useCallback(async () => {
    if (!report || busy || saved) return
    setBusy(true)
    try {
      const r = await api.deliverSave({
        title: report.title,
        sections: report.sections,
        used: report.used,
        sources: report.sources,
        // M5：体裁与读者一起存进文件头——「这份是给谁写的」以前存完就丢了，
        // 而交付的事后见证（`deliverWitness`）要靠它说清「交给谁的那份」。
        genre,
        audience,
      })
      setSaved(r.filename)
      refresh()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [report, busy, saved, genre, audience, refresh])

  /** 改写成：拿一件报告当**钉住材料**，换个体裁重写（周报 / 短稿 / 一页纸提案）。
   *  J4 的缺口——成品别只躺在清单里，要能变成「交得出去的那一版」。 */
  const rewriteAs = useCallback((o: WorkOutput) => {
    setReading(null)
    setGenOpen(true)
    setTopic(`把《${o.title}》改写成`)
    setPinned([{ spec: o.path, title: o.title }])
    setReport(null)
    setDraft(null)
    setSaved('')
    setMsg('')
    setPhase('idle')
    // 上一份提纲是按旧题目出的，留着只会让人以为它还算数
    setOutline(null)
    setOutlineErr('')
    outlineRef.current = []
    window.scrollTo({ top: 0 })
  }, [])

  /** 点一份报告 → 拉它的正文，进阅读视图。
   *
   *  **读的是 vault 里那份文件本身**（`readNote` 的 `_NOTES_ROOT` 就是 vault 根，
   *  所以 `deliver/xxx.md` 读得到）——不是重新生成、也不是拿清单里的摘要凑。
   *  **打开了但读不到要说话**：不说的话阅读视图会摆一个空正文，看起来像这份是空的。 */
  const openReport = useCallback(
    async (o: WorkOutput) => {
      const seq = ++readSeq.current
      setReadErr('')
      setReading({ o, md: '', sources: [] })
      try {
        const r = await api.readNote(o.path)
        if (seq !== readSeq.current) return // 又点了别的，这一份的结果作废
        if (!r.content) {
          setReadErr(`这份读出来是空的（${o.path}）——文件可能已经不在了。`)
          return
        }
        setReading({ o, md: stripFrontMatter(r.content), sources: [] })
      } catch (e) {
        if (seq !== readSeq.current) return
        setReadErr(`正文读不出来：${humanErr(e)}`)
      }
    },
    []
  )

  const present = FILTER_GROUPS.map((g) => ({
    ...g,
    n: g.kinds.length ? outputs.filter((o) => g.kinds.includes(o.kind)).length : outputs.length,
  }))
  const shown = useMemo(() => {
    const g = FILTER_GROUPS.find((x) => x.key === filter)
    if (!g || !g.kinds.length) return outputs
    return outputs.filter((o) => g.kinds.includes(o.kind))
  }, [outputs, filter])

  /** 这一种体裁走哪一模。**判据来自后端**（`catalogue().genres[].long`），前端不猜。
   *  体裁还没拉到时不摆提纲那套控件——宁可少一个按钮，也不要摆一个按下去不知道会怎样的。 */
  const longMode = !!catalogue?.genres.find((g) => g.id === genre)?.long

  /** 选中的这一种是**你自己写的**吗。是的话行2 多一颗「编辑这份模板」——
   *  内置那五条是代码，界面上改不了（`custom` 就是后端为这件事给的）。 */
  const currentCustom = catalogue?.genres.find((g) => g.id === genre && g.custom)

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      onError(`复制没成功：${humanErr(e)}`)
    }
  }, [onError])

  /** 导出 .md：走一条 blob 链接，不经过后端（正文已经在手上）。 */
  const exportMd = useCallback((title: string, path: string, md: string) => {
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = fileNameOf(title, path)
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  // ---------- 阅读视图（页内切换，不跳路由） ----------
  if (reading) {
    const outline = outlineOf(reading.md)
    return (
      <section data-report-reader className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              readSeq.current++ // 作废还在路上的那一次拉取
              setReading(null)
              setReadErr('')
            }}
            className="shrink-0 rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs text-neutral-600 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300"
          >
            ← 返回清单
          </button>
          <span className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${KIND_BADGE[reading.o.kind]}`}>
            {reading.o.label}
          </span>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            {reading.o.title}
          </h2>
          <button onClick={() => void copyText(reading.md)} className={ROW_BTN}>
            {copied ? '已复制' : '复制全文'}
          </button>
          <button
            onClick={() => exportMd(reading.o.title, reading.o.path, reading.md)}
            className={ROW_BTN}
          >
            导出 md
          </button>
          <button onClick={() => rewriteAs(reading.o)} title="拿它当材料，换个体裁重写" className={ROW_BTN}>
            改写成
          </button>
          <Link
            to={`/notes?path=${encodeURIComponent(reading.o.path)}`}
            className={ROW_BTN}
            title="在笔记页里打开这份文件（要改原文时用）"
          >
            在 vault 里打开
          </Link>
        </div>

        {readErr ? (
          <p data-report-read-err className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {readErr}
          </p>
        ) : null}

        <div className="wb-card p-5">
          <div className="grid gap-6 xl:grid-cols-[220px_minmax(0,1fr)_260px]">
            {/* 左栏：大纲导航。窄屏不占位（方案 §七：右栏无内容时网格轨道不得预留）。 */}
            {outline.length > 1 ? (
              <nav className="hidden xl:block">
                <p className="pb-2 text-xs text-neutral-400">大纲</p>
                <ul className="space-y-1 border-l border-neutral-200 dark:border-neutral-800">
                  {outline.map((h, i) => (
                    <li key={`${h.id}-${i}`}>
                      <a
                        href={`#${h.id}`}
                        className={`block truncate border-l-2 border-transparent pl-2 text-xs text-neutral-500 transition-colors hover:border-teal-400 hover:text-teal-700 dark:text-neutral-400 dark:hover:text-teal-300 ${
                          h.level === 3 ? 'pl-4' : ''
                        }`}
                        title={h.text}
                      >
                        {h.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}

            {/* 中栏：正文。三种情形分开——**读到了**（渲染）/ **读不到**（上面那条错误条
                已经说了，这里一个字都不补，免得同一件事说两遍）/ **还在读**。
                最后那种不能和「读不到」混在一起：混了就会出现「错误条 + 正在读正文…」同屏。 */}
            <div className="min-w-0">
              {reading.md ? (
                <Markdown withAnchors>{reading.md}</Markdown>
              ) : readErr ? null : (
                <p className="text-sm text-neutral-400">正在读正文…</p>
              )}
              {reading.o.path ? (
                <p className="pt-3 text-xs text-neutral-400">{reading.o.path}</p>
              ) : null}
            </div>

            {/* 右栏：引用来源。**清单里那一份不带 sources**（读的是 vault 里的文件本身，
                正文里是 `[1]` 这种纯文本），所以这里只解释规矩，不硬凑一份来源表。 */}
            <aside className="hidden xl:block">
              <p className="pb-2 text-xs text-neutral-400">引用</p>
              {reading.sources.length ? (
                <SourceList sources={reading.sources} />
              ) : (
                <p className="text-xs leading-relaxed text-neutral-400">
                  这一份是从 vault 里读出来的原文，没带来源表。
                  <br />
                  刚生成完那一屏里，正文的 <code className="text-neutral-500">[n]</code> 点得回原材料。
                </p>
              )}
            </aside>
          </div>
        </div>
      </section>
    )
  }

  // ---------- 生成面板 + 清单 ----------
  return (
    <div className="space-y-4">
      {genOpen && catalogue ? (
        <section
          data-report-panel
          className="wb-card-hero space-y-3 rounded-lg p-5"
        >
          {/* 行1：体裁。**自定义模板也在这一排**——它是体裁，不是别的东西；结构只能由
              一处决定，所以这里不摆第二个「模板选择器」（两处选会互相打架）。
              自定义那些用**虚线边框**区分（不靠颜色：颜色在这个仓里都是有语义的）。 */}
          <div className="flex flex-wrap items-center gap-1.5">
            {catalogue.genres.map((g) => (
              <button
                key={g.id}
                onClick={() => {
                  setGenre(g.id)
                  // 换了体裁，上一份提纲就不是这份体裁的结构了——清掉，别让它继续挂着。
                  // `outlineRef` 也得清：失败之后那颗「重试」读的是它，不清就会拿**别的体裁**
                  // 的小节去写这一份（界面上明明已经换了体裁）。
                  clearOutlineFor()
                }}
                title={g.custom ? '自定义模板' : undefined}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  genre === g.id
                    ? KIND_BADGE.deliver
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
                } ${g.custom ? 'border-dashed' : ''}`}
              >
                {g.label}
              </button>
            ))}
          </div>

          {/* 行2：读者 + 体裁模板（§8.1：自定义模板也在此）。读者与体裁是**两根独立的轴**
              ——读者改详略与口气，体裁定结构与篇幅。模板那一头只管「这种体裁从哪来」。 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-neutral-400">读者</span>
            {catalogue.audiences.map((a) => (
              <button
                key={a.id}
                onClick={() => setAudience(a.id)}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  audience === a.id
                    ? 'border-teal-400 text-teal-700 dark:border-teal-600 dark:text-teal-300'
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
                }`}
              >
                {a.label}
              </button>
            ))}

            <span className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-700" />
            <button
              data-template-new
              onClick={() => setEditing({})}
              className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
            >
              ＋ 新建模板
            </button>
            {currentCustom ? (
              <button
                data-template-edit
                onClick={() => void editCurrentTemplate()}
                title={`改「${currentCustom.label}」这份模板`}
                className="rounded-full border border-dashed border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
              >
                编辑这份模板
              </button>
            ) : null}
          </div>

          {editing ? (
            <DeliverTemplateEditor
              // 换一份模板重开编辑器时把内部状态也重置（key 变了就重挂）
              key={editing.id ?? 'new'}
              editing={editing}
              onSaved={(t) => void templateSaved(t)}
              onDeleted={(id) => void templateDeleted(id)}
              onCancel={() => setEditing(null)}
              onError={onError}
            />
          ) : null}

          {/* 行3：题目 + 生成。
              长稿那颗按钮出的是**提纲**（不是成文），所以它照实叫「出提纲」——按钮说
              「生成」而给出提纲，等于骗一次点击。短稿一键直出，仍叫「生成」。 */}
          <div className="flex gap-2">
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void (longMode ? makeOutline() : run())
              }}
              placeholder="写什么？（例：这周的 RAG 调研）"
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              data-report-go
              onClick={() => void (longMode ? makeOutline() : run())}
              disabled={!topic.trim() || busy || outlineBusy}
              className="shrink-0 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-700 disabled:opacity-40"
            >
              {longMode
                ? outlineBusy
                  ? '出提纲…'
                  : '出提纲'
                : busy
                  ? '生成中…'
                  : '生成'}
            </button>
          </div>

          {/* 行4：钉材料（搜索**手动触发**——回车或「搜」。不做边打边搜，见探测报告 D6） */}
          <div className="flex flex-wrap items-center gap-1.5">
            {pinned.map((p) => (
              <span
                key={p.spec}
                title={p.spec}
                className="flex items-center gap-1 rounded-full border border-teal-300 px-2 py-0.5 text-xs text-teal-700 dark:border-teal-600 dark:text-teal-300"
              >
                <span className="max-w-[220px] truncate">{p.title}</span>
                <button
                  onClick={() => setPinned((c) => c.filter((x) => x.spec !== p.spec))}
                  title="取消钉住"
                  className="text-teal-500 hover:text-rose-500"
                >
                  ✕
                </button>
              </span>
            ))}
            <button
              onClick={() => setPinOpen((v) => !v)}
              className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-teal-300 hover:text-teal-600 dark:border-neutral-700 dark:text-neutral-400"
            >
              {pinOpen ? '收起' : '＋ 钉一条材料'}
            </button>
          </div>

          {pinOpen ? (
            <div>
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={pinQuery}
                  onChange={(e) => setPinQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void searchPin()
                  }}
                  placeholder="在你自己的材料里搜一条…"
                  className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs outline-none placeholder:text-neutral-400 focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
                />
                <button
                  onClick={() => void searchPin()}
                  disabled={pinBusy || !pinQuery.trim()}
                  className="shrink-0 rounded-lg border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
                >
                  {pinBusy ? '搜…' : '搜'}
                </button>
              </div>
              {pinHits.length > 0 ? (
                <ul className="mt-1.5 space-y-0.5">
                  {pinHits.map((h) => (
                    <li key={h.spec || h.source}>
                      <button
                        onClick={() => addPin(h)}
                        title={h.text}
                        className="block w-full truncate rounded px-1.5 py-1 text-left text-xs text-neutral-600 transition-colors hover:bg-teal-50 hover:text-teal-700 dark:text-neutral-300 dark:hover:bg-teal-500/10"
                      >
                        {h.title || h.source}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {/* 行5：提纲确认区（§8.1 长稿模式才有）。逐条可删可改，点头后才去取材成文——
              取材与成文是贵的那两段，先让结构定下来再花那个钱。
              那一块自己一份文件（`DeliverOutlineBox.tsx`）：边界清楚，且这一页已经不短了。 */}
          <DeliverOutlineBox
            outline={outline}
            staleFor={outlineFor}
            topic={topic}
            err={outlineErr}
            busy={busy}
            onEdit={editSection}
            onDrop={dropSection}
            onAdd={addSection}
            onConfirm={writeWithOutline}
            onDirect={writeDirect}
          />

          {/* 行6：分步可视。交付流 = 一次长任务，所以走 RunPanel 的六态（全站统一）。 */}
          {phase !== 'idle' ? (
            <RunPanel
              phase={phase}
              tone="teal"
              icon="✍️"
              title="写报告"
              status={msg}
              error={runErr}
              onCancel={busy ? stopRun : undefined}
              onRetry={
                phase === 'error'
                  ? () => {
                      setPhase('idle')
                      void run()
                    }
                  : undefined
              }
              footer={
                report ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => void save()}
                      disabled={busy || !!saved}
                      className="rounded-full border border-teal-300 px-2.5 py-0.5 text-xs text-teal-700 transition-colors hover:bg-teal-100 disabled:opacity-40 dark:border-teal-600 dark:text-teal-300 dark:hover:bg-teal-500/20"
                    >
                      {saved ? '已存进 vault' : busy ? '保存中…' : '存进 vault'}
                    </button>
                    {report ? (
                      <>
                        <button
                          onClick={() => void copyText(reportMarkdown(report))}
                          className={ROW_BTN}
                        >
                          {copied ? '已复制' : '复制全文'}
                        </button>
                        <button
                          onClick={() => exportMd(report.title, saved, reportMarkdown(report))}
                          className={ROW_BTN}
                        >
                          导出 md
                        </button>
                      </>
                    ) : null}
                    {saved ? (
                      <Link
                        to={`/notes?path=${encodeURIComponent(saved)}`}
                        className="inline-flex items-center gap-1 rounded-full border border-emerald-300 px-2 py-0.5 text-xs text-emerald-700 transition-colors hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
                      >
                        已写好《{report?.title || saved}》· 查看
                      </Link>
                    ) : null}
                    <FeedbackButtons
                      kind="deliver"
                      promptSha={report.prompt_sha}
                      modelId={report.model_id}
                      artifactRef={saved}
                      injected={injected}
                    />
                  </div>
                ) : undefined
              }
            >
              {injected.length ? (
                <InjectedLine
                  names={injected}
                  className="mb-2 block text-xs text-teal-700 dark:text-teal-300"
                />
              ) : null}
              {report || draft ? (
                <div className="rounded-lg border border-teal-200/70 bg-white p-3 dark:border-teal-500/20 dark:bg-neutral-900/60">
                  <Markdown sources={report?.sources}>{reportMarkdown(report ?? draft!)}</Markdown>
                  {report ? (
                    <SourceList
                      sources={report.sources}
                      used={report.used}
                      className="border-teal-200/70 dark:border-teal-500/20"
                    />
                  ) : null}
                </div>
              ) : null}
            </RunPanel>
          ) : null}
        </section>
      ) : null}

      {/* 报告清单 = 页面主体 */}
      <section data-report-list className="wb-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800/70">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">报告</h2>
          {/* 去哪做——这里的报告是**归宿**，不是起点。做成可点的，别只是句说明。 */}
          <span className="text-xs text-neutral-400">
            研究 / 方案 / 对质 在
            <Link to="/tutor" className="text-violet-500 hover:underline">
              学
            </Link>
            · 复盘在
            <Link to="/dashboard" className="text-violet-500 hover:underline">
              仪表盘
            </Link>
          </span>
        </div>

        {outputs.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5">
            {present.map((g) => (
              <button
                key={g.key || 'all'}
                onClick={() => setFilter(g.key)}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  filter === g.key
                    ? 'border-neutral-400 text-neutral-700 dark:border-neutral-500 dark:text-neutral-200'
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
                }`}
              >
                {g.label} {g.n}
              </button>
            ))}
          </div>
        ) : null}

        {outputs.length === 0 ? (
          <div className="p-4">
            <EmptyHint
              pad="lg"
              title="还没有报告"
              hint="点右上「写一份报告」起一份；研究 / 方案 / 复盘 / 对质跑完的成品也会落到这里。"
            />
          </div>
        ) : shown.length === 0 ? (
          <div className="p-4">
            <EmptyHint title="这一类还没有" hint="换个筛选看看，或点右上写一份。" />
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {shown.map((o) => (
              <li key={o.path} className="flex items-center gap-3 px-4 py-2.5">
                <span className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${KIND_BADGE[o.kind]}`}>
                  {o.label}
                </span>
                <button
                  onClick={() => void openReport(o)}
                  title={o.title}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm text-neutral-700 transition-colors hover:text-violet-700 dark:text-neutral-200 dark:hover:text-violet-300">
                    {o.title}
                  </span>
                  <span className="block truncate text-xs text-neutral-400">{o.path}</span>
                </button>
                <span className="shrink-0 text-xs text-neutral-400">{o.date.slice(5)}</span>
                <button onClick={() => rewriteAs(o)} title="拿它当材料，换个体裁重写" className={ROW_BTN}>
                  改写成
                </button>
                <AttachToThread
                  kind="output"
                  ref={o.path}
                  className="shrink-0 opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100"
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
