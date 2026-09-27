/** 陪伴页 — 零柒的五张脸：**聊天**（整页跟它说话，不用挤在右下角的小面板里）、
 *  **教它**（费曼法：你讲，它当那个什么都不懂的幼崽）、**成长**（它随你怎么长的
 *  总账，整页搬进来）、**小屋**（它攒下的东西：产出、徽章、道具）、
 *  **有声**（播客：拿你的卡点、你的材料录一期，干活时有声音陪着）。
 *
 *  **2026-09-18 导航改版**：这一页原来不进导航（入口只有右下角那只宠物），理由是
 *  「陪伴是随手够得着，不是又一个要去的地方」。改版后它成了侧栏「🐾 零柒」那一组——
 *  五张脸就摆在那组的子项里。**宠物那个入口照旧**（两条路都通），页面里那排标签条删了。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { api, type PetPlugin, type PetState, type PetGrowth, type PodcastEntry, type TutorStuckRow } from './api'
import EmptyHint from './EmptyHint'
import GrowthPage from './GrowthPage'
import PageShell from './PageShell'
import RoomPane from './RoomPane'
import { STARTER_CARDS, StarterGrid, StarterTile, starterTileClass } from './StarterCards'
import { Mic } from 'lucide-react'
import { petSprite } from './petFace'
import { useVoiceInput } from './voice'
import { historyOf, receiptLabel, streamPetChat, toolCallLabel, type PetToolReceipt } from './petChat'
import { streamTutorSay } from './stream'
import { COMPANION_TABS, type CompanionTab } from './routes'

type Tab = CompanionTab

interface ChatMsg {
  role: 'user' | 'pet'
  text: string
  /** 这一轮零柒真的做了什么（P3）。空 = 它只是回了句话。 */
  tools?: PetToolReceipt[]
}

function dur(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 心情 1–5 的表情，index 0 = 1 分（与宠物面板同一个量表）。 */
const MOOD_FACES = ['😞', '😕', '😐', '🙂', '😄']

function mmss(sec: number): string {
  const s = Math.max(0, Math.ceil(sec))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** 陪你干活：专注番茄钟 + 喝水打卡 + 心情打卡。
 *
 *  这三件事后端的宠物插件早就支持（`petPluginCommand`，挂件里只有一行小按钮），
 *  但聊天页从来没有给过它们一个正经的位置。这里是**真功能**，不是摆设：
 *  · 专注：**真的倒计时**（服务端 remaining 是真值，本地每秒走针、每 30 秒对一次表），
 *    点停它就停；结束/开始零柒都会开口（`r.said`）。
 *  · 喝水：N/8 杯的进度可视化，+1 杯当场记。
 *  · 心情：五档一键打卡，点同一档再按一次=清掉（后端 `clear`）。
 *  全部走现成接口；插件被关掉就整块不摆，绝不摆一个死的遥控器。
 */
function WorkshopCard({
  plugins,
  syncedAt,
  applyPanel,
}: {
  /** 已经滤过的插件（三格里开着的）。取数在 `ChatRail`——右栏要在空的时候整条退场 */
  plugins: PetPlugin[]
  /** 这份插件快照是什么时候拿的：专注倒计时的本地走针从这一刻起算 */
  syncedAt: number
  /** 一条命令的新面板落到那一格（快照时刻同步前移，走针才不会多算） */
  applyPanel: (name: string, panel: PetPlugin['panel']) => void
}) {
  const [said, setSaid] = useState('')
  const [err, setErr] = useState('')
  // 倒计时的本地走针：每秒重画（对表的节奏在 ChatRail——它才是取数的人）
  const [tick, setTick] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const water = plugins.find((p) => p.name === 'water' && p.enabled)
  const focus = plugins.find((p) => p.name === 'focus' && p.enabled)
  const mood = plugins.find((p) => p.name === 'mood' && p.enabled)

  const run = async (name: string, command: string, args?: Record<string, unknown>) => {
    setErr('')
    try {
      const r = await api.petPluginCommand(name, command, args)
      applyPanel(name, r.panel)
      if (r.said) setSaid(r.said)
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      const i = raw.indexOf(':')
      setErr(i > 0 ? raw.slice(i + 2) : raw)
    }
  }

  const focusPanel = focus?.panel.kind === 'timer' ? focus.panel : null
  // 本地走针：服务端真值 − 这份快照之后经过的秒数
  const focusLeft = focusPanel?.running
    ? Math.max(0, (focusPanel.remaining ?? 0) - (tick - syncedAt) / 1000)
    : 0

  const waterPanel = water?.panel.kind === 'counter' ? water.panel : null
  const waterValue = waterPanel?.value ?? 0
  const waterTarget = Math.max(1, waterPanel?.target ?? 8)

  const moodPanel = mood?.panel.kind === 'mood' ? mood.panel : null
  const moodValue = moodPanel?.value ?? 0

  return (
    <section className="wb-card p-4">
      <RailTitle>陪你干活</RailTitle>

      {focus && focusPanel && (
        <div className="flex items-center gap-3 pb-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-neutral-400">⏱ 专注</p>
            <p className="text-2xl font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
              {focusPanel.running ? mmss(focusLeft) : `${focusPanel.minutes ?? focusPanel.default_minutes ?? 25}:00`}
            </p>
          </div>
          <button
            onClick={() => void run('focus', focusPanel.running ? 'stop' : 'start')}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium text-white transition-all disabled:opacity-40 ${
              focusPanel.running
                ? 'bg-neutral-700 hover:bg-neutral-600 dark:bg-neutral-600 dark:hover:bg-neutral-500'
                : 'bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:brightness-110'
            }`}
          >
            {focusPanel.running ? '停' : '开始专注'}
          </button>
        </div>
      )}

      {water && waterPanel && (
        <div className="border-t border-neutral-100 py-2.5 dark:border-neutral-800/70">
          <div className="flex items-center gap-2">
            <p className="text-xs text-neutral-400">💧 喝水</p>
            <p className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
              {waterValue}/{waterTarget} {waterPanel.unit ?? '杯'}
            </p>
            <div className="flex-1" />
            <button
              onClick={() => void run('water', 'drink')}
              title="记一杯水"
              className="rounded-full border border-sky-300 px-2.5 py-0.5 text-xs text-sky-700 transition-colors hover:bg-sky-50 dark:border-sky-500/50 dark:text-sky-300 dark:hover:bg-sky-500/10"
            >
              +1 杯
            </button>
          </div>
          <div className="mt-1.5 flex gap-1">
            {Array.from({ length: waterTarget }, (_, i) => (
              <span
                key={i}
                className={`h-1.5 flex-1 rounded-full ${
                  i < waterValue ? 'bg-sky-400' : 'bg-neutral-100 dark:bg-neutral-800'
                }`}
              />
            ))}
          </div>
        </div>
      )}

      {mood && moodPanel && (
        <div className="border-t border-neutral-100 pt-2.5 dark:border-neutral-800/70">
          <div className="flex items-center gap-2">
            <p className="text-xs text-neutral-400">🙂 心情</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {moodValue ? `今天 ${moodValue}/${moodPanel.scale ?? 5}` : '今天还没记'}
            </p>
          </div>
          <div className="mt-1 flex gap-1">
            {MOOD_FACES.map((face, i) => {
              const v = i + 1
              const active = moodValue === v
              return (
                <button
                  key={face}
                  title={active ? '再点一下清掉' : `${v} 分`}
                  onClick={() => void run('mood', active ? 'clear' : 'set', active ? undefined : { value: v })}
                  className={`flex-1 rounded-lg py-1 text-lg leading-none transition-all ${
                    active
                      ? 'bg-amber-50 ring-1 ring-amber-300 dark:bg-amber-500/10 dark:ring-amber-500/40'
                      : 'opacity-45 hover:bg-neutral-50 hover:opacity-100 dark:hover:bg-neutral-800'
                  }`}
                >
                  {face}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {said ? (
        <p className="mt-2 border-t border-neutral-100 pt-2 text-xs leading-relaxed text-violet-600 dark:border-neutral-800/70 dark:text-violet-300">
          零柒：{said}
        </p>
      ) : null}
      {err ? <p className="mt-2 text-xs text-rose-500">{err}</p> : null}
    </section>
  )
}

/** 侧栏三小卡的公共外壳：标题小写字距款，与「学」页右栏同一套排版语言。 */
function RailTitle({ children }: { children: string }) {
  return (
    <p className="pb-2 text-xs font-medium uppercase tracking-wider text-neutral-400">
      {children}
    </p>
  )
}

/** 聊天右栏：只摆这一页**自己的功能**——陪你干活（专注番茄钟/喝水/心情打卡）。
 *  别的页面已经摆过的清单（最近对话、事件流水）不再搬一份过来——重复的信息
 *  不叫充实。插件全被关掉时整条侧栏不渲染，聊天占满整行。
 *
 *  侧栏规范（宠物模块改造 §A）：右栏 = `hidden w-[290px] xl:flex shrink-0`——窄屏不摆
 *  （五枚心情按钮会把聊天区挤扁），xl 起才有；**内容为空时整条不渲染**，父级不得
 *  留一条空轨道。所以取数在这条组件里：有没有卡可摆，只有它自己知道。 */
function ChatRail() {
  const [plugins, setPlugins] = useState<PetPlugin[] | null>(null)
  // 快照时刻：专注倒计时的本地走针从它起算（随每次取数一起更新）
  const [syncedAt, setSyncedAt] = useState(0)

  const refresh = useCallback(() => {
    api
      .petPlugins()
      .then((r) => {
        setPlugins(r.plugins)
        setSyncedAt(Date.now())
      })
      .catch(() => setPlugins([]))
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 60000)
    return () => clearInterval(t)
  }, [refresh])

  // 专注在跑的时候：每 30 秒对一次服务端的表
  const focusing = plugins?.some(
    (p) => p.name === 'focus' && p.panel.kind === 'timer' && p.panel.running
  )
  useEffect(() => {
    if (!focusing) return
    const t = setInterval(refresh, 30000)
    return () => clearInterval(t)
  }, [focusing, refresh])

  // 三格里开着的才有得摆；一张都没有（或还没取到数）→ 整条退场
  const visible = (plugins ?? []).filter(
    (p) => ['water', 'focus', 'mood'].includes(p.name) && p.enabled
  )
  if (plugins === null || visible.length === 0) return null

  // 一条命令的新面板落到那一格；快照时刻同步前移，专注走针不多算
  const applyPanel = (name: string, panel: PetPlugin['panel']) => {
    setPlugins((prev) => (prev ? prev.map((p) => (p.name === name ? { ...p, panel } : p)) : prev))
    setSyncedAt(Date.now())
  }

  return (
    <aside className="hidden w-[290px] shrink-0 flex-col gap-4 xl:flex">
      <WorkshopCard plugins={visible} syncedAt={syncedAt} applyPanel={applyPanel} />
    </aside>
  )
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
  // 空态头图上那只零柒摆的是**此刻的姿势**（与挂件、小屋同一接口同一只）
  const [pet, setPet] = useState<PetState | null>(null)
  // 语音说话：点一下录音、再点一下转写进输入框——**不自动发送**，
  // 转写可能听错，让你看一眼再按发送（与「讲给它听」同一条规矩）。
  const voice = useVoiceInput(
    (t) => setInput((prev) => (prev ? `${prev} ${t}` : t)),
    (m) => setError(m)
  )

  useEffect(() => {
    api.petState(0, '/companion').then(setPet).catch(() => {})
  }, [])

  // P5 落库之后：上一场的对话从库里铺出来——刷新、隔天回来，整页聊天接着上次聊。
  // 服务端在客户端没带历史时也会从同一张表补（routers/pet.pet_chat），两边同源。
  // **合入而不是覆盖**：历史在前面，这一场已经打出去的话留在后面——
  // 这几条 promise 是并着跑的，谁都有可能后到。
  useEffect(() => {
    api.petChats(30)
      .then((r) =>
        setChat((prev) => [
          ...r.chats.map((c) => ({
            role: c.role,
            text: c.text,
            tools: c.tools?.length ? (c.tools as ChatMsg['tools']) : undefined,
          })),
          ...prev,
        ])
      )
      .catch(() => {})
  }, [])

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
        // Z1：整页聊天也把已有的那几轮带上（与右下角面板同一个函数、同一个上限）
        { message: msg, history: historyOf(chat) },
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
  // `chat` 也在依赖里（Z1）：历史是随请求带过去的，闭包里必须是最新那一串对话
  }, [busy, input, chat])

  return (
    <div className="flex min-h-[380px] min-w-0 flex-1 flex-col wb-card">
      {/* 一句都没说：空态头图——居中的它 + 一句问候 + 几张能点的卡（每张卡就是
          第一句话本身）。这不是把一行字挪到中间，是成熟聊天产品的空态范式。 */}
      {chat.length === 0 && !error ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8">
          <img
            src={petSprite(pet?.action)}
            alt="零柒"
            className="h-20 w-20 object-contain drop-shadow-md"
            onError={(e) => {
              e.currentTarget.src = '/pet-avatar.png'
            }}
          />
          <h2 className="mt-3 text-lg font-semibold text-neutral-800 dark:text-neutral-100">
            {pet?.busy_with ? `它在${pet.busy_with}，聊两句也不耽误。` : '我在。想聊什么都行。'}
          </h2>
          <p className="mt-1 text-sm text-neutral-400 dark:text-neutral-500">
            卡住的地方、今天的心情，或者什么都不为。
          </p>
          <StarterGrid>
            {STARTER_CARDS.map((c) => (
              <StarterTile
                key={c.title}
                icon={c.icon}
                title={c.title}
                desc={c.desc}
                disabled={busy}
                onClick={() => void send(c.q)}
              />
            ))}
          </StarterGrid>
        </div>
      ) : (
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm leading-relaxed">
          {chat.map((m, i) =>
            m.role === 'user' ? (
              <div
                key={`u${i}`}
                className="ml-auto max-w-[75%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-violet-600 px-4 py-3 text-white"
              >
                {m.text}
              </div>
            ) : (
              <div
                key={`p${i}`}
                className="max-w-[75%] break-words rounded-lg rounded-bl-sm bg-neutral-100 px-4 py-3 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              >
                {/* 它真的做了什么。写在话**前面**：先有动作，再有解释。 */}
                {m.tools && m.tools.length > 0 && (
                  <ul className="mb-1.5 flex flex-wrap gap-1">
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
                {m.text ? <span className="whitespace-pre-wrap">{m.text}</span> : null}
                {!m.text && (
                  <span className="text-xs text-neutral-400 dark:text-neutral-500">
                    {toolBusy ?? (
                      <span className="inline-block animate-pulse text-violet-400">▊</span>
                    )}
                  </span>
                )}
              </div>
            )
          )}
          {error && (
            <div className="rounded-lg bg-rose-100 px-3 py-2 text-xs text-rose-600 dark:bg-rose-950/60 dark:text-rose-300">
              {error}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
        <div className="flex gap-2">
          <button
            onClick={() => voice.toggle()}
            title={voice.recording ? '停止录音并转写' : '说一段，转成文字（不自动发送）'}
            className={`shrink-0 rounded-md border px-3 transition-colors ${
              voice.recording
                ? 'animate-pulse border-rose-300 bg-rose-50 text-rose-600 dark:border-rose-500/50 dark:bg-rose-500/10 dark:text-rose-300'
                : 'border-neutral-300 text-neutral-500 hover:border-violet-400 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-violet-500/50'
            }`}
          >
            {voice.transcribing ? (
              <span className="text-xs">转写中…</span>
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </button>
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
            className="flex-1 rounded-md border border-neutral-300 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
          <button
            onClick={() => (busy ? abortRef.current?.abort() : void send())}
            disabled={!busy && !input.trim()}
            className="rounded-md bg-violet-600 px-5 text-sm text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
          >
            {busy ? '停' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 有声右栏：能拿来讲的素材（卡点）。
 *  播客清单空着的时候，这张卡说明「录一期」录的是什么、为什么值得录。 */
function AudioRail({ stuck }: { stuck: TutorStuckRow[] }) {
  if (stuck.length === 0) return null

  return (
    <aside className="hidden w-[290px] shrink-0 flex-col gap-4 pb-2 xl:flex">
      <section className="wb-card p-4">
        <RailTitle>它能拿来讲的</RailTitle>
        <ul className="space-y-2">
          {stuck.map((s) => (
            <li key={s.id}>
              <p className="truncate text-sm text-neutral-700 dark:text-neutral-200">{s.concept}</p>
              {s.stuck ? (
                <p className="truncate text-xs text-neutral-400 dark:text-neutral-500" title={s.stuck}>
                  ↳ {s.stuck}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="pt-2 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
          点左上「拿没解的卡点录一期」，它把「你卡在哪」讲成人话。
        </p>
      </section>
    </aside>
  )
}

/** 有声：播客清单 + 就地录一期。声音从你自己的材料里来——陪伴不是背景音乐，是你自己的事被讲出来。 */
function AudioPane() {
  const [podcasts, setPodcasts] = useState<PodcastEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  // 右栏的素材（卡点）由这一页取——AudioRail 空的时候整条退场，轨道跟着不预留
  const [stuck, setStuck] = useState<TutorStuckRow[]>([])

  useEffect(() => {
    api
      .tutorStuck()
      .then((r) => setStuck(r.stuck.filter((s) => !s.resolved_at).slice(0, 5)))
      .catch(() => {})
  }, [])

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

  // §A：右栏空 → 不预留 290px 轨道，列表吃满整行（原来空轨道白挂在网格里）
  const hasRail = stuck.length > 0

  return (
    <div className={`grid items-start gap-4${hasRail ? ' xl:grid-cols-[minmax(0,1fr)_290px]' : ''}`}>
      <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void fromStuck()}
          disabled={busy}
          className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-40"
        >
          {busy ? '录制中…' : '🎙 拿没解的卡点录一期'}
        </button>
        <span className="text-xs text-neutral-400">
          想聊调研圆桌，去
          <Link to="/tutor" className="text-violet-500 hover:underline">
            学
          </Link>
          页的圆桌卡
        </span>
      </div>
      {msg ? <p className="text-xs text-neutral-500">{msg}</p> : null}

      {podcasts === null ? null : podcasts.length === 0 ? (
        <EmptyHint
          title="还没有一期播客。"
          hint="上面点一下，拿你最近没解的卡点录一期——它把「你卡在哪」讲成人话。"
        />
      ) : (
        <ul className="wb-card divide-y divide-neutral-100 dark:divide-neutral-800/70">
          {podcasts.map((p) => (
            <li key={p.id} className="px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                  {p.title}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-neutral-400">
                  {dur(p.duration_sec)}
                </span>
                <span className="shrink-0 text-xs text-neutral-400">{p.created_at.slice(5, 10)}</span>
                <button
                  onClick={() => void remove(p.id)}
                  title="删掉这一期（脚本和音频一起）"
                  className="shrink-0 text-xs text-neutral-400 transition-colors hover:text-rose-500"
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
      <AudioRail stuck={stuck} />
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
  // 空态头图上那只零柒摆的是**此刻的姿势**（与挂件、小屋同一接口同一只）
  const [pet, setPet] = useState<PetState | null>(null)
  useEffect(() => {
    api.petState(0, '/companion').then(setPet).catch(() => {})
  }, [])
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

  // 讲通了一个之前卡着的概念？当场把那条卡点结掉——教学与卡点是同一本账的两面，
  // 这个闭环以前要跑去「学 → 记录」手动打勾，现在讲完顺手就完成了。
  const [stuckMsg, setStuckMsg] = useState('')
  const resolveStuck = useCallback(async (s: TutorStuckRow) => {
    try {
      await api.tutorResolveStuck(s.id, true)
      setStuck((prev) => prev.filter((x) => x.id !== s.id))
      setStuckMsg(`卡点「${s.concept}」结了。`)
    } catch (e) {
      setStuckMsg(e instanceof Error ? e.message : String(e))
    }
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
    <div className="flex min-h-[380px] min-w-0 flex-1 flex-col wb-card">
      {/* 还没开讲：空态头图——居中的它 + 原话 + 一个大的开讲框 + 选题卡
          （卡着的概念优先；一张都没有就给两条真入口）。讲起来之后回到普通聊天流。 */}
      {idle && !verdict ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8">
          <img
            src={petSprite(pet?.action)}
            alt="零柒"
            className="h-20 w-20 object-contain drop-shadow-md"
            onError={(e) => {
              e.currentTarget.src = '/pet-avatar.png'
            }}
          />
          <h2 className="mt-3 max-w-xl text-center text-lg font-semibold leading-relaxed text-neutral-800 dark:text-neutral-100">
            我什么都不懂。你挑一个东西，用大白话讲给我听——讲到我听明白，我就学会了。
          </h2>
          <div className="mt-5 flex w-full max-w-xl gap-2">
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
              className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-4 py-3 text-sm text-neutral-800 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            />
            <button
              onClick={() => void begin(topic)}
              disabled={busy || !topic.trim()}
              className="shrink-0 rounded-md bg-violet-600 px-5 text-sm text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
            >
              开始讲
            </button>
          </div>
          <StarterGrid>
            {stuck.map((s) => (
              <StarterTile
                key={s.id}
                icon="🎯"
                title={s.concept}
                desc={s.stuck ? `↳ ${s.stuck}` : undefined}
                descTitle={s.stuck || undefined}
                descTruncate
                footer="讲这个 →"
                disabled={busy}
                onClick={() => void begin(s.concept)}
              />
            ))}
            {stuck.length === 0 && (
              <>
                <Link
                  to="/notes"
                  className={starterTileClass}
                >
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    📝 去笔记挑一段
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                    学过的东西带着出处，以后可考。
                  </p>
                </Link>
                <Link
                  to="/tutor?tab=learn"
                  className={starterTileClass}
                >
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    🧭 消化一份材料
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                    要搞懂的点列出来，逐个讲给它听。
                  </p>
                </Link>
              </>
            )}
          </StarterGrid>
        </div>
      ) : (
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm leading-relaxed">
        {turns.map((m, i) =>
          m.role === 'user' ? (
            <div
              key={`u${i}`}
              className="ml-auto max-w-[75%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-violet-600 px-4 py-3 text-white"
            >
              {m.text}
            </div>
          ) : (
            <div
              key={`p${i}`}
              className="max-w-[75%] whitespace-pre-wrap break-words rounded-lg rounded-bl-sm bg-neutral-100 px-4 py-3 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
            >
              {m.text}
            </div>
          )
        )}

        {streaming ? (
          <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-lg rounded-bl-sm bg-neutral-100 px-4 py-3 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
            {streaming}
          </div>
        ) : busy ? (
          <div className="max-w-[75%] rounded-lg rounded-bl-sm bg-neutral-100 px-4 py-3 text-violet-400 dark:bg-neutral-800">
            <span className="inline-block animate-pulse">▊</span>
          </div>
        ) : null}

        {verdict && (
          <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-4 py-3 text-neutral-700 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-neutral-200">
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
            {verdict === 'got' &&
              (() => {
                const hit = stuck.find((s) => s.concept === (concept || who) && !s.resolved_at)
                return hit ? (
                  <button
                    onClick={() => void resolveStuck(hit)}
                    className="mt-1.5 block text-xs text-amber-600 transition-colors hover:text-amber-700 dark:text-amber-400"
                  >
                    这条之前卡过——把卡点「{hit.concept}」标记为已解
                  </button>
                ) : null
              })()}
            {stuckMsg ? (
              <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">{stuckMsg}</p>
            ) : null}
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
          <div className="rounded-lg bg-rose-100 px-3 py-2 text-xs text-rose-600 dark:bg-rose-950/60 dark:text-rose-300">
            {err}
          </div>
        )}
        <div ref={bottomRef} />
        </div>
      )}

      {/* 自评那一行：这是「它学没学会」的唯一输入，也是成长值的来源 */}
      {!idle && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-neutral-200 px-5 py-2 dark:border-neutral-800">
          <span className="text-xs text-neutral-400">它听明白了吗：</span>
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
              className="flex-1 rounded-md border border-neutral-300 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            />
            <button
              onClick={() => (busy ? abortRef.current?.abort() : void submit())}
              disabled={!busy && !draft.trim()}
              className="rounded-md bg-violet-600 px-5 text-sm text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
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
  const [params] = useSearchParams()
  const tabParam = params.get('tab')
  // 五张脸的清单在 `routes.tsx`（侧栏与这一页**同一份**）：`?tab=` 是唯一入口，
  // 页面里那排标签按钮已经删掉（2026-09-18 导航改版）。
  const tab: Tab = (COMPANION_TABS.find((t) => t.key === tabParam)?.key as Tab | undefined) ?? 'chat'

  return (
    <PageShell
      title="陪伴"
      description="零柒在这里：说话、把它教会、看它随你长、看它屋里攒了什么、有声音陪着干活。"
      // 聊天/教学是满高页（§B）：高度由 flex 链推导，容器内部自己滚
      fill={tab === 'chat' || tab === 'teach'}
    >
      {tab === 'chat' ? (
        <div className="flex min-h-0 flex-1 items-stretch gap-4">
          <ChatPane />
          <ChatRail />
        </div>
      ) : null}
      {tab === 'teach' ? <TeachPane /> : null}
      {tab === 'growth' ? <GrowthPage chromeless /> : null}
      {tab === 'room' ? <RoomPane /> : null}
      {tab === 'audio' ? <AudioPane /> : null}
    </PageShell>
  )
}
