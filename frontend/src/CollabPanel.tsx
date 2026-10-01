// 协作选择面板（方向 6 第十九刀，2026-09-30 自 App.tsx 拆出）：
// 工具栏的 👥 开关 + 模式/成员/钉选材料三段选择 + 开始按钮。纯展示组件，
// 状态与 startCollab 在 useCollabChat，经同名 props 注入（JSX 与拆出前逐字一致）。
import CollabPins from './CollabPins'
import type { AgentPreset } from './api'
import type { Dispatch, SetStateAction } from 'react'
import type { PinnedMaterial } from './CollabPins'

type CollabPattern = 'pipeline' | 'review' | 'fanout'

export default function CollabPanel({
  collabOpen,
  setCollabOpen,
  collabPattern,
  setCollabPattern,
  collabPick,
  setCollabPick,
  collabPins,
  setCollabPins,
  agents,
  input,
  busy,
  startCollab,
}: {
  collabOpen: boolean
  setCollabOpen: Dispatch<SetStateAction<boolean>>
  collabPattern: CollabPattern
  setCollabPattern: Dispatch<SetStateAction<CollabPattern>>
  collabPick: number[]
  setCollabPick: Dispatch<SetStateAction<number[]>>
  collabPins: PinnedMaterial[]
  setCollabPins: Dispatch<SetStateAction<PinnedMaterial[]>>
  agents: AgentPreset[]
  input: string
  busy: boolean
  startCollab: () => void
}) {
  return (
    <>
      <button
        onClick={() => setCollabOpen((v) => !v)}
        title="智能体协作：选 2-4 个智能体按流水线或评审回路协作完成输入框里的目标"
        className={`flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-lg border text-lg transition-all ${
          collabOpen
            ? 'border-violet-400 bg-violet-50 text-violet-600 dark:border-violet-500/50 dark:bg-violet-500/10'
            : 'border-neutral-300 bg-white text-neutral-400 hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-violet-500/50'
        }`}
      >
        👥
      </button>
      {collabOpen && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-80 overflow-hidden rounded-md border border-neutral-200 wb-float bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          <p className="border-b border-neutral-100 px-3 py-1.5 text-xs uppercase tracking-wider text-neutral-400 dark:border-neutral-800">
            智能体协作 · 以输入框内容为目标
          </p>
          <div className="flex gap-1.5 px-3 pt-2.5">
            {(
              [
                ['pipeline', '流水线', '依次接力完成'],
                ['review', '评审回路', '初稿→评审→修订'],
                ['fanout', '并行分派', '各自独立做→汇总'],
              ] as const
            ).map(([id, label, hint]) => (
              <button
                key={id}
                onClick={() => setCollabPattern(id)}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-left transition-colors ${
                  collabPattern === id
                    ? 'border-violet-400 bg-violet-50 dark:border-violet-500/50 dark:bg-violet-500/10'
                    : 'border-neutral-200 hover:border-violet-300 dark:border-neutral-700'
                }`}
              >
                <span className="block text-xs font-medium text-neutral-700 dark:text-neutral-200">{label}</span>
                <span className="block text-xs text-neutral-400">{hint}</span>
              </button>
            ))}
          </div>
          <div className="max-h-44 overflow-y-auto px-3 py-2">
            <p className="pb-1 text-xs text-neutral-400">选择 {collabPattern === 'review' ? '2 个（起草者与评审者）' : '2-4 个'}智能体：</p>
            {collabPattern === 'fanout' && (
              <p className="pb-1 text-xs text-neutral-400">
                每个智能体各做一版（互不依赖，服务端并行跑），最后一个负责汇总
              </p>
            )}
            {agents.length ? (
              <div className="flex flex-wrap gap-1.5">
                {agents
                  .filter((a) => a.enabled)
                  .map((a) => {
                    const picked = collabPick.includes(a.id)
                    return (
                      <button
                        key={a.id}
                        onClick={() => setCollabPick((p) => (picked ? p.filter((x) => x !== a.id) : [...p, a.id]))}
                        className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                          picked
                            ? 'border-violet-400 bg-violet-100 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/15 dark:text-violet-300'
                            : 'border-neutral-200 text-neutral-500 hover:border-violet-300 dark:border-neutral-700 dark:text-neutral-400'
                        }`}
                      >
                        {a.avatar} {a.name}
                      </button>
                    )
                  })}
              </div>
            ) : (
              <p className="py-2 text-xs text-neutral-400">还没有智能体 — 在设置页「智能体预设」创建</p>
            )}
          </div>
          {collabPattern === 'fanout' && (
            <CollabPins pins={collabPins} onChange={setCollabPins} />
          )}
          <div className="flex items-center gap-2 border-t border-neutral-100 px-3 py-2 dark:border-neutral-800">
            <span className="text-xs leading-snug text-neutral-400">
              已选 {collabPick.length} 个 · 评审回路用前 2 个
              {collabPattern === 'fanout' && ' · 并行分派：第 1 个负责汇总'}
            </span>
            <button
              onClick={startCollab}
              disabled={busy || !input.trim() || collabPick.length < 2}
              className="ml-auto rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-40 dark:bg-violet-500"
            >
              ▶ 开始协作
            </button>
          </div>
        </div>
      )}
    </>
  )
}
