/** 夜间评测回归的开关卡（评测自动挡收尾，2026-09-26）。
 *
 *  promptfoo / Langfuse / LangSmith 收敛到同一个骨架：**定时**用金标集跑一遍 →
 *  **和上一夜比分数** → 回退了**报警**。调度与报警在 `core/eval_regression.py`，
 *  这里只补开关界面与最近一跑的展示。
 *
 *  **默认关**：每晚一遍金标集是真金白银的模型调用——开关打开那一刻，
 *  钱花在哪就该写在明面上。配置读不到时整卡不摆：**读不到 ≠ 关着**。
 */
import { useEffect, useState } from 'react'

import { api } from './api'

export default function EvalNightlyCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [cron, setCron] = useState('0 5 * * *')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [last, setLast] = useState<{
    id: number
    hit1: number
    faithfulness: number | null
    created: string
  } | null>(null)

  useEffect(() => {
    api
      .getPrefs()
      .then((p) => {
        setEnabled(Boolean(p.eval_regression_enabled))
        const c = p.eval_regression_cron
        if (typeof c === 'string' && c) setCron(c)
      })
      .catch(() => setEnabled(null))
    api
      .listEvalRuns()
      .then((runs) => {
        const r = runs[0]
        if (r)
          setLast({
            id: r.id,
            hit1: r.hit1,
            faithfulness: r.faithfulness ?? null,
            created: r.created_at ?? '',
          })
      })
      .catch(() => {})
  }, [])

  async function save(next: boolean) {
    setBusy(true)
    setMsg('')
    try {
      await api.updatePrefs({ eval_regression_enabled: next, eval_regression_cron: cron })
      setEnabled(next)
      setMsg(next ? `已开：${cron} 每晚跑一遍，回归会报警` : '已关——不再有夜间调用')
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  if (enabled === null) return null

  return (
    <section data-nightly-card className="wb-card p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">夜间回归</h2>
        <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => void save(e.target.checked)}
          />
          每晚自动跑一遍金标集
        </label>
        {enabled ? (
          <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
            cron
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className="w-28 rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-xs outline-none focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              disabled={busy}
              onClick={() => void save(true)}
              className="rounded-md border border-violet-300 px-2 py-0.5 text-xs text-violet-700 transition-colors hover:bg-violet-50 disabled:opacity-40 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10"
            >
              存
            </button>
          </label>
        ) : null}
        {msg ? <span className="text-xs text-neutral-500 dark:text-neutral-400">{msg}</span> : null}
      </div>
      <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        {last
          ? `最近一跑：第 ${last.id} 号（${last.created.slice(0, 16).replace('T', ' ')}）· hit@1 ${(last.hit1 * 100).toFixed(0)}%${last.faithfulness != null ? ` · 忠实度 ${last.faithfulness}` : ''}——和上一夜比，回落就报警`
          : '还没跑过——开了之后每晚一跑就会出现在这里；金标集在登记表里维护'}
        。
      </p>
    </section>
  )
}
