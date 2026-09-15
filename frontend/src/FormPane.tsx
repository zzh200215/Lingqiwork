/** 形态（Q3）—— 一个领域长成了什么样，**只由可验证的能力算**。
 *
 *  这一页要挡住的是一种很自然的做法：让「上传了多少篇法律文书」决定它长成不像法务。
 *  这个仓库不微调，上传只改变检索覆盖，不改变模型——如果形态由量驱动，它的最优解就是
 *  往 vault 里堆文件，而堆出来的形态是纯装饰。所以一根枝要**三样都在同一个领域里站得住**：
 *  检索得住（命中率 + 区间）、搞懂过概念（`tutor.is_mastered` 那一条）、技能卡跑通过
 *  （对照台的基线）。
 *
 *  语气上的三条，和宠物那条线、实验室那条线一致：
 *  - **不算样本不够的率**：够不着就说「样本不足」，不给一个会被误读的比例；
 *  - **不摆进度条、不写「还差 N」**：这一页是诊断台，不是待办清单；
 *  - **必须写出它没学会它**：「检索得住」和「懂了」是两件事。
 *
 *  领域从哪来：**你自己在证据上写的那个短词**（样例题、教学会话由提取自动带上、实验室
 *  那套用例）。不从 vault 目录推——目录是笔记怎么放，不是领域是什么。
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, type EvalItem, type FormDomain, type FormReport } from './api'
import EmptyHint from './EmptyHint'

/** 区间一律带着走：裸比例在 n 小的时候没有意义。 */
function ci(lo: number | null, hi: number | null): string {
  if (lo == null || hi == null) return ''
  return `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`
}

function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 三样里的一样。`enough === false` 一律只说「样本不足」，不说还缺多少。 */
function Number_({
  label,
  value,
  extra,
  enough,
  note,
}: {
  label: string
  value: string
  extra?: string
  enough: boolean
  note?: string
}) {
  return (
    <div
      className={`rounded-lg border px-2.5 py-1.5 ${
        enough
          ? 'border-emerald-200 bg-white dark:border-emerald-500/30 dark:bg-neutral-900'
          : 'border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/60'
      }`}
    >
      <div className="text-[10px] text-neutral-400 dark:text-neutral-500">{label}</div>
      <div className="text-sm tabular-nums text-neutral-700 dark:text-neutral-200">
        {enough ? value : '样本不足'}
      </div>
      <div className="text-[10px] text-neutral-400 dark:text-neutral-500">
        {enough ? extra : note}
      </div>
    </div>
  )
}

function Card({ b }: { b: FormDomain }) {
  const r = b.retrieval
  const best = b.skills.find((s) => s.enough) ?? b.skills[0]
  return (
    <li
      data-form-domain={b.domain}
      data-form-grown={b.grown ? '1' : '0'}
      className={`rounded-xl border p-3 ${
        b.grown
          ? 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-500/30 dark:bg-emerald-500/5'
          : 'border-neutral-200 dark:border-neutral-800'
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-base leading-none">{b.grown ? '🌿' : '·'}</span>
        <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {b.domain}
        </span>
        <div className="flex-1" />
        <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
          {b.grown ? '三样都有数' : '还没成枝'}
        </span>
      </div>

      <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
        <Number_
          label="① 检索"
          value={
            r.hit_rate == null
              ? `${r.hits}/${r.cases}`
              : `${r.hits}/${r.cases} 命中 · ${Math.round(r.hit_rate * 100)}%`
          }
          extra={[ci(r.ci_low, r.ci_high), r.faithfulness != null ? `忠实度 ${r.faithfulness}/5` : '']
            .filter(Boolean)
            .join(' · ')}
          enough={r.enough}
          note={r.note}
        />
        <Number_
          label="② 搞懂的概念"
          value={`${b.concepts.mastered} 个`}
          extra={b.concepts.names.length > 0 ? b.concepts.names.join('、') : ''}
          enough={b.concepts.enough}
          note={b.concepts.seen > 0 ? `碰过 ${b.concepts.seen} 个，还没说通` : '这个领域还没上过课'}
        />
        <Number_
          label="③ 技能卡"
          value={best ? `${best.passed}/${best.cases} 通过` : ''}
          extra={
            best
              ? [best.name, best.ci_low != null ? ci(best.ci_low, best.ci_high) : '']
                  .filter(Boolean)
                  .join(' · ')
              : ''
          }
          enough={b.skills.some((s) => s.enough)}
          note="这个领域还没有跑过对照的技能卡"
        />
      </div>

      {r.run_id != null ? (
        <div className="mt-1 text-[10px] text-neutral-400 dark:text-neutral-500">
          检索读的是 #{r.run_id} 那次评测（{when(r.at)}），这个领域当时有 {r.cases} 条题
          {r.labelled > r.cases ? `（现在标了 ${r.labelled} 条，多出来的还没跑过）` : ''}
        </div>
      ) : null}

      {b.grown ? (
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-300">
          它没有学会{b.domain}。这三个数说的是「在你的材料里找得到、讲得有据、这一条跑通过」
          ——没有一样测过它对你这类问题的判断。
        </p>
      ) : null}
    </li>
  )
}

export default function FormPane() {
  const [report, setReport] = useState<FormReport | null>(null)
  const [items, setItems] = useState<EvalItem[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      const [f, its] = await Promise.all([api.form(), api.listEvalItems()])
      setReport(f)
      setItems(its)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 给一条样例题标领域。空字符串合法 = 退回「还没归类」。 */
  const saveDomain = useCallback(
    async (id: number) => {
      const v = editing[id]
      if (v == null) return
      try {
        await api.updateEvalItem(id, { domain: v })
        setEditing((c) => {
          const n = { ...c }
          delete n[id]
          return n
        })
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [editing, load]
  )

  /** 跑一次评测。**要花钱**：每条题一次回答 + 一次判分，所以把条数写在按钮上。 */
  const runEval = useCallback(async () => {
    setBusy(true)
    setMsg('')
    try {
      const r = await api.runEval(null, true)
      setMsg(`跑完了 #${r.id}：hit@1 ${Math.round(r.hit1 * 100)}% · ${r.total} 条`)
      await load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [load])

  if (error) {
    return <p className="text-sm text-rose-600 dark:text-rose-300">读形态出错了：{error}</p>
  }
  if (!report) return <p className="text-sm text-neutral-400">正在算它长成什么样…</p>

  const domains = report.domains
  const grown = domains.filter((d) => d.grown)
  const unclassified = items.filter((i) => !i.domain.trim())

  return (
    <div data-form-root className="space-y-6">
      <section className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-3 text-[11px] leading-relaxed text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/40 dark:text-neutral-400">
        一根枝 = 同一个领域里三样可验证的东西都够说话了：
        <b className="text-neutral-600 dark:text-neutral-300">检索住</b>（这个领域的样例题命中率）、
        <b className="text-neutral-600 dark:text-neutral-300">搞懂过</b>（这个领域已掌握的概念）、
        <b className="text-neutral-600 dark:text-neutral-300">跑通过</b>（这个领域的技能卡）。
        <br />
        长出来只说明证据够说话了，不说明它在这个领域做得好——好不好的数就是上面那三个，
        区间宽的时候连「好不好」都还问不出来。
        这里也没有「上传多少文档就长成什么形态」：这个仓库不微调，堆文件只改变检索覆盖。
      </section>

      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
            领域（{grown.length}/{domains.length} 长成了枝）
          </h2>
          <div className="flex-1" />
          <Link to="/work?tab=lab" className="text-xs text-violet-500 hover:underline">
            技能那边去实验室
          </Link>
        </div>
        {domains.length === 0 ? (
          <EmptyHint
            pad="lg"
            title="还没有任何一个领域。"
            hint="领域是你在证据上自己写的一个短词：给下面的样例题标一个，或者去实验室给那套用例标一个，上过课的概念会自己带上。"
          />
        ) : (
          <ul className="space-y-2">
            {domains.map((d) => (
              <Card key={d.domain} b={d} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
            样例题的领域
          </h2>
          <div className="flex-1" />
          <span className="text-[11px] text-neutral-400">
            {unclassified.length > 0 ? `${unclassified.length} 条还没归类` : '都归好类了'}
          </span>
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500">
            评测集是空的。检索那一样读的就是它——先往 `eval_items` 里放几条「问题 + 期望源」。
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {items.map((i) => (
              <li key={i.id} data-form-item={i.id} className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-600 dark:text-neutral-300">
                  {i.question}
                </span>
                <span className="hidden shrink-0 truncate text-[10px] text-neutral-400 sm:block sm:max-w-[12rem]">
                  {i.expected_source || '（没有期望源）'}
                </span>
                <input
                  data-form-domain-input={i.id}
                  value={editing[i.id] ?? i.domain}
                  onChange={(e) => setEditing((c) => ({ ...c, [i.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveDomain(i.id)
                  }}
                  onBlur={() => void saveDomain(i.id)}
                  placeholder="领域"
                  className="w-24 shrink-0 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-[11px] outline-none placeholder:text-neutral-400 focus:border-emerald-400 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </li>
            ))}
          </ul>
        )}
        {items.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              data-form-run
              onClick={() => void runEval()}
              disabled={busy}
              title={`每条题一次回答 + 一次判分，${items.length} 条 = 最多 ${items.length * 2} 次模型调用`}
              className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-[11px] text-neutral-600 transition-colors hover:border-emerald-400 hover:text-emerald-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
            >
              {busy ? '评测中…' : `跑一次评测（${items.length} 条，最多 ${items.length * 2} 次调用）`}
            </button>
            {msg ? (
              <span data-form-msg className="text-[11px] text-neutral-500">
                {msg}
              </span>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  )
}
