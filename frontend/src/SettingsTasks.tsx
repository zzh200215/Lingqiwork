// 定时任务分区（方向 6 第十一刀，2026-09-29 自 SettingsPage 拆出）：
// `?section=automation` 的执行卡——简单执行 / 自主智能体 / 链式触发、工具白名单、
// NL 解析与执行日志。状态与处理器整体住在这里，挂载时自拉任务与工具清单；
// 取数失败仍走 failLoad 汇总到页级错误条；providers 只读传入（表单的模型 datalist）。
import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import {
  api,
  type ProviderConfig,
  type ScheduledTask,
  type TaskRunItem,
  type TaskTool,
} from './api'
import { fmtTime, inputCls } from './settingsShared'

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
    if (!window.confirm(`删除定时任务「${t.name}」？历史会话不会被删除。`)) return
    await api.deleteTask(t.id).catch((e) => setTaskMsg(`✗ ${String(e)}`))
    if (taskEditId === t.id) {
      setTaskEditId(null)
      setTaskDraft({ ...EMPTY_TASK })
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
    <section className="mb-6 flex flex-col gap-3 wb-card p-5">
      <h2 className="flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300"><Clock className="h-3.5 w-3.5" /></span></h2>
      <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
        三种玩法：① 简单执行——到点跑一条指令（可带知识库与工具）；② 自主智能体——给目标让它多轮调用工具干到完成，全程留执行日志；
        ③ 任务链——上游任务的产出自动交给下游继续处理（经 vault/tasks/handoff/ 交接，可人工干预）。触发支持 cron 或 vault
        文件变化。时间用 5 段 crontab：<code className="text-neutral-500">分 时 日 月 周</code>（本地时区）。
      </p>
      {tasks.map((t) => (
        <div
          key={t.id}
          className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
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
              </div>
              <div className="truncate text-xs text-neutral-500">{t.prompt}</div>
              <div className="mt-0.5 text-xs text-neutral-400">
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
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2 text-sm">
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
            </div>
          </div>
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
        </div>
      ))}
      {!tasks.length && <p className="text-sm text-neutral-400">还没有定时任务</p>}
      <div className="wb-card p-5">
        <h3 className="mb-3 text-sm font-medium">
          {taskEditId != null ? `编辑「${taskDraft.name}」` : '新增定时任务'}
        </h3>
        <label className="flex flex-col gap-1 text-sm">
          用中文描述（模型帮你转成 cron 并起草指令）
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
              className="shrink-0 rounded-md border border-violet-500 px-3 py-1.5 text-sm font-medium text-violet-600 transition-colors hover:bg-violet-50 disabled:opacity-50 dark:text-violet-300 dark:hover:bg-violet-950"
            >
              {taskBusy === 'parse' ? '解析中…' : '解析'}
            </button>
          </div>
        </label>
        <div className="mt-3 grid grid-cols-[1fr_150px_210px] gap-4">
          <label className="flex flex-col gap-1 text-sm">
            任务名
            <input
              value={taskDraft.name}
              onChange={(e) => setTaskDraft({ ...taskDraft, name: e.target.value })}
              placeholder="知识库日报"
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            cron
            <input
              value={taskDraft.cron}
              onChange={(e) => setTaskDraft({ ...taskDraft, cron: e.target.value })}
              placeholder="0 9 * * *"
              className={`${inputCls} font-mono`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            执行模式
            <select
              value={taskDraft.mode}
              onChange={(e) => setTaskDraft({ ...taskDraft, mode: e.target.value as 'simple' | 'agent' })}
              className={inputCls}
            >
              <option value="simple">简单执行</option>
              <option value="agent">自主智能体</option>
            </select>
          </label>
        </div>
        <label className="mt-3 flex flex-col gap-1 text-sm">
          指令（{ACTION_SHORT[taskDraft.action] ? '给引擎的话题——它拿这个去取材成文' : taskDraft.mode === 'agent' ? '给智能体的目标，它会自己决定调用哪些工具' : '到点发给模型的内容'}）
          <textarea
            value={taskDraft.prompt}
            onChange={(e) => setTaskDraft({ ...taskDraft, prompt: e.target.value })}
            rows={3}
            placeholder={ACTION_SHORT[taskDraft.action] ? '如：RAG 评测怎么做（复盘不用填，把最近几天合成一份）' : taskDraft.mode === 'agent' ? '整理 vault/tasks/ 下最近生成的日报，把要点合并成一篇周报写到 vault/reports/。' : '总结我知识库里最近新增或修改的内容，按主题归纳要点。'}
            className={`${inputCls} resize-y`}
          />
        </label>
        {taskDraft.mode === 'agent' && (
          <div className="mt-3 grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              工具循环轮数上限（1-30）
              <input
                type="number"
                min={1}
                max={30}
                value={taskDraft.max_rounds}
                onChange={(e) => setTaskDraft({ ...taskDraft, max_rounds: Number(e.target.value) || 12 })}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              失败自动重试次数（0-3）
              <input
                type="number"
                min={0}
                max={3}
                value={taskDraft.retry}
                onChange={(e) => setTaskDraft({ ...taskDraft, retry: Number(e.target.value) || 0 })}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              步级超时秒数（留空 = 默认 900）
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
            </label>
            <label className="flex flex-col gap-1 text-sm">
              接地分门禁（0–5，留空 = 只记分不挡道）
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
            </label>
          </div>
        )}
        <div className="mt-3 grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1 text-sm">
            模型（留空 = 第一个启用的 provider）
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
          </label>
          <div className="flex flex-col justify-end gap-2 pb-1 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={taskDraft.use_rag}
                onChange={(e) => setTaskDraft({ ...taskDraft, use_rag: e.target.checked })}
              />
              检索知识库(RAG)
            </label>
            {taskDraft.mode === 'simple' && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={taskDraft.tools_enabled}
                  onChange={(e) => setTaskDraft({ ...taskDraft, tools_enabled: e.target.checked })}
                />
                允许使用工具（联网/读写 vault…）
              </label>
            )}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={taskDraft.save_to_vault}
                onChange={(e) => setTaskDraft({ ...taskDraft, save_to_vault: e.target.checked })}
              />
              结果写入 vault/tasks/（自动进索引）
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={taskDraft.notify_on_error}
                onChange={(e) => setTaskDraft({ ...taskDraft, notify_on_error: e.target.checked })}
              />
              失败时邮件通知（需配置 SMTP）
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={taskDraft.require_approval}
                onChange={(e) =>
                  setTaskDraft({ ...taskDraft, require_approval: e.target.checked })
                }
              />
              跑完等我点头再交给下游（人工卡点，在「工作」页放行）
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={taskDraft.enabled}
                onChange={(e) => setTaskDraft({ ...taskDraft, enabled: e.target.checked })}
              />
              启用
            </label>
          </div>
        </div>
        {(taskDraft.mode === 'agent' || taskDraft.tools_enabled) && taskTools.length > 0 && (
          <div className="mt-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span className="text-sm">工具白名单</span>
              <span className="text-xs text-neutral-400">
                不勾选 = 全部可用；任务无人值守，建议只留必需工具
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5 md:grid-cols-3">
              {taskTools.map((tool) => (
                <label key={tool.name} className="flex min-w-0 items-center gap-1.5 text-xs" title={tool.description}>
                  <input
                    type="checkbox"
                    checked={taskToolChecked(tool.name)}
                    onChange={() => toggleTaskTool(tool.name)}
                  />
                  <span className="truncate font-mono">{tool.name}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="mt-3 grid grid-cols-[160px_1fr] gap-4">
          <label className="flex flex-col gap-1 text-sm">
            触发方式
            <select
              value={taskDraft.trigger_kind}
              onChange={(e) => setTaskDraft({ ...taskDraft, trigger_kind: e.target.value as 'cron' | 'watch' | 'chain' })}
              className={inputCls}
            >
              <option value="cron">定时（cron）</option>
              <option value="watch">文件变化</option>
              <option value="chain">链条下游</option>
            </select>
          </label>
          {taskDraft.trigger_kind === 'watch' ? (
            <label className="flex flex-col gap-1 text-sm">
              监听路径（vault 内相对路径，目录或单个文件）
              <input
                value={taskDraft.watch_path}
                onChange={(e) => setTaskDraft({ ...taskDraft, watch_path: e.target.value })}
                placeholder="如 feeds/ 或 notes/日记.md"
                className={`${inputCls} font-mono`}
              />
              <span className="text-xs text-neutral-400">
                文件新增/修改后自动运行；同一任务 90 秒冷却，任务自己写入的文件不会再次触发自己
              </span>
            </label>
          ) : taskDraft.trigger_kind === 'chain' ? (
            <div className="flex flex-col justify-end pb-1.5 text-xs text-neutral-400">
              只由上游任务交接触发——自己不会跑。串一条流水线时，下游步骤都用这个。
            </div>
          ) : (
            <div className="flex flex-col justify-end pb-1.5 text-xs text-neutral-400">
              5 段 crontab：分 时 日 月 周（本地时区）；不想等固定时刻可改用「文件变化」触发
            </div>
          )}
        </div>
        <div className="mt-3 grid grid-cols-[160px_1fr] gap-4">
          <label className="flex flex-col gap-1 text-sm">
            这一步做什么
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
          </label>
          <label className="flex flex-col gap-1 text-sm">
            产物落哪（vault 内相对目录，留空 = tasks/）
            <input
              value={taskDraft.landing_dir}
              onChange={(e) => setTaskDraft({ ...taskDraft, landing_dir: e.target.value })}
              placeholder="如 meetings"
              className={`${inputCls} font-mono`}
            />
            <span className="text-xs text-neutral-400">
              同一条链条的下游会继承上游定下的目录；由录音触发时还会再套一层「日期-录音名」
            </span>
          </label>
        </div>
        <label className="mt-3 flex flex-col gap-1 text-sm">
          下游任务（任务链：本任务成功后，产出经 vault/tasks/handoff/ 自动交给下游继续处理）
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
        </label>
        <div className="mt-4 flex justify-end gap-2">
          {taskEditId != null && (
            <button
              onClick={() => {
                setTaskEditId(null)
                setTaskDraft({ ...EMPTY_TASK })
              }}
              className="rounded-md px-4 py-1.5 text-sm text-neutral-500"
            >
              取消
            </button>
          )}
          <button
            onClick={saveTask}
            className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110"
          >
            {taskEditId != null ? '保存修改' : '添加'}
          </button>
        </div>
      </div>
      {taskMsg && <div className="text-xs text-neutral-600 dark:text-neutral-300">{taskMsg}</div>}
    </section>
  )
}
