/** 陪伴页 — 零柒的五张脸：**聊天**（整页跟它说话，不用挤在右下角的小面板里）、
 *  **教它**（费曼法：你讲，它当那个什么都不懂的幼崽）、**成长**（它随你怎么长的
 *  总账，整页搬进来）、**小屋**（它攒下的东西：产出、徽章、道具）、
 *  **有声**（播客：拿你的卡点、你的材料录一期，干活时有声音陪着）。
 *
 *  陪伴不进导航——五区导航里没有它的位置是刻意的：入口是宠物本身（右下角零柒 → 陪伴页），
 *  陪伴是「随手够得着」，不是「又一个要去的地方」。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { api, type PetGrowth, type PodcastEntry, type TutorStuckRow } from './api'
import EmptyHint from './EmptyHint'
import GrowthPage from './GrowthPage'
import PageShell from './PageShell'
import RoomPane from './RoomPane'
import { receiptLabel, streamPetChat, toolCallLabel, type PetToolReceipt } from './petChat'
import { streamTutorSay } from './stream'

type Tab = 'chat' | 'teach' | 'growth' | 'room' | 'audio'

const TABS: [Tab, string][] = [
  ['chat', '聊天'],
  ['teach', '教它'],
  ['growth', '成长'],
  ['room', '小屋'],
  ['audio', '有声'],
]

interface ChatMsg {
  role: 'user' | 'pet'
  text: string
  /** 这一轮零柒真的做了什么（P3）。空 = 它只是回了句话。 */
  tools?: PetToolReceipt[]
}

/** 还没开聊时的一键起头——与宠物面板同一份，开口的门槛越低，陪伴越真。 */
const STARTERS: [string, string][] = [
  ['排一下今天', '帮我看看现在都欠着什么，排个先后。'],
  ['陪我聊两句', '陪我聊两句，随便什么都行。'],
  ['总结今天', '总结一下我今天都干了什么。'],
]

function dur(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 整页聊天：和小面板同一条 SSE 协议（petChat.ts），但地方够大，说话不用抠抠缩缩。 */
function ChatPane() {
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [toolBusy, setToolBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [chat])

  useEffect(() => () => abortRef.current?.abort(), [])

  const send = useCallback(async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || busy) return
    setInput('')
    setError(null)
    setChat((c) => [...c, { role: 'user', text: msg }, { role: 'pet', text: '' }])
    setBusy(true)
    const ac = new AbortController()
    abortRef.current = ac
    let acc = ''
    const receipts: PetToolReceipt[] = []
    const paint = () =>
      setChat((c) => {
        const n = [...c]
        n[n.length - 1] = {
          role: 'pet',
          text: acc,
          tools: receipts.length ? [...receipts] : undefined,
        }
        return n
      })
    try {
      await streamPetChat(
        msg,
        {
          onDelta: (t) => {
            acc += t
            setToolBusy(null)
            paint()
          },
          onToolCall: (name) => setToolBusy(toolCallLabel(name)),
          onToolResult: (r) => {
            setToolBusy(null)
            receipts.push(r)
            paint()
          },
        },
        ac.signal
      )
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setToolBusy(null)
      abortRef.current = null
    }
  }, [busy, input])

  return (
    <div className="flex h-[calc(100vh-230px)] min-h-[380px] flex-col rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm leading-relaxed">
        {chat.length === 0 && !error && (
          <div className="max-w-[75%] rounded-2xl rounded-bl-sm bg-neutral-100 px-4 py-3 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
            我在。想聊什么都行——卡住的地方、今天的心情，或者什么都不为。
          </div>
        )}
        {chat.map((m, i) =>
          m.role === 'user' ? (
            <div
              key={`u${i}`}
              className="ml-auto max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-violet-600 px-4 py-3 text-white"
            >
              {m.text}
            </div>
          ) : (
            <div
              key={`p${i}`}
              className="max-w-[75%] rounded-2xl rounded-bl-sm bg-neutral-100 px-4 py-3 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
            >
              {/* 它真的做了什么。写在话**前面**：先有动作，再有解释。 */}
              {m.tools && m.tools.length > 0 && (
                <ul className="mb-1.5 flex flex-wrap gap-1">
                  {m.tools.map((r, k) => (
                    <li
                      key={k}
                      className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
                    >
                      {receiptLabel(r)}
                    </li>
                  ))}
                </ul>
              )}
              {m.text ? <span className="whitespace-pre-wrap">{m.text}</span> : null}
              {!m.text && (
                <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                  {toolBusy ?? (
                    <span className="inline-block animate-pulse text-violet-400">▊</span>
                  )}
                </span>
              )}
            </div>
          )
        )}
        {error && (
          <div className="rounded-lg bg-red-100 px-3 py-2 text-xs text-red-600 dark:bg-red-950/60 dark:text-red-300">
            {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {chat.length === 0 && (
        <div className="flex flex-wrap gap-1.5 px-5 pb-1">
          {STARTERS.map(([label, q]) => (
            <button
              key={label}
              onClick={() => void send(q)}
              disabled={busy}
              className="rounded-full border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-violet-500/50"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="跟零柒说点什么（Esc 停止生成）"
            className="flex-1 rounded-xl border border-neutral-300 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
          <button
            onClick={() => (busy ? abortRef.current?.abort() : void send())}
            disabled={!busy && !input.trim()}
            className="rounded-xl bg-violet-600 px-5 text-sm text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
          >
            {busy ? '停' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 有声：播客清单 + 就地录一期。声音从你自己的材料里来——陪伴不是背景音乐，是你自己的事被讲出来。 */
function AudioPane() {
  const [podcasts, setPodcasts] = useState<PodcastEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const refresh = useCallback(() => {
    api
      .listPodcasts()
      .then((r) => setPodcasts(r.podcasts))
      .catch(() => setPodcasts([]))
  }, [])

  useEffect(refresh, [refresh])

  const fromStuck = useCallback(async () => {
    setBusy(true)
    setMsg('正在写脚本、配音、装配——大概一两分钟…')
    try {
      await api.podcastFromStuck()
      setMsg('')
      refresh()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const remove = useCallback(
    async (id: string) => {
      try {
        await api.deletePodcast(id)
        refresh()
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e))
      }
    },
    [refresh]
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void fromStuck()}
          disabled={busy}
          className="rounded-xl border border-violet-300 px-3 py-1.5 text-xs text-violet-700 transition-colors hover:bg-violet-50 disabled:opacity-40 dark:border-violet-500/50 dark:text-violet-300 dark:hover:bg-violet-500/10"
        >
          {busy ? '录制中…' : '🎙 拿没解的卡点录一期'}
        </button>
        <span className="text-[11px] text-neutral-400">
          想聊调研圆桌，去
          <Link to="/tutor" className="text-violet-500 hover:underline">
            学
          </Link>
          页的圆桌卡
        </span>
      </div>
      {msg ? <p className="text-[11px] text-neutral-500">{msg}</p> : null}

      {podcasts === null ? null : podcasts.length === 0 ? (
        <EmptyHint
          title="还没有一期播客。"
          hint="上面点一下，拿你最近没解的卡点录一期——它把「你卡在哪」讲成人话。"
        />
      ) : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
          {podcasts.map((p) => (
            <li key={p.id} className="py-3">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                  {p.title}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">
                  {dur(p.duration_sec)}
                </span>
                <span className="shrink-0 text-[11px] text-neutral-400">{p.created_at.slice(5, 10)}</span>
                <button
                  onClick={() => void remove(p.id)}
                  title="删掉这一期（脚本和音频一起）"
                  className="shrink-0 text-[11px] text-neutral-400 transition-colors hover:text-rose-500"
                >
                  删
                </button>
              </div>
              <audio
                controls
                preload="none"
                src={`/api/podcast/audio/${p.file}`}
                className="mt-1.5 h-9 w-full max-w-xl"
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 教它 — 费曼法，而那个「什么都不懂的学生」就是零柒。
 *
 *  这里**一行宠物代码都没有**，这是刻意的：费曼会话一开，后端状态机自己就进了
 *  `pupil`（零柒摆出「我在听」）；verdict=got 时后端会发一条 `mastered` 事件，
 *  状态机随即进 `celebrating`（它自己跳一下）。成长值同理，早就在 `pet.growth` 里
 *  算好了。所以这个组件只管教学本身——宠物那边不需要被「通知」。
 */
function TeachPane() {
  const [topic, setTopic] = useState('')
  const [sid, setSid] = useState<number | null>(null)
  const [who, setWho] = useState('')
  const [turns, setTurns] = useState<ChatMsg[]>([])
  const [streaming, setStreaming] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [verdict, setVerdict] = useState<'' | 'got' | 'half' | 'useless'>('')
  const [concept, setConcept] = useState('')
  const [growth, setGrowth] = useState<PetGrowth | null>(null)
  const [stuck, setStuck] = useState<TutorStuckRow[]>([])
  // 会话开始前的成长快照：用来报**真实的**增量，而不是把后端的 EXP 常数
  // 抄一份到前端（抄了就会漂移）。
  const beforeRef = useRef<PetGrowth | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // 你卡着的东西是「讲给它听」最好的选题——本来就没搞明白，才最需要讲一遍。
  // 只是建议，不是待办：一件都没有就一个字都不提。
  useEffect(() => {
    api
      .tutorStuck()
      .then((r) => setStuck(r.stuck.filter((s) => !s.resolved_at).slice(0, 3)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [turns, streaming, verdict])

  useEffect(() => () => abortRef.current?.abort(), [])

  const say = useCallback(async (id: number, text: string) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setErr('')
    setBusy(true)
    setTurns((t) => [...t, { role: 'user', text }])
    let acc = ''
    try {
      const done = await streamTutorSay(
        { session_id: id, text },
        {
          onDelta: (d) => {
            acc += d
            setStreaming(acc)
          },
        },
        ac.signal
      )
      if (!done.ok) setErr(done.error ?? '出错了')
    } catch (e) {
      // 主动掐断不是错误（换选题、离开页面时的中断），安静收尾即可
      if (!ac.signal.aborted) setErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (abortRef.current === ac) abortRef.current = null
      setStreaming('')
      // 半截回复后端也存了一份，这边留着才与它一致
      if (acc) setTurns((t) => [...t, { role: 'pet', text: acc }])
      setBusy(false)
    }
  }, [])

  const begin = useCallback(
    async (raw: string) => {
      const text = raw.trim()
      if (!text || busy) return
      setWho(text)
      setErr('')
      setTurns([])
      setStreaming('')
      setVerdict('')
      setConcept('')
      setGrowth(null)
      beforeRef.current = await api.petGrowth().catch(() => null)
      try {
        const s = await api.tutorStart(text, '', 'feynman')
        setSid(s.id)
        // 选题本身就是第一轮——没有「先问候一句」的特殊路径
        await say(s.id, text)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    },
    [busy, say]
  )

  const submit = useCallback(async () => {
    const t = draft.trim()
    if (!t || sid === null || busy) return
    setDraft('')
    await say(sid, t)
  }, [draft, sid, busy, say])

  const mark = useCallback(
    async (v: 'got' | 'half' | 'useless') => {
      if (sid === null || busy) return
      setBusy(true)
      try {
        const done = await api.tutorEnd(sid, v)
        setVerdict(v)
        setConcept(done.concept)
        setSid(null)
        // 当场把「它长了多少」报出来——宠物挂件自己 60 秒才轮询一次成长，
        // 而你刚做完的这件事值得立刻有回音。
        setGrowth(await api.petGrowth().catch(() => null))
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [sid, busy]
  )

  const before = beforeRef.current
  const gained = growth && before && growth.exp > before.exp ? growth.exp - before.exp : 0
  const levelUp = Boolean(growth && before && growth.level > before.level)
  const idle = sid === null

  return (
    <div className="flex h-[calc(100vh-230px)] min-h-[380px] flex-col rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm leading-relaxed">
        {idle && !verdict && (
          <div className="space-y-3">
            <div className="max-w-[75%] rounded-2xl rounded-bl-sm bg-neutral-100 px-4 py-3 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
              我什么都不懂。你挑一个东西，用大白话讲给我听——讲到我听明白，我就学会了。
            </div>
            {stuck.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-neutral-400">你卡着的：</span>
                {stuck.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => void begin(s.concept)}
                    disabled={busy}
                    className="rounded-full border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-violet-500/50"
                  >
                    {s.concept}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {turns.map((m, i) =>
          m.role === 'user' ? (
            <div
              key={`u${i}`}
              className="ml-auto max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-violet-600 px-4 py-3 text-white"
            >
              {m.text}
            </div>
          ) : (
            <div
              key={`p${i}`}
              className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-neutral-100 px-4 py-3 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
            >
              {m.text}
            </div>
          )
        )}

        {streaming ? (
          <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-neutral-100 px-4 py-3 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
            {streaming}
          </div>
        ) : busy ? (
          <div className="max-w-[75%] rounded-2xl rounded-bl-sm bg-neutral-100 px-4 py-3 text-violet-400 dark:bg-neutral-800">
            <span className="inline-block animate-pulse">▊</span>
          </div>
        ) : null}

        {verdict && (
          <div className="rounded-2xl border border-violet-200 bg-violet-50/60 px-4 py-3 text-neutral-700 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-neutral-200">
            {verdict === 'got' ? (
              <>
                <div className="font-medium">零柒把「{concept || who}」记住了。</div>
                {growth && (
                  <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {gained > 0 && `+${gained} EXP · `}
                    现在是 Lv.{growth.level}「{growth.title}」
                    {levelUp && ' · 升级了'}
                    {growth.next_title && ` · 正在靠近「${growth.next_title}」`}
                  </div>
                )}
              </>
            ) : verdict === 'half' ? (
              <div>它听懂了一半。换个说法再讲一遍——第二遍通常就通了。</div>
            ) : (
              <div>这次没讲通。不记账，想讲的时候再来。</div>
            )}
            <button
              onClick={() => {
                setVerdict('')
                setTurns([])
                setWho('')
              }}
              className="mt-2 rounded-full border border-violet-300 px-3 py-1 text-xs text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-500/50 dark:text-violet-300 dark:hover:bg-violet-500/10"
            >
              再教一个
            </button>
          </div>
        )}

        {err && (
          <div className="rounded-lg bg-red-100 px-3 py-2 text-xs text-red-600 dark:bg-red-950/60 dark:text-red-300">
            {err}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 自评那一行：这是「它学没学会」的唯一输入，也是成长值的来源 */}
      {!idle && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-neutral-200 px-5 py-2 dark:border-neutral-800">
          <span className="text-[11px] text-neutral-400">它听明白了吗：</span>
          {(
            [
              ['got', '听懂了'],
              ['half', '一半'],
              ['useless', '没讲通'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => void mark(v)}
              disabled={busy}
              className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-violet-500/50"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {idle && !verdict && (
        <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
          <div className="flex gap-2">
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void begin(topic)
                }
              }}
              placeholder="你要教它什么？比如 asyncio 事件循环"
              className="flex-1 rounded-xl border border-neutral-300 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            />
            <button
              onClick={() => void begin(topic)}
              disabled={busy || !topic.trim()}
              className="rounded-xl bg-violet-600 px-5 text-sm text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
            >
              开始讲
            </button>
          </div>
        </div>
      )}

      {!idle && (
        <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void submit()
                }
              }}
              placeholder="接着说（Esc 停止生成）"
              className="flex-1 rounded-xl border border-neutral-300 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            />
            <button
              onClick={() => (busy ? abortRef.current?.abort() : void submit())}
              disabled={!busy && !draft.trim()}
              className="rounded-xl bg-violet-600 px-5 text-sm text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
            >
              {busy ? '停' : '发送'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function CompanionPage() {
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab')
  const tab: Tab =
    tabParam === 'teach' || tabParam === 'growth' || tabParam === 'room' || tabParam === 'audio'
      ? tabParam
      : 'chat'
  const setTab = (t: Tab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        n.set('tab', t)
        return n
      },
      { replace: true }
    )

  return (
    <PageShell
      title="陪伴"
      description="零柒在这里：说话、把它教会、看它随你长、看它屋里攒了什么、有声音陪着干活。"
      maxWidth="4xl"
    >
      <div className="mb-5 flex gap-1">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              tab === k
                ? 'bg-neutral-200/80 font-medium text-neutral-800 dark:bg-neutral-700/70 dark:text-neutral-100'
                : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800/70'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'chat' ? <ChatPane /> : null}
      {tab === 'teach' ? <TeachPane /> : null}
      {tab === 'growth' ? <GrowthPage chromeless /> : null}
      {tab === 'room' ? <RoomPane /> : null}
      {tab === 'audio' ? <AudioPane /> : null}
    </PageShell>
  )
}
