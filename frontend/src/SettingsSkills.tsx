// 技能分区（方向 6 第十二刀，2026-09-29 自 SettingsPage 拆出）：
// SKILL.md 指令包：从 URL 安装或手动放文件夹，对话时注入技能清单，
// 模型判断相关就自动加载全文执行。状态与处理器整体住在这里，挂载时自拉清单；
// 取数失败走 failLoad 汇总页级错误条。
import { useEffect, useState } from 'react'
import { Puzzle } from 'lucide-react'
import { api, type SkillItem } from './api'
import { inputCls } from './settingsShared'

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
    if (!confirm(`删除技能「${name}」？`)) return
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
    } catch (e) {
      setSkillMsg(`✗ ${String(e)}`)
    } finally {
      setSkillBusy(false)
    }
  }

  return (
    <section className="mb-6 flex flex-col gap-3 wb-card p-5">
      <h2 className="flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300"><Puzzle className="h-3.5 w-3.5" /></span></h2>
      <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
        SKILL.md 指令包：frontmatter 写 name/description（何时使用），正文是完整指导。对话时注入技能清单，模型判断相关就自动加载全文执行。
        技能存于 skills/ 目录，也可直接手动放文件夹进去。
      </p>
      {skillItems.map((s) => (
        <div key={s.name} className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">🧩 {s.name}</span>
                {s.model && <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">{s.model}</code>}
                {s.tools && <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">工具: {s.tools}</code>}
                <span className="text-xs text-neutral-400">{s.chars} 字 · {s.files.length} 个文件</span>
              </div>
              <div className="mt-0.5 text-xs text-neutral-500">{s.description}</div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <button onClick={() => editSkill(s.name)} className="text-sm text-blue-500 hover:text-blue-600">
                编辑
              </button>
              <button onClick={() => removeSkill(s.name)} className="text-sm text-red-400 hover:text-red-600">
                删除
              </button>
            </div>
          </div>
          {editingSkill === s.name ? (
            <div className="mt-2">
              <textarea
                value={skillDraft}
                onChange={(e) => setSkillDraft(e.target.value)}
                className={`${inputCls} min-h-[160px] w-full font-mono text-xs leading-relaxed`}
                placeholder="粘贴 SKILL.md 全文（frontmatter name/description + 正文）"
              />
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => saveSkill(s.name)}
                  disabled={skillBusy}
                  className="wb-btn-primary px-3 py-1 text-sm"
                >
                  {skillBusy ? '保存中…' : '保存'}
                </button>
                <button
                  onClick={() => setEditingSkill(null)}
                  className="rounded-md border border-neutral-300 px-3 py-1 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
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
          )}
        </div>
      ))}
      {!skillItems.length && <p className="text-sm text-neutral-400">还没有技能</p>}
      <div className="flex gap-2">
        <input
          value={skillUrl}
          onChange={(e) => setSkillUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && installSkill()}
          placeholder="粘贴 GitHub 上的 SKILL.md 地址（blob 或 raw 链接均可）"
          className={`${inputCls} flex-1`}
        />
        <button
          onClick={installSkill}
          disabled={skillBusy || !skillUrl.trim()}
          className="wb-btn-primary shrink-0 px-4 py-1.5 text-sm"
        >
          {skillBusy ? '安装中…' : '从 URL 安装'}
        </button>
      </div>
      {skillMsg && <div className="text-xs text-neutral-600 dark:text-neutral-300">{skillMsg}</div>}
    </section>
  )
}
