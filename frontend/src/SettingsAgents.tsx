// 智能体预设分区（方向 6 第十二刀，2026-09-29 自 SettingsPage 拆出）：
// 把人设提示词、模型、RAG/工具开关打包成命名预设，对话页顶部一键切换。
// 状态与处理器整体住在这里，挂载时自拉清单；取数失败走 failLoad 汇总页级错误条；
// 保存/删除的失败信息沿用页面的 setError（与 Provider 编辑同一处展示）。
import { useEffect, useState } from 'react'
import { Bot } from 'lucide-react'
import { api, type AgentPreset, type ProviderConfig } from './api'
import { inputCls } from './settingsShared'

const EMPTY_AGENT = {
  name: '',
  avatar: '🤖',
  system_prompt: '',
  model_id: '',
  use_rag: false,
  /** A2：**工具白名单**（原来是个布尔开关 `tools_enabled`）。空 = 不限制，`none` = 一个都不给。
   *  语义在后端 `mcp.filter_specs` 一处——界面只负责把这一串原样发过去。 */
  tool_whitelist: '',
  enabled: true,
}

export default function SettingsAgents({
  providers,
  failLoad,
  setError,
}: {
  providers: ProviderConfig[]
  failLoad: (what: string, e: unknown) => void
  setError: (msg: string) => void
}) {
  const [agents, setAgents] = useState<AgentPreset[]>([])
  const [agentDraft, setAgentDraft] = useState({ ...EMPTY_AGENT })
  const [agentEditId, setAgentEditId] = useState<number | null>(null)

  useEffect(() => {
    api.listAgents().then(setAgents).catch((e) => failLoad('智能体', e))
  }, [failLoad])

  // ---- agent presets ----

  async function saveAgent() {
    if (!agentDraft.name.trim()) {
      setError('智能体名称必填')
      return
    }
    try {
      if (agentEditId != null) await api.updateAgent(agentEditId, agentDraft)
      else await api.createAgent(agentDraft)
      setAgentDraft({ ...EMPTY_AGENT })
      setAgentEditId(null)
      setError('')
      setAgents(await api.listAgents())
    } catch (e) {
      setError(String(e))
    }
  }

  function editAgent(a: AgentPreset) {
    setAgentEditId(a.id)
    setAgentDraft({
      name: a.name,
      avatar: a.avatar,
      system_prompt: a.system_prompt,
      model_id: a.model_id,
      use_rag: a.use_rag,
      tool_whitelist: a.tool_whitelist ?? '',
      enabled: a.enabled,
    })
  }

  async function removeAgent(id: number) {
    const a = agents.find((x) => x.id === id)
    if (!confirm(`删除智能体「${a?.name ?? id}」？`)) return
    await api.deleteAgent(id)
    if (agentEditId === id) {
      setAgentEditId(null)
      setAgentDraft({ ...EMPTY_AGENT })
    }
    setAgents(await api.listAgents())
  }

  return (
    <section className="mb-6 flex flex-col gap-3 wb-card p-5">
      <h2 className="flex items-center gap-2 font-semibold"><span className="wb-chip h-6 w-6 rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300"><Bot className="h-3.5 w-3.5" /></span></h2>
      <p className="-mt-1 text-xs leading-relaxed text-neutral-400">
        把人设提示词、模型、RAG/工具开关打包成命名预设，对话页顶部一键切换。
      </p>
      {agents.map((a) => (
        <div
          key={a.id}
          className="flex items-start justify-between rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span>{a.avatar}</span>
              <span className="font-medium">{a.name}</span>
              {!a.enabled && <span className="text-xs text-red-500">已禁用</span>}
            </div>
            <div className="truncate text-xs text-neutral-500">
              {a.system_prompt || '(无人设提示词)'}
              {a.model_id && ` · 模型 ${a.model_id}`}
              {a.use_rag && ' · RAG'}
              {a.tool_whitelist === 'none' ? ' · 无工具' : a.tool_whitelist ? ` · 工具 ${a.tool_whitelist}` : ''}
            </div>
          </div>
          <div className="flex shrink-0 gap-2 text-sm">
            <button onClick={() => editAgent(a)} className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
              编辑
            </button>
            <button onClick={() => removeAgent(a.id)} className="text-red-400 hover:text-red-600">
              删除
            </button>
          </div>
        </div>
      ))}
      {!agents.length && <p className="text-sm text-neutral-400">还没有智能体预设</p>}

      <div className="wb-card p-5">
        <h3 className="mb-3 text-sm font-medium">
          {agentEditId != null ? `编辑「${agentDraft.name}」` : '新增智能体'}
        </h3>
        <div className="grid grid-cols-[80px_1fr] gap-4">
          <label className="flex flex-col gap-1 text-sm">
            头像
            <input
              value={agentDraft.avatar}
              onChange={(e) => setAgentDraft({ ...agentDraft, avatar: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            名称
            <input
              value={agentDraft.name}
              onChange={(e) => setAgentDraft({ ...agentDraft, name: e.target.value })}
              placeholder="写作教练 / 代码审查员…"
              className={inputCls}
            />
          </label>
        </div>
        <label className="mt-3 flex flex-col gap-1 text-sm">
          人设系统提示词（会叠加到全局系统提示词之后）
          <textarea
            value={agentDraft.system_prompt}
            onChange={(e) => setAgentDraft({ ...agentDraft, system_prompt: e.target.value })}
            rows={3}
            placeholder="例如：你是一位严格的代码审查员，只指出问题并给出修复建议，语气直接。"
            className={`${inputCls} resize-y`}
          />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1 text-sm">
            固定模型（留空 = 会话当前模型）
            <select
              value={agentDraft.model_id}
              onChange={(e) => setAgentDraft({ ...agentDraft, model_id: e.target.value })}
              className={inputCls}
            >
              <option value="">跟随会话</option>
              {providers.flatMap((p) =>
                p.enabled ? p.models.map((m) => `${p.name}/${m}`) : []
              ).map((mid) => (
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
                checked={agentDraft.use_rag}
                onChange={(e) => setAgentDraft({ ...agentDraft, use_rag: e.target.checked })}
              />
              默认开启知识库(RAG)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={agentDraft.enabled}
                onChange={(e) => setAgentDraft({ ...agentDraft, enabled: e.target.checked })}
              />
              启用
            </label>
          </div>
        </div>
        {/* A2：这一栏原来是「允许使用工具」那个布尔开关。后端已经换成**白名单**了
            （`AgentPreset.tool_whitelist`，语义在 `mcp.filter_specs` 一处），
            界面照旧只发一个布尔的话，用户勾掉之后根本说不清"到底禁了哪些"。
            所以这里给字符串本身：空 = 不限制，`none` = 一个都不给。 */}
        <label className="mt-3 block text-xs text-neutral-500">
          工具白名单
          <input
            placeholder="空 = 不限制；none = 一个都不给；例：vault_*, kb_search"
            value={agentDraft.tool_whitelist}
            onChange={(e) => setAgentDraft({ ...agentDraft, tool_whitelist: e.target.value })}
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <span className="mt-1 block text-xs text-neutral-400">
            按 fnmatch 匹配：<code className="text-neutral-500">vault_*</code> 这类前缀，
            或 <code className="text-neutral-500">server__*</code> 指某个 MCP 服务的全部工具。
          </span>
        </label>
        <div className="mt-4 flex justify-end gap-2">
          {agentEditId != null && (
            <button
              onClick={() => {
                setAgentEditId(null)
                setAgentDraft({ ...EMPTY_AGENT })
              }}
              className="rounded-md px-4 py-1.5 text-sm text-neutral-500"
            >
              取消
            </button>
          )}
          <button
            onClick={saveAgent}
            className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white transition-all hover:brightness-110"
          >
            {agentEditId != null ? '保存修改' : '添加'}
          </button>
        </div>
      </div>
    </section>
  )
}
