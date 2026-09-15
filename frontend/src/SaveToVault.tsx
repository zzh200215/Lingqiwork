/** 「存进产出」——把一条已经在手上的回答归档进 vault 的产出区。
 *
 *  为什么需要这条人工出口：`save_artifact` 是**靠模型自觉**调的，而模型并不总调。
 *  实测（sensenova-6.8-flash-lite 自然说法下两批合计 1/18；deepseek-v4-pro 0/3）——
 *  工具调用本身没坏（原始流里 finish_reason 就是 tool_calls，skill_load / kb_search
 *  照调），它只是把「写一份周报」当成一次**回答**，不是一次**落盘**。
 *
 *  后果是静默的：正文躺在回复里，工作页产出清单看不到、零柒成长不算、检索搜不到。
 *  所以内容既然已经在手上，就别让它白写——点一个体裁就落盘，回执挂回这条消息。
 *
 *  体裁**不猜**：`compose` 落到 `notes/`，那是「成文的自留地」，刻意不计进产出数与
 *  成长值；猜错了等于存了个看不见的东西。让用户点。可选值从后端拿，不硬编码。
 */
import { useState } from 'react'

import { api } from './api'
import type { ArtifactRef } from './stream'

export default function SaveToVault({
  conversationId,
  messageId,
  onSaved,
  className = '',
}: {
  conversationId: number
  messageId: number
  onSaved: (art: ArtifactRef) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [kinds, setKinds] = useState<{ kind: string; label: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function toggle() {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    setErr('')
    if (kinds.length) return
    try {
      const r = await api.outputKinds()
      setKinds(r.kinds.map((k) => ({ kind: k.kind, label: k.label })))
    } catch {
      // 拉不到就说拉不到——不编一份假的体裁表出来
      setErr('体裁表拉不到')
    }
  }

  async function pick(kind: string) {
    setBusy(true)
    setErr('')
    try {
      onSaved(await api.saveOutputFromMessage(conversationId, messageId, kind))
      setOpen(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}>
      <button
        onClick={() => void toggle()}
        title="把这条回答存进 vault 的产出区"
        className="rounded-md px-2 py-1 text-xs text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-teal-600 dark:hover:bg-neutral-800 dark:hover:text-teal-300"
      >
        📄 存进产出
      </button>
      {open ? (
        <>
          {kinds.map((k) => (
            <button
              key={k.kind}
              disabled={busy}
              onClick={() => void pick(k.kind)}
              className="rounded-full border border-teal-300 px-2 py-0.5 text-[11px] text-teal-700 transition-colors hover:bg-teal-50 disabled:opacity-40 dark:border-teal-600 dark:text-teal-300 dark:hover:bg-teal-500/10"
            >
              {k.label}
            </button>
          ))}
          {err ? <span className="text-[11px] text-red-500">{err}</span> : null}
        </>
      ) : null}
    </span>
  )
}
