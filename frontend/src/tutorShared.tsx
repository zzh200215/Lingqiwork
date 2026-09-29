// 对话式教学页的共享小件（方向 6 第六刀，2026-09-29 自 TutorPage 拆出）：
// 召回条/重复条/取材来源行/回执行/并概念面板/气泡/面试行/报告分组。
// 原来从 TutorPage 导出的名字经 TutorPage re-export，测试导入路径不变。
import { useState } from 'react'
import ArtifactReceipt from './ArtifactReceipt'
import OutputCard from './OutputCard'
import { SaveTextToVault } from './SaveToVault'
import { Markdown } from './markdown'
import { upsertArtifact } from './artifacts'
import {
  api,
  type InterviewReportResult,
  type InterviewReportSections,
  type TutorConceptRow,
  type TutorTurn,
} from './api'
import {
  type ArtifactRef,
  type TutorMaterialSource,
  type TutorRecallHit,
} from './stream'

export const VERDICTS = [
  { v: 'got' as const, label: '搞懂了', cls: 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-500/10' },
  { v: 'half' as const, label: '半懂', cls: 'border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-500/10' },
  { v: 'useless' as const, label: '没用', cls: 'border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-400 dark:hover:bg-neutral-800' },
]

export const VERDICT_LABEL: Record<string, string> = {
  got: '搞懂了',
  half: '半懂',
  useless: '没用',
}

// 会话里的讲法快捷指令（ChatGPT Study Mode 参考）：一键发指令，不用自己组织措辞。
// 最后一条是反转——让它考你，等你答了再评，不是直接讲。
export const QUICK_ASKS: [string, string][] = [
  ['更简单地讲', '我没完全跟上。用更简单、更基础的方式再讲一遍，少用术语。'],
  ['举个例子', '举一个具体的例子，最好是我熟悉领域里的。'],
  ['换个角度', '换个角度再讲一遍这个点。'],
  ['考我一题', '就这个话题考我一道题。先别给答案，等我答了你再点评。'],
]

/** 右栏「学到哪了」一屏列多少个概念；更多的靠会话历史翻（纯展示上限，不落库）。 */
export const CONCEPT_RAIL_CAP = 12

/** 「按点出卡」一次出几张。一个点的卡面要窄——3 张足够覆盖它，再多就是重复。 */
export const POINT_CARDS = 3

/** 按点出卡的请求体。**材料必须和当初拆点用的那份一模一样**：有来源文件就用文件，
 *  粘贴模式就用当初粘进去的那段（调用方一直存着它）。
 *
 *  **绝不能拿点标题当材料**：一个点是十几个字的一句话，而后端 `MIN_INPUT_CHARS = 80`
 *  会直接 400（"文本太短"）。这个坑是浏览器实测抓到的——单测覆盖不到前端这段。
 *  既然拆点本身走的就是同一个 80 字下限，能拆出点就说明这份材料一定够长。 */
export function pointCardBody(
  point: string,
  dg: { source: string } | null,
  pastedText: string
): { source_path: string; focus: string; count: number } | { text: string; focus: string; count: number } {
  const src = dg?.source || ''
  return src
    ? { source_path: src, focus: point, count: POINT_CARDS }
    : { text: pastedText, focus: point, count: POINT_CARDS }
}

/** The one thing that makes this more than a chat wrapper, so it is shown, not
 * hidden: 验收 asks whether recall fired AND whether it was right, and only the
 * user can judge the second half. */
export function RecallChip({ hits }: { hits: TutorRecallHit[] }) {
  if (hits.length === 0) return null // 自防护：空命中不该留下一个空壳标题
  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/60 p-3 text-sm dark:border-violet-500/30 dark:bg-violet-500/10">
      <p className="pb-1 text-xs font-medium uppercase tracking-wider text-violet-500 dark:text-violet-300">
        接上了以前的记录
      </p>
      {hits.map((h) => (
        <p key={h.concept + h.date} className="text-neutral-700 dark:text-neutral-300">
          ↳ <span className="font-medium">{h.concept}</span>（
          {h.verdict === 'half' ? '半懂' : '说通了'}，{h.date}）
          {h.stuck ? <span className="text-neutral-500">，当时卡在：{h.stuck}</span> : null}
        </p>
      ))}
    </div>
  )
}

/** 「又卡住」的标：概念行上一个琥珀色小 chip。传 `null` 就不画。
 *
 *  **它为什么在这里、而不是新开一栏**：这个信号本来就是「卡住」那一档里更窄的一批
 *  （接住过卡在哪、最近一次还是半懂、就在这几天），另起一栏等于把同一批概念摆两遍。
 *  判据在后端一处（`tutor.is_recurring_mistake`），也是零柒那句「又卡住了」的同一判据——
 *  界面上的标与它嘴里的话因此**永远是同一批**。
 *
 *  title 里写的是事实（接住过几次），不是「你还欠几次」：这是标记，不是待办。 */
export function RepeatChip({ c }: { c: TutorConceptRow | null }) {
  if (!c) return null
  return (
    <span
      data-concept-repeat={c.concept}
      title={`接住过你卡在哪 ${c.recalled} 次，最近一次还是半懂——零柒那句「又卡住了」说的就是这一批`}
      className="shrink-0 rounded-full bg-amber-50 px-1.5 text-xs text-amber-600 dark:bg-amber-500/10 dark:text-amber-300"
    >
      又卡住
    </span>
  )
}

/** 报告的三栏（空的整栏不摆）。抽成纯函数是为了让 JSX 里那层索引别再猜类型。 */
export function reportGroups(
  s: InterviewReportSections
): { label: string; items: string[]; teachable: boolean }[] {
  return [
    { label: '答得稳的', items: s.solid ?? [], teachable: false },
    { label: '卡壳的', items: s.stuck ?? [], teachable: true },
    { label: '建议回头搞懂', items: s.teach_next ?? [], teachable: true },
  ].filter((g) => g.items.length > 0)
}

/** 面试陪练的收尾行（M3 · PLAN §3 G3）：进度 + 出复盘报告 + 报告本身。
 *
 *  三件事都在这里说清楚：
 *  - **进度是数出来的**（助手轮次），不是另一个计数器；
 *  - 报告落 `vault/reports/`（**不算"成品"**：不计成长值、不上小屋架子、没有那句
 *    「交出去了」——它是给你自己看的，界面上不吹成一件交付）；
 *  - 每一条卡壳/建议再讲都能**一键开一场教学**——那才是「进卡点清单」的现有路径
 *    （教学里记的卡点才进卡点清单；面试不是教学，不替它造记录）。
 */
export function InterviewRow({
  sid,
  turns,
  busy,
  onTeach,
}: {
  sid: number | null
  turns: number
  busy: boolean
  onTeach: (topic: string) => void
}) {
  const [busyReport, setBusyReport] = useState(false)
  const [rep, setRep] = useState<InterviewReportResult | null>(null)
  const [msg, setMsg] = useState('')

  const make = async () => {
    if (sid === null || busyReport) return
    setBusyReport(true)
    setMsg('')
    try {
      const r = await api.interviewReport(sid)
      if (!r.ok) {
        setMsg(r.reason || '报告没生成出来')
        return
      }
      setRep(r)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyReport(false)
    }
  }

  const asked = Math.max(0, turns - 1) // 第一轮是开场那句话，问过的题 = 助手轮次
  const s = rep?.sections

  return (
    <div data-interview-row className="space-y-2 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-400">
          面试
        </span>
        <span className="text-xs text-neutral-400">
          问过 {asked} 题{asked > 0 && asked < 5 ? '（5–8 题一场）' : ''}
        </span>
        <button
          data-interview-report
          onClick={() => void make()}
          disabled={busy || busyReport || turns === 0}
          title="读完整场对话出一份复盘报告（一次模型调用），落到 vault/reports/"
          className="rounded-lg wb-btn-ghost px-2.5 py-1 text-xs"
        >
          {busyReport ? '写报告中…' : rep ? '再出一份' : '出复盘报告'}
        </button>
        {msg ? <span className="text-xs text-amber-600 dark:text-amber-400">{msg}</span> : null}
      </div>

      {s ? (
        <div
          data-interview-report-body
          className="space-y-2 rounded-md border border-violet-200 bg-violet-50/40 p-3 text-xs dark:border-violet-500/30 dark:bg-violet-500/5"
        >
          {s.summary ? (
            <p className="text-neutral-700 dark:text-neutral-200">{s.summary}</p>
          ) : null}
          {reportGroups(s).map((g) => (
            <div key={g.label}>
              <p className="pb-0.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                {g.label}
              </p>
              <ul className="space-y-0.5">
                {g.items.map((x) => (
                  <li key={x} className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 text-neutral-700 dark:text-neutral-200">
                      · {x}
                    </span>
                    {/* 卡壳的那两栏才有「去搞懂」：报告里点一下，**开一场教学**
                        （现有路径）——那条路记的卡点才进卡点清单 */}
                    {g.teachable ? (
                      <button
                        data-teach={x}
                        onClick={() => onTeach(x)}
                        title="开一场教学专门搞懂它（卡点会进卡点清单）"
                        className="shrink-0 text-xs text-violet-600 hover:underline dark:text-violet-300"
                      >
                        去搞懂 →
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {rep?.path ? (
            <p className="pt-0.5 text-xs text-neutral-400">
              报告已落{' '}
              <a
                href={`/notes?path=${encodeURIComponent(rep.path)}`}
                target="_blank"
                rel="noreferrer"
                className="text-violet-600 hover:underline dark:text-violet-300"
              >
                {rep.path}
              </a>
              （{rep.chars} 字）· 题库文件没有被改过
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Server turns carry role+content only; sources ride along on the reply the
 * turn was streamed for, so 取材来源 stays attached to the bubble that used it. */
export type Turn = TutorTurn & { sources?: TutorMaterialSource[] }
/** chroma 元数据里的 title 是文件名去后缀（「index」），没有信息量；路径尾部两段才认得出位置 */
export function shortSource(source: string): string {
  const parts = source.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

export function MaterialLine({ sources }: { sources: TutorMaterialSource[] }) {
  return (
    <p className="text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
      取材：
      {sources.map((s, i) => (
        <span key={i} className="ml-1.5 rounded bg-neutral-200/70 px-1.5 py-0.5 dark:bg-neutral-700/60">
          {shortSource(s.source)}
        </span>
      ))}
    </p>
  )
}

export function Bubble({ turn, canSave = false }: { turn: Turn; canSave?: boolean }) {
  // 方向 1：教学回答的沉淀出口——存完就地给一行回执（同一文件多存只留最后一条）。
  const [saved, setSaved] = useState<ArtifactRef[]>([])
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-md bg-violet-600 px-4 py-2.5 text-sm text-white">
          {turn.content}
        </div>
      </div>
    )
  }
  return (
    <div className="max-w-[92%] rounded-lg rounded-bl-md bg-neutral-100 px-4 py-3 dark:bg-neutral-800/70">
      <Markdown>{turn.content}</Markdown>
      {turn.sources && turn.sources.length > 0 ? (
        <div className="mt-2 border-t border-neutral-200/70 pt-1.5 dark:border-neutral-700/70">
          <MaterialLine sources={turn.sources} />
        </div>
      ) : null}
      {canSave && turn.content ? (
        <SaveTextToVault
          content={turn.content}
          onSaved={(a) => setSaved((p) => upsertArtifact(p, a))}
          className="mt-1.5"
        />
      ) : null}
      {saved.map((a) => (
        <div key={a.path} className="mt-1.5">
          <ArtifactReceipt art={a} />
        </div>
      ))}
    </div>
  )
}

/** 跑完了的一行回执：整篇正文收成一行，指到已存的产物（/notes 详情页）。
 *  流式 / 出错态不套这个——那时候正文正是要看的；「读全文」随时能把它展开回来。
 *  导出是为了单测——整页渲染设施这个仓库还没有。 */
export function ReceiptLine({ title, meta, saved }: { title: string; meta: string; saved: string }) {
  return (
    <OutputCard
      title={title}
      meta={saved ? `${meta} · 已存入` : meta}
      href={saved ? `/notes?path=${encodeURIComponent(saved)}` : undefined}
    />
  )
}

/** 「这一条其实是别的概念？并到…」（Q3.5 的人工归一出口）。
 *
 *  **为什么不是自动的。** 机器只在有量出来的余量的地方并（相似度 0.80）；同一个领域的
 *  相邻概念它**分不开** —— 实测里「SQLite WAL 模式」和「SQLite 锁机制」比某些该并的
 *  还近（尺子：`backend/smoke_concept.py` 的原始数据）。所以这里是指认，不是「再调调阈值」。
 *
 *  单独导出是为了能测：并错了会同时污染「搞懂过几个概念」和召回，这个交互值得有自己的测试。
 *  候选**只来自已有的概念名**（没有「新建一个」）——并到一个不存在的名字上不在这个交互里。
 */
export function ConceptMerge({
  concept,
  others,
  busy,
  onMerge,
}: {
  concept: string
  others: string[]
  busy: boolean
  onMerge: (source: string, into: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const candidates = others
    .filter((t) => t !== concept && (!q.trim() || t.includes(q.trim())))
    .slice(0, 8)

  if (!open) {
    return (
      <button
        data-merge-open={concept}
        onClick={() => {
          setOpen(true)
          setQ('')
        }}
        title="同一个领域的相邻概念，机器分不开（实测比某些该并的还近）——这一条得你来指认"
        className="pt-1 block text-xs text-neutral-400 transition-colors hover:text-violet-600 dark:hover:text-violet-300"
      >
        这一条其实是别的概念？并到…
      </button>
    )
  }
  return (
    <div className="pt-1">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          data-merge-q
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="并到哪个概念？"
          className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-xs outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          onClick={() => setOpen(false)}
          className="shrink-0 text-xs text-neutral-400 hover:text-neutral-600"
        >
          取消
        </button>
      </div>
      <div className="flex flex-wrap gap-1 pt-1">
        {candidates.map((t) => (
          <button
            key={t}
            data-merge-into={t}
            disabled={busy}
            onClick={() => onMerge(concept, t)}
            title={`把「${concept}」的历次记录并到「${t}」（留下来的是「${t}」这个名字）`}
            className="max-w-full truncate rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 transition-colors hover:bg-violet-100 hover:text-violet-700 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            {t}
          </button>
        ))}
        {candidates.length === 0 ? (
          <span className="text-xs text-neutral-400">
            没有别的概念可以并 —— 只有一条的时候，没得挑。
          </span>
        ) : null}
      </div>
    </div>
  )
}
