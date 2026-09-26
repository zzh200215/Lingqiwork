/** 语音备忘的「那一问」（R2 · PLAN5 §3）：这段录音是**材料**，还是**工作留痕**？
 *
 *  **拉取式**：它只在笔记页上摆着——不催、不冒泡、不进零柒的提醒来源。回答过的
 *  （拆过点 / 挂过事）就从这张单子上下去；单子空了**整块不渲染**，一点痕迹都不留。
 *
 *  **两个按钮都不是新机制**：
 *  - 「当材料」→ 既有的拆点（`POST /api/tutor/digest`），点进学习页的建议日志。
 *    **不自动建卡**：出不出卡仍然由你在学页点（S2 的先例：自动判断会产出凑数草稿）。
 *  - 「工作留痕」→ 既有的「挂到…」（`AttachToThread`，只存引用、不搬内容）。
 *
 *  **为什么不摆「还有 N 份」**：§4-1 那条红线——镜子不是掌柜，只说已发生，不说「你还欠」。
 *  一摆计数，这一格就从「随手分个类」变成一份待办清单。载荷里有 `counts`（那是事实），
 *  界面上不显示它。
 *
 *  **读不到就说读不到**（§4-8）：`readable=false` 说的是「这一格现在读不出来」，
 *  **不是**「都归类完了」——后者会把读不到说成一个具体的事实。
 */
import { useState } from 'react'

import AttachToThread from './AttachToThread'
import { api, type VoicePending } from './api'

export default function VoiceTriage({
  v,
  onChanged,
  onOpen,
}: {
  /** 那一问的载荷；`null` = 还没读到（整块不渲染，与仪表盘那些卡同一个规矩） */
  v: VoicePending | null
  /** 回答完一个之后让页面重新取一次（那一份会从单子上下去） */
  onChanged: () => void
  /** 点标题打开那一份笔记 */
  onOpen?: (path: string) => void
}) {
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  async function asMaterial(path: string) {
    setBusy(path)
    setMsg('')
    setErr('')
    try {
      const r = await api.tutorDigest({ source_path: path })
      if (r.error) {
        setErr(r.error) // 拆不出来时材料还在（后端不报错，只给一句人话）
      } else {
        setMsg(`拆出 ${r.points.length} 个点，进了学习页的建议日志。`)
      }
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  if (!v) return null
  if (!v.readable) {
    return (
      <p
        data-voice-triage-error
        className="mx-1 mb-2 rounded-lg bg-rose-50 px-2.5 py-2 text-xs leading-relaxed text-rose-600 dark:bg-rose-500/10 dark:text-rose-300"
      >
        这一格现在读不出来（{v.error || '原因没给出来'}）——读不到不等于「都归类完了」。
      </p>
    )
  }
  if (v.open.length === 0) return null

  return (
    <section
      data-voice-triage
      className="mx-1 mb-2 rounded-lg border border-amber-200 bg-amber-50/70 px-2.5 py-2 dark:border-amber-500/30 dark:bg-amber-500/10"
    >
      <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
        语音备忘 · 还没归类
      </p>
      <p className="pt-0.5 text-xs leading-relaxed text-amber-700/90 dark:text-amber-300/80">
        不回答也行——文本已经进了索引，随时搜得到。
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {v.open.map((n) => (
          <li
            key={n.path}
            data-voice-note={n.path}
            className="rounded-md bg-white/80 px-2 py-1.5 dark:bg-neutral-900/60"
          >
            <button
              onClick={() => onOpen?.(n.path)}
              title={n.path}
              className="block w-full truncate text-left text-xs text-neutral-700 hover:text-violet-600 dark:text-neutral-200 dark:hover:text-violet-300"
            >
              {n.title}
            </button>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <button
                data-voice-material
                onClick={() => void asMaterial(n.path)}
                disabled={busy === n.path}
                title="拆成「要搞懂的点」，进学习页的建议日志（出不出卡由你在学页点）"
                className="shrink-0 rounded-full border border-amber-300 px-2 py-0.5 text-xs text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-40 dark:border-amber-500/50 dark:text-amber-200 dark:hover:bg-amber-500/10"
              >
                {busy === n.path ? '拆点中…' : '当材料'}
              </button>
              <AttachToThread kind="note" ref={n.path} label="工作留痕" onAttached={onChanged} />
            </div>
          </li>
        ))}
      </ul>
      {msg ? (
        <p data-voice-triage-msg className="pt-1.5 text-xs leading-relaxed text-emerald-700 dark:text-emerald-400">
          {msg}
        </p>
      ) : null}
      {err ? (
        <p data-voice-triage-err className="pt-1.5 text-xs leading-relaxed text-rose-600 dark:text-rose-300">
          {err}
        </p>
      ) : null}
    </section>
  )
}
