/** 「提示词」——你自己的提示词库（工作模块的下级模块，参照 AI Gist）。
 *
 *  为什么要有它：在这之前，「你自己攒的提示词」只有一个四字段的表 + 设置页里一段列表——
 *  存得下，但**找不着、改不动、拿不走**，也没法变好。这一页把它做成一个库。
 *
 *  **左导航 + 右内容**（对齐 AI Gist 那一版）：
 *  - 左：全部 / 最近使用 / 收藏，以及**分类列表**（彩色圆点 + 计数 + 齿轮进分类管理）；
 *  - 右：搜索 + 排序 + 高级筛选 + 四视图（卡片/网格/表格/文件夹）+ 详情编辑。
 *
 *  五条与这个仓库其它页一致的规矩：
 *  - **一件事一处**：这一页是这份库**唯一**的管理入口（设置页那段只剩一个指过来的链接）。
 *  - **AI 只产出文本，不落库**：生成/调优的结果一律先进「草稿」，你改完再保存——
 *    照 AI Gist 那句「用之前，改一改」。从来没有「AI 直接替你存了一条」这种事。
 *  - **读不到就说读不到**：搜索失败、历史拉不到、复制失败，都出话，不摆成一个空列表。
 *  - **不养第二份真值**：用过几次、几个旧版、分类里有几条，全是后端从记录里聚合出来的。
 *  - **删分类绝不删条目**：分类只是标签，条目才是攒下来的东西。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SlidersHorizontal, Sparkles } from 'lucide-react'

import EmptyHint from './EmptyHint'
import PromptAiPanel from './PromptAiPanel'
import PromptCategoryManager from './PromptCategoryManager'
import PromptDuel from './PromptDuel'
import PromptEditor from './PromptEditor'
import PromptHistoryPanel from './PromptHistoryPanel'
import PromptNav from './PromptNav'
import PromptVarFill from './PromptVarFill'
import {
  CardView,
  CategoryView,
  GridView,
  PromptViewSwitch,
  TableView,
  catColor,
  star,
  tagTone,
} from './PromptViews'
import { EMPTY, blankDraft, draftToItem, fill, varsIn, type Draft } from './promptDraft'
import {
  api,
  type PromptCategoryItem,
  type PromptFacets,
  type PromptItem,
  type PromptSort,
  type PromptUsageItem,
  type PromptVersionItem,
  type PromptView,
} from './api'

/** `request()` 抛的是 `503: {"detail":"…"}`，直接摆出来太生。把里面那句人话挖出来。 */
function humanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const m = raw.match(/\{"detail":"([\s\S]*?)"\}/)
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`) as string
    } catch {
      return m[1]
    }
  }
  return raw
}

/** 把模型提出来、但正文里还没有的变量**挖空**。
 *
 *  为什么不能只把名字列出来就完事：变量要真出现在正文里才会被问到。模型说「这里有
 *  主题、读者两处」，可正文一个字没改——那用户填的时候一处都不会被问，等于白提。
 *  这里**做得保守**：只在能明确对上的时候替换，对不上就**不动**，宁可少挖。
 */
function addVars(content: string, vars: string[]): string {
  let out = content
  for (const v of vars) {
    if (out.includes(`{${v}}`)) continue
    const idx = out.indexOf(v)
    if (idx === -1) continue
    out = `${out.slice(0, idx)}{${v}}${out.slice(idx + v.length)}`
  }
  return out
}

const VIEW_KEY = 'prompt-view'
const SORTS: Array<{ key: PromptSort; label: string }> = [
  { key: 'updated', label: '最近优先' },
  { key: 'used', label: '最近使用' },
  { key: 'rating', label: '评分最高' },
  { key: 'title', label: '按标题' },
]

/** 视图选择记进 localStorage —— 与侧栏那套开合记忆同一个做法（`nav-open`）：
 *  你选的视图是你的偏好，不该每次进来都被重置回卡片。 */
function loadView(): PromptView {
  const v = localStorage.getItem(VIEW_KEY)
  return v === 'grid' || v === 'table' || v === 'category' ? v : 'card'
}

/** 左导航的三种「不是分类」的入口。 */
type NavKey = 'all' | 'recent' | 'fav'

/** 选中态：**中性深底**。颜色留给「这是什么」（分类色 / 标签色），
 *  选中只说明「你正在看这个」——两件事分给两种手段，谁也不挤掉谁。 */
const SEL_CHIP = 'bg-neutral-800 font-medium text-white dark:bg-neutral-200 dark:text-neutral-900'

export default function PromptLibrary({ newSignal = 0 }: { newSignal?: number }) {
  const [list, setList] = useState<PromptItem[]>([])
  const [facets, setFacets] = useState<PromptFacets | null>(null)
  const [nav, setNav] = useState<NavKey | string>('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<PromptSort>('updated')
  const [view, setView] = useState<PromptView>(loadView())
  const [advOpen, setAdvOpen] = useState(false)
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [ratingFloor, setRatingFloor] = useState(0)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  /** 头一次读库还没回来。**这一段不能是纯空白**——空白分不清「还没读到」和「库里就是空的」，
   *  而这两种情况该说的话完全不同（一个是等，一个是「去建一条」）。 */
  const [loading, setLoading] = useState(true)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const [fillOpen, setFillOpen] = useState<PromptItem | null>(null)
  const [fillVals, setFillVals] = useState<Record<string, string>>({})
  const [history, setHistory] = useState<{ of: PromptItem; items: PromptVersionItem[] } | null>(null)
  const [usages, setUsages] = useState<{ of: PromptItem; items: PromptUsageItem[] } | null>(null)
  const [catMgr, setCatMgr] = useState(false)

  const [aiOpen, setAiOpen] = useState(false)
  const [idea, setIdea] = useState('')
  const [aiPhase, setAiPhase] = useState<'idle' | 'planning' | 'done' | 'error'>('idle')
  const [aiErr, setAiErr] = useState('')
  const [refineAsk, setRefineAsk] = useState('')

  /** 草稿的「已保存基线」。
   *
   *  **为什么需要它**：改了一大段正文之后，点「关掉」或者点左边另一条，草稿会被
   *  静默丢掉——一个字都不问。这是这一页唯一会**丢东西**的地方，而它跟版面无关，
   *  是行为问题（AI Gist 的设计契约把「关闭/切走前先保护未保存的改动」列成必查项）。
   *  比法就是整份草稿的序列化：字段少、没有大对象，够用且不会漏字段。 */
  const [baseline, setBaseline] = useState('')

  const refresh = useCallback(async () => {
    try {
      setList(await api.listPrompts())
      setFacets(await api.promptFacets())
      setErr('')
    } catch (e) {
      // 读不到就说读不到——不摆成一个空列表（「失败」冒充「没有」是本仓库点过名的毛病）
      setErr(`库拉不出来：${humanError(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 左导航当前是不是停在某个分类上（是的话，新建的条目默认归到它）。 */
  const navCategory = nav !== 'all' && nav !== 'recent' && nav !== 'fav' ? nav : ''

  /** 页头那个「＋ 新建提示词」推上来的信号。
   *
   *  为什么要一个信号而不是把按钮放进这个组件：页头是 `PageShell` 的，
   *  而它是 `WorkPage` 渲染的——按钮在上一层的右上角，状态在这一层。
   *  用「计数器变了就开一条新草稿」把两边接起来：**按钮的位置归页头，
   *  草稿的状态归这里**，谁也不越界。 */
  useEffect(() => {
    if (newSignal <= 0) return
    // 页头那个按钮也是「走开」的一种：手上没存的东西同样要问一句
    if (!confirmDiscard()) return
    openDraft(blankDraft(navCategory))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newSignal])

  /** 手上这条改了但没保存。**只在这一页会丢东西的两条路上用**：关掉、和切走。 */
  const dirty = draft != null && JSON.stringify(draft) !== baseline

  /** 要丢掉未保存的改动之前问一句。返回 `true` = 可以往下走。
   *
   *  **不静默丢弃**：改了一大段正文再点另一条，改动就这么没了——那是这一页唯一
   *  会丢东西的地方。问一句的成本很低，而丢掉的是他刚写的东西。 */
  function confirmDiscard(): boolean {
    if (!dirty) return true
    return window.confirm('这条还没保存，走开就丢了。要丢掉改动吗？')
  }

  /** 开一份草稿（新建或编辑），**同时把「已保存基线」记下来**。
   *  三处开草稿都走它，免得漏掉某处导致「没改也提示未保存」。 */
  function openDraft(d: Draft) {
    setDraft(d)
    setBaseline(JSON.stringify(d))
    setHistory(null)
    setUsages(null)
  }

  function openNew() {
    if (!confirmDiscard()) return
    openDraft(blankDraft(navCategory))
  }

  const colorOf = useCallback(
    (name: string) => facets?.categories.find((c) => c.name === name)?.color ?? '',
    [facets]
  )

  /** 筛选与排序都在本地做：这是个人级的库（几十到几百条），来回打后端只会让它变慢，
   *  而且搜索框每敲一个字都发一次请求。 */
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out = list.filter((p) => {
      // 左导航
      if (nav === 'recent' && !p.last_used_at) return false
      if (nav === 'fav' && !p.favorite) return false
      if (nav !== 'all' && nav !== 'recent' && nav !== 'fav') {
        // 分类：空字符串这个 nav 值代表「未分类」
        if (nav === '' ? p.category !== '' : p.category !== nav) return false
      }
      // 高级筛选
      if (tagFilter.length && !tagFilter.every((t) => p.tags.includes(t))) return false
      if (p.rating < ratingFloor) return false
      if (!needle) return true
      return (
        p.title.toLowerCase().includes(needle) ||
        p.content.toLowerCase().includes(needle) ||
        p.tags.some((t) => t.toLowerCase().includes(needle))
      )
    })
    const sorted = [...out]
    sorted.sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title, 'zh')
      if (sort === 'rating') return b.rating - a.rating || b.used_count - a.used_count
      if (sort === 'used') {
        // 「最近使用」按**时间**排，不是按次数：用过 9 次但半年前，不该排在昨天用的前面
        return (b.last_used_at || '').localeCompare(a.last_used_at || '')
      }
      return (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at)
    })
    return sorted
  }, [list, q, nav, tagFilter, ratingFloor, sort])

  const activeFilters = tagFilter.length + (ratingFloor > 0 ? 1 : 0)

  function toast(text: string) {
    setMsg(text)
    window.setTimeout(() => setMsg(''), 2500)
  }

  function openEditor(p: PromptItem) {
    if (!confirmDiscard()) return
    openDraft({
      id: p.id,
      title: p.title,
      content: p.content,
      tags: p.tags.join(', '),
      category: p.category,
      favorite: p.favorite,
      rating: p.rating,
      source: p.source,
      note: p.note,
    })
    setErr('')
  }

  const save = useCallback(async () => {
    if (!draft) return
    if (!draft.title.trim()) {
      setErr('标题不能空——它是这张卡片上唯一一眼能认的东西。')
      return
    }
    if (!draft.content.trim()) {
      setErr('正文不能空。')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const payload = {
        title: draft.title.trim(),
        content: draft.content,
        // **只做形状转换，不在这里做归一化**：去重、去空、全角逗号都是后端
        // `_tags_of` 那一处的事（它连 `["写作，周报"]` 这种整串也认）。两边各归一化一遍，
        // 迟早分叉——而分叉的那天没人会发现。
        tags: draft.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        category: draft.category.trim(),
        favorite: draft.favorite,
        rating: draft.rating,
        source: draft.source.trim(),
        note: draft.note.trim(),
      }
      const saved =
        draft.id == null ? await api.createPrompt(payload) : await api.updatePrompt(draft.id, payload)
      await refresh()
      // 存完就是「干净的」了——基线跟着走，否则刚保存完还提示有未保存改动
      openDraft({ ...draft, id: saved.id })
      toast(draft.id == null ? `已存进库：《${saved.title}》` : '改好了')
    } catch (e) {
      setErr(`保存失败：${humanError(e)}`)
    } finally {
      setBusy(false)
    }
  }, [draft, refresh])

  const remove = useCallback(
    async (p: PromptItem) => {
      if (!window.confirm(`删掉《${p.title}》？它的历史版本与使用记录会一起删。`)) return
      try {
        await api.deletePrompt(p.id)
        if (draft?.id === p.id) setDraft(null)
        setHistory(null)
        setUsages(null)
        await refresh()
        toast('删了')
      } catch (e) {
        setErr(`删除失败：${humanError(e)}`)
      }
    },
    [draft, refresh]
  )

  const toggleFavorite = useCallback(
    async (p: PromptItem) => {
      try {
        await api.updatePrompt(p.id, { favorite: !p.favorite })
        await refresh()
      } catch (e) {
        setErr(`收藏失败：${humanError(e)}`)
      }
    },
    [refresh]
  )

  const copy = useCallback(
    async (p: PromptItem, values: Record<string, string>) => {
      const text = fill(p.content, values)
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        setErr('剪贴板用不了（浏览器没给权限）。正文在下面，手动选一下也行。')
        return
      }
      try {
        await api.usePrompt(p.id, values)
        await refresh()
      } catch {
        // 记使用失败不该让「已经复制成功」变成一次失败——同 `_attach_to_thread` 那条纪律
      }
      setFillOpen(null)
      toast(`已复制《${p.title}》`)
    },
    [refresh]
  )

  const startCopy = useCallback(
    (p: PromptItem) => {
      const vars = varsIn(p.content)
      if (!vars.length) {
        void copy(p, {})
        return
      }
      setFillVals(Object.fromEntries(vars.map((v) => [v, p.last_vars?.[v] ?? ''])))
      setFillOpen(p)
    },
    [copy]
  )

  const openHistory = useCallback(async (p: PromptItem) => {
    try {
      setUsages(null)
      setHistory({ of: p, items: await api.promptVersions(p.id) })
    } catch (e) {
      setErr(`历史拉不出来：${humanError(e)}`)
    }
  }, [])

  const openUsages = useCallback(async (p: PromptItem) => {
    try {
      setHistory(null)
      setUsages({ of: p, items: await api.promptUsages(p.id) })
    } catch (e) {
      setErr(`使用记录拉不出来：${humanError(e)}`)
    }
  }, [])

  const restore = useCallback(
    async (p: PromptItem, v: PromptVersionItem) => {
      try {
        const back = await api.restorePromptVersion(p.id, v.id)
        setHistory(null)
        await refresh()
        openEditor(back)
        toast('回到那一版了（你刚丢下的那版也留在历史里）')
      } catch (e) {
        setErr(`回滚失败：${humanError(e)}`)
      }
    },
    [refresh]
  )

  // ---------- 分类管理 ----------

  const addCategory = useCallback(
    async (name: string, color: string) => {
      try {
        await api.createPromptCategory(name, color)
        await refresh()
        toast(`建了分类「${name}」`)
      } catch (e) {
        setErr(`建分类失败：${humanError(e)}`)
      }
    },
    [refresh]
  )

  const renameCategory = useCallback(
    async (c: PromptCategoryItem, name: string, color: string) => {
      try {
        await api.updatePromptCategory(c.id, { name, color })
        await refresh()
        // 改名会连条目一起搬，所以左导航选中的那个名字也要跟着走
        if (nav === c.name) setNav(name)
        toast('改好了')
      } catch (e) {
        setErr(`改分类失败：${humanError(e)}`)
      }
    },
    [refresh, nav]
  )

  const dropCategory = useCallback(
    async (c: PromptCategoryItem) => {
      if (!window.confirm(`删掉分类「${c.name}」？里面的 ${c.count} 条提示词会退回「未分类」，一条都不会删。`))
        return
      try {
        const r = await api.deletePromptCategory(c.id)
        if (nav === c.name) setNav('all')
        await refresh()
        toast(`分类删了，${r.uncategorized} 条退回未分类`)
      } catch (e) {
        setErr(`删分类失败：${humanError(e)}`)
      }
    },
    [refresh, nav]
  )

  // ---------- AI 三条 ----------
  //
  // 三条共用一个 `aiPhase`（一次只可能跑一条）与**同一个 AbortController**。
  // 「不等了」据此真的断开请求——**它不是「停止」**：一次性 POST 断开之后服务端照样
  // 跑完那次模型调用。所以 RunPanel 上那颗按钮的字是「不等了」。

  const aiAbort = useRef<AbortController | null>(null)

  /** 起一趟 AI：装上新的 controller，把 signal 交给调用方。 */
  const beginAi = useCallback(() => {
    aiAbort.current?.abort()
    const ctl = new AbortController()
    aiAbort.current = ctl
    setAiPhase('planning')
    setAiErr('')
    return ctl
  }, [])

  const endAi = useCallback((ctl: AbortController) => {
    if (aiAbort.current === ctl) aiAbort.current = null
  }, [])

  const aiGenerate = useCallback(async () => {
    const ctl = beginAi()
    try {
      const r = await api.promptAiGenerate(idea, ctl.signal)
      if (ctl.signal.aborted) return
      // **只进草稿，不落库**——用之前，改一改
      openDraft({ ...EMPTY, title: r.title, content: r.content })
      setAiPhase('idle')
      setAiOpen(false)
      setIdea('')
      toast('生成好了，在右边——改完再存')
    } catch (e) {
      if (ctl.signal.aborted) return // 自己点的不等了，不当成失败
      setAiErr(humanError(e))
      setAiPhase('error')
    } finally {
      endAi(ctl)
    }
  }, [idea, beginAi, endAi])

  const aiRefine = useCallback(
    async (instruction: string) => {
      if (!draft) return
      const ctl = beginAi()
      try {
        const r = await api.promptAiRefine(draft.content, instruction, ctl.signal)
        if (ctl.signal.aborted) return
        setDraft({ ...draft, content: r.content })
        setAiPhase('idle')
        setRefineAsk('')
        toast('改好了——只是草稿，点「保存」才算数')
      } catch (e) {
        if (ctl.signal.aborted) return
        setAiErr(humanError(e))
        setAiPhase('error')
      } finally {
        endAi(ctl)
      }
    },
    [draft, beginAi, endAi]
  )

  const aiVars = useCallback(async () => {
    if (!draft) return
    const ctl = beginAi()
    try {
      const r = await api.promptAiVars(draft.content, ctl.signal)
      if (ctl.signal.aborted) return
      if (!r.vars.length) {
        setAiPhase('idle')
        toast('没找到会变的地方——这条大概不需要变量')
        return
      }
      setDraft((d) => (d ? { ...d, content: addVars(d.content, r.vars) } : d))
      setAiPhase('idle')
      toast(
        r.via === 'model' ? `提取了 ${r.vars.length} 个变量` : `模型用不了，按本地规则提取了 ${r.vars.length} 个`
      )
    } catch (e) {
      if (ctl.signal.aborted) return
      setAiErr(humanError(e))
      setAiPhase('error')
    } finally {
      endAi(ctl)
    }
  }, [draft, beginAi, endAi])

  // ---------- 导入导出 ----------

  const doExport = useCallback(async (format: 'json' | 'csv') => {
    try {
      await api.exportPrompts(format)
      toast(format === 'csv' ? '导出了 CSV（Excel 直接打开）' : '导出了 JSON（连标签分类一起）')
    } catch (e) {
      setErr(`导出失败：${humanError(e)}`)
    }
  }, [])

  const doImport = useCallback(
    async (file: File) => {
      try {
        const text = await file.text()
        const parsed = JSON.parse(text) as { prompts?: unknown[] }
        const rows = Array.isArray(parsed?.prompts) ? parsed.prompts : []
        if (!rows.length) {
          setErr('这份文件里没有 prompts 数组——它可能是别的 JSON。')
          return
        }
        const r = await api.importPrompts(rows as never)
        await refresh()
        toast(
          r.skipped.length
            ? `进 ${r.added.length} 条，跳过 ${r.skipped.length} 条同名的（同名不覆盖）`
            : `进了 ${r.added.length} 条`
        )
      } catch (e) {
        setErr(`导入失败：${humanError(e)}`)
      }
    },
    [refresh]
  )

  // ---------- 渲染 ----------

  const cats = facets?.categories ?? []
  /** 右侧那半屏只在「真的有东西要看」时才出现：选中一条、或打开了历史/使用记录。
   *  没选中时它只是个空框——占着地方把列表挤窄，是纯粹的浪费。 */
  const detailOpen = !!(history || usages || draft)

  const viewProps = {
    items: shown,
    colorOf,
    // 详情没开时列表是整宽的——那时才排得下更多列
    wide: !detailOpen,
    a: {
      activeId: draft?.id ?? null,
      onOpen: openEditor,
      onCopy: startCopy,
      onRemove: (p: PromptItem) => void remove(p),
      onHistory: (p: PromptItem) => void openHistory(p),
      onUsage: (p: PromptItem) => void openUsages(p),
      onFavorite: (p: PromptItem) => void toggleFavorite(p),
    },
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ---------- 区1 · 库 ----------
          方案 §8.2 把提示词页分成五区（库/对打/评测/技能/数据形态）。这里只放
          **库 + 对打**——评测/技能/数据形态三块是另外三个现成组件（`PromptLab` /
          `CapabilityCandidate` / `FormPane`），由 `WorkPage` 按区挂上；
          把别家的组件 import 进来会凭空造一个「谁编排谁」的耦合。 */}
      <div data-prompt-library className="flex flex-col gap-4 lg:flex-row">
      {/* ---------- 左导航 ---------- */}
      <PromptNav
        nav={nav}
        onPick={setNav}
        onManage={() => setCatMgr(true)}
        facets={facets}
        list={list}
        cats={cats}
      />
      {/* ---------- 右内容 ---------- */}
      <div className="min-w-0 flex-1">
        {err ? (
          <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {err}
          </p>
        ) : null}
        {msg ? (
          <p className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
            {msg}
          </p>
        ) : null}

        {/* 工具条。**一排，按用途从右往左收**：
            看（搜/排序/筛选/收藏/视图）→ 做（AI 生成）→ 带走（导出/导入）。
            分成两排的结果是中间空一大截、还看不出哪几个是一组的。 */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索提示词…"
            aria-label="搜索提示词"
            className="min-w-[10rem] max-w-xs flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as PromptSort)}
            aria-label="排序"
            className="rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => setAdvOpen((v) => !v)}
            aria-expanded={advOpen}
            className={`rounded-md border px-3 py-2 text-sm transition-colors ${
              activeFilters
                ? 'border-neutral-400 bg-neutral-100 text-neutral-800 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100'
                : 'border-neutral-300 text-neutral-500 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400'
            }`}
          >
            <SlidersHorizontal className="h-4 w-4" /> 高级筛选
            {activeFilters ? ` (${activeFilters})` : ''}
          </button>
          <button
            onClick={() => setNav(nav === 'fav' ? 'all' : 'fav')}
            aria-pressed={nav === 'fav'}
            className={`rounded-md border px-3 py-2 text-sm transition-colors ${
              nav === 'fav'
                ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-500/10 dark:text-amber-300'
                : 'border-neutral-300 text-neutral-500 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400'
            }`}
          >
            ★ 收藏
          </button>
          <PromptViewSwitch
            view={view}
            onChange={(v) => {
              setView(v)
              localStorage.setItem(VIEW_KEY, v)
            }}
          />

          <button
            onClick={() => {
              setAiOpen((v) => !v)
              setAiPhase('idle')
              setAiErr('')
            }}
            className="rounded-md border border-teal-300 px-3 py-2 text-sm text-teal-700 transition-colors hover:bg-teal-50 dark:border-teal-700 dark:text-teal-300 dark:hover:bg-teal-500/10"
          >
            <Sparkles className="h-4 w-4" /> AI 生成
          </button>
          {/* 导出收成一个下拉：两个按钮各占一格，但九成时候你只想要其中一种。
              选完把 value 复位，这样同一个格式连点两次也还会触发。 */}
          <select
            value=""
            aria-label="导出"
            onChange={(e) => {
              const v = e.target.value
              e.target.value = ''
              if (v) void doExport(v as 'json' | 'csv')
            }}
            className="rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm text-neutral-600 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
          >
            <option value="">导出…</option>
            <option value="json">JSON（标签分类一起）</option>
            <option value="csv">CSV（Excel 直接开）</option>
          </select>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300"
          >
            导入
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void doImport(f)
              e.target.value = ''
            }}
          />
        </div>

        {/* 高级筛选面板：分类与标签**都带计数**，标签还带「用得多的在前」 */}
        {advOpen ? (
          <section className="mb-3 space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-12 shrink-0 text-[13px] uppercase tracking-wider text-neutral-400">
                分类
              </span>
              <button
                onClick={() => setNav('all')}
                className={`rounded-full px-2 py-0.5 text-[13px] ${
                  nav === 'all' ? SEL_CHIP : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                }`}
              >
                全部 ({facets?.total ?? 0})
              </button>
              {cats.map((c) => {
                const hex = catColor(c.name, c.color)
                const on = nav === c.name
                return (
                  <button
                    key={c.name}
                    onClick={() => setNav(c.name)}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] ${
                      // **颜色是身份，选中是状态**：没选中时用这个分类自己的色，
                      // 选中时走中性深底——两者各管各的，谁也不挤掉谁。
                      on ? SEL_CHIP : ''
                    }`}
                    style={on ? undefined : { backgroundColor: `${hex}22`, color: hex }}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: hex }} />
                    {c.name} ({c.count})
                  </button>
                )
              })}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-12 shrink-0 text-[13px] uppercase tracking-wider text-neutral-400">
                标签
              </span>
              {(facets?.tags ?? []).length === 0 ? (
                <span className="text-[13px] text-neutral-400">还没有标签。</span>
              ) : (
                (facets?.tags ?? []).map((t) => {
                  const on = tagFilter.includes(t.name)
                  return (
                    <button
                      key={t.name}
                      onClick={() =>
                        setTagFilter((cur) =>
                          cur.includes(t.name) ? cur.filter((x) => x !== t.name) : [...cur, t.name]
                        )
                      }
                      aria-pressed={on}
                      // 同上：标签的色是**身份**，选中走中性深底。用的是与卡片上
                      // 那枚标签**同一个 `tagTone`**——两处颜色不一致就等于没颜色。
                      className={`rounded-full px-2 py-0.5 text-[13px] ${on ? SEL_CHIP : tagTone(t.name)}`}
                    >
                      #{t.name} ({t.count})
                    </button>
                  )
                })
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="w-12 shrink-0 text-[13px] uppercase tracking-wider text-neutral-400">
                评分
              </span>
              <select
                value={ratingFloor}
                onChange={(e) => setRatingFloor(Number(e.target.value))}
                aria-label="最低评分"
                className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              >
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? '不限' : `${star(n)} 以上`}
                  </option>
                ))}
              </select>
              {activeFilters ? (
                <button
                  onClick={() => {
                    setTagFilter([])
                    setRatingFloor(0)
                  }}
                  className="text-[13px] text-neutral-400 underline hover:text-neutral-600"
                >
                  清空筛选
                </button>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* AI 生成：**结果只进草稿**，不直接落库。整块独立成文件（见那里的注释）。 */}
        {aiOpen ? (
          <PromptAiPanel
            idea={idea}
            setIdea={setIdea}
            phase={aiPhase}
            err={aiErr}
            onGenerate={() => void aiGenerate()}
            onCancel={() => aiAbort.current?.abort()}
          />
        ) : null}

        {/* 变量填写：复制前把 {变量} 填上。**右侧同步显示填进去之后长什么样。** */}
        {fillOpen ? (
          <PromptVarFill
            item={fillOpen}
            vals={fillVals}
            setVals={setFillVals}
            onCopy={() => void copy(fillOpen, fillVals)}
            onUsages={() => void openUsages(fillOpen)}
            onClose={() => setFillOpen(null)}
          />
        ) : null}

        {/* **没选中就整宽**：右侧详情是「你在看某一条」时才该占的地方。
            照搬分栏却不照搬这个条件，结果是列表被挤成窄条、右边空一大片——
            截图上一眼就看出来了。 */}
        <div
          className={detailOpen ? 'grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]' : ''}
          data-prompt-split={detailOpen ? '1' : '0'}
        >
          {/* 列表 */}
          <section>
            {loading ? (
              <p className="py-12 text-center text-[13px] text-neutral-400">正在读你的库…</p>
            ) : err ? null : list.length === 0 ? (
              <EmptyHint
                pad="lg"
                title="库里还没有提示词。"
                hint="右上角「＋ 新建提示词」手写一条，或者用「AI 生成」让它先起个稿。"
                action={
                  <button
                    onClick={openNew}
                    className="rounded-md bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-700"
                  >
                    ＋ 新建提示词
                  </button>
                }
              />
            ) : shown.length === 0 ? (
              <EmptyHint
                pad="lg"
                title="没有符合条件的。"
                hint="搜的是标题、正文和标签三处；左导航的分类与上面的筛选也会一起算。"
              />
            ) : view === 'card' ? (
              <CardView {...viewProps} />
            ) : view === 'grid' ? (
              <GridView {...viewProps} />
            ) : view === 'table' ? (
              <TableView {...viewProps} />
            ) : (
              <CategoryView
                {...viewProps}
                onOpenCategory={(name) => setNav(name)}
              />
            )}
          </section>

          {/* 详情 / 编辑 —— **只在真的有东西要看时才占那半屏** */}
          {detailOpen ? (
          <section className="space-y-3">
            {/* 历史 / 使用记录：**折叠区**（方案 §8.2 区1③），加在编辑器上面。
                原来它俩是整栏替换——点「看历史」编辑器就没了，看完想接着改还得再点一次。 */}
            <PromptHistoryPanel
              history={history}
              usages={usages}
              onRestore={(p, v) => void restore(p, v)}
              onCloseHistory={() => setHistory(null)}
              onCloseUsages={() => setUsages(null)}
            />
            {/* **有草稿就一定有编辑器**：折叠区是加在它上面的，不是替掉它的。
                两样都没有（没草稿、也没在看历史）时才是那句空态。 */}
            {draft ? (
              <PromptEditor
                draft={draft}
                setDraft={setDraft}
                dirty={dirty}
                cats={cats}
                busy={busy}
                aiPhase={aiPhase}
                aiErr={aiErr}
                onAiCancel={() => aiAbort.current?.abort()}
                refineAsk={refineAsk}
                setRefineAsk={setRefineAsk}
                onSave={() => void save()}
                onClose={() => {
                  if (confirmDiscard()) setDraft(null)
                }}
                onReset={() =>
                  openEditor(draftToItem(draft, list.find((p) => p.id === draft.id)))
                }
                onHistory={() => {
                  const p = list.find((x) => x.id === draft.id)
                  if (p) void openHistory(p)
                }}
                onUsages={() => {
                  const p = list.find((x) => x.id === draft.id)
                  if (p) void openUsages(p)
                }}
                onRefine={(ask) => void aiRefine(ask)}
                onVars={() => void aiVars()}
              />
            ) : history || usages ? null : (
              <EmptyHint
                pad="lg"
                title="选一条，或者新建一条。"
                hint="左边点一条就能看正文、改它、复制走。"
              />
            )}
          </section>
          ) : null}
        </div>
      </div>
      </div>

      {/* ---------- 区2 · 对打 ---------- */}
      {/* id 挂在这一块上，因为**这里才是它的落点**：五区锚点导航（`WorkPage` 的
          `PROMPT_SECTIONS`）里的 `prompt-duel` 指的就是它。原来那是 `WorkPage` 里一个
          **空 div**——点「对打」会滚到一个没有内容的锚点上，落到隔壁那一区。 */}
      <PromptDuel id="prompt-duel" prompts={list} />

      {catMgr ? (
        <PromptCategoryManager
          cats={cats}
          onClose={() => setCatMgr(false)}
          onCreate={(n, c) => void addCategory(n, c)}
          onRename={(c, n, col) => void renameCategory(c, n, col)}
          onDelete={(c) => void dropCategory(c)}
        />
      ) : null}
    </div>
  )
}

/** 把草稿拼成一份「像 PromptItem 的东西」——只为了走同一条复制路径（含变量面板）。 */
