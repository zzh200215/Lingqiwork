// 对话气泡层（方向 6 第十六刀，2026-09-30 自 App.tsx 拆出）：
// ChatMessage 形状 / MarkdownBody（memo）/ MessageRow（memo，气泡全套：编辑·产出回执·
// 逐步账·工具与来源折叠·操作栏）/ toChatMessage（后端消息 → 界面气泡的纯函数，
// `App.message.test` 钉它）。
// 纯展示层：全部行为经回调 props 注入，与 ChatView 无状态耦合。
import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import CodeBlock from './CodeBlock'
import ArtifactReceipt from './ArtifactReceipt'
import CollabSteps from './CollabSteps'
import { saveHint } from './artifacts'
import SaveToVault from './SaveToVault'
import { type Message } from './api'
import { type ArtifactRef, type CollabStep, type QualityNote, type SourceRef, type ToolTrace } from './stream'

export interface ChatMessage {
  id?: number // backend id when persisted
  role: 'user' | 'assistant' | 'system'
  content: string
  streaming?: boolean
  sources?: SourceRef[]
  tools?: ToolTrace[] // tool calls made this turn (ephemeral, not persisted)
  /** 这一轮落盘的产出（`save_artifact` 的副产物）。正文在 vault 文件里，
   *  这里只留回执——点开才看正文，对话流不被长文淹。 */
  artifacts?: ArtifactRef[]
  /** W2a：服务端对这一轮两条底线的校验结论（该存的存了没 / 有没有编路径）。
   *  **判定在服务端**，这里只显示。 */
  quality?: QualityNote
  modelId?: string // which model produced this answer (comparison mode)
  modelLabel?: string
  streamUid?: string // 'a'/'b' while streaming in comparison mode
  feedback?: 'up' | 'down' | null
  ctxFiles?: string[] // vault files injected whole via # command (ephemeral)
  /** 协作的**逐步账**（A2 的 `step` 事件：谁跑的、几轮、几次工具、几秒、有没有烧光）。
   *  与 `tools` 一样是**这一轮的过程读数**，后端不落库——刷新之后只剩纪要正文，
   *  逐步账不再出现（它是"看这一步贵在哪"的现场账，不是历史）。 */
  collabSteps?: CollabStep[]
}
// Memoized markdown body — only re-renders when its own text changes,
// so streaming one message doesn't re-render every other message.
const MarkdownBody = React.memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
      components={{ pre: CodeBlock }}
    >
      {text}
    </ReactMarkdown>
  )
})

// Memoized message row
export const MessageRow = React.memo(function MessageRow({
  m,
  onRegenerate,
  onFork,
  onEditUser,
  onFeedback,
  onSpeak,
  speaking,
  convId,
  onSavedArtifact,
}: {
  m: ChatMessage
  onRegenerate?: () => void
  onFork?: () => void
  onEditUser?: (content: string) => void
  onFeedback?: (rating: 'up' | 'down' | null) => void
  onSpeak?: (m: ChatMessage) => void
  speaking?: boolean
  convId?: number
  onSavedArtifact?: (art: ArtifactRef) => void
}) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  if (m.role === 'user') {
    return (
      <div className="group animate-slide-up">
        <div className="flex justify-end">
          {editing ? (
            <div className="flex w-[80%] max-w-[80%] flex-col gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(8, Math.max(2, draft.split('\n').length))}
                autoFocus
                className="resize-none rounded-lg border border-violet-300 bg-white px-4 py-3 text-[15px] focus:border-violet-500 focus:outline-none dark:border-violet-500/50 dark:bg-neutral-900"
              />
              <div className="flex justify-end gap-2 text-xs">
                <button
                  onClick={() => setEditing(false)}
                  className="rounded-md px-3 py-1.5 text-neutral-500"
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    setEditing(false)
                    if (draft.trim() && draft.trim() !== m.content) onEditUser?.(draft.trim())
                  }}
                  disabled={!draft.trim()}
                  className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 font-medium text-white disabled:opacity-40"
                >
                  保存并重新生成
                </button>
              </div>
            </div>
          ) : (
            <div className="max-w-[80%] whitespace-pre-wrap rounded-lg rounded-br-md bg-gradient-to-br from-violet-600 to-fuchsia-600 px-4 py-2.5 text-[15px] text-white shadow-sm shadow-violet-200 dark:shadow-none">
              {m.content}
            </div>
          )}
        </div>
        {!!m.ctxFiles?.length && (
          <div className="mt-1 flex flex-wrap justify-end gap-1">
            {m.ctxFiles.map((f) => (
              <span
                key={f}
                className="max-w-[240px] truncate rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-600 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
              >
                # {f}
              </span>
            ))}
          </div>
        )}
        {!editing && (
          <div className="mt-1 flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {m.id && onEditUser && (
              <button
                onClick={() => {
                  setDraft(m.content)
                  setEditing(true)
                }}
                className="rounded-md px-2 py-1 text-xs text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              >
                ✎ 编辑
              </button>
            )}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="group animate-slide-up">
      <div className="flex gap-3">
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-sm shadow-sm shadow-violet-200 dark:shadow-none">
          🧠
        </div>
        <div className="prose prose-neutral min-w-0 max-w-none flex-1 break-words text-[15px] leading-relaxed dark:prose-invert">
          {m.modelLabel && (
            <span
              className={`not-prose mb-1 inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                m.modelLabel.startsWith('B')
                  ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300'
                  : 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
              }`}
            >
              {m.modelLabel}
            </span>
          )}
          <MarkdownBody text={m.content} />
          {m.streaming && <span className="stream-cursor" />}
          {m.artifacts && m.artifacts.length > 0 && (
            <ul className="not-prose mt-2 space-y-1.5">
              {m.artifacts.map((a, i) => (
                <li key={`${a.path}-${i}`}>
                  <ArtifactReceipt art={a} />
                </li>
              ))}
            </ul>
          )}
          {!m.streaming &&
            (() => {
              // 这一轮该不该给用户一句实话。判据在服务端（W2a），这里只显示。
              const hint = saveHint(m.content, m.artifacts, m.quality)
              if (!hint) return null
              return (
                <p
                  data-save-hint={hint.primary ? 'primary' : 'info'}
                  className={
                    hint.primary
                      ? 'not-prose mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
                      : 'not-prose mt-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/60'
                  }
                >
                  {hint.primary ? '⚠️ ' : 'ℹ️ '}
                  {hint.text}
                  {/* 一键补：**提到最显眼处**（不靠 hover 才出现的操作栏）。内容已经在
                      手上，点一个体裁就落盘——这是 W2a 修复失败时的人工出口。 */}
                  {hint.primary && convId !== undefined && m.id !== undefined && onSavedArtifact ? (
                    <SaveToVault
                      conversationId={convId}
                      messageId={m.id}
                      onSaved={onSavedArtifact}
                      className="ml-1 align-middle"
                    />
                  ) : null}
                </p>
              )
            })()}
          {m.tools && m.tools.length > 0 && (
            <details className="not-prose mt-2 rounded-lg border border-neutral-200 bg-neutral-50 text-xs transition-colors dark:border-neutral-800 dark:bg-neutral-900/60">
              <summary className="cursor-pointer px-3 py-1.5 text-neutral-500 transition-colors hover:text-violet-600 dark:hover:text-violet-400">
                🔧 调用了 {m.tools.length} 个工具
              </summary>
              <ul className="max-h-40 space-y-1 overflow-y-auto px-3 pb-2">
                {m.tools.map((t, i) => (
                  <li key={i} className="break-all font-mono text-neutral-500">
                    {t.name}
                    <span className="text-neutral-400"> {JSON.stringify(t.arguments)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {m.sources && m.sources.length > 0 && (
            <details className="not-prose mt-2 rounded-md border border-neutral-200 bg-neutral-50 text-xs transition-colors dark:border-neutral-800 dark:bg-neutral-900/60">
              <summary className="cursor-pointer px-3 py-2 text-neutral-500 transition-colors hover:text-violet-600 dark:hover:text-violet-400">
                📚 参考了 {m.sources.length} 个知识库片段
              </summary>
              <ol className="max-h-48 space-y-2 overflow-y-auto px-3 pb-2">
                {m.sources.map((s, j) => (
                  <li key={j} className="border-l-2 border-violet-300 pl-2 dark:border-violet-700">
                    <div className="flex items-center justify-between gap-2 text-neutral-500">
                      <span className="min-w-0 truncate">
                        [{j + 1}] {s.source}
                        {s.chunk != null && (
                          <span className="text-neutral-400"> · 第 {s.chunk + 1} 段</span>
                        )}
                        {' · '}score {s.score}
                        {s.channels?.includes('full') && (
                          <span className="ml-1 rounded bg-emerald-100 px-1 py-0.5 text-xs text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
                            全文
                          </span>
                        )}
                      </span>
                      {s.source?.endsWith('.md') && (
                        <Link
                          to={`/notes?path=${encodeURIComponent(s.source)}`}
                          className="shrink-0 text-violet-500 transition-colors hover:text-violet-700 hover:underline dark:text-violet-400"
                        >
                          打开
                        </Link>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-neutral-400">{s.text}</p>
                  </li>
                ))}
              </ol>
            </details>
          )}
          {/* 协作的逐步账（A2）：摆在纪要**下面**——正文是结论，这一份是"贵在哪"的现场账。
              它是流式事件带来的，后端不落库，所以刷新之后就不再出现（同 `tools`）。 */}
          {m.collabSteps && m.collabSteps.length > 0 && <CollabSteps steps={m.collabSteps} />}
        </div>
      </div>
      {/* action bar */}
      {!m.streaming && m.content && (
        <div className="ml-10 mt-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => {
              navigator.clipboard.writeText(m.content).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
            className="rounded-md px-2 py-1 text-xs text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            {copied ? '✓ 已复制' : '复制'}
          </button>
          {onSpeak && m.role === 'assistant' && (
            <button
              onClick={() => onSpeak(m)}
              title={speaking ? '停止播报' : '朗读这条回答'}
              className={`rounded-md px-2 py-1 text-xs transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                speaking ? 'text-violet-600 dark:text-violet-300' : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300'
              }`}
            >
              {speaking ? '⏹ 停止播报' : '🔊 播报'}
            </button>
          )}
          {onRegenerate && (
            <button
              onClick={onRegenerate}
              className="rounded-md px-2 py-1 text-xs text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              ↻ 重新生成
            </button>
          )}
          {convId !== undefined && m.id !== undefined && onSavedArtifact && (
            <SaveToVault
              conversationId={convId}
              messageId={m.id}
              onSaved={onSavedArtifact}
            />
          )}
          {onFork && (
            <button
              onClick={onFork}
              className="rounded-md px-2 py-1 text-xs text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              🍴 从这里分叉
            </button>
          )}
          {onFeedback && (
            <>
              <button
                onClick={() => onFeedback(m.feedback === 'up' ? null : 'up')}
                className={`rounded-md px-2 py-1 text-xs transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                  m.feedback === 'up'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-neutral-400 hover:text-emerald-600'
                }`}
                title="回答有帮助"
              >
                👍
              </button>
              <button
                onClick={() => onFeedback(m.feedback === 'down' ? null : 'down')}
                className={`rounded-md px-2 py-1 text-xs transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                  m.feedback === 'down'
                    ? 'text-red-500 dark:text-red-400'
                    : 'text-neutral-400 hover:text-red-500'
                }`}
                title="回答不准确或没用"
              >
                👎
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
})

/** 后端那条消息 → 界面这条气泡。**纯函数，故有测试**（`App.message.test.tsx`）。
 *
 * 三条附属事实都是「刷新后就没了」那一类，所以每一条都要 hydrate：产出回执（正文在 vault
 * 文件里）、W2a 的校验结论（不做的话那条「没落盘」的实话消失、看起来一切正常）、以及
 * A2 的逐步账（协作那条路才有）。
 *
 * **`null` 一律化成 `undefined`**：后端用 NULL 说「那时候没有这笔账」，界面据此**不渲染那一栏**
 * ——不能把它变成空数组，那会画出一个 0 步的空壳（「没有」与「空账」是两件事）。
 */
export function toChatMessage(m: Message): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    sources: (m as { sources?: SourceRef[] | null }).sources ?? undefined,
    artifacts: m.artifacts ?? undefined,
    quality: m.quality ?? undefined,
    collabSteps: m.steps ?? undefined,
    feedback: m.feedback ?? undefined,
  }
}
