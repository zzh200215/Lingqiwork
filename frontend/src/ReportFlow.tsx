/** 报告流程的小组件（2026-09-26 从 `ReportPage` 拆出，给它腾出 ≤1000 行的空间）。
 *
 *  - `StepHead`：生成面板里的**步骤分区头**。参考 SmartBrief 的三步向导
 *    （任务清单 → 项目配置 → 生成报告）：面板原来是一摞没分组的行，看不出
 *    「先定什么、再定什么」。行的顺序与方案 §8.1 线框一致，分区头只负责标顺序。
 *  - `DeliverSteps`：交付流的**分步可视**（方案 §二-2）。数字圆圈 + 连线的向导样式，
 *    给的是「整条流程走到哪了」；RunPanel 的状态行说的是细节（找到几个来源、
 *    写到第几节）。阶段是状态、格子是表达，锚点钉在 `data-deliver-steps` 的
 *    **值**上，不钉中文。
 *  - `ReportPreview`：**成品预览卡**——正文 + 引用栏 + 文风扫描折叠条。
 *    生成面板里的那张「纸」。
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { api } from './api'
import FeedbackButtons from './FeedbackButtons'
import { Markdown, reportMarkdown, SourceList } from './markdown'
import type { DeliverReport, ReportDraft } from './stream'
import { humanErr } from './workData'

/** 正文字数：非空白字符。与后端 `_chars_of` 同一条口径（读出来的正文在 `ReportPage`
 *  已经剥过 front-matter）——字数只有一份定义，阅读视图与成品预览都用这份。 */
export function countChars(md: string): number {
  return [...md].filter((c) => !/\s/.test(c)).length
}

/** 成品区操作按钮：常显淡色（同清单行的写法——hidden 的元素键盘够不着）。 */
const ROW_BTN_LIKE =
  'shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-[color,border-color,opacity] hover:border-violet-300 hover:text-violet-600 focus-visible:opacity-100 dark:border-neutral-700 dark:text-neutral-400'

/** 每页字数：GB/T 9704 版心每面 22 行 × 每行 28 字 ≈ 616 字。约页数按它折算，
 *  界面上「约」字写明是折算不是实测。 */
export const PAGE_CHARS = 616

export function pageOf(chars: number): number {
  return Math.max(1, Math.ceil(chars / PAGE_CHARS))
}

/** 生成面板里的步骤分区头：数字 + 标题 + 提示 + 一条走到卡片边的细线。
 *  配色跟着**深色玻璃面板**走（它是唯一的使用处）：teal 玻璃数字圈、浅字、白 10% 细线。 */
export function StepHead({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-teal-400/40 bg-teal-500/15 text-xs font-medium text-teal-300"
      >
        {n}
      </span>
      <span className="text-xs font-semibold text-neutral-200">{title}</span>
      {hint ? <span className="min-w-0 truncate text-xs text-neutral-400">{hint}</span> : null}
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-white/10" />
    </div>
  )
}

const STEPS = [
  { key: 'gather', label: '取材' },
  { key: 'write', label: '写作' },
  { key: 'done', label: '完成' },
] as const

export default function DeliverSteps({ step }: { step: 'gather' | 'write' | 'done' }) {
  const idx = STEPS.findIndex((s) => s.key === step)
  return (
    <ol data-deliver-steps={step} className="flex items-center gap-2 pb-1.5">
      {STEPS.map((s, i) => {
        const state = i < idx ? 'done' : i === idx ? 'now' : 'todo'
        return (
          <li key={s.key} className="flex items-center gap-2">
            {i > 0 ? (
              <span aria-hidden="true" className="h-px w-8 bg-neutral-200 dark:bg-neutral-700" />
            ) : null}
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-medium ${
                  state === 'done'
                    ? 'bg-emerald-500 text-white'
                    : state === 'now'
                      ? 'bg-sky-500 text-white wb-node-running'
                      : 'border border-neutral-300 text-neutral-400 dark:border-neutral-600'
                }`}
              >
                {state === 'done' ? '✓' : i + 1}
              </span>
              <span
                className={`text-xs ${
                  state === 'now'
                    ? 'font-medium text-sky-700 dark:text-sky-300'
                    : state === 'done'
                      ? 'text-neutral-500 dark:text-neutral-400'
                      : 'text-neutral-400'
                }`}
              >
                {s.label}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** 成品预览卡：正文 + 引用栏 + 文风扫描折叠条。
 *
 *  文风扫描（后端 `prose_lint`，只报告不改写）：AI 腔/旁白/占位符的成稿检查。
 *  判定给人——折起来是事实，摊开是原句与建议。没扫成不摆（`undefined` ≠ 0），
 *  扫出 0 处也照实说「未扫出风险」——那是一次真跑完的 0。 */
export function ReportPreview({
  report,
  draft,
}: {
  report: DeliverReport | null
  draft: ReportDraft | null
}) {
  return (
    <div className="rounded-lg border border-teal-200/70 bg-white p-3 dark:border-teal-500/20 dark:bg-neutral-900/60">
      <Markdown sources={report?.sources}>{reportMarkdown(report ?? draft!)}</Markdown>
      {/* 字数与约页数（参考 AI-Report 完成态的字数条）：一行小事实，写在引用栏上方。
          draft 流式期间不算——半截的字数没有意义。 */}
      {report ? (
        <p data-report-stats className="text-xs tabular-nums text-neutral-400">
          {countChars(reportMarkdown(report)).toLocaleString()} 字 · 约{' '}
          {pageOf(countChars(reportMarkdown(report)))} 页
        </p>
      ) : null}
      {report ? (
        <SourceList
          sources={report.sources}
          used={report.used}
          className="border-teal-200/70 dark:border-teal-500/20"
        />
      ) : null}
      {report?.lint ? (
        <details
          data-report-lint
          className="mt-2 border-t border-neutral-100 pt-2 dark:border-neutral-800/70"
        >
          <summary className="cursor-pointer text-xs text-neutral-400">
            文风扫描 ·{' '}
            {report.lint.count > 0 ? `${report.lint.count} 处建议核对` : '未扫出风险'}
          </summary>
          {report.lint.count > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {report.lint.items.map((it, i) => (
                <li
                  key={i}
                  className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400"
                >
                  <span className="text-neutral-400">{it.label}</span>
                  <span className="mx-1 text-neutral-300 dark:text-neutral-600">·</span>
                  {it.excerpt}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
    </div>
  )
}


/** 「导出 docx」：GB/T 9704 公文版式（构建器在后端 `official_docx.py`）。
 *
 *  红头单位名**当场问一次**（内联一行输入，回车即导出），存 localStorage 下次自动带出；
 *  留空 = 不加红头——后端不替用户编造机关名。`path` 给了就读 vault 里那份（阅读视图），
 *  否则把 `title+sections` 直接送去（生成屏上还没存的那份）。 */
const DOCX_BTN =
  'shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 transition-[color,border-color] hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400'

export function DocxExportButton({
  path,
  title,
  sections,
  onError,
}: {
  path?: string
  title: string
  sections?: { heading: string; body: string }[]
  onError: (m: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [org, setOrg] = useState('')
  const [busy, setBusy] = useState(false)

  const doExport = async () => {
    setBusy(true)
    try {
      const orgTrimmed = org.trim()
      try {
        localStorage.setItem('wb-docx-org', orgTrimmed)
      } catch {
        // localStorage 存不了（隐私模式）就不记住——导出本身照常，不值得报错
      }
      await api.exportWorkDocx(
        path?.trim() ? { path: path.trim(), org: orgTrimmed } : { title, sections, org: orgTrimmed },
        `${title}.docx`,
      )
      setOpen(false)
    } catch (e) {
      onError(`docx 没导出来：${humanErr(e)}`)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => {
          try {
            setOrg(localStorage.getItem('wb-docx-org') ?? '')
          } catch {
            /* 读不到就空着 */
          }
          setOpen(true)
        }}
        title="按 GB/T 9704 公文版式导出 Word"
        className={DOCX_BTN}
      >
        导出 docx
      </button>
    )
  }
  return (
    <span data-docx-export className="flex flex-wrap items-center gap-1.5">
      <input
        autoFocus
        value={org}
        onChange={(e) => setOrg(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void doExport()
        }}
        placeholder="红头单位（留空 = 不加红头）"
        title="发文机关标志；记住一次，下次自动带出"
        className="w-52 rounded-lg border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 outline-none placeholder:text-neutral-400 focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
      />
      <button
        onClick={() => void doExport()}
        disabled={busy}
        className="shrink-0 rounded-full border border-teal-300 px-2.5 py-1 text-xs text-teal-700 transition-colors hover:bg-teal-50 disabled:opacity-40 dark:border-teal-600 dark:text-teal-300 dark:hover:bg-teal-500/10"
      >
        {busy ? '出稿…' : '导出'}
      </button>
      <button onClick={() => setOpen(false)} className={DOCX_BTN}>
        取消
      </button>
    </span>
  )
}


/** 成品区的操作行 + 「带要求重写」的输入行（2026-09-26 从 `ReportPage` 拆出）。
 *
 *  按钮从左到右是一条动作链：存档 → 复制/导出 → 带要求重写 → 回执（已写好《×》）
 *  → 反馈。重写的一句话要求**随组件**输入与收起；真正执行在页面（`onRewrite`），
 *  因为 `extraRef` 要给 `run` 和「重试」读——输入是表达，执行是状态，两边分开。 */
export function ReportActions({
  report,
  saved,
  busy,
  copied,
  onSave,
  onCopy,
  onExport,
  onRewrite,
  onError,
  injected,
}: {
  report: DeliverReport
  saved: string
  busy: boolean
  copied: boolean
  onSave: () => void
  onCopy: (md: string) => void
  onExport: (title: string, path: string, md: string) => void
  /** 带一句话要求重写这一份。空串不会来（按钮空着禁用）。 */
  onRewrite: (extra: string) => void
  onError: (m: string) => void
  /** 这次生成注入的技能名——反馈按它记账（质量闭环要知道当时吃到了什么）。 */
  injected: string[]
}) {
  const [rewriteOpen, setRewriteOpen] = useState(false)
  const [extraInput, setExtraInput] = useState('')

  const doRewrite = () => {
    const text = extraInput.trim()
    if (!text) return
    setRewriteOpen(false)
    onRewrite(text)
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onSave}
          disabled={busy || !!saved}
          className="rounded-full border border-teal-300 px-2.5 py-0.5 text-xs text-teal-700 transition-colors hover:bg-teal-100 disabled:opacity-40 dark:border-teal-600 dark:text-teal-300 dark:hover:bg-teal-500/20"
        >
          {saved ? '已存进 vault' : busy ? '保存中…' : '存进 vault'}
        </button>
        <button onClick={() => onCopy(reportMarkdown(report))} className={ROW_BTN_LIKE}>
          {copied ? '已复制' : '复制全文'}
        </button>
        <button
          onClick={() => onExport(report.title, saved, reportMarkdown(report))}
          className={ROW_BTN_LIKE}
        >
          导出 md
        </button>
        <DocxExportButton title={report.title} sections={report.sections} onError={onError} />
        <button
          onClick={() => setRewriteOpen((v) => !v)}
          title="带一句话要求重写这一份——同题目同材料，只是换要求"
          className={ROW_BTN_LIKE}
        >
          带要求重写
        </button>
        {saved ? (
          <Link
            to={`/notes?path=${encodeURIComponent(saved)}`}
            className="inline-flex items-center gap-1 rounded-full border border-emerald-300 px-2 py-0.5 text-xs text-emerald-700 transition-colors hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
          >
            已写好《{report.title}》· 查看
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
      {/* 带要求重写：一句话要求当场给，重写走同一次运行的口径（同题目/同材料/同提纲），
          extra 不进 prompt_sha 的基准串。 */}
      {rewriteOpen ? (
        <div data-report-rewrite className="flex flex-wrap items-center gap-1.5">
          <input
            autoFocus
            value={extraInput}
            onChange={(e) => setExtraInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && extraInput.trim() && !busy) doRewrite()
            }}
            placeholder="例：重点写技术方案；增加风险分析"
            className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 outline-none placeholder:text-neutral-400 focus:border-teal-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          />
          <button
            onClick={doRewrite}
            disabled={busy || !extraInput.trim()}
            className="shrink-0 rounded-full bg-teal-600 px-3 py-1 text-xs text-white transition-colors hover:bg-teal-700 disabled:opacity-40"
          >
            重写
          </button>
          <button onClick={() => setRewriteOpen(false)} className={ROW_BTN_LIKE}>
            取消
          </button>
        </div>
      ) : null}
    </div>
  )
}
