// 页头工具栏（方向 6 第二十一刀，2026-09-30 自 App.tsx 拆出）：
// 模型下拉（切换即 PUT 落库 + 重拉会话）、智能体选择、一问多答对比模式、
// RAG 开关、氛围粒子、导出与当前会话标题。纯展示；状态经同名 props 注入，
// activeAgent 派生（教学页头显示「正在和谁说话」）随迁到组件内。
import { type Dispatch, type SetStateAction } from 'react'
import type { AgentPreset, Conversation } from './api'

export default function ChatHeader({
  currentModel,
  modelOptions,
  activeId,
  refreshConversations,
  agents,
  agentId,
  setAgentId,
  compareModel,
  setCompareModel,
  useRag,
  setUseRag,
  ambience,
  setAmbience,
  conversations,
  exportChat,
}: {
  currentModel: string
  modelOptions: { value: string; label: string }[]
  activeId: number | null
  refreshConversations: () => Promise<void>
  agents: AgentPreset[]
  agentId: number | null
  setAgentId: Dispatch<SetStateAction<number | null>>
  compareModel: string
  setCompareModel: Dispatch<SetStateAction<string>>
  useRag: boolean
  setUseRag: Dispatch<SetStateAction<boolean>>
  ambience: boolean
  setAmbience: Dispatch<SetStateAction<boolean>>
  conversations: Conversation[]
  exportChat: () => void
}) {
  const activeAgent = agents.find((a) => a.id === agentId) ?? null

  return (
    <>
      {/* Header */}
      {/* flex-wrap：这一行放的是模型下拉 + RAG 开关 + 各种 icon 按钮，宽度由内容
          说了算（select 不会缩到自己文字以下）。不换行的话窄窗格/窄窗口里这一行会
          顶出横向滚动条——分屏侧栏只有三百来像素，一定会撞上。 */}
      {/* 会话页的顶栏**就是壳的顶栏**——它与模块页那个 `Layout.TopBar` 是同一个
          位置上的两个实现（这一页要摆模型选择器，模块页要摆面包屑），
          所以两者用同一组类：`wb-chrome wb-topbar`。
          自己写一层 `bg-white/80` 的话，皮肤在会话页上只改到一半——
          而会话页正是这个应用待得最久的一页。 */}
      <header className="wb-chrome wb-topbar flex flex-wrap items-center gap-3 border-b border-neutral-200/80 px-4 py-2.5 dark:border-neutral-800/80">
        <select
          value={currentModel}
          onChange={async (e) => {
            if (activeId) {
              await fetch(`/api/conversations/${activeId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model_id: e.target.value }),
              })
              await refreshConversations()
            }
          }}
          disabled={!modelOptions.length}
          className="min-w-0 max-w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm shadow-sm transition-colors hover:border-violet-300 focus:border-violet-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-violet-500/50"
        >
          {!modelOptions.length && <option value="">未配置模型</option>}
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {agents.length > 0 && (
          <select
            value={agentId ?? ''}
            onChange={(e) => setAgentId(e.target.value ? Number(e.target.value) : null)}
            className={`min-w-0 max-w-full rounded-lg border px-2.5 py-1.5 text-sm shadow-sm transition-colors focus:outline-none ${
              agentId != null
                ? 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300'
                : 'border-neutral-200 bg-white text-neutral-400 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-900'
            }`}
          >
            <option value="">🤖 默认助手</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.avatar} {a.name}
              </option>
            ))}
          </select>
        )}
        {modelOptions.length > 1 && (
          <select
            value={compareModel}
            onChange={(e) => setCompareModel(e.target.value)}
            title="选择第二个模型做一问多答对比"
            className={`min-w-0 max-w-full rounded-lg border px-2.5 py-1.5 text-sm shadow-sm transition-colors focus:outline-none ${
              compareModel
                ? 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-300'
                : 'border-neutral-200 bg-white text-neutral-400 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-900'
            }`}
          >
            <option value="">⚖ 对比关</option>
            {modelOptions
              .filter((o) => o.value !== currentModel)
              .map((o) => (
                <option key={o.value} value={o.value}>
                  ⚖ vs {o.label}
                </option>
              ))}
          </select>
        )}
        <label
          className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${
            useRag
              ? 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300'
              : 'border-neutral-200 bg-white text-neutral-400 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-500'
          }`}
        >
          <input
            type="checkbox"
            checked={useRag}
            onChange={(e) => setUseRag(e.target.checked)}
            className="h-4 w-4 accent-violet-600"
          />
          知识库
        </label>
        <button
          onClick={() =>
            setAmbience((v) => {
              const next = !v
              try {
                localStorage.setItem('wb:ambience', next ? '1' : '0')
              } catch {
                /* 无痕模式记不了就算了 */
              }
              return next
            })
          }
          aria-pressed={ambience}
          title={ambience ? '氛围粒子：开（点一下关掉）' : '氛围粒子：关'}
          className={`rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${
            ambience
              ? 'border-pink-200 bg-pink-50 text-pink-500 dark:border-pink-500/40 dark:bg-pink-500/10 dark:text-pink-300'
              : 'border-neutral-200 bg-white text-neutral-400 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-500'
          }`}
        >
          🌸
        </button>
        {activeId && (
          <>
            <span className="ml-auto truncate text-xs text-neutral-400">
              {activeAgent ? `${activeAgent.avatar} ${activeAgent.name} · ` : ''}
              {conversations.find((c) => c.id === activeId)?.title}
            </span>
            <button
              onClick={exportChat}
              title="导出为 Markdown"
              className="ml-1 shrink-0 rounded-md px-2 py-1 text-xs text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              ⬇ 导出
            </button>
          </>
        )}
      </header>
    </>
  )
}
