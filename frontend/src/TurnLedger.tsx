/** 最近回合（W5）—— 聊天那条路上每一轮发生了什么。
 *
 *  **它补的是缺口二。** 界面上一直看得到调了哪些工具，但**什么都不落盘**：没有工具耗时、
 *  没有轮数、没有「这一轮为什么没存」。升级计划那一轮的每个结论都是临时脚本量出来的，
 *  量完就散——光为了量一件事就临时搭了 `measure.py` + 一个 Playwright 脚本。这一栏要做的
 *  就是让那个问题**在界面上点得出来**，不用起脚本。
 *
 *  **红线（照 `quality.py`）**：这是诊断工具，不是考核仪表。不设目标、不催、不做排行榜。
 *  所以这里没有「好回合」这个筛选项、没有百分比、没有趋势箭头——只有事实和毛病。
 *  毛病由后端判定（`core/turn_trace.py`），界面不重算：同一个判断的第二份实现，
 *  分叉的那天这个数就没人敢信了。
 */
import { useCallback, useEffect, useState } from 'react'

import { api, type TurnFilter, type TurnTrace } from './api'

/** 相对时间：一屏里只取一次「现在」，免得同一屏出现「刚刚」与「1 分钟前」并列。 */
function ago(iso: string, now: number): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso.slice(5, 16).replace('T', ' ')
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

function shortModel(id: string): string {
  return id ? id.split('/').slice(-1)[0] : '—'
}

export function TurnRow({ t, now, labels }: { t: TurnTrace; now: number; labels: Record<string, string> }) {
  const tools = t.tool_calls.length
  return (
    <li data-turn={t.id} className="border-t border-neutral-100 py-1.5 text-xs dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-neutral-400 tabular-nums">{ago(t.at, now)}</span>
        <span className="max-w-[12rem] truncate text-neutral-600 dark:text-neutral-300" title={t.model_id}>
          {shortModel(t.model_id)}
        </span>
        <span className="text-neutral-400 tabular-nums">
          {t.rounds} 轮 · {tools} 次工具 · {Math.round(t.seconds)}s
        </span>
        <span className="text-neutral-400 tabular-nums" title="输入 / 输出 token">
          {t.tokens_in}/{t.tokens_out}
        </span>
        <span className="text-neutral-400">
          {t.artifacts.length > 0 ? `${t.artifacts.length} 份产出` : `正文 ${t.answer_chars} 字`}
        </span>
        {t.retried > 0 ? <span className="text-amber-600 dark:text-amber-400">重试 {t.retried}</span> : null}
        {/* 毛病：标签与筛选项同一份文案（后端的 FILTERS），这里不另立说法 */}
        {t.flags.map((f) => (
          <span
            key={f}
            data-turn-flag={f}
            className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
          >
            {labels[f] ?? f}
          </span>
        ))}
      </div>
      {t.error ? (
        <p className="truncate text-[11px] text-rose-600 dark:text-rose-400" title={t.error}>
          {t.error}
        </p>
      ) : null}
    </li>
  )
}

export default function TurnLedger() {
  const [data, setData] = useState<{ traces: TurnTrace[]; filters: TurnFilter[] } | null>(null)
  const [only, setOnly] = useState('')
  const [err, setErr] = useState('')
  const [now] = useState(() => Date.now())

  const load = useCallback(async (key: string) => {
    try {
      const r = await api.turns(30, key)
      setData({ traces: r.traces, filters: r.filters })
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load(only)
  }, [load, only])

  const labels = Object.fromEntries((data?.filters ?? []).map((f) => [f.key, f.label]))

  return (
    <div data-turn-ledger className="mt-1 border-t border-neutral-100 pt-3 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">最近回合</p>
        <div className="flex-1" />
        <button
          data-turn-filter=""
          onClick={() => setOnly('')}
          className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
            only === ''
              ? 'border-neutral-400 text-neutral-700 dark:border-neutral-500 dark:text-neutral-200'
              : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
          }`}
        >
          全部
        </button>
        {(data?.filters ?? []).map((f) => (
          <button
            key={f.key}
            data-turn-filter={f.key}
            onClick={() => setOnly(f.key)}
            title={f.hint}
            className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
              only === f.key
                ? 'border-violet-400 text-violet-700 dark:border-violet-500 dark:text-violet-300'
                : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {/* 语气与整个仓库一致：它是诊断，不是考核 */}
      <p className="mt-1 text-[11px] text-neutral-400">
        聊天那条路上每一轮的真实开销与结果。这是诊断，不是考核 —— 没有目标、没有排行榜。
      </p>
      {err ? <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">读回合账本出错：{err}</p> : null}
      {!data ? (
        <p className="mt-1 text-[11px] text-neutral-400">正在读…</p>
      ) : data.traces.length === 0 ? (
        <p className="mt-1 text-[11px] text-neutral-400">
          {only ? '这一类目前一个都没有。' : '还没有回合记录 —— 聊一句就有了。'}
        </p>
      ) : (
        <ul data-turn-list className="mt-1">
          {data.traces.map((t) => (
            <TurnRow key={t.id} t={t} now={now} labels={labels} />
          ))}
        </ul>
      )}
    </div>
  )
}
