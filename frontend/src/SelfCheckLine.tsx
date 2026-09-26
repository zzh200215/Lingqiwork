import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, type SelfCheck } from './api'

// One quiet line on the 今日 page saying whether the background actually works.
//
// It exists because of 2026-09-04: the default model's quota had run out, all
// eight scheduled jobs were failing into a log nobody reads, and the UI showed
// nothing. Rendered even when everything is fine — a line that only appears on
// failure is a line you never learn to look at.

function tone(c: SelfCheck): 'bad' | 'warn' | 'idle' {
  if (c.default_model_broken || c.jobs_missing.length) return 'bad'
  if (c.jobs_failing.length) return 'warn'
  return 'idle'
}

const CLS = {
  bad: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300',
  warn: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300',
  idle: 'border-neutral-200/80 text-neutral-400 dark:border-neutral-800/80',
} as const

export default function SelfCheckLine() {
  const [check, setCheck] = useState<SelfCheck | null>(null)

  useEffect(() => {
    // swallowed: a self-check that breaks the page it reports on is worse than none
    api.selfCheck().then(setCheck).catch(() => {})
  }, [])

  if (!check) return null
  const t = tone(check)
  const failing = check.jobs_failing

  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-xs ${CLS[t]}`}>
      <span>⚙️ 后台</span>
      {t === 'bad' ? (
        check.default_model_broken ? (
          <span>
            默认模型 <span className="font-mono">{check.default_model}</span> 打不通
            {check.models_broken.find((m) => m.model_id === check.default_model)?.code
              ? `（${check.models_broken.find((m) => m.model_id === check.default_model)?.code}）`
              : ''}
            —— 所有自动化功能都在用它
          </span>
        ) : (
          <span>{check.jobs_missing.join('、')} 应该在跑但没注册</span>
        )
      ) : t === 'warn' ? (
        <span>
          {failing.length} 个作业连续失败：
          {failing.slice(0, 2).map((f) => `${f.job_id}×${f.fails}`).join('、')}
          {failing.length > 2 ? ` 等 ${failing.length} 个` : ''}
        </span>
      ) : (
        <span>
          {check.jobs_live} 个作业在跑
          {check.jobs_off.length ? ` · ${check.jobs_off.length} 个已关` : ''}
          {check.default_model ? ` · 默认模型 ${check.default_model}` : ' · 还没配 provider'}
        </span>
      )}
      {check.never_probed && check.models_total > 0 && (
        <span className="text-neutral-400">· 模型可用性还没测过</span>
      )}
      <Link
        to="/settings"
        className="ml-auto underline decoration-dotted underline-offset-2 hover:no-underline"
      >
        {check.never_probed || t === 'bad' ? '去测一下' : '详情'}
      </Link>
    </div>
  )
}
