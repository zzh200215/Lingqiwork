// 技能分区（方向 6 第十二刀拆出，2026-10-02 设置中心改版）：
// SKILL.md 指令包：从 URL 安装或手动放文件夹，对话时注入技能清单，
// 模型判断相关就自动加载全文执行。清单挂载时自拉；编辑器住右侧抽屉，
// 页面只留「查看内容」的折叠详情与安装入口。
import { useEffect, useState } from 'react'
import { api, type SkillItem } from './api'
import { inputCls } from './settingsShared'
import { askConfirm, Drawer, SettingActions, SettingGroup } from './SettingsUI'
import EmptyHint from './EmptyHint'

export default function SettingsSkills({
  failLoad,
}: {
  failLoad: (what: string, e: unknown) => void
}) {
  const [skillItems, setSkillItems] = useState<SkillItem[]>([])
  const [skillUrl, setSkillUrl] = useState('')
  const [skillBusy, setSkillBusy] = useState(false)
  const [skillMsg, setSkillMsg] = useState('')
  const [skillContent, setSkillContent] = useState<Record<string, string>>({})
  const [editingSkill, setEditingSkill] = useState<string | null>(null)
  const [skillDraft, setSkillDraft] = useState('')
  const [skillDrawer, setSkillDrawer] = useState(false)

  useEffect(() => {
    api.listSkills().then((r) => setSkillItems(r.skills)).catch((e) => failLoad('技能', e))
  }, [failLoad])

  // ---- skills ----

  async function installSkill() {
    const url = skillUrl.trim()
    if (!url || skillBusy) return
    setSkillBusy(true)
    setSkillMsg('下载并安装中…')
    try {
      const r = await api.installSkill(url)
      setSkillUrl('')
      setSkillMsg(`✓ 已安装技能「${r.name}」(${r.chars} 字)`)
      setSkillItems((await api.listSkills()).skills)
    } catch (e) {
      setSkillMsg(`✗ ${String(e)}`)
    } finally {
      setSkillBusy(false)
    }
  }

  async function removeSkill(name: string) {
    if (!(await askConfirm({ title: `删除技能「${name}」？`, confirmLabel: '删除' }))) return
    await api.deleteSkill(name).catch((e) => setSkillMsg(`✗ ${String(e)}`))
    setSkillItems((await api.listSkills()).skills)
  }

  async function viewSkill(name: string) {
    if (skillContent[name] !== undefined) return
    try {
      const r = await api.readSkill(name)
      setSkillContent((m) => ({ ...m, [name]: r.content }))
    } catch {
      setSkillContent((m) => ({ ...m, [name]: '（加载失败）' }))
    }
  }

  async function editSkill(name: string) {
    try {
      const r = await api.readSkill(name)
      setSkillContent((m) => ({ ...m, [name]: r.content }))
      setSkillDraft(r.raw)
      setEditingSkill(name)
      setSkillDrawer(true)
    } catch {
      setSkillMsg('（加载失败）')
    }
  }

  async function saveSkill(name: string) {
    if (!skillDraft.trim()) {
      setSkillMsg('✗ 内容不能为空')
      return
    }
    setSkillBusy(true)
    setSkillMsg('保存中…')
    try {
      const r = await api.updateSkill(name, skillDraft)
      setEditingSkill(null)
      setSkillContent((m) => {
        const next = { ...m }
        delete next[name]
        delete next[r.name]
        return next
      })
      setSkillMsg(`✓ 已保存技能「${r.name}」(${r.chars} 字)`)
      setSkillItems((await api.listSkills()).skills)
      setSkillDrawer(false)
    } catch (e) {
      setSkillMsg(`✗ ${String(e)}`)
    } finally {
      setSkillBusy(false)
    }
  }

  return (
    <SettingGroup
      title="技能"
      description="SKILL.md 指令包：frontmatter 写 name/description（何时使用），正文是完整指导。对话时注入技能清单，模型判断相关就自动加载全文执行。技能存于 skills/ 目录，也可直接手动放文件夹进去。"
      divide={false}
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        {skillItems.map((s) => (
          <div key={s.name} className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
            <div className="flex items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">🧩 {s.name}</span>
                  {s.model && <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">{s.model}</code>}
                  {s.tools && <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">工具: {s.tools}</code>}
                  <span className="text-xs text-neutral-400">{s.chars} 字 · {s.files.length} 个文件</span>
                </div>
                <div className="mt-0.5 text-xs text-neutral-500">{s.description}</div>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-sm">
                <button
                  onClick={() => editSkill(s.name)}
                  className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                >
                  编辑
                </button>
                <button onClick={() => removeSkill(s.name)} className="text-red-400 hover:text-red-600">
                  删除
                </button>
              </div>
            </div>
            <details
              className="mt-2 text-xs text-neutral-500"
              onToggle={(e) => {
                if ((e.target as HTMLDetailsElement).open) void viewSkill(s.name)
              }}
            >
              <summary className="cursor-pointer select-none">查看内容</summary>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-3 leading-relaxed dark:bg-neutral-900">
                {skillContent[s.name] ?? '加载中…'}
              </pre>
            </details>
          </div>
        ))}
        {!skillItems.length && (
          <EmptyHint
            pad="sm"
            title="还没有技能。"
            hint="粘贴 GitHub 上的 SKILL.md 地址从 URL 安装，或把文件夹直接放进 skills/。"
          />
        )}
        {/* 安装入口：一行动作（URL + 按钮），不是设置 */}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">从 URL 安装</span>
            <input
              value={skillUrl}
              onChange={(e) => setSkillUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && installSkill()}
              placeholder="粘贴 GitHub 上的 SKILL.md 地址（blob 或 raw 链接均可）"
              className={inputCls}
            />
          </label>
          <button
            onClick={installSkill}
            disabled={skillBusy || !skillUrl.trim()}
            className="wb-btn-primary px-4 py-1.5 text-sm"
          >
            {skillBusy ? '安装中…' : '安装'}
          </button>
        </div>
        {skillMsg && <div className="text-xs text-neutral-600 dark:text-neutral-300">{skillMsg}</div>}
      </div>

      <Drawer
        open={skillDrawer}
        onClose={() => setSkillDrawer(false)}
        title={`编辑技能「${editingSkill ?? ''}」`}
        description="SKILL.md 全文：frontmatter（name/description）+ 正文指导。"
        footer={
          <SettingActions
            left={
              <>
                <button
                  onClick={() => setSkillDrawer(false)}
                  className="rounded-md px-4 py-1.5 text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                >
                  取消
                </button>
              </>
            }
          >
            <button onClick={() => editingSkill && saveSkill(editingSkill)} disabled={skillBusy} className="wb-btn-primary px-4 py-1.5 text-sm">
              {skillBusy ? '保存中…' : '保存'}
            </button>
          </SettingActions>
        }
      >
        <textarea
          value={skillDraft}
          onChange={(e) => setSkillDraft(e.target.value)}
          className={`${inputCls} min-h-[360px] w-full font-mono text-xs leading-relaxed`}
          placeholder="粘贴 SKILL.md 全文（frontmatter name/description + 正文）"
        />
      </Drawer>
    </SettingGroup>
  )
}
