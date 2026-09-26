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
 *  - **报告清单**：页面主体。行 = 体裁徽章 + 标题 + 字数/日期 + 常显动作
 *    （2026-09-26 打磨：原来那行完整路径与标题几乎逐字重复，退到 title 提示里，
 *    字数顶上来——「这份交出去有多重」才是清单上唯一一眼看得见的事实）。
 *  - **阅读视图**：点一行进来（**页内切换，不跳路由**），三栏 = 大纲 / 正文 / 引用。
 *    整块在 `ReportReader.tsx`（滚动高亮的大纲、右栏的文档事实都在那边）。
 *
 *  ## 「点开」为什么不再跳笔记页
 *
 *  原来点一行直接 `navigate('/notes?path=…')`——读一份自己刚写的东西，却被扔到编辑器里。
 *  现在清单行进阅读视图（大纲导航 + 正文 + 引用栏）；想去 vault 里改，阅读视图头上有入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { PenLine } from 'lucide-react'

import { api, type DeliverCatalogue, type DeliverTemplate, type MaterialHit, type WorkOutput } from './api'
import AttachToThread from './AttachToThread'
import DeliverOutlineBox from './DeliverOutlineBox'
import DeliverTemplateEditor from './DeliverTemplateEditor'
import EmptyHint from './EmptyHint'
import InjectedLine from './InjectedLine'
import type { CiteSource } from './markdown'
import { KIND_BADGE } from './OutputCard'
import ReportReader from './ReportReader'
import DeliverSteps, { ReportActions, ReportPreview, StepHead } from './ReportFlow'
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

/** 报告清单的**列网格**：渐变列头与每一行共用同一份模板，对齐是结构保证的，
 *  不是肉眼对出来的（体裁 / 标题 / 字数 / 日期 / 操作）。 */
const LIST_GRID =
  'grid grid-cols-[3rem_minmax(0,1fr)_5rem_3rem_auto] items-center gap-3'

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
  /** 分步可视走到哪一格（取材/写作/完成）。与 `phase` 分开：六态是 RunPanel 的通用
   *  状态机，这三格是交付流自己的流程形状（方案 §二-2）。 */
  const [stage, setStage] = useState<'gather' | 'write' | 'done'>('gather')
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
  /** 带要求重写（参考 AI-Report 的逐章「重新生成 + 自定义提示词」，收成整份一份）：
   *  同题目、同材料、同提纲，只换这次的一句话要求。ref 与 outlineRef 同一个道理——
   *  重试必须复用上一次的要求；正常生成路径会在点下去时把它清空。 */
  const extraRef = useRef('')

  // ---------- 体裁模板（§8.1 行2） ----------
  /** 开着的编辑器：`{}` = 新建，带 `id` = 改一个已有的，`null` = 收着。
   *  **它是体裁，不是别的东西**——所以存完就把它选上（你刚定义的那种体裁就是你要用的那种）。 */
  const [editing, setEditing] = useState<Partial<DeliverTemplate> | null>(null)

  // ---------- 清单 / 阅读视图 ----------
  const [filter, setFilter] = useState('')
  /** 清单的标题/路径搜索。客户端过滤——清单数据本来就在手上，不必为两个字发请求。 */
  const [query, setQuery] = useState('')
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
    setStage('gather')
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
            setStage('gather')
          } else if (event === 'sources') {
            // 方案 §二-2：**「已找到 N 个来源」**——N 是这一帧的全部信息量。
            // 只说「材料到手」的话，这条状态行在「找到 1 条」和「找到 12 条」时一模一样。
            const n = ((data.sources ?? []) as unknown[]).length
            setMsg(`已找到 ${n} 个来源，开始写…`)
            setPhase('progress')
            setStage('write')
          } else if (event === 'skills') {
            // S1：命中即注入。只说事实——没命中这一帧根本不发
            setInjected(((data.skills ?? []) as unknown[]).map(String))
          } else if (event === 'writing') {
            setMsg('成文中…')
            setPhase('progress')
            setStage('write')
          } else if (event === 'draft') {
            // draft 一帧帧来，正文边生成边渲染；`report` 到了才算数。
            // 方案 §二-2 的**「正在写第几节」**：数得出的那一节就是**最后那一节**
            // （它正被打字机式地补全），所以报它的序号。整篇有几节要到收尾才知道，
            // 这里**不编一个分母**出来。
            const secs = (data.sections ?? []) as ReportDraft['sections']
            setMsg(secs.length ? `正在写第 ${secs.length} 节…` : '')
            setPhase('streaming')
            setStage('write')
            setDraft({ title: String(data.title ?? ''), sections: secs })
          }
        },
        ctl.signal,
        pinned.map((p) => p.spec),
        // 定稿的提纲。**空数组 = 没走提纲**（短稿一键直出，或长稿里点了「直接写」）。
        outlineRef.current,
        // 带要求重写的那句话（正常生成为空；重试按 ref 复用——与提纲同一口径）
        extraRef.current
      )
      if (r.ok && r.report) {
        setReport(r.report)
        setMsg('')
        setPhase('done')
        setStage('done')
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

  /** 带要求重写：同题目/同材料/同提纲，只把这句话要求交给这一次成文。extraRef 让
      「重试」复用同一句话（与提纲同一个口径）；正常生成的路径都把它清空。 */
  const doRewrite = (text: string) => {
    extraRef.current = text
    void run()
  }

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
    extraRef.current = ''
    void run()
  }

  /** 「直接写」：不要提纲，照体裁默认结构写。 */
  const writeDirect = () => {
    outlineRef.current = []
    extraRef.current = ''
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
    extraRef.current = ''
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
    let rows = outputs
    if (g && g.kinds.length) rows = rows.filter((o) => g.kinds.includes(o.kind))
    const q = query.trim().toLowerCase()
    if (q)
      rows = rows.filter(
        (o) => o.title.toLowerCase().includes(q) || o.path.toLowerCase().includes(q)
      )
    return rows
  }, [outputs, filter, query])

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

  // ---------- 阅读视图（页内切换，不跳路由；三栏与滚动高亮在 ReportReader） ----------
  if (reading) {
    return (
      <ReportReader
        reading={reading}
        readErr={readErr}
        copied={copied}
        onClose={() => {
          readSeq.current++ // 作废还在路上的那一次拉取
          setReading(null)
          setReadErr('')
        }}
        onCopy={(md) => void copyText(md)}
        onExport={exportMd}
        onRewrite={rewriteAs}
        onError={onError}
      />
    )
  }

  // ---------- 生成面板 + 清单 ----------
  return (
    <div className="space-y-4">
      {genOpen && catalogue ? (
        <section
          data-report-panel
          /* 深色玻璃（参考 SmartBrief 的面板质感）：半透明深底 + backdrop-blur，
              两团 teal/emerald 辉光用 background-image 画在同一层——不另起 DOM。
              底色不是中性灰黑（`neutral-900`），是**带青调的墨色**（`#0b201e`）：
              辉光、渐变按钮、表头同属一个色族，面板才像长在这一页上的，
              而不是一块外来的深灰贴在白纸上。
              面板里的**配置控件**走玻璃芯片（白 5% 底 / 白 15% 边），
              提纲区 / RunPanel / 成品预览保持白底「纸面」：深色框手、浅色内容，
              读长文的对比度不受这份炫技影响。 */
          className="space-y-3 rounded-lg border border-teal-200/15 bg-[#0b201e]/90 p-5 backdrop-blur-xl [background-image:radial-gradient(40rem_12rem_at_10%_-20%,rgba(45,212,191,0.34),transparent_62%),radial-gradient(32rem_14rem_at_98%_120%,rgba(52,211,153,0.26),transparent_58%),radial-gradient(24rem_10rem_at_70%_-30%,rgba(94,234,212,0.12),transparent_60%)]"
        >
          {/* 面板头：图标 + 标题 + 收起。原来这块只能开不能收——摊开就一直占着首屏，
              把清单顶下去想收都收不掉。收起归这一层自己管（页头按钮只管推开）。 */}
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2.5 text-sm font-semibold text-white">
              <span className="wb-chip h-7 w-7 rounded-lg bg-teal-400/20 text-teal-300">
                <PenLine className="h-4 w-4" />
              </span>
              写一份报告
              <span className="text-xs font-normal text-neutral-400">
                三步：定体裁 → 想题目 → 出成稿
              </span>
            </h2>
            <button
              onClick={() => setGenOpen(false)}
              title="收起面板"
              className="shrink-0 rounded-full border border-white/20 px-2.5 py-0.5 text-xs text-neutral-300 transition-colors hover:border-white/40 hover:text-white"
            >
              收起
            </button>
          </div>

          <StepHead n={1} title="体裁与读者" hint="体裁定结构与篇幅，读者定详略与口气" />

          {/* 行1：体裁。**自定义模板也在这一排**——它是体裁，不是别的东西；结构只能由
              一处决定，所以这里不摆第二个「模板选择器」（两处选会互相打架）。
              自定义那些用**虚线边框**区分（不靠颜色：颜色在这个仓里都是有语义的）。 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-neutral-400">体裁</span>
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
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  genre === g.id
                    ? 'border-teal-300 bg-teal-500/20 font-medium text-teal-200'
                    : 'border-white/15 bg-white/5 text-neutral-300 hover:border-teal-400/50 hover:text-teal-200'
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
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  audience === a.id
                    ? 'border-teal-400 bg-teal-500/20 font-medium text-teal-200'
                    : 'border-white/15 bg-white/5 text-neutral-300 hover:border-teal-400/50 hover:text-teal-200'
                }`}
              >
                {a.label}
              </button>
            ))}

            <span className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-700" />
            <button
              data-template-new
              onClick={() => setEditing({})}
              className="rounded-full border border-white/15 px-2 py-0.5 text-xs text-neutral-300 transition-colors hover:border-teal-400/50 hover:text-teal-200"
            >
              ＋ 新建模板
            </button>
            {currentCustom ? (
              <button
                data-template-edit
                onClick={() => void editCurrentTemplate()}
                title={`改「${currentCustom.label}」这份模板`}
                className="rounded-full border border-dashed border-white/15 px-2 py-0.5 text-xs text-neutral-300 transition-colors hover:border-teal-400/50 hover:text-teal-200"
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

          <StepHead n={2} title="题目与材料" hint="写什么；要重点用哪几份材料，就钉进来" />

          {/* 行3：题目 + 生成。
              长稿那颗按钮出的是**提纲**（不是成文），所以它照实叫「出提纲」——按钮说
              「生成」而给出提纲，等于骗一次点击。短稿一键直出，仍叫「生成」。 */}
          <div className="flex gap-2">
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  extraRef.current = ''
                  void (longMode ? makeOutline() : run())
                }
              }}
              placeholder="写什么？（例：这周的 RAG 调研）"
              className="min-w-0 flex-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2.5 text-sm text-white outline-none placeholder:text-neutral-500 focus:border-teal-400/60"
            />
            <button
              data-report-go
              onClick={() => {
                extraRef.current = ''
                void (longMode ? makeOutline() : run())
              }}
              disabled={!topic.trim() || busy || outlineBusy}
              className="shrink-0 rounded-lg bg-gradient-to-r from-teal-500 to-emerald-400 px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-emerald-500/25 transition-all hover:brightness-110 disabled:opacity-40 dark:shadow-none"
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
                className="flex items-center gap-1 rounded-full border border-teal-400/40 bg-teal-500/10 px-2 py-0.5 text-xs text-teal-200"
              >
                <span className="max-w-[220px] truncate">{p.title}</span>
                <button
                  onClick={() => setPinned((c) => c.filter((x) => x.spec !== p.spec))}
                  title="取消钉住"
                  className="text-teal-300 hover:text-rose-400"
                >
                  ✕
                </button>
              </span>
            ))}
            <button
              onClick={() => setPinOpen((v) => !v)}
              className="rounded-full border border-white/15 px-2 py-0.5 text-xs text-neutral-300 transition-colors hover:border-teal-400/50 hover:text-teal-200"
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
                  className="min-w-0 flex-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-neutral-500 focus:border-teal-400/60"
                />
                <button
                  onClick={() => void searchPin()}
                  disabled={pinBusy || !pinQuery.trim()}
                  className="shrink-0 rounded-lg border border-white/15 px-2.5 py-1 text-xs text-neutral-300 transition-colors hover:border-teal-400/50 hover:text-teal-200 disabled:opacity-40"
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
                        className="block w-full truncate rounded px-1.5 py-1 text-left text-xs text-neutral-300 transition-colors hover:bg-white/10 hover:text-teal-200"
                      >
                        {h.title || h.source}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {/* 步骤③的落点：提纲确认区、运行面板、成品。没走到这一步时整个不出现——
              空摆一个「成稿」格子只会让人问「这里怎么什么都没有」。 */}
          {outline || phase !== 'idle' ? (
            <StepHead n={3} title="成稿" hint="提纲点头后才取材成文；过程与成品都落在这里" />
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
                  /* 操作行与「带要求重写」的输入行在 `ReportFlow.tsx`——这一块自己就有
                      百来行，ReportPage 装不下了；extraRef 留在页面（run 要读它）。 */
                  <ReportActions
                    report={report}
                    saved={saved}
                    busy={busy}
                    copied={copied}
                    onSave={() => void save()}
                    onCopy={(md) => void copyText(md)}
                    onExport={exportMd}
                    onRewrite={doRewrite}
                    onError={onError}
                    injected={injected}
                  />
                ) : undefined
              }
            >
              {/* 分步可视（方案 §二-2）：整条流程走到哪了，扫一眼就够；
                  细节仍在 RunPanel 的状态行里（找到几个来源 / 写到第几节）。 */}
              <DeliverSteps step={stage} />
              {injected.length ? (
                <InjectedLine
                  names={injected}
                  className="mb-2 block text-xs text-teal-700 dark:text-teal-300"
                />
              ) : null}
              {report || draft ? (
                /* 成品预览卡（正文 + 引用栏 + 文风扫描）在 `ReportFlow.tsx`——
                    这张「纸」自己就有几十行，ReportPage 装不下了。 */
                <ReportPreview report={report} draft={draft} />
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
            {/* 标题/路径搜索：清单是本页已到手的数据，过滤在客户端做。
                压到筛选 chips 的同一行右端——它是「找某一篇」的工具，不配占一整行。 */}
            <input
              data-report-search
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜标题或路径…"
              className="ml-auto w-44 rounded-lg border border-neutral-300 bg-white px-2.5 py-1 text-xs outline-none placeholder:text-neutral-400 focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
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
            {query.trim() ? (
              /* 搜出来是空的与「这一类还没有」是两件事：前者给一个就地清掉搜索的出口，
                  不用让人自己找到那颗 ×（其实输入框里也没有 ×）。 */
              <EmptyHint
                title="没有匹配的报告"
                hint={`没有标题或路径带「${query.trim()}」的。`}
                action={
                  <button
                    onClick={() => setQuery('')}
                    className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:border-teal-300 hover:text-teal-600 dark:border-neutral-700 dark:text-neutral-300"
                  >
                    清掉搜索
                  </button>
                }
              />
            ) : (
              <EmptyHint title="这一类还没有" hint="换个筛选看看，或点右上写一份。" />
            )}
          </div>
        ) : (
          <>
            {/* 渐变列头（参考 SmartBrief 的表格头）：teal 语义色打底、白字小标题。
                列与行共用 `LIST_GRID` 这一份网格模板——对齐由结构保证，不靠肉眼。 */}
            <div
              className={`${LIST_GRID} border-b border-teal-700/40 bg-gradient-to-r from-teal-600 to-emerald-500 px-4 py-2 text-xs font-medium text-white`}
            >
              <span className="text-center">体裁</span>
              <span>标题</span>
              <span className="text-right">字数</span>
              <span className="text-right">日期</span>
              <span className="text-right">操作</span>
            </div>
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
              {shown.map((o) => (
                /* 单行：徽章 | 标题 | 字数 | 日期 | 动作。原来标题下挂一行完整路径，
                    与标题几乎逐字重复（日期还在路径里又出现了一次）；路径退到 title
                    提示里，字数顶上来——它才是清单上唯一一眼看得见的新事实。 */
                <li
                  key={o.path}
                  className={`${LIST_GRID} px-4 py-2.5 transition-colors hover:bg-neutral-50/80 dark:hover:bg-neutral-800/30`}
                >
                  <span
                    className={`inline-flex w-12 justify-center rounded border py-0.5 text-xs ${KIND_BADGE[o.kind]}`}
                  >
                    {o.label}
                  </span>
                  <button
                    onClick={() => void openReport(o)}
                    title={`${o.title} · ${o.path}`}
                    className="min-w-0 text-left"
                  >
                    <span className="block truncate text-sm text-neutral-700 transition-colors hover:text-violet-700 dark:text-neutral-200 dark:hover:text-violet-300">
                      {o.title}
                    </span>
                  </button>
                  <span className="text-right text-xs tabular-nums text-neutral-400">
                    {typeof o.chars === 'number' ? `${o.chars.toLocaleString()} 字` : ''}
                  </span>
                  <span className="text-right text-xs text-neutral-400">{o.date.slice(5)}</span>
                  <span className="flex items-center justify-end gap-1.5">
                    <button
                      onClick={() => rewriteAs(o)}
                      title="拿它当材料，换个体裁重写"
                      className={ROW_BTN}
                    >
                      改写成
                    </button>
                    <AttachToThread
                      kind="output"
                      ref={o.path}
                      className="shrink-0 opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100"
                    />
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}
