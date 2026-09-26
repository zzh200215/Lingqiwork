/** 成文渲染：markdown 渲染器 + 「报告形状 → markdown」+ 引用回填。
 *
 *  教学页的成文卡、今日页、工作页三处共用同一份——此前 `Markdown` 在前两处逐字节重复。
 *  收在一处还有一个理由：正文里的 `[n]` 引用回填是跨全部引擎的改动，只改这里就够。
 */
import { useMemo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import CodeBlock from './CodeBlock'

/** 一条成文的来源。四个引擎的 `sources` 事件都是这个形状（`n` 就是正文里的 `[n]`）。 */
export interface CiteSource {
  n: number
  kind: string
  title: string
  ref: string
}

/** 这个来源点开往哪去；够不着就返回 null——**不假装能点**。
 *
 *  vault 相对路径交给笔记页（它的 root 就是 vault）；网络来源直接外链；
 *  `repos/` `dirs/` 这些块住在 vault 之外（`indexer.EXTERNAL_PREFIXES`），记忆与日记
 *  没有单一落点（ref 为空）——几类都够不着，只能看标题。
 */
export function sourceHref(ref: string): string | null {
  const r = (ref || '').trim()
  if (!r) return null
  if (/^https?:\/\//i.test(r)) return r
  if (r.startsWith('repos/') || r.startsWith('dirs/')) return null
  if (r.startsWith('/') || r.includes('..')) return null // 别把可疑路径塞进地址栏
  return `/notes?path=${encodeURIComponent(r)}`
}

function sourceIcon(kind: string): string {
  if (kind === 'kb') return '📄'
  if (kind === 'memory') return '🧠'
  if (kind === 'journal') return '📓'
  return '🌐'
}

function sourceTip(s: CiteSource): string {
  const where = s.ref ? ` — ${s.ref}` : ''
  return `来源 ${s.n}：${s.title || s.ref || s.kind}${where}`
}

/** 正文里的 `[n]` → sentinel 链接，交给下面的 `a` 渲染器接管。
 *  **代码围栏里的 `[n]` 不动**——那是代码，不是引用。
 *  哨兵用 `#wb-cite-n`（一个 fragment）而不是自定义协议：react-markdown 默认的
 *  `urlTransform` 会把不认识的协议清成空串，fragment 不在其列。 */
const CITE = /\[(\d+)\](?!\()/g

export function linkCitations(md: string): string {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 ? part : part.replace(CITE, '[\\[$1\\]](#wb-cite-$1)')))
    .join('')
}

/** `[n]` 角标：够得着的渲染成链接、够不着的只是带说明的角标。 */
function Citation({ n, sources }: { n: number; sources: Map<number, CiteSource> }) {
  const s = sources.get(n)
  const href = s ? sourceHref(s.ref) : null
  const cls = `align-super rounded px-0.5 text-xs no-underline ${
    href
      ? 'text-violet-600 hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-500/20'
      : 'text-neutral-400'
  }`
  const title = s ? sourceTip(s) : `来源 ${n}（这一次的材料里没有这一条）`
  const label = `[${n}]`
  // 新标签页而不是就地跳转：报告是流式产物，状态在页面组件里，跳走就没了。
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" title={title} className={cls}>
      {label}
    </a>
  ) : (
    <span title={title} className={cls}>
      {label}
    </span>
  )
}

export function Markdown({
  children,
  sources,
  withAnchors = false,
}: {
  children: string
  /** 给了就把正文里的 `[n]` 变成可点回来源的角标；不给则与从前逐字节一致。 */
  sources?: CiteSource[]
  /** 给标题挂锚点 id（阅读视图的大纲导航要用）。
   *
   *  **默认关**：这个组件在今日页、教学页、学页回执等五处共用，
   *  给它们悄悄加上 id 是「一处改、五处跟着变」——而只有阅读视图需要它。 */
  withAnchors?: boolean
}) {
  const byN = useMemo(() => new Map((sources ?? []).map((s) => [s.n, s])), [sources])
  const components = useMemo(() => {
    const base: Components = { pre: CodeBlock }
    if (withAnchors) Object.assign(base, headingComponents())
    if (!byN.size) return base
    return {
      ...base,
      a: ({ href, children }: { href?: string; children?: ReactNode }) => {
        const m = /^#wb-cite-(\d+)$/.exec(href ?? '')
        if (!m) {
          // 正文里真正的链接：外链开新页，别把正在读的东西顶掉
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }
        return <Citation n={Number(m[1])} sources={byN} />
      },
    }
  }, [byN, withAnchors])

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
      >
        {byN.size ? linkCitations(children) : children}
      </ReactMarkdown>
    </div>
  )
}

/** 把标题文本变成一个能当 `id` 的锚点串。
 *
 *  **阅读视图的「大纲导航」需要它**（方案 §8.1）：左栏点一节要跳到正文那一节，
 *  而 `react-markdown` 默认不给标题 `id`。中文标题没法像英文那样转成短横线串
 *  （`### 本周进展` → `id="本周进展"` 就挺好），所以只做「去空白、去标点」这一步。
 *
 *  **同一份文档里重名标题会撞 id**——这是可接受的：撞了就跳到第一个，
 *  比为了唯一性给标题编号（`本周进展-2`）更难认。 */
export function slug(title: string): string {
  return title
    .trim()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .slice(0, 80)
}

/** 从成文里抽出大纲（章节 → 锚点），给阅读视图左栏用。
 *
 *  只认 `##` 与 `###`：`reportMarkdown` 就是这么生成的（`## 标题` + 每条 `### 小节`）。 */
export function outlineOf(md: string): { level: number; text: string; id: string }[] {
  const out: { level: number; text: string; id: string }[] = []
  for (const line of md.split('\n')) {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const text = m[2]
    out.push({ level: m[1].length, text, id: slug(text) })
  }
  return out
}

/** 阅读视图的标题组件：把 `## / ###` 挂上锚点 id，左栏的大纲才跳得动。
 *
 *  和 `outlineOf` 用**同一个** `slug()`——两处各算一份的那天，点了没反应还没人报错。 */
export function headingComponents(): Components {
  const H = (Tag: 'h2' | 'h3') =>
    function Heading({ children }: { children?: ReactNode }) {
      const text = flatten(children)
      return <Tag id={slug(text)}>{children}</Tag>
    }
  return { h2: H('h2'), h3: H('h3') }
}

/** 把 React 子节点压成纯文本——标题里常带 `**粗体**` 或 `` `代码` ``，
 *  锚点要按**文字**算，不能按节点树算。 */
function flatten(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join('')
  if (typeof node === 'object' && 'props' in node) {
    return flatten((node as { props?: { children?: ReactNode } }).props?.children)
  }
  return ''
}

/** 成文（研究 / 方案 / 对质 / 交付同一形状）→ markdown。正文里的 [n] 由 `Markdown` 接管。 */
export function reportMarkdown(r: {
  title: string
  sections: { heading: string; body: string }[]
}): string {
  return (
    `## ${r.title}\n\n` +
    r.sections.map((s) => (s.heading ? `### ${s.heading}\n\n${s.body}` : s.body)).join('\n\n')
  )
}

/** 来源清单（成文卡片底部那个折叠区）。四个引擎此前各写了一遍，收成一份。 */
export function SourceList({
  sources,
  used,
  summary,
  className = '',
}: {
  sources: CiteSource[]
  /** 正文里真正引到的编号——它们加粗，其余灰显 */
  used?: number[]
  summary?: ReactNode
  /** 上边框的配色跟着卡片走 */
  className?: string
}) {
  if (!sources.length) return null
  const marked = new Set(used ?? [])
  return (
    <details className={`mt-2 border-t pt-2 ${className}`}>
      <summary className="cursor-pointer text-xs text-neutral-500">
        {summary ?? `来源 ${sources.length} 条`}
      </summary>
      <ul className="mt-1 space-y-0.5">
        {sources.map((s) => {
          const href = sourceHref(s.ref)
          const body = (
            <>
              <span
                className={
                  marked.has(s.n)
                    ? 'font-medium text-neutral-800 dark:text-neutral-100'
                    : 'text-neutral-500 dark:text-neutral-400'
                }
              >
                [{s.n}] {sourceIcon(s.kind)} {s.title || s.ref || s.kind}
              </span>
              {s.ref ? <span className="text-neutral-400"> — {s.ref}</span> : null}
            </>
          )
          return (
            <li key={s.n} className="text-xs leading-relaxed">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  title={sourceTip(s)}
                  className="hover:underline"
                >
                  {body}
                </a>
              ) : (
                <span title={s.ref ? `${sourceTip(s)}（在 vault 之外，打不开）` : sourceTip(s)}>
                  {body}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </details>
  )
}
