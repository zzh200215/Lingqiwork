/** 报告阅读视图（方案 §8.1）——「读一份自己刚写的东西」的那一屏。
 *
 *  ## 它为什么是独立文件
 *
 *  它是清单行的**下一跳**：进去一份已落盘的报告，出来「返回清单」一个动作。
 *  2026-09-26 前端打磨时拆出自成一份，`ReportPage` 才装得下清单与生成面板的
 *  新东西（工作模块单文件 ≤1000 行，方案 §十二）。
 *
 *  ## 三栏怎么分工
 *
 *  - **左栏大纲导航**：与正文同一份 slug（`outlineOf`）；带**滚动高亮**——
 *    IntersectionObserver 看正文标题走到视口「阅读带」时亮哪一节，
 *    长文里「我读到哪了」不用自己数。
 *  - **中栏正文**：读的是 vault 里那份文件本身（`readNote`），不是重新生成。
 *  - **右栏**：有引用表就摆引用表；没有就摆**这份文档自己的事实**（字数 / 约读）
 *    ——原来这一栏只有三行解释（「没带来源表」），现在解释还在，
 *    只是不再让整栏空着。
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type { WorkOutput } from './api'
import { countChars, DocxExportButton } from './ReportFlow'
import { Markdown, outlineOf, SourceList, type CiteSource } from './markdown'
import { KIND_BADGE } from './OutputCard'

/** 行内动作按钮：**常显淡色**，不是 hover 才出现（与清单行同一份写法）。
 *  （`display:none` 的元素不在 Tab 序列里——键盘用户完全够不着，那是 WCAG 2.1.1 的失败。） */
const ROW_BTN =
  'shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 opacity-60 transition-[color,border-color,opacity] hover:border-violet-300 hover:text-violet-600 hover:opacity-100 focus-visible:opacity-100 dark:border-neutral-700 dark:text-neutral-400'

export default function ReportReader({
  reading,
  readErr,
  copied,
  onClose,
  onCopy,
  onExport,
  onRewrite,
  onError,
}: {
  reading: { o: WorkOutput; md: string; sources: CiteSource[] }
  readErr: string
  /** 「已复制」的状态话归页面管——生成面板那份正文共用同一个复制出口。 */
  copied: boolean
  onClose: () => void
  onCopy: (md: string) => void
  onExport: (title: string, path: string, md: string) => void
  onRewrite: (o: WorkOutput) => void
  /** docx 导出失败时要说话的出口（页级错误条）。 */
  onError: (m: string) => void
}) {
  const outline = useMemo(() => outlineOf(reading.md), [reading.md])
  const [activeId, setActiveId] = useState('')

  // 滚动高亮：盯着正文里的每个标题锚点。视口顶部 80px（顶栏）以下、70% 以上的
  // 那一带算「阅读带」——一段正文进带时，亮的正是它上面**正在读的这一节**。
  // （jsdom 没有 IntersectionObserver——环境不给就不守，导航退化为纯锚点跳转。）
  useEffect(() => {
    if (!outline.length || typeof IntersectionObserver === 'undefined') return
    const els = outline
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => !!el)
    if (!els.length) return
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (seen.length) setActiveId(seen[0].target.id)
      },
      { rootMargin: '-80px 0px -70% 0px' }
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [outline])

  const chars = useMemo(() => (reading.md ? countChars(reading.md) : 0), [reading.md])
  const minutes = Math.max(1, Math.round(chars / 400))

  return (
    <section data-report-reader className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onClose}
          className="shrink-0 rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs text-neutral-600 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300"
        >
          ← 返回清单
        </button>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${KIND_BADGE[reading.o.kind]}`}>
          {reading.o.label}
        </span>
        <h2
          className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-800 dark:text-neutral-100"
          title={reading.o.title}
        >
          {reading.o.title}
        </h2>
        <button onClick={() => onCopy(reading.md)} className={ROW_BTN}>
          {copied ? '已复制' : '复制全文'}
        </button>
        <button onClick={() => onExport(reading.o.title, reading.o.path, reading.md)} className={ROW_BTN}>
          导出 md
        </button>
        <DocxExportButton path={reading.o.path} title={reading.o.title} onError={onError} />
        <button onClick={() => onRewrite(reading.o)} title="拿它当材料，换个体裁重写" className={ROW_BTN}>
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
          {/* 左栏：大纲导航。滚动到哪一节就亮哪一节；窄屏不占位（方案 §七）。 */}
          {outline.length > 1 ? (
            <nav className="hidden self-start xl:sticky xl:top-14 xl:block">
              <p className="pb-2 text-xs text-neutral-400">大纲</p>
              <ul className="space-y-1 border-l border-neutral-200 dark:border-neutral-800">
                {outline.map((h, i) => {
                  const active = h.id === activeId
                  return (
                    <li key={`${h.id}-${i}`}>
                      <a
                        href={`#${h.id}`}
                        onClick={() => setActiveId(h.id)}
                        aria-current={active || undefined}
                        title={h.text}
                        className={`block truncate border-l-2 pl-2 text-xs transition-colors hover:border-teal-400 hover:text-teal-700 dark:hover:text-teal-300 ${
                          active
                            ? 'border-teal-500 font-medium text-teal-700 dark:text-teal-300'
                            : 'border-transparent text-neutral-500 dark:text-neutral-400'
                        } ${h.level === 3 ? 'pl-4' : ''}`}
                      >
                        {h.text}
                      </a>
                    </li>
                  )
                })}
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

          {/* 右栏：引用来源。清单里那一份不带 sources（读的是 vault 里的文件本身），
              所以有引用表摆引用表；没有就把这一栏让给**这份文档的事实**——
              字数与约读。加载中（正文还没到）什么都不摆，别先报一个 0。 */}
          <aside className="hidden self-start xl:sticky xl:top-14 xl:block">
            <p className="pb-2 text-xs text-neutral-400">引用</p>
            {reading.sources.length ? (
              <SourceList sources={reading.sources} />
            ) : reading.md ? (
              <div className="space-y-3">
                <dl className="space-y-1.5 text-xs">
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-neutral-400">字数</dt>
                    <dd className="tabular-nums text-neutral-600 dark:text-neutral-300">
                      {chars.toLocaleString()}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-neutral-400">约读</dt>
                    <dd className="text-neutral-600 dark:text-neutral-300">{minutes} 分钟</dd>
                  </div>
                </dl>
                <p className="text-xs leading-relaxed text-neutral-400">
                  这一份是从 vault 里读出来的原文，没带来源表。
                  <br />
                  刚生成完那一屏里，正文的 <code className="text-neutral-500">[n]</code> 点得回原材料。
                </p>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </section>
  )
}
