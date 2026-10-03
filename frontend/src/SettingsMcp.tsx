// MCP 工具域（方向 6 第十四刀，2026-09-30 自 SettingsPage 拆出）：
// `?section=mcp` 的 server 清单（连接状态 / 测试探针 / 增删改）+ 抽屉编辑器 + 页尾提示。
// 状态与五个处理器整体住在这里；挂载时自拉 getMcp，失败走 failLoad 汇总到页级错误条
// （原先挂在 refresh() 的串行 try 块里，失败会中断 refresh 后续取数——搬家后不再挡道）。
// 2026-10-02 设置中心改版：server 清单改成资源卡，编辑器搬进右侧抽屉——
// 页面负责浏览和管理，编辑不再常驻页面底部。
import { useEffect, useState } from 'react'
import { api, type McpProbe, type McpServer, type McpView } from './api'
import { inputCls } from './settingsShared'
import { askConfirm, Drawer, ResCard, SettingActions, SettingField, SettingGroup, SettingSwitch } from './SettingsUI'
import EmptyHint from './EmptyHint'

/** A3 那一栏的**成本读数**（2026-09-22：A3 改成症状驱动，不再是「工具数 > 20」）。
 *
 *  工具定义每一轮都要重发一遍——这段话把「重发多少」念出来：总字数 + 最占地方的三个，
 *  再给一句**提示**（到 20 个工具就复看一遍）。**是提示不是及格线**：这行字里不许出现
 *  「到线 / 没到线」这种判词，`review_hint` 是提醒你看一眼，不是判你合不合格。
 *
 *  **读不到就明说读不到**（§4-8）：`undefined` 走「没拿到」，绝不当成 0 印出来——
 *  「0 字」是在说「工具定义不要钱」，而事实是这一格没读到。
 *
 *  纯函数，所以只钉它（`SettingsPage.tools.test.tsx`）：整页要拉一堆端点，
 *  而这一行的规矩只有三条——照实念、最占地方的排前面、读不到不许印 0。 */
export function toolCostLine(tools: McpView['tools']): string {
  if (!tools) return '工具定义的字数没拿到——这一格不编一个 0 出来。'
  const top = (tools.biggest ?? []).slice(0, 3)
  const body = top.map((t) => `${t.name} ${t.chars} 字`).join('、')
  // 只有一条时不能写成「最占地方的是 X」（读起来像半句话），用「是」而不是「是…的」
  const biggest = body ? `最占地方的是 ${body}。` : ''
  return `${tools.count} 个工具的说明合起来 ${tools.chars} 字：这些每一轮都重发一遍。${biggest}到 ${tools.review_hint} 个工具就复看一遍——这是提示，不是及格线。`
}

const EMPTY_MCP: McpServer = { name: '', type: 'stdio', command: '', args: [], url: '', enabled: true }

export default function SettingsMcp({ failLoad }: { failLoad: (what: string, e: unknown) => void }) {
  const [mcpView, setMcpView] = useState<McpView | null>(null)
  const [mcpDraft, setMcpDraft] = useState<McpServer>({ ...EMPTY_MCP })
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpEditIdx, setMcpEditIdx] = useState<number | null>(null)
  const [mcpDrawer, setMcpDrawer] = useState(false)
  const [probe, setProbe] = useState<Record<string, McpProbe | 'loading'>>({})
  const [mcpError, setMcpError] = useState('')

  useEffect(() => {
    api.getMcp().then(setMcpView).catch((e) => failLoad('MCP', e))
  }, [])

  // ---- MCP server management ----

  async function saveMcp(list: McpServer[]) {
    try {
      setMcpView(await api.saveMcp(list))
      setMcpEditIdx(null)
      setMcpDraft({ ...EMPTY_MCP })
      setMcpArgs('')
      setMcpError('')
      setMcpDrawer(false)
    } catch (e) {
      setMcpError(String(e))
    }
  }

  function applyMcpDraft() {
    if (!mcpDraft.name.trim()) {
      setMcpError('名称必填')
      return
    }
    const item: McpServer = {
      ...mcpDraft,
      name: mcpDraft.name.trim(),
      args: mcpArgs
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    }
    const list = mcpView?.servers ?? []
    const next =
      mcpEditIdx == null ? [...list, item] : list.map((s, i) => (i === mcpEditIdx ? item : s))
    void saveMcp(next)
  }

  async function removeMcp(idx: number) {
    const list = mcpView?.servers ?? []
    const name = list[idx]?.name ?? ''
    if (!(await askConfirm({ title: `删除 MCP server「${name}」？`, confirmLabel: '删除' }))) return
    void saveMcp(list.filter((_, i) => i !== idx))
  }

  function editMcp(idx: number) {
    const s = mcpView?.servers[idx]
    if (!s) return
    setMcpEditIdx(idx)
    setMcpDraft({ ...s })
    setMcpArgs(s.args.join('\n'))
    setMcpError('')
    setMcpDrawer(true)
  }

  function startCreate() {
    setMcpEditIdx(null)
    setMcpDraft({ ...EMPTY_MCP })
    setMcpArgs('')
    setMcpError('')
    setMcpDrawer(true)
  }

  async function testMcp(s: McpServer, idx: number) {
    setProbe((prev) => ({ ...prev, [String(idx)]: 'loading' }))
    const r = await api.testMcp(s).catch((e): McpProbe => ({ name: s.name, ok: false, tools: [], error: String(e) }))
    setProbe((prev) => ({ ...prev, [String(idx)]: r }))
  }

  const mcpServers = mcpView?.servers ?? []
  const activeToolCount = mcpView?.active_tools.length ?? 0

  return (
    <div className="mt-4 flex flex-col gap-4">
      <SettingGroup
        title="MCP 服务器"
        description={`${toolCostLine(mcpView?.tools)} 配置 MCP server 可接入文件系统、浏览器、数据库等任意工具。`}
        actions={
          <button onClick={startCreate} className="wb-btn-primary px-3 py-1.5 text-sm">
            ＋ 添加服务器
          </button>
        }
        divide={false}
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          {/* 状态总览：可用工具数念在这一行，进页先知道现在有多少家伙能用 */}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            当前 {activeToolCount} 个可用工具。内置工具始终可用：
            <code className="text-neutral-500">vault_read_file</code> /{' '}
            <code className="text-neutral-500">vault_list_files</code> /{' '}
            <code className="text-neutral-500">vault_write_file</code> /{' '}
            <code className="text-neutral-500">fetch_url</code> /{' '}
            <code className="text-neutral-500">web_search</code> /{' '}
            <code className="text-neutral-500">memory_save</code> 等。
          </p>
          {mcpServers.map((s, i) => {
            const st = mcpView?.status[s.name]
            const pr = probe[String(i)]
            return (
              <ResCard
                key={`${s.name}-${i}`}
                title={
                  <>
                    <span className="font-medium">{s.name}</span>
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                      {s.type === 'sse' ? 'SSE 远程' : 'stdio 本地'}
                    </span>
                    {st ? (
                      st.ok ? (
                        <span className="text-xs text-emerald-600 dark:text-emerald-400">
                          ● 已连接 · {st.tools} 个工具
                        </span>
                      ) : (
                        <span className="text-xs text-red-500" title={st.error ?? ''}>
                          ● 连接失败
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-neutral-400">○ 未连接</span>
                    )}
                    {!s.enabled && <span className="text-xs text-red-500">已禁用</span>}
                  </>
                }
                meta={
                  <>
                    <span className="block truncate font-mono text-neutral-400">
                      {s.type === 'sse' ? s.url : [s.command, ...s.args].join(' ')}
                    </span>
                    {pr === 'loading' && <span className="block text-neutral-400">测试中…</span>}
                    {pr && pr !== 'loading' && (
                      <span className="block">
                        {pr.ok ? (
                          <span className="text-emerald-600 dark:text-emerald-400">
                            测试通过：{pr.tools.join(', ') || '(无工具)'}
                          </span>
                        ) : (
                          <span className="text-red-500">测试失败：{pr.error}</span>
                        )}
                      </span>
                    )}
                  </>
                }
                actions={
                  <>
                    <button
                      onClick={() => testMcp(s, i)}
                      className="text-violet-600 hover:underline dark:text-violet-300"
                    >
                      测试
                    </button>
                    <button
                      onClick={() => editMcp(i)}
                      className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                    >
                      编辑
                    </button>
                    <button onClick={() => removeMcp(i)} className="text-red-400 hover:text-red-600">
                      删除
                    </button>
                  </>
                }
              />
            )
          })}
          {!mcpServers.length && (
            <EmptyHint
              pad="sm"
              title="还没有配置 MCP server（可选）。"
              hint="内置工具已经够日常用；要接文件系统、浏览器或数据库时，点右上「＋ 添加服务器」。"
            />
          )}
        </div>
      </SettingGroup>

      {/* MCP 编辑抽屉 */}
      <Drawer
        open={mcpDrawer}
        onClose={() => setMcpDrawer(false)}
        title={mcpEditIdx != null ? `编辑 ${mcpDraft.name || 'MCP Server'}` : '添加 MCP Server'}
        description="模型在对话中可以直接调用这些 server 提供的工具。"
        footer={
          <SettingActions left={mcpError ? <p className="text-xs text-red-500">{mcpError}</p> : null}>
            <button
              onClick={() => setMcpDrawer(false)}
              className="rounded-md px-4 py-1.5 text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              取消
            </button>
            <button onClick={applyMcpDraft} className="wb-btn-primary px-4 py-1.5 text-sm">
              {mcpEditIdx != null ? '保存修改' : '添加'}
            </button>
          </SettingActions>
        }
      >
        <div className="flex flex-col gap-4">
          <SettingField label="名称">
            <input
              value={mcpDraft.name}
              onChange={(e) => setMcpDraft({ ...mcpDraft, name: e.target.value })}
              placeholder="filesystem"
              className={inputCls}
            />
          </SettingField>
          <SettingField label="传输类型">
            <select
              value={mcpDraft.type}
              onChange={(e) => setMcpDraft({ ...mcpDraft, type: e.target.value as 'stdio' | 'sse' })}
              className={inputCls}
            >
              <option value="stdio">stdio（本地子进程）</option>
              <option value="sse">SSE（远程服务）</option>
            </select>
          </SettingField>
          {mcpDraft.type === 'sse' ? (
            <SettingField label="SSE URL" hint="远程 MCP 服务的地址。">
              <input
                value={mcpDraft.url}
                onChange={(e) => setMcpDraft({ ...mcpDraft, url: e.target.value })}
                placeholder="https://example.com/mcp/sse"
                className={inputCls}
              />
            </SettingField>
          ) : (
            <>
              <SettingField label="启动命令" hint="python / npx / uvx 等可执行命令。">
                <input
                  value={mcpDraft.command}
                  onChange={(e) => setMcpDraft({ ...mcpDraft, command: e.target.value })}
                  placeholder="python / npx / uvx"
                  className={inputCls}
                />
              </SettingField>
              <SettingField label="参数" hint="逗号或换行分隔。">
                <textarea
                  value={mcpArgs}
                  onChange={(e) => setMcpArgs(e.target.value)}
                  rows={2}
                  placeholder={'-y @modelcontextprotocol/server-filesystem C:\\path\\to\\dir'}
                  className={inputCls}
                />
              </SettingField>
            </>
          )}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
            <div className="min-w-0">
              <p className="text-sm font-medium">启用</p>
              <p className="mt-0.5 text-xs text-neutral-500">禁用后它的工具不会暴露给模型。</p>
            </div>
            <SettingSwitch
              checked={mcpDraft.enabled}
              onChange={(v) => setMcpDraft({ ...mcpDraft, enabled: v })}
              ariaLabel="启用该 server"
            />
          </div>
        </div>
      </Drawer>

      <p className="text-xs leading-relaxed text-neutral-400">
        提示：MCP server 支持 stdio 与 SSE。OpenAI 兼容协议的模型在对话页显示为 provider名/模型名。
      </p>
    </div>
  )
}
