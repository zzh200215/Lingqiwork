/** 体裁模板编辑器（方案 §8.1 行2）——把「你常写的那种东西」存成一种体裁。
 *
 *  ## 它为什么是独立文件
 *
 *  它是一张**自己管自己的表单**：名字 / 结构指令 / 长稿三格，加上存、删、取消。
 *  报告页那边已经有生成面板 + 清单 + 阅读视图三块（`ReportPage.tsx` 九百多行），
 *  再往里塞一张带自己状态的表单就越过方案 §十二 的规模线了。
 *
 *  ## 为什么「长稿」这一格要露出来
 *
 *  它是**界面走哪一模**的判据（长稿先出提纲、短稿一键直出），而判据本身长在体裁上。
 *  藏起来的话，用户存了一个多小节的模板却拿到「一键直出」，会以为是坏了。
 *
 *  ## 名字与 id
 *
 *  id 由后端从名字生成，**建了就不动**（`prompt_sha` 按 id 分版本，改名不该让质量闭环的
 *  历史断裂）。所以这里改名是安全的，界面上也不必提 id。
 */
import { useState } from 'react'

import { api, type DeliverTemplate } from './api'
import { humanErr } from './workData'

/** 新建时的那张空表。**结构指令不给默认值**：它是这种体裁的定义，替用户写等于替他定义。 */
const BLANK = { label: '', prompt: '', long: true }

export default function DeliverTemplateEditor({
  /** 有 `id` = 改一个已有的；没有 = 新建。 */
  editing,
  onSaved,
  onDeleted,
  onCancel,
  onError,
}: {
  editing: Partial<DeliverTemplate> | null
  /** 存好之后把新的那一行交回去（父组件据此刷新 chips 并选中它）。 */
  onSaved: (t: DeliverTemplate, created: boolean) => void
  onDeleted: (id: string) => void
  onCancel: () => void
  /** 页级错误条。删除失败走它——那一格上没有地方摆错误。 */
  onError: (m: string) => void
}) {
  const [form, setForm] = useState({ ...BLANK, ...(editing ?? {}) })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const isEdit = !!form.id

  const save = async () => {
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      const payload = { label: form.label, prompt: form.prompt, long: !!form.long }
      if (isEdit) {
        onSaved(await api.deliverTemplateUpdate(form.id!, payload), false)
      } else {
        onSaved(await api.deliverTemplateCreate(payload), true)
      }
    } catch (e) {
      // 422（名字重了 / 结构指令空着）是**你的输入有问题**，就地摆出来；
      // 别的（网络、500）也照实说，不吞。
      setErr(humanErr(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (busy || !isEdit) return
    setBusy(true)
    try {
      await api.deliverTemplateDelete(form.id!)
      onDeleted(form.id!)
    } catch (e) {
      onError(`模板没删掉：${humanErr(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-template-editor
      // `wb-card` 而不是手抄一份同款边框——见 `DeliverOutlineBox` 里那条注释。
      className="wb-card space-y-2 p-3"
    >
      <p className="text-xs text-neutral-500">
        {isEdit ? '改这份模板' : '存成一种新体裁'}
        <span className="pl-1 text-neutral-400">
          结构指令就是这种体裁的定义：写哪些小节、什么顺序、多长。
        </span>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={form.label}
          aria-label="模板名"
          onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
          placeholder="叫什么？（例：给老板的月报）"
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-neutral-500">
          <input
            type="checkbox"
            checked={!!form.long}
            aria-label="长稿"
            onChange={(e) => setForm((f) => ({ ...f, long: e.target.checked }))}
            className="accent-violet-600"
          />
          长稿（先出提纲再写）
        </label>
      </div>

      <textarea
        value={form.prompt}
        aria-label="结构指令"
        rows={3}
        onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
        placeholder="体裁：月报。按「本月成果 / 下月目标」两个小节写，小节名就用这两个词、顺序不要变。全文不超过 400 字。"
        className="w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm outline-none placeholder:text-neutral-400 focus:border-violet-400 dark:border-neutral-700 dark:bg-neutral-900"
      />

      {err ? (
        <p data-template-err className="text-xs text-rose-600 dark:text-rose-400">
          {err}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={busy || !form.label.trim() || !form.prompt.trim()}
          className="rounded-lg bg-violet-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-40"
        >
          {busy ? '存中…' : isEdit ? '保存' : '存成模板'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="text-xs text-neutral-500 underline decoration-neutral-300 underline-offset-2 transition-colors hover:text-neutral-700 disabled:opacity-40 dark:text-neutral-400"
        >
          取消
        </button>
        {isEdit ? (
          <button
            onClick={() => void remove()}
            disabled={busy}
            title="删掉这份模板。已经写出去的成品一份都不动"
            className="ml-auto rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 opacity-60 transition-[color,border-color,opacity] hover:border-rose-300 hover:text-rose-600 hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400"
          >
            删掉这份模板
          </button>
        ) : null}
      </div>
    </div>
  )
}
