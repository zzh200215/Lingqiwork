// 零柒的展开面板（方向 6 第四刀，2026-09-29 自 PetWidget 拆出的展示层）：
// 头部七样、成长进度、此刻、事件流与聊天、插件、快捷起头、输入行。
// 状态与逻辑全部住在 PetWidget 本体，这里只收 props 画 UI。
import { Link } from 'react-router-dom'
import type { PetGrowth, PetPlugin, PetRoom, PetState, TutorMastery } from './api'
import { receiptLabel } from './petChat'
import type { PipWindow } from './petPip'
import { MODE_LABEL, timeLabel, type ChatMsg, type PetEvent } from './petShared'
import { STARTER_CARDS } from './StarterCards'
import PetPluginRow from './PetPluginRow'
import type { useVoiceInput } from './voice'

interface Props {
  growth: PetGrowth | null
  state: PetState | null
  mastery: TutorMastery | null
  room: PetRoom | null
  events: PetEvent[]
  chat: ChatMsg[]
  error: string | null
  /** 工具正在跑时的一句话：模型调完工具还要再走一轮才开口，那段空白得有个交代 */
  toolBusy: string | null
  plugins: PetPlugin[]
  speakOn: boolean
  speaking: boolean
  blipOn: boolean
  pipWin: PipWindow | null
  voice: ReturnType<typeof useVoiceInput>
  input: string
  setInput: (v: string) => void
  busy: boolean
  panelBottomRef: React.RefObject<HTMLDivElement | null>
  onToggleSpeak: () => void
  onToggleBlip: () => void
  onOpenPip: () => void
  onClose: () => void
  onRunPlugin: (name: string, command: string, args?: Record<string, unknown>) => void
  onSend: (text?: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
}

export default function PetPanel({
  growth,
  state,
  mastery,
  room,
  events,
  chat,
  error,
  toolBusy,
  plugins,
  speakOn,
  speaking,
  blipOn,
  pipWin,
  voice,
  input,
  setInput,
  busy,
  panelBottomRef,
  onToggleSpeak,
  onToggleBlip,
  onOpenPip,
  onClose,
  onRunPlugin,
  onSend,
  onKeyDown,
}: Props) {
  return (
    <div className="pet-bubble pointer-events-auto mb-2 flex h-[380px] max-h-[70vh] w-[calc(100vw-32px)] max-w-[320px] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-2xl shadow-neutral-900/20 dark:border-neutral-700 dark:bg-neutral-900">
      {/* 头部一行七样（§#24）：成长链 min-w-0 flex-1 truncate 吃掉弹性、
          尾部按钮 shrink-0 保活——窄面板上被裁的是「正在靠近…」，不再是按钮。 */}
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <span className="shrink-0 text-sm font-semibold text-neutral-800 dark:text-neutral-100">零柒</span>
        {growth && (
          <Link
            to="/growth"
            onClick={onClose}
            title="看成长"
            className="min-w-0 flex-1 truncate text-xs text-neutral-400 transition-colors hover:text-violet-500 dark:text-neutral-500"
          >
            Lv.{growth.level} {growth.title} · EXP {growth.exp}
            {growth.next_title && ` · 正在靠近「${growth.next_title}」`}
          </Link>
        )}
        <button
          onClick={onToggleSpeak}
          title={speakOn ? '朗读：开（点一下关掉）' : '朗读：关'}
          className={`shrink-0 text-xs transition-colors ${
            speakOn ? 'text-violet-500' : 'text-neutral-400 dark:text-neutral-500'
          } hover:text-violet-500`}
        >
          {speaking ? '🔊' : speakOn ? '🔈' : '🔇'}
        </button>
        <button
          onClick={onToggleBlip}
          title={blipOn ? '音效：开（点一下关掉）' : '音效：关'}
          className={`shrink-0 text-xs transition-colors ${
            blipOn ? 'text-violet-500' : 'text-neutral-400 dark:text-neutral-500'
          } hover:text-violet-500`}
        >
          {blipOn ? '🔔' : '🔕'}
        </button>
        <button
          onClick={onOpenPip}
          title={
            pipWin ? '收回置顶小窗' : '弹出置顶小窗：切去别的应用，它也浮在屏幕上'
          }
          className={`shrink-0 text-xs transition-colors ${
            pipWin ? 'text-violet-500' : 'text-neutral-400 dark:text-neutral-500'
          } hover:text-violet-500`}
        >
          📌
        </button>
        <Link
          to="/companion"
          onClick={onClose}
          title="整页聊天 / 教它 / 成长 / 小屋 / 有声"
          className="shrink-0 text-xs text-neutral-400 transition-colors hover:text-violet-500 dark:text-neutral-500"
        >
          陪伴页 →
        </Link>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md px-1.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          ✕
        </button>
      </div>

      {/* 成长进度条：只画「正在靠近」，不写「还差 N」 */}
      {growth && (
        <div className="h-0.5 w-full bg-neutral-100 dark:bg-neutral-800">
          <div
            className="h-0.5 bg-violet-500 transition-all"
            style={{ width: `${Math.round(growth.progress * 100)}%` }}
          />
        </div>
      )}

      {/* 此刻（P1）：状态机给的姿势与精力。零柒的台词放在前，界面的说法在后——
          它是**当下**的量，跨天归零，不是「还欠 N」的账。 */}
      {state && (
        <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-1.5 text-xs text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
          <span className="min-w-0 flex-1 truncate" data-pet-mode={state.mode}>
            {state.line || MODE_LABEL[state.mode]}
          </span>
          <span className="shrink-0" title="此刻的精神——只描述现在，不是要还的债">
            精力
          </span>
          <div
            data-pet-energy={state.energy}
            className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700"
          >
            <div
              className="h-full bg-violet-400 transition-all"
              style={{ width: `${Math.max(0, Math.min(100, state.energy))}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2 text-sm leading-relaxed">
        {growth && growth.parts.length > 0 && (
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-neutral-400 dark:text-neutral-500">
            {growth.parts.map((p) => (
              <span key={p.key}>
                {p.label} +{p.exp}
              </span>
            ))}
          </div>
        )}
        {mastery && mastery.events.length > 0 && (
          <div className="text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
            最近搞懂：
            {mastery.events.slice(0, 3).map((e) => e.concept).join('、')}
            {mastery.mastered > 3 ? ` 等 ${mastery.mastered} 个` : ''}
            <Link
              to="/tutor"
              onClick={onClose}
              className="ml-1 text-violet-500 hover:underline"
            >
              看学习地图
            </Link>
          </div>
        )}
        {room?.carried && (
          <div className="text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
            它最近叼回来：{room.carried.icon} {room.carried.label}
            <Link
              to="/companion?tab=room"
              onClick={onClose}
              className="ml-1 text-violet-500 hover:underline"
            >
              去小屋
            </Link>
          </div>
        )}
        {!events.length && !chat.length && !error && (
          <div className="text-neutral-400 dark:text-neutral-500">
            零柒还没说过话。它会在任务、摘要、备份、订阅有动静时主动开口——你也可以现在跟它聊。
          </div>
        )}
        {events.map((e) => (
          <div key={`e${e.id}`} className="max-w-[92%] break-words rounded-lg rounded-bl-sm bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
            <div className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-200">{e.text}</div>
            <div className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">{timeLabel(e.created_at)}</div>
          </div>
        ))}
        {chat.map((m, i) =>
          m.role === 'user' ? (
            <div key={`u${i}`} className="ml-auto max-w-[92%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-violet-600 px-3 py-2 text-white">
              {m.text}
            </div>
          ) : (
            <div
              key={`p${i}`}
              className="max-w-[92%] break-words rounded-lg rounded-bl-sm bg-neutral-100 px-3 py-2 dark:bg-neutral-800"
            >
              {/* 它真的做了什么。写在话**前面**：先有动作，再有解释。 */}
              {m.tools && m.tools.length > 0 && (
                <ul className="mb-1 flex flex-wrap gap-1">
                  {m.tools.map((r, k) => (
                    <li
                      key={k}
                      className="rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
                    >
                      {receiptLabel(r)}
                    </li>
                  ))}
                </ul>
              )}
              {m.text ? (
                <span className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-200">
                  {m.text}
                </span>
              ) : null}
              {!m.text && (
                <span className="text-xs text-neutral-400 dark:text-neutral-500">
                  {toolBusy ?? (
                    <span className="inline-block animate-pulse text-violet-400">▊</span>
                  )}
                </span>
              )}
            </div>
          ),
        )}
        {error && <div className="rounded-lg bg-rose-100 px-3 py-2 text-xs text-rose-600 dark:bg-rose-950/60 dark:text-rose-300">{error}</div>}
        <div ref={panelBottomRef} />
      </div>

      {plugins.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
          {plugins.map((p) => (
            <PetPluginRow
              key={p.name}
              p={p}
              onCommand={(name, command, args) => void onRunPlugin(name, command, args)}
            />
          ))}
        </div>
      )}

      {/* 快捷对话条：还没开聊的时候，一键起头——开口的门槛越低，陪伴越真 */}
      {chat.length === 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-neutral-200 px-3 pt-2 dark:border-neutral-800">
          {/* 文案与陪伴页空态同源（STARTER_CARDS 前三张）——两处维护必漂移（§#26） */}
          {STARTER_CARDS.slice(0, 3).map((c) => (
            <button
              key={c.title}
              onClick={() => onSend(c.q)}
              disabled={busy}
              className="rounded-full border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-violet-500/50"
            >
              {c.title}
            </button>
          ))}
        </div>
      )}

      <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
        <div className="flex gap-2">
          {/* 对着零柒说话：说完直接发，不用再按一下（见 voice 那段注释） */}
          <button
            onClick={voice.toggle}
            disabled={voice.transcribing || busy}
            title={voice.recording ? '停止并转写' : '对着零柒说话（说完直接发）'}
            className={`flex w-9 shrink-0 items-center justify-center rounded-lg border text-sm transition-colors disabled:opacity-40 ${
              voice.recording
                ? 'border-rose-400 bg-rose-50 text-rose-500 dark:border-rose-500/50 dark:bg-rose-500/10'
                : 'border-neutral-300 text-neutral-400 hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:hover:border-violet-500/50'
            }`}
          >
            {voice.transcribing ? (
              '⏳'
            ) : voice.recording ? (
              <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" />
            ) : (
              '🎤'
            )}
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="跟零柒说点什么"
            className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-800 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
          <button
            onClick={() => onSend()}
            disabled={busy || !input.trim()}
            className="rounded-lg bg-violet-600 px-3 text-sm text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  )
}
