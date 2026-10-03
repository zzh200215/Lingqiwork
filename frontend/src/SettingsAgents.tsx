// 智能体预设分区（方向 6 第十二刀拆出，2026-10-02 设置中心改版）：
// 把人设提示词、模型、RAG/工具开关打包成命名预设，对话页顶部一键切换。
// 清单挂载时自拉；取数失败走 failLoad 汇总页级错误条；编辑器住右侧抽屉。
import { useEffect, useState } from 'react'
import { api, type AgentPreset, type ProviderConfig } from './api'
import { inputCls } from './settingsShared'
import { askConfirm, Drawer, ResCard, SettingActions, SettingField, SettingGroup, SettingSwitch } from './SettingsUI'
import EmptyHint from './EmptyHint'

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
}: {
  providers: ProviderConfig[]
  failLoad: (what: string, e: unknown) => void
}) {
  const [agents, setAgents] = useState<AgentPreset[]>([])
  const [agentDraft, setAgentDraft] = useState({ ...EMPTY_AGENT })
  const [agentEditId, setAgentEditId] = useState<number | null>(null)
  const [agentDrawer, setAgentDrawer] = useState(false)
  const [agentError, setAgentError] = useState('')

  useEffect(() => {
    api.listAgents().then(setAgents).catch((e) => failLoad('智能体', e))
  }, [failLoad])

  // ---- agent presets ----

  async function saveAgent() {
    if (!agentDraft.name.trim()) {
      setAgentError('智能体名称必填')
      return
    }
    try {
      if (agentEditId != null) await api.updateAgent(agentEditId, agentDraft)
      else await api.createAgent(agentDraft)
      setAgentDraft({ ...EMPTY_AGENT })
      setAgentEditId(null)
      setAgentError('')
      setAgentDrawer(false)
      setAgents(await api.listAgents())
    } catch (e) {
      setAgentError(String(e))
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
    setAgentError('')
    setAgentDrawer(true)
  }

  function startCreate() {
    setAgentEditId(null)
    setAgentDraft({ ...EMPTY_AGENT })
    setAgentError('')
    setAgentDrawer(true)
  }

  async function removeAgent(id: number) {
    const a = agents.find((x) => x.id === id)
    if (!(await askConfirm({ title: `删除智能体「${a?.name ?? id}」？`, confirmLabel: '删除' }))) return
    await api.deleteAgent(id)
    if (agentEditId === id) {
      setAgentEditId(null)
      setAgentDraft({ ...EMPTY_AGENT })
      setAgentDrawer(false)
    }
    setAgents(await api.listAgents())
  }

  return (
    <SettingGroup
      title="智能体预设"
      description="把人设提示词、模型、RAG/工具开关打包成命名预设，对话页顶部一键切换。"
      actions={
        <button onClick={startCreate} className="wb-btn-primary px-3 py-1.5 text-sm">
          ＋ 新建智能体
        </button>
      }
      divide={false}
    >
      <div className="grid gap-3 px-5 py-4 sm:grid-cols-2">
        {agents.map((a) => (
          <ResCard
            key={a.id}
            title={
              <>
                <span aria-hidden>{a.avatar}</span>
                <span className="font-medium">{a.name}</span>
                {a.enabled ? (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400">● 已启用</span>
                ) : (
                  <span className="text-xs text-red-500">● 已禁用</span>
                )}
              </>
            }
            meta={
              <>
                <span className="block truncate">{a.system_prompt || '(无人设提示词)'}</span>
                <span className="block text-neutral-400">
                  {a.model_id ? `模型 ${a.model_id}` : '跟随会话模型'}
                  {a.use_rag && ' · RAG'}
                  {a.tool_whitelist === 'none' ? ' · 无工具' : a.tool_whitelist ? ` · 工具 ${a.tool_whitelist}` : ''}
                </span>
              </>
            }
            actions={
              <>
                <button
                  onClick={() => editAgent(a)}
                  className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                >
                  编辑
                </button>
                <button onClick={() => removeAgent(a.id)} className="text-red-400 hover:text-red-600">
                  删除
                </button>
              </>
            }
          />
        ))}
      </div>
      {!agents.length && (
        <div className="px-5 pb-4">
          <EmptyHint
            pad="sm"
            title="还没有智能体预设。"
            hint="点右上「＋ 新建智能体」：给一段人设提示词、钉一个模型，对话页就能一键切换。"
          />
        </div>
      )}

      <Drawer
        open={agentDrawer}
        onClose={() => setAgentDrawer(false)}
        title={agentEditId != null ? `编辑「${agentDraft.name}」` : '新建智能体'}
        description="预设只决定「这个对话怎么配」，不会动全局设置。"
        footer={
          <SettingActions left={agentError ? <p className="text-xs text-red-500">{agentError}</p> : null}>
            <button
              onClick={() => setAgentDrawer(false)}
              className="rounded-md px-4 py-1.5 text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              取消
            </button>
            <button onClick={saveAgent} className="wb-btn-primary px-4 py-1.5 text-sm">
              {agentEditId != null ? '保存修改' : '添加'}
            </button>
          </SettingActions>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[88px_1fr] gap-4">
            <SettingField label="头像">
              <input
                value={agentDraft.avatar}
                onChange={(e) => setAgentDraft({ ...agentDraft, avatar: e.target.value })}
                className={inputCls}
              />
            </SettingField>
            <SettingField label="名称">
              <input
                value={agentDraft.name}
                onChange={(e) => setAgentDraft({ ...agentDraft, name: e.target.value })}
                placeholder="写作教练 / 代码审查员…"
                className={inputCls}
              />
            </SettingField>
          </div>
          <SettingField
            label="人设系统提示词"
            hint="会叠加到全局系统提示词之后。"
          >
            <textarea
              value={agentDraft.system_prompt}
              onChange={(e) => setAgentDraft({ ...agentDraft, system_prompt: e.target.value })}
              rows={3}
              placeholder="例如：你是一位严格的代码审查员，只指出问题并给出修复建议，语气直接。"
              className={`${inputCls} resize-y`}
            />
          </SettingField>
          <SettingField label="固定模型" hint="留空 = 会话当前模型。">
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
          </SettingField>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
            <div className="min-w-0">
              <p className="text-sm font-medium">默认开启知识库（RAG）</p>
              <p className="mt-0.5 text-xs text-neutral-500">切到这个预设时自动带上知识库检索。</p>
            </div>
            <SettingSwitch
              checked={agentDraft.use_rag}
              onChange={(v) => setAgentDraft({ ...agentDraft, use_rag: v })}
              ariaLabel="默认开启知识库"
            />
          </div>
          {/* A2：这一栏原来是「允许使用工具」那个布尔开关。后端已经换成**白名单**了
              （`AgentPreset.tool_whitelist`，语义在 `mcp.filter_specs` 一处），
              界面照旧只发一个布尔的话，用户勾掉之后根本说不清"到底禁了哪些"。
              所以这里给字符串本身：空 = 不限制，`none` = 一个都不给。 */}
          <SettingField
            label="工具白名单"
            hint={
              <>
                按 fnmatch 匹配：<code className="text-neutral-500">vault_*</code> 这类前缀，
                或 <code className="text-neutral-500">server__*</code> 指某个 MCP 服务的全部工具。
              </>
            }
          >
            <input
              placeholder="空 = 不限制；none = 一个都不给；例：vault_*, kb_search"
              value={agentDraft.tool_whitelist}
              onChange={(e) => setAgentDraft({ ...agentDraft, tool_whitelist: e.target.value })}
              className={inputCls}
            />
          </SettingField>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
            <div className="min-w-0">
              <p className="text-sm font-medium">启用</p>
              <p className="mt-0.5 text-xs text-neutral-500">禁用后不出现在对话页的切换器里。</p>
            </div>
            <SettingSwitch
              checked={agentDraft.enabled}
              onChange={(v) => setAgentDraft({ ...agentDraft, enabled: v })}
              ariaLabel="启用该智能体"
            />
          </div>
        </div>
      </Drawer>
    </SettingGroup>
  )
}
