// 模型分区（2026-10-02 设置中心改版自 SettingsPage 拆出）：
// 默认模型说明 + 用量与成本 + 供应商资源卡 + 抽屉编辑器。
// provider 清单由页面传入（任务 / 智能体分区也用它）；探测与增删改的状态住在这里，
// 改动后经 onChanged 让页面重拉清单。
import { useEffect, useState } from 'react'
import { api, type CostSummary, type ModelProbe, type ProviderConfig } from './api'
import { inputCls } from './settingsShared'
import {
  askConfirm,
  Drawer,
  ResCard,
  SettingActions,
  SettingField,
  SettingGroup,
  SettingRow,
  SettingSwitch,
} from './SettingsUI'
import EmptyHint from './EmptyHint'

const EMPTY = { name: '', kind: 'openai' as 'openai' | 'anthropic', base_url: '', api_key: '', models: '', enabled: true }

export default function SettingsModels({
  providers,
  onChanged,
  failLoad,
}: {
  /** provider 清单（页面持有——定时任务与智能体分区的模型下拉同用一份） */
  providers: ProviderConfig[]
  /** 增删改之后让页面重拉 */
  onChanged: () => void | Promise<void>
  failLoad: (what: string, e: unknown) => void
}) {
  const [probes, setProbes] = useState<Record<number, ModelProbe[]>>({})
  const [probing, setProbing] = useState<number | null>(null)
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [draft, setDraft] = useState({ ...EMPTY })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [drawer, setDrawer] = useState(false)
  const [error, setError] = useState('')
  const [cost, setCost] = useState<CostSummary | null>(null)

  // 用量与成本：以前只有聊天与定时任务记账，其余路径一点都看不见
  useEffect(() => {
    api.costSummary(30).then(setCost).catch((e) => failLoad('用量与成本', e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save() {
    if (!draft.name.trim()) {
      setError('名称必填')
      return
    }
    const payload = {
      name: draft.name.trim(),
      kind: draft.kind,
      base_url: draft.base_url.trim(),
      api_key: draft.api_key.trim(),
      models: draft.models
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
      enabled: draft.enabled,
    }
    try {
      if (editingId) await api.updateProvider(editingId, payload)
      else await api.createProvider(payload)
      setDraft({ ...EMPTY })
      setEditingId(null)
      setDrawer(false)
      setError('')
      await onChanged()
    } catch (e) {
      setError(String(e))
    }
  }

  async function remove(id: number) {
    if (!(await askConfirm({ title: '删除该 provider？', confirmLabel: '删除' }))) return
    await api.deleteProvider(id)
    await onChanged()
  }

  // 模型可用性探测：模型顺序决定所有自动化功能用哪一个，探测结果会让
  // default_model_id() 自动跳过打不通的那些。
  async function runProbe(id: number) {
    setProbing(id)
    setError('')
    try {
      const r = await api.probeProvider(id)
      setProbes((p) => ({ ...p, [id]: r.results }))
      setDefaultModel(r.default_model)
    } catch (e) {
      setError(String(e))
    } finally {
      setProbing(null)
    }
  }

  function startEdit(p: ProviderConfig) {
    setEditingId(p.id)
    setDraft({
      name: p.name,
      kind: p.kind,
      base_url: p.base_url,
      api_key: '',
      models: p.models.join(', '),
      enabled: p.enabled,
    })
    setError('')
    setDrawer(true)
  }

  function startCreate() {
    setEditingId(null)
    setDraft({ ...EMPTY })
    setError('')
    setDrawer(true)
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup
        title="默认模型"
        description={
          <>
            所有自动化功能（每日提醒、每日摘要、自动记忆、图谱抽取…）用的是「第一个能打通的模型」
            ——探测失败的自动跳过，所以<b className="font-medium text-neutral-700 dark:text-neutral-200">模型顺序有意义</b>。
          </>
        }
      >
        <SettingRow title="当前自动化默认" description="来自最近一次「测一下」的探测结果。">
          {defaultModel ? (
            <code className="rounded bg-neutral-100 px-2 py-1 font-mono text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
              {defaultModel}
            </code>
          ) : (
            <span className="text-xs text-neutral-400">尚未探测</span>
          )}
        </SettingRow>
      </SettingGroup>

      {cost && (
        <SettingGroup
          title="用量与成本"
          description={`最近 ${cost.days} 天。聊天与定时任务各自记账；其余路径（研究 / 产出 / 复盘 / 方案 / 对质 / 教学 / 圆桌 / 播客 / 卡片 / 记忆整理）走统一账本——以前它们一点都看不见。填了模型价格才会给金额，否则只显示 token。`}
          divide={false}
        >
          <div className="px-5 py-4">
            {/* 三块统计砖同级同重——此前 2xl/lg 混排，并列的信息被字号误读成了层级 */}
            <div className="grid grid-cols-3 gap-x-6 gap-y-4 pb-5">
              <div>
                <p className="text-xl font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
                  {cost.total_tokens.toLocaleString()}
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">总 token</p>
              </div>
              <div>
                <p className="text-xl font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
                  {cost.total_tokens_in.toLocaleString()} / {cost.total_tokens_out.toLocaleString()}
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">输入 / 输出</p>
              </div>
              <div>
                <p className="text-xl font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
                  {cost.chat_calls} · {cost.task_runs} · {cost.ledger_calls}
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">聊天 / 定时任务 / 其他路径</p>
              </div>
            </div>

            {Object.keys(cost.by_kind).length > 0 ? (
              <div className="pb-5">
                <p className="pb-1.5 text-xs font-medium text-neutral-500">按操作（钱花在哪）</p>
                <table className="w-full text-left text-xs">
                  <thead className="text-neutral-400">
                    <tr>
                      <th className="pb-1.5 pr-3 font-normal">操作</th>
                      <th className="pb-1.5 pr-3 text-right font-normal">次数</th>
                      <th className="pb-1.5 text-right font-normal">Token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(cost.by_kind)
                      .sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out))
                      .map(([kind, r]) => (
                        <tr key={kind} className="border-t border-neutral-100 dark:border-neutral-800">
                          <td className="py-1.5 pr-3 font-medium text-neutral-700 dark:text-neutral-200">{kind}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-neutral-600 dark:text-neutral-300">{r.calls} 次</td>
                          <td className="py-1.5 text-right tabular-nums text-neutral-500">
                            {(r.in + r.out).toLocaleString()} tok
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {cost.by_day.length > 0 ? (
              <div>
                <p className="pb-1 text-xs font-medium text-neutral-500">按天</p>
                <div className="flex h-16 items-end gap-0.5">
                  {(() => {
                    const days = cost.by_day.slice(-30)
                    const peak = Math.max(...days.map(([, t]) => t), 1)
                    return days.map(([day, tokens]) => (
                      <div
                        key={day}
                        title={`${day}：${tokens.toLocaleString()} tok`}
                        className="min-w-0 flex-1 rounded-t bg-violet-400 dark:bg-violet-500"
                        style={{ height: `${Math.max(2, (tokens / peak) * 100)}%` }}
                      />
                    ))
                  })()}
                </div>
              </div>
            ) : null}
          </div>
        </SettingGroup>
      )}

      <SettingGroup
        title="模型供应商"
        description="「测一下」会给这个 provider 的每个模型各打一次最小请求，逐个标出可用还是打不通。"
        divide={false}
        actions={
          <button onClick={startCreate} className="wb-btn-primary px-3 py-1.5 text-sm">
            ＋ 添加 Provider
          </button>
        }
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          {providers.map((p) => (
            <ResCard
              key={p.id}
              title={
                <>
                  <span className="font-medium">{p.name}</span>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                    {p.kind}
                  </span>
                  {p.enabled ? (
                    <span className="text-xs text-emerald-600 dark:text-emerald-400">● 已启用</span>
                  ) : (
                    <span className="text-xs text-red-500">● 已禁用</span>
                  )}
                </>
              }
              meta={
                <>
                  <span className="block">
                    {p.models.length} 个模型：{p.models.join(' · ') || '—'}
                  </span>
                  {p.base_url && <span className="block truncate text-neutral-400">{p.base_url}</span>}
                </>
              }
              actions={
                <>
                  <button
                    onClick={() => void runProbe(p.id)}
                    disabled={probing === p.id}
                    className="text-violet-600 hover:underline disabled:opacity-50 dark:text-violet-300"
                  >
                    {probing === p.id ? '测试中…' : '测一下'}
                  </button>
                  <button
                    onClick={() => startEdit(p)}
                    className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                  >
                    编辑
                  </button>
                  <button onClick={() => remove(p.id)} className="text-red-400 hover:text-red-600">
                    删除
                  </button>
                </>
              }
            >
              {probes[p.id] && (
                <div className="mt-2.5 space-y-1 border-t border-neutral-200/80 pt-2.5 dark:border-neutral-800/80">
                  {probes[p.id].map((r) => (
                    <div key={r.model_id} className="flex items-center gap-2 text-xs">
                      <span
                        className={`rounded px-1.5 py-0.5 ${
                          r.ok
                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
                            : 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300'
                        }`}
                      >
                        {r.ok ? '可用' : r.code || '打不通'}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {r.model_id.split('/').slice(1).join('/')}
                      </span>
                      {r.ok && <span className="text-neutral-400">{r.ms}ms</span>}
                      {!r.ok && r.message && (
                        <span className="min-w-0 max-w-[45%] truncate text-neutral-400" title={r.message}>
                          {r.message}
                        </span>
                      )}
                    </div>
                  ))}
                  {defaultModel && (
                    <p className="pt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      自动化功能将使用：
                      <span className="font-mono text-neutral-700 dark:text-neutral-200">
                        {defaultModel}
                      </span>
                    </p>
                  )}
                </div>
              )}
            </ResCard>
          ))}
          {!providers.length && (
            <EmptyHint
              pad="sm"
              title="尚未配置任何 provider。"
              hint="点右上「＋ 添加 Provider」：填名称、协议与 API Key 就能开始对话。"
            />
          )}
        </div>
      </SettingGroup>

      {/* Provider 编辑抽屉：页面负责浏览，抽屉负责编辑（不再摊在列表下面） */}
      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title={editingId ? `编辑 ${draft.name || 'Provider'}` : '添加 Provider'}
        description="OpenAI 兼容协议可接 DeepSeek、Qwen、Moonshot、Ollama、OpenRouter 等，填对应 base_url 即可。"
        footer={
          <SettingActions left={error ? <p className="text-xs text-red-500">{error}</p> : null}>
            <button
              onClick={() => setDrawer(false)}
              className="rounded-md px-4 py-1.5 text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              取消
            </button>
            <button onClick={save} className="wb-btn-primary px-4 py-1.5 text-sm">
              {editingId ? '保存修改' : '添加'}
            </button>
          </SettingActions>
        }
      >
        <div className="flex flex-col gap-4">
          <SettingField label="名称" hint="用于 model_id 前缀（对话页显示为 provider名/模型名）。">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="deepseek"
              className={inputCls}
            />
          </SettingField>
          <SettingField label="协议类型">
            <select
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'openai' | 'anthropic' })}
              className={inputCls}
            >
              <option value="openai">OpenAI 兼容（deepseek/qwen/moonshot/ollama…）</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </SettingField>
          <SettingField label="API Key" hint={editingId ? '留空保持不变。' : '只存在本机 data/config.json。'}>
            <input
              type="password"
              value={draft.api_key}
              onChange={(e) => setDraft({ ...draft, api_key: e.target.value })}
              className={inputCls}
            />
          </SettingField>
          <SettingField
            label="Base URL"
            hint="OpenAI 兼容协议接官方以外的服务时必填（如 https://api.deepseek.com/v1）。"
          >
            <input
              value={draft.base_url}
              onChange={(e) => setDraft({ ...draft, base_url: e.target.value })}
              placeholder="https://api.deepseek.com/v1"
              className={inputCls}
            />
          </SettingField>
          <SettingField
            label="模型列表"
            hint="逗号或换行分隔。顺序有意义——第一个能打通的会成为自动化默认模型。"
          >
            <textarea
              value={draft.models}
              onChange={(e) => setDraft({ ...draft, models: e.target.value })}
              rows={2}
              placeholder="deepseek-chat, deepseek-reasoner"
              className={inputCls}
            />
          </SettingField>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
            <div className="min-w-0">
              <p className="text-sm font-medium">启用</p>
              <p className="mt-0.5 text-xs text-neutral-500">禁用后不参与对话与自动化。</p>
            </div>
            <SettingSwitch
              checked={draft.enabled}
              onChange={(v) => setDraft({ ...draft, enabled: v })}
              ariaLabel="启用该 provider"
            />
          </div>
        </div>
      </Drawer>
    </div>
  )
}
