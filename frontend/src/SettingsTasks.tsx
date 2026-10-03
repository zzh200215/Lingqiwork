// 定时任务分区（方向 6 第十一刀拆出，2026-10-02 设置中心改版）：
// `?section=automation` 的执行面——简单执行 / 自主智能体 / 链式触发、工具白名单、
// NL 解析与执行日志。任务清单是页面主角；二十多个字段的编辑器搬进右侧抽屉，
// 内部分「基础 / 触发 / 能力 / 高级」四层，高级默认折叠。
// 挂载时自拉任务与工具清单；取数失败走 failLoad 汇总页级错误条。
import { useEffect, useState } from 'react'
import {
  api,
  type ProviderConfig,
  type ScheduledTask,
  type TaskRunItem,
  type TaskTool,
} from './api'
import { fmtTime, inputCls } from './settingsShared'
import { askConfirm, Drawer, ResCard, SettingField, SettingGroup, SettingSwitch } from './SettingsUI'
import EmptyHint from './EmptyHint'

// 这一步做什么（§15）：跑提示词 / 转写录音 / 把一个成文引擎按表跑一遍。
// 引擎名与后端 core.tasks.ENGINE_ACTIONS 一一对应；产出落进引擎自己的 vault 目录。
type TaskAction =
  | 'prompt'
  | 'transcribe'
  | 'research'
  | 'compose'
  | 'recap'
  | 'decide'
  | 'conflict'

const ENGINE_ACTIONS: { value: TaskAction; label: string; short: string }[] = [
  { value: 'research', label: '研究（拿话题去查，成文落 research/）', short: '研究' },
  { value: 'compose', label: '产出（从你自己的材料成文，落 notes/）', short: '产出' },
  { value: 'decide', label: '方案（就一个待定的事出方案，落 decisions/）', short: '方案' },
  { value: 'conflict', label: '对质（查材料里对不上的地方，落 conflicts/）', short: '对质' },
  { value: 'recap', label: '复盘（把最近几天的记录合成一份，落 recap/）', short: '复盘' },
]

const ACTION_SHORT: Record<string, string> = Object.fromEntries(
  ENGINE_ACTIONS.map((e) => [e.value, e.short])
)

const EMPTY_TASK = {
  name: '',
  prompt: '',
  cron: '0 9 * * *',
  model_id: '',
  use_rag: false,
  tools_enabled: true,
  save_to_vault: false,
  enabled: true,
  mode: 'simple' as 'simple' | 'agent',
  tool_whitelist: '',
  max_rounds: 12,
  retry: 1,
  timeout_seconds: null as number | null,
  gate_min_grounded: null as number | null,
  notify_on_error: false,
  trigger_kind: 'cron' as 'cron' | 'watch' | 'chain',
  watch_path: '',
  chain_next_id: null as number | null,
  require_approval: false,
  action: 'prompt' as TaskAction,
  landing_dir: '',
}

/** 抽屉里的小节标题：不做卡片（抽屉已经是一层面），一条小节名 + 分隔就够。 */
function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-neutral-100 pt-4 first:border-t-0 first:pt-0 dark:border-neutral-800/80">
      <p className="mb-3 text-xs font-medium uppercase tracking-wider text-neutral-400">{title}</p>
      <div className="flex flex-col gap-3.5">{children}</div>
    </section>
  )
}

/** 抽屉里的开关行：左说明、右开关（与 SettingRow 同构，但不带分组的内边距）。 */
function DrawerSwitchRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 rounded-lg border px-3.5 py-2.5 dark:border-neutral-800 ${
        disabled ? 'opacity-50' : ''
      }`}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{description}</p>
      </div>
      <SettingSwitch checked={checked} disabled={disabled} onChange={onChange} ariaLabel={title} />
    </div>
  )
}

export default function SettingsTasks({
  providers,
  failLoad,
}: {
  providers: ProviderConfig[]
  failLoad: (what: string, e: unknown) => void
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [taskDraft, setTaskDraft] = useState({ ...EMPTY_TASK })
  const [taskEditId, setTaskEditId] = useState<number | null>(null)
  const [taskDrawer, setTaskDrawer] = useState(false)
  const [taskNl, setTaskNl] = useState('')
  const [taskBusy, setTaskBusy] = useState('')  // 'parse' | 'run-<id>' | ''
  const [taskMsg, setTaskMsg] = useState('')
  const [taskTools, setTaskTools] = useState<TaskTool[]>([])
  const [taskRuns, setTaskRuns] = useState<Record<number, TaskRunItem[]>>({})

  useEffect(() => {
    api.listTasks().then(setTasks).catch((e) => failLoad('定时任务', e))
    api.listTaskTools().then(setTaskTools).catch((e) => failLoad('任务工具', e))
  }, [failLoad])

  // ---- scheduled tasks ----

  async function saveTask() {
    if (!taskDraft.name.trim() || !taskDraft.prompt.trim()) {
      setTaskMsg('✗ 任务名和指令都必填')
      return
    }
    if (taskDraft.trigger_kind === 'watch' && !taskDraft.watch_path.trim()) {
      setTaskMsg('✗ 文件变化触发需要填写监听路径（留空表示整个 vault 可直接选 cron）')
      return
    }
    const payload = {
      ...taskDraft,
      name: taskDraft.name.trim(),
      prompt: taskDraft.prompt.trim(),
      cron: taskDraft.cron.trim(),
      watch_path: taskDraft.watch_path.trim(),
    }
    try {
      if (taskEditId != null) await api.updateTask(taskEditId, payload)
      else await api.createTask(payload)
      setTaskDraft({ ...EMPTY_TASK })
      setTaskEditId(null)
      setTaskDrawer(false)
      setTaskMsg('')
      setTasks(await api.listTasks())
    } catch (e) {
      setTaskMsg(`✗ ${String(e)}`)
    }
  }

  function editTask(t: ScheduledTask) {
    setTaskEditId(t.id)
    setTaskMsg('')
    setTaskDraft({
      name: t.name,
      prompt: t.prompt,
      cron: t.cron,
      model_id: t.model_id,
      use_rag: t.use_rag,
      tools_enabled: t.tools_enabled,
      save_to_vault: t.save_to_vault,
      enabled: t.enabled,
      mode: t.mode || 'simple',
      tool_whitelist: t.tool_whitelist || '',
      max_rounds: t.max_rounds || 12,
      retry: t.retry ?? 1,
      notify_on_error: !!t.notify_on_error,
      trigger_kind: t.trigger_kind || 'cron',
      watch_path: t.watch_path || '',
      chain_next_id: t.chain_next_id,
      require_approval: !!t.require_approval,
      timeout_seconds: t.timeout_seconds ?? null,
      gate_min_grounded: t.gate_min_grounded ?? null,
      action: (t.action as TaskAction) || 'prompt',
      landing_dir: t.landing_dir || '',
    })
    setTaskDrawer(true)
  }

  function startCreate() {
    setTaskEditId(null)
    setTaskDraft({ ...EMPTY_TASK })
    setTaskNl('')
    setTaskMsg('')
    setTaskDrawer(true)
  }

  function toggleTaskTool(name: string) {
    const selected = taskDraft.tool_whitelist.split(',').map((s) => s.trim()).filter(Boolean)
    const next = selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]
    setTaskDraft({ ...taskDraft, tool_whitelist: next.join(',') })
  }

  function taskToolChecked(name: string): boolean {
    // empty whitelist = no restriction (all tools on)
    if (!taskDraft.tool_whitelist.trim()) return false
    return taskDraft.tool_whitelist.split(',').map((s) => s.trim()).includes(name)
  }

  async function loadRuns(t: ScheduledTask) {
    if (taskRuns[t.id]) return
    setTaskRuns((m) => ({ ...m, [t.id]: [] }))
    try {
      const runs = await api.listTaskRuns(t.id)
      setTaskRuns((m) => ({ ...m, [t.id]: runs }))
    } catch {
      setTaskRuns((m) => {
        const copy = { ...m }
        delete copy[t.id]
        return copy
      })
    }
  }

  function chainName(id: number | null | undefined): string {
    if (id == null) return ''
    return tasks.find((x) => x.id === id)?.name || `#${id}`
  }

  async function removeTask(t: ScheduledTask) {
    if (
      !(await askConfirm({
        title: `删除定时任务「${t.name}」？`,
        description: '历史会话不会被删除。',
        confirmLabel: '删除',
      }))
    )
      return
    await api.deleteTask(t.id).catch((e) => setTaskMsg(`✗ ${String(e)}`))
    if (taskEditId === t.id) {
      setTaskEditId(null)
      setTaskDraft({ ...EMPTY_TASK })
      setTaskDrawer(false)
    }
    setTasks(await api.listTasks())
  }

  async function toggleTask(t: ScheduledTask) {
    await api.updateTask(t.id, { enabled: !t.enabled }).catch((e) => setTaskMsg(`✗ ${String(e)}`))
    setTasks(await api.listTasks())
  }

  async function runTaskNow(t: ScheduledTask) {
    setTaskBusy(`run-${t.id}`)
    setTaskMsg('')
    try {
      const r = await api.runTask(t.id)
      setTaskMsg(
        r.status === 'ok'
          ? `✓ 「${t.name}」执行成功（${r.model_id}${r.sources ? `，引用 ${r.sources} 个片段` : ''}` +
            (r.tool_calls ? `，${r.rounds} 轮 ${r.tool_calls} 次工具调用` : '') +
            (r.vault_file ? `，已写入 ${r.vault_file}` : '') +
            '）'
          : `✗ 「${t.name}」执行失败：${r.error}`
      )
      setTasks(await api.listTasks())
      setTaskRuns((m) => {
        const copy = { ...m }
        delete copy[t.id]  // refetch on next expand
        return copy
      })
    } catch (e) {
      setTaskMsg(`✗ ${String(e)}`)
    } finally {
      setTaskBusy('')
    }
  }

  async function parseTaskNl() {
    if (!taskNl.trim()) return
    setTaskBusy('parse')
    setTaskMsg('')
    try {
      const d = await api.parseTask(taskNl.trim())
      setTaskDraft({ ...EMPTY_TASK, ...taskDraft, name: d.name, prompt: d.prompt, cron: d.cron })
      setTaskMsg(`✓ 已解析为 cron「${d.cron}」，确认后点「添加」`)
    } catch (e) {
      setTaskMsg(`✗ ${String(e)}`)
    } finally {
      setTaskBusy('')
    }
  }

  return (
    <SettingGroup
      title="定时任务"
      description="三种玩法：① 简单执行——到点跑一条指令（可带知识库与工具）；② 自主智能体——给目标让它多轮调用工具干到完成，全程留执行日志；③ 任务链——上游任务的产出自动交给下游继续处理。触发支持 cron 或 vault 文件变化。"
      actions={
        <button onClick={startCreate} className="wb-btn-primary px-3 py-1.5 text-sm">
          ＋ 创建任务
        </button>
      }
      divide={false}
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        {taskMsg && <div className="text-xs text-neutral-600 dark:text-neutral-300">{taskMsg}</div>}
        {tasks.map((t) => (
          <ResCard
            key={t.id}
            title={
              <>
                <span className="font-medium">{t.mode === 'agent' ? '🤖' : t.trigger_kind === 'watch' ? '📁' : t.trigger_kind === 'chain' ? '🔗' : '⏰'} {t.name}</span>
                {t.mode === 'agent' && (
                  <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-600 dark:bg-violet-950 dark:text-violet-300">
                    自主智能体
                  </span>
                )}
                {t.trigger_kind === 'watch' ? (
                  <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                    📁 监听 {t.watch_path || '/'}
                  </code>
                ) : t.trigger_kind === 'chain' ? (
                  <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                    🔗 链条下游
                  </code>
                ) : (
                  <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                    {t.cron}
                  </code>
                )}
                {t.chain_next_id != null && (
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                    → {chainName(t.chain_next_id)}
                  </span>
                )}
                {t.running && (
                  <span className="animate-pulse rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-600 dark:bg-violet-950 dark:text-violet-300">
                    运行中…
                  </span>
                )}
                {!t.enabled && <span className="text-xs text-red-500">已停用</span>}
                {t.last_status === 'ok' && !t.running && <span className="text-xs text-emerald-500">上次 ✓</span>}
                {t.last_status === 'error' && <span className="text-xs text-red-500">上次 ✗</span>}
              </>
            }
            meta={
              <>
                <span className="block truncate">{t.prompt}</span>
                <span className="mt-0.5 block text-neutral-400">
                  {t.trigger_kind === 'watch'
                    ? `文件变化触发${t.watch_path ? ` · ${t.watch_path}` : ' · 整个 vault'}`
                    : t.trigger_kind === 'chain'
                      ? '由上游任务交接触发，自己不跑'
                      : `下次 ${t.enabled ? fmtTime(t.next_run) : '—'}`}
                  {' · '}上次 {fmtTime(t.last_run)}
                  {t.model_id && ` · ${t.model_id}`}
                  {t.use_rag && ' · RAG'}
                  {t.mode === 'agent' ? ` · 智能体 ≤${t.max_rounds} 轮` : !t.tools_enabled && ' · 无工具'}
                  {t.save_to_vault && ' · 写入 vault'}
                  {t.action === 'transcribe' && ' · 转写'}
                  {ACTION_SHORT[t.action] && ` · ${ACTION_SHORT[t.action]}引擎`}
                  {t.require_approval && ' · 卡点'}
                  {t.gate_min_grounded != null && ` · 门禁 ≥${t.gate_min_grounded}`}
                  {(t.timeout_seconds ?? 0) > 0 && ` · 超时 ${t.timeout_seconds}s`}
                  {(t.retry ?? 0) > 0 && ` · 失败重试 ${t.retry}`}
                </span>
              </>
            }
            actions={
              <>
                <button
                  onClick={() => runTaskNow(t)}
                  disabled={taskBusy === `run-${t.id}`}
                  className="text-violet-600 hover:underline disabled:opacity-50 dark:text-violet-300"
                >
                  {taskBusy === `run-${t.id}` ? '运行中…' : '立即运行'}
                </button>
                {t.conversation_id && (
                  <a href={`/?conv=${t.conversation_id}`} className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
                    会话
                  </a>
                )}
                <button onClick={() => toggleTask(t)} className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
                  {t.enabled ? '停用' : '启用'}
                </button>
                <button onClick={() => editTask(t)} className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
                  编辑
                </button>
                <button onClick={() => removeTask(t)} className="text-red-400 hover:text-red-600">
                  删除
                </button>
              </>
            }
          >
            {t.last_result && (
              <details className="mt-2 text-xs text-neutral-500">
                <summary className="cursor-pointer select-none">上次结果</summary>
                <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-3 leading-relaxed dark:bg-neutral-900">
                  {t.last_result}
                </pre>
              </details>
            )}
            <details
              className="mt-2 text-xs text-neutral-500"
              onToggle={(e) => {
                if ((e.target as HTMLDetailsElement).open) void loadRuns(t)
              }}
            >
              <summary className="cursor-pointer select-none">运行记录</summary>
              <div className="mt-2 space-y-1.5">
                {(taskRuns[t.id] || []).map((r) => (
                  <details key={r.id} className="rounded-md bg-neutral-50 px-2.5 py-1.5 dark:bg-neutral-900">
                    <summary className="flex cursor-pointer flex-wrap select-none items-center gap-2">
                      <span
                        className={
                          r.status === 'ok' ? 'text-emerald-600' : r.status === 'running' ? 'text-amber-500' : 'text-red-500'
                        }
                      >
                        {r.status === 'ok' ? '✓' : r.status === 'running' ? '…' : '✗'}
                      </span>
                      <span>{fmtTime(r.started_at)}</span>
                      <span className="text-neutral-400">
                        {r.trigger === 'chain'
                          ? `链 · 来自 ${chainName(r.upstream_task_id)}`
                          : { cron: '定时', manual: '手动', watch: '文件变化' }[r.trigger] || r.trigger}
                      </span>
                      {r.tool_calls > 0 && (
                        <span className="text-neutral-400">
                          {r.rounds} 轮 · {r.tool_calls} 次工具调用
                        </span>
                      )}
                      {r.status === 'error' && <span className="truncate text-red-400">{r.error}</span>}
                    </summary>
                    {r.log.length > 0 && (
                      <div className="mt-1.5 space-y-1">
                        {r.log.map((entry, i) => (
                          <div key={i} className="rounded bg-white px-2 py-1 dark:bg-neutral-800">
                            <div className="font-mono">{entry.ok ? '🔧' : '⚠️'} {entry.tool}</div>
                            <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-neutral-400">
                              {JSON.stringify(entry.args)}
                            </pre>
                            <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-neutral-500">{entry.result}</pre>
                          </div>
                        ))}
                      </div>
                    )}
                    {r.status === 'ok' && r.answer && (
                      <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap text-neutral-500">{r.answer}</pre>
                    )}
                  </details>
                ))}
                {taskRuns[t.id] && taskRuns[t.id].length === 0 && <p className="text-neutral-400">还没有运行记录</p>}
                {!taskRuns[t.id] && <p className="text-neutral-400">加载中…</p>}
              </div>
            </details>
          </ResCard>
        ))}
        {!tasks.length && (
          <EmptyHint
            pad="sm"
            title="还没有定时任务。"
            hint="点右上「＋ 创建任务」，用一句中文描述（如「每天早上 8 点总结知识库新增内容」）让模型帮你起草。"
          />
        )}
      </div>

      {/* 任务编辑抽屉：基础 / 触发 / 能力 / 高级——高级默认折叠，二十多个字段不再一次全摊开 */}
      <Drawer
        open={taskDrawer}
        onClose={() => setTaskDrawer(false)}
        title={taskEditId != null ? `编辑「${taskDraft.name || '任务'}」` : '创建定时任务'}
        description="时间用 5 段 crontab：分 时 日 月 周（本地时区）。"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setTaskDrawer(false)}
              className="rounded-md px-4 py-1.5 text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              取消
            </button>
            <button onClick={saveTask} className="wb-btn-primary px-4 py-1.5 text-sm">
              {taskEditId != null ? '保存修改' : '添加'}
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-5">
          {/* NL 起草：新建时才有——编辑一个既有任务时它只会碍事 */}
          {taskEditId == null && (
            <SettingField
              label="用中文描述这个任务"
              hint="模型帮你转成 cron 并起草指令；解析后下面各栏会自动填好。"
            >
              <div className="flex gap-2">
                <input
                  value={taskNl}
                  onChange={(e) => setTaskNl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void parseTaskNl()
                    }
                  }}
                  placeholder="每天早上 8 点帮我总结知识库新增内容"
                  className={`${inputCls} flex-1`}
                />
                <button
                  onClick={parseTaskNl}
                  disabled={taskBusy === 'parse' || !taskNl.trim()}
                  className="wb-btn-ghost shrink-0 px-3 py-1.5 text-sm"
                >
                  {taskBusy === 'parse' ? '解析中…' : '解析'}
                </button>
              </div>
            </SettingField>
          )}
          {taskMsg && <p className="text-xs text-neutral-500">{taskMsg}</p>}

          <DrawerSection title="基础">
            <div className="grid grid-cols-[1fr_150px] gap-3">
              <SettingField label="任务名">
                <input
                  value={taskDraft.name}
                  onChange={(e) => setTaskDraft({ ...taskDraft, name: e.target.value })}
                  placeholder="知识库日报"
                  className={inputCls}
                />
              </SettingField>
              <SettingField label="执行模式">
                <select
                  value={taskDraft.mode}
                  onChange={(e) => setTaskDraft({ ...taskDraft, mode: e.target.value as 'simple' | 'agent' })}
                  className={inputCls}
                >
                  <option value="simple">简单执行</option>
                  <option value="agent">自主智能体</option>
                </select>
              </SettingField>
            </div>
            <SettingField
              label="指令"
              hint={
                ACTION_SHORT[taskDraft.action]
                  ? '给引擎的话题——它拿这个去取材成文。'
                  : taskDraft.mode === 'agent'
                    ? '给智能体的目标，它会自己决定调用哪些工具。'
                    : '到点发给模型的内容。'
              }
            >
              <textarea
                value={taskDraft.prompt}
                onChange={(e) => setTaskDraft({ ...taskDraft, prompt: e.target.value })}
                rows={3}
                placeholder={ACTION_SHORT[taskDraft.action] ? '如：RAG 评测怎么做（复盘不用填，把最近几天合成一份）' : taskDraft.mode === 'agent' ? '整理 vault/tasks/ 下最近生成的日报，把要点合并成一篇周报写到 vault/reports/。' : '总结我知识库里最近新增或修改的内容，按主题归纳要点。'}
                className={`${inputCls} resize-y`}
              />
            </SettingField>
            <SettingField label="模型" hint="留空 = 第一个启用的 provider。">
              <select
                value={taskDraft.model_id}
                onChange={(e) => setTaskDraft({ ...taskDraft, model_id: e.target.value })}
                className={inputCls}
              >
                <option value="">自动选择</option>
                {providers
                  .flatMap((p) => (p.enabled ? p.models.map((m) => `${p.name}/${m}`) : []))
                  .map((mid) => (
                    <option key={mid} value={mid}>
                      {mid}
                    </option>
                  ))}
              </select>
            </SettingField>
            <DrawerSwitchRow
              title="启用"
              description="停用的任务保留配置，不再触发。"
              checked={taskDraft.enabled}
              onChange={(v) => setTaskDraft({ ...taskDraft, enabled: v })}
            />
          </DrawerSection>

          <DrawerSection title="触发">
            <div className="grid grid-cols-[170px_1fr] items-start gap-3">
              <SettingField label="触发方式">
                <select
                  value={taskDraft.trigger_kind}
                  onChange={(e) => setTaskDraft({ ...taskDraft, trigger_kind: e.target.value as 'cron' | 'watch' | 'chain' })}
                  className={inputCls}
                >
                  <option value="cron">定时（cron）</option>
                  <option value="watch">文件变化</option>
                  <option value="chain">链条下游</option>
                </select>
              </SettingField>
              {taskDraft.trigger_kind === 'watch' ? (
                <SettingField
                  label="监听路径"
                  hint="vault 内相对路径，目录或单个文件。文件新增/修改后自动运行；同一任务 90 秒冷却，任务自己写入的文件不会再次触发自己。"
                >
                  <input
                    value={taskDraft.watch_path}
                    onChange={(e) => setTaskDraft({ ...taskDraft, watch_path: e.target.value })}
                    placeholder="如 feeds/ 或 notes/日记.md"
                    className={`${inputCls} font-mono`}
                  />
                </SettingField>
              ) : taskDraft.trigger_kind === 'chain' ? (
                <p className="self-end pb-1.5 text-xs text-neutral-400">
                  只由上游任务交接触发——自己不会跑。串一条流水线时，下游步骤都用这个。
                </p>
              ) : (
                <SettingField label="cron" hint="5 段 crontab：分 时 日 月 周（本地时区）。">
                  <input
                    value={taskDraft.cron}
                    onChange={(e) => setTaskDraft({ ...taskDraft, cron: e.target.value })}
                    placeholder="0 9 * * *"
                    className={`${inputCls} font-mono`}
                  />
                </SettingField>
              )}
            </div>
            <SettingField
              label="下游任务"
              hint="任务链：本任务成功后，产出经 vault/tasks/handoff/ 自动交给下游继续处理。"
            >
              <select
                value={taskDraft.chain_next_id ?? ''}
                onChange={(e) =>
                  setTaskDraft({ ...taskDraft, chain_next_id: e.target.value === '' ? null : Number(e.target.value) })
                }
                className={inputCls}
              >
                <option value="">无（不链接下游）</option>
                {tasks
                  .filter((x) => x.id !== taskEditId)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </select>
            </SettingField>
          </DrawerSection>

          <DrawerSection title="能力">
            <DrawerSwitchRow
              title="检索知识库（RAG）"
              description="跑之前先检索 vault 与知识库，把相关片段带进上下文。"
              checked={taskDraft.use_rag}
              onChange={(v) => setTaskDraft({ ...taskDraft, use_rag: v })}
            />
            {taskDraft.mode === 'simple' && (
              <DrawerSwitchRow
                title="允许使用工具"
                description="联网、读写 vault 等内置与 MCP 工具。"
                checked={taskDraft.tools_enabled}
                onChange={(v) => setTaskDraft({ ...taskDraft, tools_enabled: v })}
              />
            )}
            <DrawerSwitchRow
              title="结果写入 vault/tasks/"
              description="自动进知识库索引。"
              checked={taskDraft.save_to_vault}
              onChange={(v) => setTaskDraft({ ...taskDraft, save_to_vault: v })}
            />
            {(taskDraft.mode === 'agent' || taskDraft.tools_enabled) && taskTools.length > 0 && (
              <div className="rounded-lg border border-neutral-200 px-3.5 py-2.5 dark:border-neutral-800">
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="text-sm font-medium">工具白名单</span>
                  <span className="text-xs text-neutral-400">
                    不勾选 = 全部可用；任务无人值守，建议只留必需工具
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1.5 md:grid-cols-3">
                  {taskTools.map((tool) => (
                    <label key={tool.name} className="flex min-w-0 items-center gap-1.5 text-xs" title={tool.description}>
                      <input
                        type="checkbox"
                        className="accent-violet-600"
                        checked={taskToolChecked(tool.name)}
                        onChange={() => toggleTaskTool(tool.name)}
                      />
                      <span className="truncate font-mono">{tool.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </DrawerSection>

          {/* 高级：智能体参数 / 可靠性 / 引擎产物。折叠不是藏——是不让它们挡在
              「起一个任务」这条最短路径上。 */}
          <details className="rounded-lg border border-neutral-200 px-3.5 py-2.5 dark:border-neutral-800">
            <summary className="cursor-pointer select-none text-sm font-medium">高级</summary>
            <div className="mt-3 flex flex-col gap-3.5">
              {taskDraft.mode === 'agent' && (
                <div className="grid grid-cols-2 gap-3">
                  <SettingField label="工具循环轮数上限" hint="1-30。">
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={taskDraft.max_rounds}
                      onChange={(e) => setTaskDraft({ ...taskDraft, max_rounds: Number(e.target.value) || 12 })}
                      className={inputCls}
                    />
                  </SettingField>
                  <SettingField label="失败自动重试" hint="0-3 次。">
                    <input
                      type="number"
                      min={0}
                      max={3}
                      value={taskDraft.retry}
                      onChange={(e) => setTaskDraft({ ...taskDraft, retry: Number(e.target.value) || 0 })}
                      className={inputCls}
                    />
                  </SettingField>
                  <SettingField label="步级超时秒数" hint="留空 = 默认 900。">
                    <input
                      type="number"
                      min={10}
                      max={7200}
                      value={taskDraft.timeout_seconds ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        setTaskDraft({ ...taskDraft, timeout_seconds: v === '' ? null : Number(v) })
                      }}
                      className={inputCls}
                    />
                  </SettingField>
                  <SettingField label="接地分门禁" hint="0–5，留空 = 只记分不挡道。">
                    <input
                      type="number"
                      step={0.5}
                      min={0}
                      max={5}
                      value={taskDraft.gate_min_grounded ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        setTaskDraft({ ...taskDraft, gate_min_grounded: v === '' ? null : Number(v) })
                      }}
                      className={inputCls}
                    />
                  </SettingField>
                </div>
              )}
              <div className="grid grid-cols-[1fr_150px] items-start gap-3">
                <SettingField label="这一步做什么">
                  <select
                    value={taskDraft.action}
                    onChange={(e) =>
                      setTaskDraft({ ...taskDraft, action: e.target.value as TaskAction })
                    }
                    className={inputCls}
                  >
                    <option value="prompt">跑提示词（交给模型）</option>
                    <option value="transcribe">转写录音（本地 ASR，不花模型钱）</option>
                    {ENGINE_ACTIONS.map((e) => (
                      <option key={e.value} value={e.value}>
                        {e.label}
                      </option>
                    ))}
                  </select>
                </SettingField>
                <SettingField label="产物落哪" hint="vault 内相对目录，留空 = tasks/。">
                  <input
                    value={taskDraft.landing_dir}
                    onChange={(e) => setTaskDraft({ ...taskDraft, landing_dir: e.target.value })}
                    placeholder="如 meetings"
                    className={`${inputCls} font-mono`}
                  />
                </SettingField>
              </div>
              <p className="text-xs leading-relaxed text-neutral-400">
                同一条链条的下游会继承上游定下的目录；由录音触发时还会再套一层「日期-录音名」。
              </p>
              <DrawerSwitchRow
                title="失败时邮件通知"
                description="需先在「邮件推送」里配好 SMTP。"
                checked={taskDraft.notify_on_error}
                onChange={(v) => setTaskDraft({ ...taskDraft, notify_on_error: v })}
              />
              <DrawerSwitchRow
                title="人工卡点"
                description="跑完等我点头再交给下游（在「工作」页放行）。"
                checked={taskDraft.require_approval}
                onChange={(v) => setTaskDraft({ ...taskDraft, require_approval: v })}
              />
            </div>
          </details>
        </div>
      </Drawer>
    </SettingGroup>
  )
}
