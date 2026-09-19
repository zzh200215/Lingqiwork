import { useState } from 'react'

import { api } from './api'

/**
 * 生成质量闭环的那一次点击。
 *
 * research / compose / recap / decide / deliver 几条链路都通过 `core/report.py` 成文，但此前**没有
 * 任何地方记录过"这次我满意吗"**——只有聊天消息有 feedback、教学有自评。结果是：改了提示词、
 * 换了 provider，只能靠"看起来对不对"判断；而四个引擎共用一条脊梁，一次提示词回归
 * 同时打穿四个功能。
 *
 * 评价挂在 (kind, prompt_sha, model_id) 上，所以攒够之后能回答"哪版提示词更好"
 * 和"哪个 provider 在本产品上更强"。
 *
 * 护栏：这是**事后的一次点击**，不是待办——不计数、不催、不设目标，评过就收起。
 */
export default function FeedbackButtons({
  kind,
  promptSha,
  modelId,
  artifactRef,
  injected,
}: {
  kind: 'research' | 'compose' | 'recap' | 'decide' | 'conflict' | 'deliver'
  promptSha?: string
  modelId?: string
  artifactRef?: string
  /**
   * S1（PLAN3 §9.2 决策4）：这份产出吃着技能生成的没有。
   *
   * **三态，别用 bool**：不传 = **不知道**（比如从产出清单事后点的，那时手上没有注入
   * 信息）；`[]` = 确实没注入；`['技能名']` = 有注入。把「不知道」记成「没注入」，
   * 质量卡上那一行就是编出来的数。
   */
  injected?: string[]
}) {
  const [sent, setSent] = useState<'good' | 'bad' | null>(null)
  const [badOpen, setBadOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  async function send(verdict: 'good' | 'bad', why = '') {
    setBusy(true)
    try {
      await api.qualityFeedback({
        kind,
        verdict,
        prompt_sha: promptSha ?? '',
        model_id: modelId ?? '',
        reason: why,
        ref: artifactRef ?? '',
        // 只有调用方说得出「有没有注入」时才带这一项（`undefined` = 不知道）
        ...(injected ? { injected: JSON.stringify(injected) } : {}),
      })
      setSent(verdict)
      setBadOpen(false)
    } catch {
      /* 评价失败不该打扰正在看东西的人 */
    } finally {
      setBusy(false)
    }
  }

  if (sent === 'good') {
    return <span className="text-[11px] text-emerald-600 dark:text-emerald-400">记下了 👍</span>
  }
  if (sent === 'bad') {
    return <span className="text-[11px] text-neutral-400">记下了 👎</span>
  }

  if (badOpen) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px]">
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send('bad', reason)
            if (e.key === 'Escape') setBadOpen(false)
          }}
          placeholder="哪里不好？（可留空）"
          className="w-44 rounded border border-neutral-200 bg-transparent px-1.5 py-0.5 text-[11px] outline-none focus:border-violet-400 dark:border-neutral-700"
        />
        <button
          disabled={busy}
          onClick={() => void send('bad', reason)}
          className="rounded px-1 text-violet-600 hover:bg-neutral-100 disabled:opacity-50 dark:text-violet-300 dark:hover:bg-neutral-800"
        >
          发送
        </button>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-neutral-400">
      <span>这篇怎么样？</span>
      <button
        disabled={busy}
        onClick={() => void send('good')}
        title="好"
        className="rounded px-1 transition-colors hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
      >
        👍
      </button>
      <button
        disabled={busy}
        onClick={() => setBadOpen(true)}
        title="不好"
        className="rounded px-1 transition-colors hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
      >
        👎
      </button>
    </span>
  )
}
