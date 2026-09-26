/** 提示词库的**四种视图**（对齐 AI Gist：卡片 / 网格 / 表格 / 文件夹）。
 *
 *  为什么要四种而不是一种：它们回答的是**四个不同的问题**——
 *  - **卡片**：「这条写了什么」——正文摘要占地方，适合挑一条来用；
 *  - **网格**：「我一共有哪些」——一屏扫得完，适合东西多起来之后认脸；
 *  - **表格**：「各自什么状态」——分类/标签/评分/用过几次并排，适合盘点；
 *  - **文件夹**：「这一类里有什么」——按分类收，适合按主题找。
 *
 *  四种共用同一个 `PromptActions`，所以「点开、复制、收藏、看历史、删」在哪一屏都是同一套行为，
 *  不会出现「表格视图里不能复制」这种分叉。
 */
import {
  Copy,
  FolderClosed,
  Grid3x3,
  LayoutGrid,
  Pencil,
  Star,
  Table2,
  Trash,
  type LucideIcon,
} from 'lucide-react'

import { varsIn } from './promptDraft'
import type { PromptItem } from './api'

/** 四种视图的键。定义在 `api.ts` 里（那边是「契约」），这里只是再导出一次方便用。 */
export type PromptViewKey = 'card' | 'grid' | 'table' | 'category'

/** 每条要用到的那几个动作。**一处定义，四个视图共用。** */
export type PromptActions = {
  activeId: number | null
  onOpen: (p: PromptItem) => void
  onCopy: (p: PromptItem) => void
  onRemove: (p: PromptItem) => void
  onHistory: (p: PromptItem) => void
  onUsage: (p: PromptItem) => void
  onFavorite: (p: PromptItem) => void
}

/** 未分类那一组。空分类不是「没有」，是「还没归」——界面要说得出这个区别。 */
export const UNCATEGORIZED = '未分类'

/** 分类的默认色板。与 AI Gist 一样按分类着色——**颜色是认脸用的，不是装饰**。 */
const PALETTE = [
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#10b981',
  '#f59e0b',
  '#06b6d4',
  '#ef4444',
  '#84cc16',
]

/** 分类的颜色：挑过就用挑的，没挑过按**名字**派一个稳定的（同一个名字永远同一个色）。
 *
 *  为什么不随机：随机会让同一个分类每次刷新换个颜色——那比没颜色更糟，
 *  因为它把「认脸」这件事变成了「重新认一遍」。 */
export function catColor(name: string, given?: string): string {
  if (given) return given
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export function star(n: number): string {
  return n > 0 ? '★'.repeat(n) + '☆'.repeat(5 - n) : ''
}

// ---------- 小标的配色 ----------
//
// **颜色是认脸用的，不是装饰。** 参考项目里标签就是一屏五颜六色的：一屏几十个标签
// 灰成一片，你只能逐个读字；给了色，扫一眼就知道「那条带红的在哪儿」。
//
// 两边各有一套，是**有意不一样**的，正好用来一眼分清「分类」和「标签」：
//  - **分类**：用存下来的那个色（可挑），染成**实心圆点 + 同色淡底**——它是一等对象；
//  - **标签**：色按**名字**派生（同一个标签永远同一个色），染成**整块淡底**。

/** 标签色板。**写成完整的类名字面量**——Tailwind 靠扫源码生成类，
 *  拼出来的字符串它看不见（`bg-${c}-100` 那种写法一个类都生不出来）。 */
const TAG_TONES = [
  'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300',
  'bg-lime-100 text-lime-700 dark:bg-lime-500/15 dark:text-lime-300',
]

/** 标签的色：按**名字**派，稳定——同一个标签永远是同一个色。
 *
 *  为什么按名字而不是按顺序：按顺序的话，删掉一个标签会让后面所有标签**集体换色**，
 *  那比没颜色更糟——它把「认脸」变成了「重新认一遍」。 */
export function tagTone(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return TAG_TONES[h % TAG_TONES.length]
}

/** 分类小标：**实心圆点 + 同色淡底**（分类是一等对象，用存下来的那个色）。 */
export function CategoryChip({ name, color }: { name: string; color?: string }) {
  const hex = catColor(name, color)
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[13px] font-medium"
      // 底色是同色的淡版（`22` ≈ 13% 不透明度）。用内联样式是因为**色是数据**
      // （后端存了 `#rrggbb`），Tailwind 的动态类名生不出来。
      style={{ backgroundColor: `${hex}22`, color: hex }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: hex }} />
      {name}
    </span>
  )
}

/** 标签小标：**整块淡底 + 同色文字**，色由名字派生。 */
function TagChip({ name }: { name: string }) {
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[13px] ${tagTone(name)}`}>#{name}</span>
  )
}

/** 标签多了会撑破版面。**溢出的收成「+N」**——收起来的那几个在详情里看得到。 */
function Tags({ tags, max = 2 }: { tags: string[]; max?: number }) {
  const shown = tags.slice(0, max)
  const rest = tags.length - shown.length
  return (
    <>
      {shown.map((t) => (
        <TagChip key={t} name={t} />
      ))}
      {rest > 0 ? <span className="text-xs text-neutral-400">+{rest}</span> : null}
    </>
  )
}

/** 键盘焦点环。契约的必查项里有 "focus" 这一态，而本仓**一处都没写过** `focus-visible`
 *  ——只用鼠标的人看不见差别，但用 Tab 走一遍就会发现整页没有落点。
 *  颜色用主色：契约里 "focus" 正是允许用主色的四件事之一（主操作 / 焦点 / 链接 / 真状态）。 */
const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-neutral-900'

/** 卡片 / 网格里那排**图标动作**（AI Gist 的做法：图标 + ⋮ 菜单，而不是一排文字按钮）。
 *
 *  图标**不跟标题抢宽度**：标题 `truncate` 占满，图标钉在右上角一行——
 *  否则四个图标会把标题挤成两行（截图里「项目BUG / 排查」就是这么断的）。
 *
 *  用 `lucide` 而不是 `⧉ ★ ✏ 🗑` 这类符号字符：**本仓全站的图标就是 lucide**
 *  （侧栏、`PageShell`、各页都走它）。混一套文字符号进来，字体一换就变形，
 *  尺寸也和旁边的图标对不齐。 */
/* **本文件里的卡片刻意不套 `wb-card`**（四处：卡片 / 网格 / 表格 / 文件夹）。
 *  它们的底色会随「选中」变（`bg-neutral-50` / `dark:bg-neutral-800/60`），
 *  而 `.wb-card` 定义在 `@tailwind utilities` **之后**（`index.css`）——同权重的
 *  工具类压不过它，套上去选中态就没底色了。方案 §8.2 区1 对这块的原话是
 *  「现有 PromptLibrary 原样保留，**标杆不动**」，所以保持原样；别「统一」成 `wb-card`。 */
/** 「有变量」= 这个动作是**填值使用**（弹表单填了再复制）；没有就是**复制**。
 *
 *  方案 §8.2 区1② 把那个动作叫「填值使用」——它确实不是同一个动作：
 *  一条带 `{变量}` 的提示词直接复制走，粘出去还是带花括号的；先填空再复制才用得了。
 *  所以标签跟着**这条有没有变量**走，而不是写死一个。 */
function copyLabel(p: PromptItem): string {
  return varsIn(p.content).length ? '填值使用' : '复制'
}

function IconActions({ p, a }: { p: PromptItem; a: PromptActions }) {
  const icon = `rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200 ${FOCUS}`
  const label = copyLabel(p)
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        onClick={() => a.onCopy(p)}
        className={icon}
        title={label}
        aria-label={`${label} ${p.title}`}
      >
        <Copy className="h-4 w-4" />
      </button>
      <button
        onClick={() => a.onFavorite(p)}
        className={p.favorite ? 'rounded-md p-1 text-amber-500' : icon}
        title={p.favorite ? '取消收藏' : '收藏'}
        aria-label={`${p.favorite ? '取消收藏' : '收藏'} ${p.title}`}
        aria-pressed={p.favorite}
      >
        <Star className="h-4 w-4" fill={p.favorite ? 'currentColor' : 'none'} />
      </button>
      <button onClick={() => a.onOpen(p)} className={icon} title="编辑" aria-label={`编辑 ${p.title}`}>
        <Pencil className="h-4 w-4" />
      </button>
      {/* 破坏性操作走**错误色**（契约："Destructive actions use type=error"），
          而不是 hover 才变红的普通按钮——变了色只是 hover 反馈，不是身份。 */}
      <button
        onClick={() => a.onRemove(p)}
        className={`rounded-md p-1 text-rose-500 transition-colors hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-500/10 dark:hover:text-rose-300 ${FOCUS}`}
        title="删除"
        aria-label={`删除 ${p.title}`}
      >
        <Trash className="h-4 w-4" />
      </button>
    </div>
  )
}

// ---------- 卡片视图 ----------

export function CardView({
  items,
  a,
  colorOf,
  wide = false,
}: {
  items: PromptItem[]
  a: PromptActions
  colorOf: (name: string) => string | undefined
  /** 右侧详情没开时列表是整宽的——那时才排得下更多列。
   *  **窄容器里硬排三列，卡片会被压成一条**（截图里就是这么断的行）。 */
  wide?: boolean
}) {
  // 分栏时（右侧在看某一条）左栏只占四成宽，**排两列会把卡片压成条**——
  // 降成单列，它就退化成一份「可切换的清单」，那正是这个场景要的东西。
  const cols = wide ? 'sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4' : 'grid-cols-1'
  return (
    <ul className={`grid gap-3 ${cols}`} data-prompt-list>
      {items.map((p) => (
        <li key={p.id}>
          <div
            className={`rounded-lg border border-neutral-200 bg-white transition-colors dark:border-neutral-800 dark:bg-neutral-900 flex h-full flex-col p-3 ${a.activeId === p.id ? 'bg-neutral-50 dark:bg-neutral-800/60' : ''}`}
            data-prompt={p.id}
          >
            {/* 标题一行截断、图标钉在右边：**图标不跟标题抢宽度**，
                否则四个图标会把标题挤成两行（「项目BUG / 排查」就是这么断的）。 */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => a.onOpen(p)}
                className="min-w-0 flex-1 truncate text-left text-sm font-medium text-neutral-800 dark:text-neutral-100"
                title={p.title}
              >
                {p.title}
              </button>
              <IconActions p={p} a={a} />
            </div>

            {/* 正文**不能放进 `<button>` 里**：Chrome 把按钮内容包进一个匿名 flex 容器，
                `<p>` 于是成了 flex item，`display:-webkit-box` 被 blockify 成 `block`，
                `line-clamp` 当场失效——而且正文还会被按钮默认**垂直居中**到卡片中间。
                所以这里用一层普通 div 承接点击，`<p>` 是它的普通块级子元素。 */}
            <div onClick={() => a.onOpen(p)} className="flex-1 cursor-pointer">
              <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                {p.content}
              </p>
            </div>

            {/* `mt-auto`：这行**钉在卡片底**，几张卡片才等高、底边才齐 */}
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
              {p.category ? <CategoryChip name={p.category} color={colorOf(p.category)} /> : null}
              <Tags tags={p.tags} />
              {p.rating ? <span className="text-xs text-amber-500">{star(p.rating)}</span> : null}
              {p.used_count ? (
                <span className="text-xs text-neutral-400">用过 {p.used_count}</span>
              ) : null}
              <span className="ml-auto shrink-0 text-xs text-neutral-400">
                {(p.updated_at || p.created_at).slice(0, 10).replace(/-/g, '/')}
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

// ---------- 网格视图（一屏扫得完）----------

export function GridView({
  items,
  a,
  colorOf,
  wide = false,
}: {
  items: PromptItem[]
  a: PromptActions
  colorOf: (name: string) => string | undefined
  wide?: boolean
}) {
  const cols = wide ? 'sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6' : 'grid-cols-2 sm:grid-cols-3'
  return (
    <ul className={`grid gap-2 ${cols}`} data-prompt-grid>
      {items.map((p) => (
        <li key={p.id}>
          <div
            className={`rounded-lg border border-neutral-200 bg-white transition-colors dark:border-neutral-800 dark:bg-neutral-900 flex h-full flex-col gap-1 p-2.5 ${a.activeId === p.id ? 'bg-neutral-50 dark:bg-neutral-800/60' : ''}`}
            data-prompt={p.id}
          >
            <div className="flex items-start justify-between gap-1">
              {/* 同 CardView：`line-clamp` **不能放在 `<button>` 里**（会被 blockify 掉）。
                  这里标题短、本来就只有一两行，用 `truncate` 就够，不需要 clamp。 */}
              <button
                onClick={() => a.onOpen(p)}
                className="min-w-0 flex-1 truncate text-left text-xs font-medium text-neutral-800 dark:text-neutral-100"
                title={p.title}
              >
                {p.title}
              </button>
              {p.favorite ? (
                <Star className="h-3 w-3 shrink-0 text-amber-500" fill="currentColor" />
              ) : null}
              <button
                onClick={() => a.onCopy(p)}
                className="shrink-0 rounded-md p-0.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-violet-600 dark:hover:bg-neutral-800"
                title={copyLabel(p)}
                aria-label={`${copyLabel(p)} ${p.title}`}
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {p.category ? <CategoryChip name={p.category} color={colorOf(p.category)} /> : null}
              <Tags tags={p.tags} max={1} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

// ---------- 表格视图 ----------

export function TableView({
  items,
  a,
  colorOf,
}: {
  items: PromptItem[]
  a: PromptActions
  colorOf: (name: string) => string | undefined
}) {
  // 表头用次级表面、表体用主表面（契约：tables use a secondary-color header）
  const th = 'py-1.5 pr-3 text-left font-normal text-sm text-neutral-500 dark:text-neutral-400'
  return (
    <div className="rounded-lg border border-neutral-200 bg-white transition-colors dark:border-neutral-800 dark:bg-neutral-900 overflow-x-auto p-0" data-prompt-table>
      <table className="w-full text-left text-sm">
        <thead className="bg-neutral-50 dark:bg-neutral-800/50">
          <tr className="border-b border-neutral-200 dark:border-neutral-800">
            <th className={th}>提示词</th>
            <th className={th}>分类</th>
            <th className={th}>标签</th>
            <th className={th}>评分</th>
            <th className={th}>用过</th>
            <th className={th}>更新</th>
            <th className={th}> </th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr
              key={p.id}
              onClick={() => a.onOpen(p)}
              className={`cursor-pointer border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-800/70 dark:hover:bg-neutral-800/40 ${
                a.activeId === p.id ? 'bg-violet-50/60 dark:bg-violet-500/10' : ''
              }`}
              data-prompt={p.id}
            >
              <td className="max-w-[18rem] py-1.5 pr-3">
                <span className="block truncate font-medium text-neutral-800 dark:text-neutral-100">
                  {p.favorite ? '★ ' : ''}
                  {p.title}
                </span>
                <span className="block truncate text-[13px] text-neutral-400">{p.content}</span>
              </td>
              <td className="whitespace-nowrap py-1.5 pr-3">
                {p.category ? <CategoryChip name={p.category} color={colorOf(p.category)} /> : null}
              </td>
              <td className="py-1.5 pr-3">
                <span className="flex flex-wrap items-center gap-1">
                  <Tags tags={p.tags} max={2} />
                </span>
              </td>
              <td className="whitespace-nowrap py-1.5 pr-3 text-amber-500">{star(p.rating)}</td>
              <td className="py-1.5 pr-3 text-neutral-500 dark:text-neutral-400">{p.used_count}</td>
              <td className="whitespace-nowrap py-1.5 pr-3 text-sm text-neutral-400">
                {(p.updated_at || p.created_at).slice(0, 10).replace(/-/g, '/')}
              </td>
              <td className="py-1.5">
                <IconActions p={p} a={a} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------- 文件夹视图 ----------

/** 文件夹图标：一个带颜色的折角。用 SVG 而不是 emoji，是因为 emoji 上不了色。 */
function FolderIcon({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-9 w-9" fill="none" stroke={color} strokeWidth="1.6">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.6 2h9.4A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  )
}

export function CategoryView({
  items,
  colorOf,
  onOpenCategory,
}: {
  items: PromptItem[]
  colorOf: (name: string) => string | undefined
  /** 点文件夹 = 按这个分类筛。**不在这里就地展开**——AI Gist 就是这么走的：
   *  文件夹视图回答「我分了哪几类」，展开条目是列表那一屏的事。 */
  onOpenCategory: (name: string) => void
}) {
  const groups = new Map<string, PromptItem[]>()
  for (const p of items) {
    const k = p.category || UNCATEGORIZED
    const cur = groups.get(k)
    if (cur) cur.push(p)
    else groups.set(k, [p])
  }
  const named = [...groups.keys()].filter((k) => k !== UNCATEGORIZED).sort()
  const order = groups.has(UNCATEGORIZED) ? [...named, UNCATEGORIZED] : named

  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4" data-prompt-folders>
      {order.map((name) => {
        const rows = groups.get(name) ?? []
        return (
          <button
            key={name}
            onClick={() => onOpenCategory(name === UNCATEGORIZED ? '' : name)}
            className={`flex flex-col items-start gap-1 rounded-lg border border-neutral-200 bg-white p-4 text-left transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700 ${FOCUS}`}
          >
            <FolderIcon color={name === UNCATEGORIZED ? '#9ca3af' : catColor(name, colorOf(name))} />
            <span className="mt-1 text-sm font-medium text-neutral-800 dark:text-neutral-100">
              {name}
            </span>
            <span className="text-xs text-neutral-400">{rows.length} 个提示词</span>
            <span className="mt-1 flex flex-wrap items-center gap-1">
              <Tags tags={rows.flatMap((r) => r.tags)} max={2} />
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ---------- 视图切换 ----------

/** 四种视图。**用真图标而不是符号字符**：`▤ ⣿ ☰ 🗂` 在中文环境下分不清谁是谁
 *  （`⣿` 还常常渲染成一个怪方块）。 */
export const VIEWS: Array<{ key: PromptViewKey; label: string; icon: LucideIcon }> = [
  { key: 'card', label: '卡片', icon: LayoutGrid },
  { key: 'grid', label: '网格', icon: Grid3x3 },
  { key: 'table', label: '表格', icon: Table2 },
  { key: 'category', label: '文件夹', icon: FolderClosed },
]

export function PromptViewSwitch({
  view,
  onChange,
}: {
  view: PromptViewKey
  onChange: (v: PromptViewKey) => void
}) {
  return (
    <div
      className="flex shrink-0 overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-700"
      role="group"
      aria-label="视图"
    >
      {VIEWS.map((o) => {
        const Icon = o.icon
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            aria-pressed={view === o.key}
            aria-label={o.label}
            title={o.label}
            className={`px-2.5 py-2 transition-colors ${FOCUS} ${
              view === o.key
                ? 'bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-700 dark:text-neutral-50'
                : 'text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'
            }`}
          >
            <Icon className="h-4 w-4" />
          </button>
        )
      })}
    </div>
  )
}
