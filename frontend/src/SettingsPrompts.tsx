// 提示词库分区（方向 6 第十二刀拆出，2026-10-02 设置中心改版）：
// 常用提示词存成模板，对话页输入框敲 / 即可唤起，支持 {变量} 占位符。
// 清单挂载时自拉；取数失败走 failLoad 汇总页级错误条；编辑器住右侧抽屉。
import { useEffect, useState } from 'react'
import { api, type PromptItem } from './api'
import { inputCls } from './settingsShared'
import { askConfirm, Drawer, ResCard, SettingActions, SettingField, SettingGroup } from './SettingsUI'
import EmptyHint from './EmptyHint'

export default function SettingsPrompts({
  failLoad,
}: {
  failLoad: (what: string, e: unknown) => void
}) {
  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [promptDraft, setPromptDraft] = useState({ title: '', content: '' })
  const [promptEditId, setPromptEditId] = useState<number | null>(null)
  const [promptDrawer, setPromptDrawer] = useState(false)
  const [promptError, setPromptError] = useState('')

  useEffect(() => {
    api.listPrompts().then(setPrompts).catch((e) => failLoad('系统提示词', e))
  }, [failLoad])

  // ---- prompt library ----

  async function savePrompt() {
    if (!promptDraft.title.trim()) {
      setPromptError('提示词标题必填')
      return
    }
    try {
      if (promptEditId != null) await api.updatePrompt(promptEditId, promptDraft)
      else await api.createPrompt(promptDraft)
      setPromptDraft({ title: '', content: '' })
      setPromptEditId(null)
      setPromptError('')
      setPromptDrawer(false)
      setPrompts(await api.listPrompts())
    } catch (e) {
      setPromptError(String(e))
    }
  }

  function startCreate() {
    setPromptEditId(null)
    setPromptDraft({ title: '', content: '' })
    setPromptError('')
    setPromptDrawer(true)
  }

  function startEdit(p: PromptItem) {
    setPromptEditId(p.id)
    setPromptDraft({ title: p.title, content: p.content })
    setPromptError('')
    setPromptDrawer(true)
  }

  async function removePrompt(id: number) {
    if (!(await askConfirm({ title: '删除该提示词？', confirmLabel: '删除' }))) return
    await api.deletePrompt(id)
    if (promptEditId === id) {
      setPromptEditId(null)
      setPromptDraft({ title: '', content: '' })
      setPromptDrawer(false)
    }
    setPrompts(await api.listPrompts())
  }

  return (
    <SettingGroup
      title="提示词模板"
      description={
        <>
          常用提示词存成模板，对话页输入框敲 <code className="text-neutral-500">/</code> 即可唤起。
          内容支持 <code className="text-neutral-500">{'{变量}'}</code> 占位符，使用时会逐个询问填入。
        </>
      }
      actions={
        <button onClick={startCreate} className="wb-btn-primary px-3 py-1.5 text-sm">
          ＋ 新建提示词
        </button>
      }
      divide={false}
    >
      <div className="grid gap-3 px-5 py-4 sm:grid-cols-2">
        {prompts.map((p) => (
          <ResCard
            key={p.id}
            title={<span className="font-medium">/{p.title}</span>}
            meta={<span className="block truncate">{p.content}</span>}
            actions={
              <>
                <button
                  onClick={() => startEdit(p)}
                  className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                >
                  编辑
                </button>
                <button onClick={() => removePrompt(p.id)} className="text-red-400 hover:text-red-600">
                  删除
                </button>
              </>
            }
          />
        ))}
      </div>
      {!prompts.length && (
        <div className="px-5 pb-4">
          <EmptyHint
            pad="sm"
            title="还没有提示词模板。"
            hint="把常用的指令存成 /模板，比如「/翻译」「/周报」，对话里敲 / 就能带上。"
          />
        </div>
      )}

      <Drawer
        open={promptDrawer}
        onClose={() => setPromptDrawer(false)}
        title={promptEditId != null ? `编辑「${promptDraft.title}」` : '新建提示词'}
        description="对话页输入 / 后按标题匹配唤起。"
        footer={
          <SettingActions left={promptError ? <p className="text-xs text-red-500">{promptError}</p> : null}>
            <button
              onClick={() => setPromptDrawer(false)}
              className="rounded-md px-4 py-1.5 text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              取消
            </button>
            <button onClick={savePrompt} className="wb-btn-primary px-4 py-1.5 text-sm">
              {promptEditId != null ? '保存修改' : '添加'}
            </button>
          </SettingActions>
        }
      >
        <div className="flex flex-col gap-4">
          <SettingField label="标题" hint="对话页输入 / 后按此匹配，短一点好记。">
            <input
              value={promptDraft.title}
              onChange={(e) => setPromptDraft({ ...promptDraft, title: e.target.value })}
              placeholder="翻译成英文 / 周报生成…"
              className={inputCls}
            />
          </SettingField>
          <SettingField label="提示词内容" hint="{'{变量}'} 会在使用时询问填入。">
            <textarea
              value={promptDraft.content}
              onChange={(e) => setPromptDraft({ ...promptDraft, content: e.target.value })}
              rows={5}
              placeholder={'把下面的内容翻译成英文，保留代码块：\n\n{内容}'}
              className={`${inputCls} resize-y`}
            />
          </SettingField>
        </div>
      </Drawer>
    </SettingGroup>
  )
}
