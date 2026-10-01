// 提示词库分区（方向 6 第十二刀，2026-09-29 自 SettingsPage 拆出）：
// 常用提示词存成模板，对话页输入框敲 / 即可唤起，支持 {变量} 占位符。
// 状态与处理器整体住在这里，挂载时自拉清单；取数失败走 failLoad 汇总页级错误条；
// 保存/删除的失败信息沿用页面的 setError（与 Provider 编辑同一处展示）。
import { useEffect, useState } from 'react'
import { ScrollText } from 'lucide-react'
import { api, type PromptItem } from './api'
import { inputCls } from './settingsShared'

export default function SettingsPrompts({
  failLoad,
  setError,
}: {
  failLoad: (what: string, e: unknown) => void
  setError: (msg: string) => void
}) {
  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [promptDraft, setPromptDraft] = useState({ title: '', content: '' })
  const [promptEditId, setPromptEditId] = useState<number | null>(null)

  useEffect(() => {
    api.listPrompts().then(setPrompts).catch((e) => failLoad('系统提示词', e))
  }, [failLoad])

  // ---- prompt library ----

  async function savePrompt() {
    if (!promptDraft.title.trim()) {
      setError('提示词标题必填')
      return
    }
    try {
      if (promptEditId != null) await api.updatePrompt(promptEditId, promptDraft)
      else await api.createPrompt(promptDraft)
      setPromptDraft({ title: '', content: '' })
      setPromptEditId(null)
      setError('')
      setPrompts(await api.listPrompts())
    } catch (e) {
      setError(String(e))
    }
  }

  async function removePrompt(id: number) {
    if (!confirm('删除该提示词？')) return
    await api.deletePrompt(id)
    if (promptEditId === id) {
      setPromptEditId(null)
      setPromptDraft({ title: '', content: '' })
    }
    setPrompts(await api.listPrompts())
  }

  return (
    <section className="mb-6 flex flex-col gap-3 wb-card p-5">
      <h2 className="flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"><ScrollText className="h-3.5 w-3.5" /></span></h2>
      <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
        常用提示词存成模板，对话页输入框敲 <code className="text-neutral-500">/</code> 即可唤起。
        内容支持 <code className="text-neutral-500">{'{变量}'}</code> 占位符，使用时会逐个询问填入。
      </p>
      {prompts.map((p) => (
        <div
          key={p.id}
          className="flex items-start justify-between rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800"
        >
          <div className="min-w-0">
            <span className="font-medium">/{p.title}</span>
            <div className="truncate text-xs text-neutral-500">{p.content}</div>
          </div>
          <div className="flex shrink-0 gap-2 text-sm">
            <button
              onClick={() => {
                setPromptEditId(p.id)
                setPromptDraft({ title: p.title, content: p.content })
              }}
              className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              编辑
            </button>
            <button onClick={() => removePrompt(p.id)} className="text-red-400 hover:text-red-600">
              删除
            </button>
          </div>
        </div>
      ))}
      {!prompts.length && <p className="text-sm text-neutral-400">还没有提示词模板</p>}

      <div className="wb-card p-5">
        <h3 className="mb-3 text-sm font-medium">
          {promptEditId != null ? `编辑「${promptDraft.title}」` : '新增提示词'}
        </h3>
        <label className="flex flex-col gap-1 text-sm">
          标题（对话页输入 / 后按此匹配）
          <input
            value={promptDraft.title}
            onChange={(e) => setPromptDraft({ ...promptDraft, title: e.target.value })}
            placeholder="翻译成英文 / 周报生成…"
            className={inputCls}
          />
        </label>
        <label className="mt-3 flex flex-col gap-1 text-sm">
          提示词内容（{'{变量}'} 会在使用时询问）
          <textarea
            value={promptDraft.content}
            onChange={(e) => setPromptDraft({ ...promptDraft, content: e.target.value })}
            rows={3}
            placeholder={'把下面的内容翻译成英文，保留代码块：\n\n{内容}'}
            className={`${inputCls} resize-y`}
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          {promptEditId != null && (
            <button
              onClick={() => {
                setPromptEditId(null)
                setPromptDraft({ title: '', content: '' })
              }}
              className="rounded-md px-4 py-1.5 text-sm text-neutral-500"
            >
              取消
            </button>
          )}
          <button
            onClick={savePrompt}
            className="wb-btn-primary px-4 py-1.5 text-sm"
          >
            {promptEditId != null ? '保存修改' : '添加'}
          </button>
        </div>
      </div>
    </section>
  )
}
