import type { Dispatch, SetStateAction } from 'react'
import { MessageSquare } from 'lucide-react'
import ArtifactReceipt from './ArtifactReceipt'
import { upsertArtifact } from './artifacts'
import { SaveTextToVault } from './SaveToVault'
import type { ArtifactRef } from './stream'
import type { ChatMsg } from './useNoteChat'

// 笔记对话面板——JSX 从 NotesPage 原样搬来（方向 6），状态由 useNoteChat 持有、宿主下发。
export default function NoteChatPanel(props: {
  chatMsgs: ChatMsg[]
  setChatMsgs: Dispatch<SetStateAction<ChatMsg[]>>
  chatSaved: Record<number, ArtifactRef[]>
  setChatSaved: Dispatch<SetStateAction<Record<number, ArtifactRef[]>>>
  chatInput: string
  setChatInput: Dispatch<SetStateAction<string>>
  chatBusy: boolean
  sendChat: () => Promise<void>
  stopChat: () => void
  activePath: string | null
  insertAtCaret: (text: string) => void
  setChatOpen: Dispatch<SetStateAction<boolean>>
  chatBottomRef: { current: HTMLDivElement | null }
}) {
  const { chatMsgs, setChatMsgs, chatSaved, setChatSaved, chatInput, setChatInput, chatBusy, sendChat, stopChat, activePath, insertAtCaret, setChatOpen, chatBottomRef } = props
  return (
          <aside className="hidden w-80 shrink-0 flex-col overflow-hidden border-l border-neutral-200/80 bg-white/60 md:flex dark:border-neutral-800/80 dark:bg-neutral-950/60">
            <div className="flex items-center justify-between border-b border-neutral-200/80 px-3 py-2.5 dark:border-neutral-800/80">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
                <MessageSquare className="h-4 w-4" />
                笔记对话
              </h2>
              <div className="flex items-center gap-2">
                {chatMsgs.length > 0 && !chatBusy && (
                  <button
                    onClick={() => setChatMsgs([])}
                    className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                  >
                    清空
                  </button>
                )}
                <button
                  onClick={() => setChatOpen(false)}
                  className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
              {chatMsgs.map((m, i) => (
                <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
                  <div
                    className={`inline-block max-w-[92%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-left text-xs leading-relaxed ${
                      m.role === 'user'
                        ? 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200'
                        : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-200'
                    }`}
                  >
                    {m.content || (chatBusy && i === chatMsgs.length - 1 ? '…' : '')}
                  </div>
                  {m.role === 'assistant' && m.content && !chatBusy && (
                    <>
                      <div className="mt-1 flex gap-2 text-xs text-neutral-400">
                        <button
                          onClick={() => insertAtCaret(m.content)}
                          className="hover:text-violet-600 dark:hover:text-violet-300"
                        >
                          ⤵ 插入到笔记
                        </button>
                        <button
                          onClick={() => navigator.clipboard.writeText(m.content)}
                          className="hover:text-neutral-600 dark:hover:text-neutral-200"
                        >
                          复制
                        </button>
                        <SaveTextToVault
                          content={m.content}
                          label="存进产出"
                          title="把这条回答存进 vault 的产出区"
                          onSaved={(a) =>
                            setChatSaved((p) => ({ ...p, [i]: upsertArtifact(p[i], a) }))
                          }
                        />
                      </div>
                      {(chatSaved[i] ?? []).map((a) => (
                        <div key={a.path} className="mt-1">
                          <ArtifactReceipt art={a} />
                        </div>
                      ))}
                    </>
                  )}
                </div>
              ))}
              {!chatMsgs.length && (
                <p className="py-8 text-center text-xs leading-relaxed text-neutral-400">
                  基于当前笔记内容提问
                  <br />
                  如「给这篇列一个行动清单」
                </p>
              )}
              <div ref={chatBottomRef} />
            </div>
            <div className="border-t border-neutral-200/80 p-2 dark:border-neutral-800/80">
              {/* data-pet-clear：这行钉在右栏（全高侧栏）的底部，侧栏开着的窗口里
                  它就在右下角——零柒按这个属性给自己让位（见 PetWidget 的 dodge）。 */}
              <div data-pet-clear className="flex items-end gap-2">
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void sendChat()
                    }
                  }}
                  rows={2}
                  placeholder={activePath ? '问这篇笔记…（Enter 发送）' : '先打开一篇笔记'}
                  disabled={!activePath}
                  className="flex-1 resize-none rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs outline-none transition-colors focus:border-violet-400 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
                />
                {chatBusy ? (
                  <button
                    onClick={stopChat}
                    className="shrink-0 rounded-md border border-red-300 px-2 py-1.5 text-xs text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-950/30"
                  >
                    停止
                  </button>
                ) : (
                  <button
                    onClick={sendChat}
                    disabled={!chatInput.trim() || !activePath}
                    className="shrink-0 rounded-md bg-violet-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-40 dark:bg-violet-500 dark:hover:bg-violet-400"
                  >
                    发送
                  </button>
                )}
              </div>
            </div>
          </aside>
  )
}
