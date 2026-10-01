// 零柒 — the resident companion avatar fixed to the corner of the main workspace.
//
// This is NOT a separate window (that's PetView / QuickView). This is the
// "real pet on the main screen" form: a rendered pet avatar fixed to the
// bottom-right of every main page (chat/dashboard/notes/kb/settings via
// Layout). It breathes, pops a speech bubble when the system does something,
// and expands into a chat panel on click.
//
// All data comes from the same /api/pet/* endpoints the companion already
// exposes — this is a second, visual face of the same 零柒, not a new brain.
//
// 本体只留状态与编排（方向 6 第四刀，2026-09-29）：
// 纯逻辑在 petNudges / petDrag / petPip / petShared，展示层在 PetPanel / PetPluginRow，
// 拖拽与让位的指针/测量状态机在 usePetDrag / usePetDodge。
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'

import {
  api,
  type PetGrowth,
  type PetPlugin,
  type PetRoom,
  type PetState,
  type TutorMastery,
} from './api'
import { historyOf, streamPetChat, toolCallLabel, type PetToolReceipt } from './petChat'
// Animation states come from the Codex pet atlas (awesome-codex-pet v1):
// 9 states, each shipped as an animated webp under /pet/<state>.webp.
// The browser plays them natively, so switching state is just swapping src.
import { asPetAction, petSprite, type PetAction } from './petFace'
import { blipOn as isBlipOn, playBlip, setBlipOn as storeBlipOn } from './petSound'
import { MODE_LABEL, DIM_MODES, type ChatMsg, type PetEvent } from './petShared'
import { gatherNudges, markNudged, wasNudged, type Nudge } from './petNudges'
import { PET_CORNER } from './petDrag'
import { copyStyles, type PipWindow } from './petPip'
import { streamPet } from './stream'
import { makeSpeech, useVoiceInput } from './voice'
import { usePetDrag } from './usePetDrag'
import { usePetDodge } from './usePetDodge'
import PetPanel from './PetPanel'

export type { PetAction }

export default function PetWidget() {
  const navigate = useNavigate()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [bubble, setBubble] = useState<string | null>(null)
  const [nudge, setNudge] = useState<Nudge | null>(null)
  // 姿势分两层：**状态机给底**（你这会儿在干嘛），**feed 事件与主动提醒给一次性覆盖**
  // （系统出事了、你欠账了——那两件事该盖过日常状态几秒）。
  const [flash, setFlash] = useState<PetAction | null>(null)
  const [thinking, setThinking] = useState(false)
  const [state, setState] = useState<PetState | null>(null)
  // 事件流通着没有。它决定两件事：状态多久重算一回、兜底轮询跑不跑。
  const [live, setLive] = useState(false)
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [events, setEvents] = useState<PetEvent[]>([])
  const [growth, setGrowth] = useState<PetGrowth | null>(null)
  const [mastery, setMastery] = useState<TutorMastery | null>(null)
  const [room, setRoom] = useState<PetRoom | null>(null)
  const [plugins, setPlugins] = useState<PetPlugin[]>([])
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [toolBusy, setToolBusy] = useState<string | null>(null)
  // 朗读：开着的话，零柒说完一句就读出来。**说完了才读**——边流边读会念成一堆碎片。
  const [speakOn, setSpeakOn] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastIdRef = useRef(0)
  const openRef = useRef(false)
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelBottomRef = useRef<HTMLDivElement>(null)

  // ---------- 做活（P5）：点击 Q 弹 + 一声合成音效 ----------
  //
  // 反馈是给「摸到它」的那个瞬间的：scale 压下去再弹回来，配一声 WebAudio 现做的
  // 「啵」（oscillator 合成，零素材，实现与开关在 `petSound.ts`——桌面壳那只小窗
  // 共用同一声）。关得掉（记在 localStorage）；摸不出声的环境就安静，都不算错。
  const [squash, setSquash] = useState(false)
  const squashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [blipOn, setBlipOn] = useState(true)

  // ---------- 拖拽（P5 · 做活）与让位 ----------
  const { drag, dragging, draggedRef, onSpritePointerDown } = usePetDrag()
  const dodge = usePetDodge(panelRef, open, bubble, nudge, location.pathname)

  // ---------- 弹出置顶（P5 · Document PiP）----------
  const [pipWin, setPipWin] = useState<PipWindow | null>(null)
  const pipWinRef = useRef<PipWindow | null>(null)
  pipWinRef.current = pipWin

  // 此刻摆哪个姿势：一次性覆盖 > 正在想 > 状态机。
  const action: PetAction = flash ?? (thinking ? 'review' : asPetAction(state?.action))
  const dimmed = state != null && DIM_MODES.includes(state.mode)

  useEffect(() => {
    openRef.current = open
  }, [open])

  // 面板里的消息流式追加时跟到底（与陪伴页同一条体验，改造 #21）；面板刚打开也
  // 对一次底——从最近那条接着看，而不是从最旧那条开始滚。
  useEffect(() => {
    if (open) panelBottomRef.current?.scrollIntoView({ block: 'end' })
  }, [chat, open])

  // ---------- 此刻：状态机（P1 · 维度一）----------
  //
  // 键鼠活动**只在浏览器里算**：`lastInput` 从不发送、不落库、不写日志，只换算成
  // 一个「几秒没动」的**瞬时**数字带在请求上。服务端因此只知道「该显示无聊了」，
  // 不知道你在不在电脑前——同 `pet.sanitize()` 那道隐私闸门的精神。
  const lastInput = useRef(Date.now())
  useEffect(() => {
    const bump = () => {
      lastInput.current = Date.now()
    }
    const evs = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }))
    // 切回这个标签页 = 你回来了。切走时故意不碰：idle 自己会往上长。
    const onVis = () => {
      if (document.visibilityState === 'visible') bump()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      evs.forEach((e) => window.removeEventListener(e, bump))
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  // 路由换了立刻重算（学/工作/复习是三种不同的状态），其余时候 15 秒一回；
  // 事件流接上以后退到 60 秒——它已经不再负责「及时」，只负责兜底。
  //
  // 读的都是 ref（`lastInput` / `pathRef`），所以流的回调里拿到的也一定是**最新**的值，
  // 不会因为闭包停在某一次渲染上。
  const pathRef = useRef(location.pathname)
  useEffect(() => {
    pathRef.current = location.pathname
  }, [location.pathname])

  const loadState = useCallback(() => {
    const idleSec = (Date.now() - lastInput.current) / 1000
    return api
      .petState(idleSec, pathRef.current)
      .then((s) => setState(s))
      .catch(() => {
        /* 拿不到就沿用上一次的姿势，别闪 */
      })
  }, [])

  // 慢慢变的那几样（成长 / 学到了什么 / 屋里的东西）：流说「有活跑完了」时值得重看一眼，
  // 平时 60 秒一次也够——它们不是「此刻」。
  const loadSlow = useCallback(() => {
    void api.petGrowth().then(setGrowth).catch(() => {})
    void api.tutorMastery().then(setMastery).catch(() => {})
    void api.petRoom().then(setRoom).catch(() => {})
  }, [])

  useEffect(() => {
    void loadState()
    const t = setInterval(() => void loadState(), live ? 60000 : 15000)
    return () => clearInterval(t)
  }, [loadState, live, location.pathname])

  // 久别重逢（P5）：状态机说「好几天没见」时，把那句话当**气泡**说一次——
  // 这趟到访值得它先开口，且这次会话只说这一回。不落 localStorage：它是
  // 「这一趟」的问候，不是一天一条的账；页面刷新重挂，重逢还在，就该再见面。
  const reunionShown = useRef(false)
  useEffect(() => {
    if (reunionShown.current || state?.mode !== 'returning' || !state.line) return
    reunionShown.current = true
    setNudge(null)
    setBubble(state.line)
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
    bubbleTimer.current = setTimeout(() => setBubble(null), 8000)
  }, [state])

  // ---------- 语音（P3 的另一半）----------
  //
  // 录音→转写那份实现在 `voice.ts`，聊天页与今日日记共用同一份。
  // 这里**说完就直接发**：对着零柒说话要的是「说完它答」，不是先落进输入框
  // 再让你按一下（聊天页那边落进输入框是对的——你可能在口述一段长 prompt）。
  const voice = useVoiceInput((t) => {
    setInput('')
    void send(t)
  }, setError)

  const speak = useCallback(async (text: string) => {
    audioRef.current?.pause()
    audioRef.current = null
    setSpeaking(false)
    const t = text.trim()
    if (!t) return
    try {
      const audio = await makeSpeech(t)
      audioRef.current = audio
      setSpeaking(true)
      audio.onended = () => {
        setSpeaking(false)
        audioRef.current = null
      }
      audio.onerror = () => setSpeaking(false)
      await audio.play()
    } catch (e) {
      setSpeaking(false)
      setError(`语音播报失败：${String(e)}`)
    }
  }, [])

  // 关掉朗读要**立刻闭嘴**，不能等这一句念完——那正是你关它的原因。
  function toggleSpeak() {
    const next = !speakOn
    setSpeakOn(next)
    try {
      localStorage.setItem('pet:speak', next ? '1' : '0')
    } catch {
      /* 无痕模式记不了就算了，只是下次要重新打开 */
    }
    if (!next) {
      audioRef.current?.pause()
      audioRef.current = null
      setSpeaking(false)
    }
  }

  useEffect(() => {
    try {
      setSpeakOn(localStorage.getItem('pet:speak') === '1')
      setBlipOn(isBlipOn())
    } catch {
      /* 无痕模式：朗读默认关、音效默认开 */
    }
    // 卸载时把嘴闭上、把没弹完的 Q 弹收掉：不然离开这一页它还在念
    return () => {
      audioRef.current?.pause()
      audioRef.current = null
      if (squashTimer.current) clearTimeout(squashTimer.current)
    }
  }, [])

  // play a one-shot action, then fall back to whatever the state machine says
  const playAction = useCallback((a: PetAction, ms: number) => {
    setFlash(a)
    if (actionTimer.current) clearTimeout(actionTimer.current)
    actionTimer.current = setTimeout(() => setFlash(null), ms)
  }, [])

  // ---------- 随机小动作（P5 · 做活）----------
  //
  // 状态机说 idle（没活、没提醒，你也安静）时，隔一阵子它自己动一下——挥挥手、
  // 蹦一下、溜两步。**只动 idle**：状态机给的任何别的姿势（在跑 / 在等 / 蔫了）都是
  // 事实，盖不得；小动作是一次性 flash，到点自然回到状态机。姿势随机——「它自己
  // 想动一下」本就不需要可复现。读 ref 而不是进依赖：状态每 15 秒重取一次，
  // 依赖一变 interval 就重置，小动作会被永远饿死在 30 秒之前。
  const stateRef = useRef(state)
  stateRef.current = state
  const flashRef = useRef(flash)
  flashRef.current = flash
  const thinkingRef = useRef(thinking)
  thinkingRef.current = thinking
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return
      if (flashRef.current || thinkingRef.current) return
      if (asPetAction(stateRef.current?.action) !== 'idle') return
      const pool: PetAction[] = ['waving', 'jumping', 'running-left', 'running-right']
      playAction(pool[Math.floor(Math.random() * pool.length)], 2600 + Math.floor(Math.random() * 1600))
    }, 30000)
    return () => clearInterval(t)
  }, [playAction])

  // 气泡区一次只说一句话：feed 和 nudge 谁开口，另一个闭嘴
  const showNudge = useCallback(
    (n: Nudge) => {
      setBubble(null)
      setNudge(n)
      playAction('waving', 6000)
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
      bubbleTimer.current = setTimeout(() => setNudge(null), 12000)
    },
    [playAction]
  )

  // 主动提醒的节奏：进页面缓一口气再看（别跟首屏抢），之后每 5 分钟看一眼，
  // 但**刚念完一件，半小时内不念下一件**——4 件事欠着也不该 20 分钟被念 4 回。
  // 面板开着不念（你自己已经在看了）；人在哪个页面就不念那个页面的账；
  // 当天念过的不再念（localStorage 按日期记账）。
  const lastShownAt = useRef(0)
  const considerNudges = useCallback(() => {
    void (async () => {
      if (openRef.current) return
      if (lastShownAt.current && Date.now() - lastShownAt.current < 30 * 60 * 1000) return
      const here = location.pathname
      const list = (await gatherNudges()).filter((n) => n.to.split('?')[0] !== here)
      const fresh = list.find((n) => !wasNudged(n.key))
      if (!fresh || openRef.current) return
      markNudged(fresh.key)
      lastShownAt.current = Date.now()
      showNudge(fresh)
    })()
  }, [showNudge, location.pathname])

  useEffect(() => {
    const first = setTimeout(considerNudges, 4000)
    const t = setInterval(considerNudges, 5 * 60 * 1000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [considerNudges])

  // initial load
  useEffect(() => {
    void (async () => {
      try {
        const [f, g, p, m, rm, pc] = await Promise.all([
          fetch('/api/pet/feed?limit=30').then((r) => r.json()),
          api.petGrowth().catch(() => null),
          api.petPlugins().then((r) => r.plugins).catch(() => []),
          api.tutorMastery().catch(() => null),
          api.petRoom().catch(() => null),
          // P5 落库之后：上一场的对话从库里铺出来。「它记得你」不再只活在
          // 这一次会话的内存里——刷新、隔天回来，上一句还在。
          api.petChats(30).catch(() => ({ chats: [] })),
        ])
        const evs: PetEvent[] = f.events ?? []
        setEvents([...evs].reverse())
        if (evs.length) lastIdRef.current = Math.max(...evs.map((e) => e.id))
        setGrowth(g)
        setPlugins(p)
        setMastery(m)
        setRoom(rm)
        // **合入而不是覆盖**：这几条 promise 是并着跑的，谁都有可能后到——
        // 直接 setChat(历史) 会把你已经打出去、正在等回复的那几条冲掉。
        // 库里的历史摆在前面，这一场会话的排在后面。
        setChat((prev) => [
          ...pc.chats.map((c) => ({
            role: c.role,
            text: c.text,
            tools: c.tools?.length ? (c.tools as ChatMsg['tools']) : undefined,
          })),
          ...prev,
        ])
      } catch {
        /* offline — the pet just sits quietly */
      }
    })()
  }, [])

  // 新台词到了 → 说（气泡 + 一次性姿势）。**流与兜底轮询共用这一段**：
  // 两处各写一遍，迟早会长出两种行为（一条一次性的规矩在第 47 天被改了一半）。
  const speakFresh = useCallback(
    (fresh: PetEvent[]) => {
      if (!fresh.length) return
      setEvents((prev) => {
        const ids = new Set(prev.map((e) => e.id))
        const add = fresh.filter((e) => !ids.has(e.id))
        return add.length ? [...prev, ...add.reverse()] : prev
      })
      for (const e of fresh) lastIdRef.current = Math.max(lastIdRef.current, e.id)
      // react to what happened: failures slump, everything else waves hello
      const isFail = fresh.some((e) => e.kind === 'task_failed')
      playAction(isFail ? 'failed' : 'waving', 6000)
      if (!openRef.current) {
        setNudge(null) // 轮到系统事件说话，主动提醒先让位
        setBubble(fresh[0].text)
        if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
        bubbleTimer.current = setTimeout(() => setBubble(null), 6000)
      }
    },
    [playAction]
  )

  // ---------- 事件流（SSE）：有事发生就立刻说 ----------
  //
  // 轮询留下来当**兜底**：流断了不该让零柒变成哑巴——那正是最看不出问题的坏法
  // （页面一切正常，只是它再也不说话）。所以 `live=false` 时那条 15 秒的轮询照旧跑。
  // 重连用退避（5→10→20→30 秒封顶）：服务端重启、网线拔了，都不该刷屏。
  useEffect(() => {
    const ctl = new AbortController()
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let wait = 5000

    const connect = async () => {
      let heard = false
      try {
        await streamPet(
          lastIdRef.current,
          (event, data) => {
            heard = true
            if (event === 'hello') setLive(true)
            else if (event === 'event') {
              setLive(true)
              const line = data as unknown as PetEvent
              speakFresh([line])
              // 这两句背后是**累计量变了**：交出一份成品 → 屋里的架子多一件、EXP 涨；
              // 说通一个概念 → 最近搞懂那栏换人。慢的那几样这时候值得立刻重看一眼。
              if (line.kind === 'output' || line.kind === 'mastered') loadSlow()
            } else if (event === 'work') {
              // 有活开始 / 跑完 / 卡住了：立刻重算「此刻」，顺带看一眼慢的那几样
              // （成品可能刚落地，屋里的架子上就多一件）。
              void loadState()
              loadSlow()
            }
          },
          ctl.signal
        )
      } catch {
        /* 断了：下面按退避重连，这期间轮询兜着 */
      }
      if (stopped) return
      setLive(false)
      if (heard) wait = 5000 // 刚才是通着的，那就从最短的间隔重来
      timer = setTimeout(() => void connect(), wait)
      wait = Math.min(wait * 2, 30000)
    }

    void connect()
    return () => {
      stopped = true
      ctl.abort()
      if (timer) clearTimeout(timer)
    }
  }, [speakFresh, loadState, loadSlow])

  // 兜底轮询：流接上了就停（`live`），断了自然接着跑
  useEffect(() => {
    if (live) return
    const t = setInterval(() => {
      void (async () => {
        try {
          const r = await fetch(`/api/pet/feed?since_id=${lastIdRef.current}&limit=20`)
          if (!r.ok) return
          const data = await r.json()
          speakFresh(data.events ?? [])
        } catch {
          /* retry next tick */
        }
      })()
    }, 15000)
    return () => clearInterval(t)
  }, [live, speakFresh])

  useEffect(() => {
    // 成长是累计量，慢慢变——每次轮询顺带刷新，等级/EXP/最近搞懂跟上就好。
    // 小屋同频：**它身上带着的那件东西**是同一份真值里最新的一件。
    const growthTimer = setInterval(() => loadSlow(), 60000)
    return () => clearInterval(growthTimer)
  }, [loadSlow])

  // a plugin command (drink / start / stop / set) → 更新那一格的面板
  const runPlugin = useCallback(
    async (name: string, command: string, args?: Record<string, unknown>) => {
      try {
        const r = await api.petPluginCommand(name, command, args)
        setPlugins((prev) =>
          prev.map((p) => (p.name === name ? { ...p, panel: r.panel } : p))
        )
        if (r.said) {
          setBubble(r.said)
          if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
          bubbleTimer.current = setTimeout(() => setBubble(null), 6000)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    []
  )

  // close panel on outside click
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  async function send(text?: string) {
    const msg = (text ?? input).trim()
    if (!msg || busy) return
    setInput('')
    setError(null)
    // **必须 push 两条**（用户那条 + 一条空的宠物占位，正文往里填）。
    // 早先这里只 push 用户那条，然后在 delta 里写 `n[n.length - 1] = {role:'pet',…}`——
    // 那是**把用户刚问的那句直接覆盖掉**：零柒一开口，你打的字就从面板上消失了。
    setChat((c) => [...c, { role: 'user', text: msg }, { role: 'pet', text: '' }])
    setBusy(true)
    setThinking(true) // focused/inspecting while it thinks
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
        // Z1：把面板上已有的那几轮一起带上——后端不落库，不带它就等于每一句都是新会话
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
            // 零柒刚动过这个插件 —— 面板**那一格也得跟着变**。
            // 不刷新的话，它做的事只有别处看得见：面板还写着「25 分 / 开始」，
            // 而后端其实已经在倒计时了。回执里带的就是权威面板状态，直接用。
            if (r.plugin) {
              setPlugins((prev) =>
                prev.map((p) =>
                  p.name === r.plugin
                    ? { ...p, panel: r.panel as unknown as PetPlugin['panel'] }
                    : p
                )
              )
            }
            paint()
          },
        },
        ac.signal
      )
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setThinking(false)
      setToolBusy(null)
      abortRef.current = null
      // 朗读放在**说完了**这一刻：边流边读会念成一堆碎片
      const said = acc.trim()
      if (speakOn && said) void speak(said)
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape') {
      if (busy) abortRef.current?.abort()
      setOpen(false)
    }
  }

  // ---------- 摸它一下（P5 · 做活）：Q 弹 + 一声「啵」（音效本体在 petSound.ts） ----------
  function onSpriteClick() {
    if (draggedRef.current) {
      draggedRef.current = false // 这是拖完松手的那个 click，不是「点开面板」
      return
    }
    setSquash(true)
    if (squashTimer.current) clearTimeout(squashTimer.current)
    squashTimer.current = setTimeout(() => setSquash(false), 380)
    playBlip()
    setOpen((v) => !v)
  }

  // ---------- 音效开关（P5 · 做活）----------
  function toggleBlip() {
    const next = !blipOn
    setBlipOn(next)
    storeBlipOn(next)
  }

  // ---------- 弹出置顶（P5 · Document PiP）----------
  async function openPip() {
    if (pipWinRef.current) {
      pipWinRef.current.close()
      setPipWin(null)
      return
    }
    const dpip = (
      window as unknown as {
        documentPictureInPicture?: {
          requestWindow: (o: { width: number; height: number }) => Promise<PipWindow>
        }
      }
    ).documentPictureInPicture
    if (!dpip) {
      setError('这个浏览器还不支持弹出置顶（要 Chrome / Edge 116+）。')
      return
    }
    try {
      const win = await dpip.requestWindow({ width: 240, height: 300 })
      copyStyles(win.document)
      // 暗色跟主页面走一份（主题中途切换不重拷：收回再弹就是新的）
      win.document.documentElement.className = document.documentElement.className
      win.addEventListener('pagehide', () => setPipWin(null))
      setPipWin(win)
    } catch (e) {
      setError(`弹出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 主页面一走，小窗里的 React 树就没了——把窗口也带上，别留一个空壳钉在屏幕上
  useEffect(
    () => () => {
      pipWinRef.current?.close()
    },
    []
  )

  // 陪伴页自己就是整页的零柒（聊天/教它/成长/小屋/有声五张脸）。挂件退场那条
  // （2026-09-30 用户拍板：改回）——同屏双宠是当初的顾虑，但用户要挂件常在；
  // 想再退场就是恢复这一行判断。PiP 小窗里的树长在这个组件上，别动它的挂载。

  return (
    <>
      {/* 零柒的三个动画（pet-idle / pet-squash / pet-bubble-in）已搬进 index.css：
          桌面壳那只小窗（pet.html）共用同一份，这里不再各抄一份。 */}

      {/* 分栏（SplitPane）已移除，不再需要躲开 `--aside-w`——宠物就固定在右下角。 */}
      {/* 拖拽的位移与「让位」共用 translate 轴：拖过就走偏移量，没拖过保持原来的
          写法（让位那条测试与旧习惯都钉着 `translateY` 的样子）。拖动进行中关掉
          transition——200ms 的过渡追着每一帧 move 跑，手感是橡皮。 */}
      <div
        ref={panelRef}
        data-pet-root
        // pointer-events-none 在外层：这个 flex 盒子的宽度由最宽的子元素决定
        // （气泡能到 280px），不关掉的话，离精灵很远的地方点下去也会被它吃掉。
        // 真正要能点的三块（气泡 / 面板 / 精灵本体）各自 pointer-events-auto。
        // z-30（§H 弹层分级）：挂件要随手够得着，但必须永远压不过模态——
        // 原来它与命令面板、确认弹窗同为 z-50 且 DOM 靠后，精灵会盖住 Ctrl+K 的面板。
        className={`pointer-events-none fixed z-30 flex flex-col items-end ${
          dragging ? '' : 'transition-transform duration-200'
        }`}
        style={{
          // 离边多远由 PET_CORNER 一处决定（原 bottom-5/right-5 就是 20px，同一个数）
          bottom: PET_CORNER,
          right: PET_CORNER,
          transform:
            drag.dx || drag.dy
              ? `translate(${drag.dx}px, ${drag.dy - dodge}px)`
              : dodge
                ? `translateY(-${dodge}px)`
                : undefined,
        }}
      >
        {/* speech bubble above the sprite：主动提醒（带去处）优先，系统气泡让位 */}
        {nudge && !open ? (
          <div className="pet-bubble pointer-events-auto mb-2 max-w-[280px] rounded-lg rounded-br-sm border border-violet-200 wb-float bg-white px-3.5 py-2.5 text-left text-sm leading-relaxed text-neutral-800 shadow-lg shadow-violet-900/10 dark:border-violet-500/40 dark:bg-neutral-800 dark:text-neutral-100">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 break-words">{nudge.text}</span>
              <button
                onClick={() => setNudge(null)}
                title="知道了，今天别念了"
                className="shrink-0 text-xs text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
              >
                ✕
              </button>
            </div>
            <div className="mt-1.5">
              <button
                onClick={() => {
                  setNudge(null)
                  navigate(nudge.to)
                }}
                className="rounded-full wb-btn-ghost px-2.5 py-0.5 text-xs"
              >
                {nudge.toLabel} →
              </button>
            </div>
          </div>
        ) : bubble && !open ? (
          <button
            onClick={() => setOpen(true)}
            // 与 nudge 气泡同一个 max-w（280）：两种气泡互替时左缘不跳（§#27）
            className="pet-bubble pointer-events-auto mb-2 max-w-[280px] break-words rounded-lg rounded-br-sm border border-neutral-200 wb-float bg-white px-3.5 py-2.5 text-left text-sm leading-relaxed text-neutral-800 shadow-lg shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          >
            {bubble}
          </button>
        ) : null}

        {/* expanded panel：高度封顶 70vh、宽度封顶 320px——横屏矮视口（667×375）上
            面板不超出屏幕高，窄手机（375px）上不顶满整屏宽（§P0 #19/#20）。 */}
        {open && (
          <PetPanel
            growth={growth}
            state={state}
            mastery={mastery}
            room={room}
            events={events}
            chat={chat}
            error={error}
            toolBusy={toolBusy}
            plugins={plugins}
            speakOn={speakOn}
            speaking={speaking}
            blipOn={blipOn}
            pipWin={pipWin}
            voice={voice}
            input={input}
            setInput={setInput}
            busy={busy}
            panelBottomRef={panelBottomRef}
            onToggleSpeak={toggleSpeak}
            onToggleBlip={toggleBlip}
            onOpenPip={() => void openPip()}
            onClose={() => setOpen(false)}
            onRunPlugin={(name, command, args) => void runPlugin(name, command, args)}
            onSend={(text) => void send(text)}
            onKeyDown={onKeyDown}
          />
        )}

        {/* the avatar itself — animated webp per state, PNG fallback on error.
            P5 做活：能拽着走（指针事件 + 惯性），点一下有 Q 弹和一声「啵」。 */}
        <button
          onClick={onSpriteClick}
          onPointerDown={onSpritePointerDown}
          title={state ? `零柒 · ${MODE_LABEL[state.mode]}` : '零柒'}
          className="pointer-events-auto relative flex h-16 w-16 touch-none items-center justify-center transition-transform hover:scale-105 active:scale-95 md:h-24 md:w-24"
        >
          <div className="pet-idle flex items-center justify-center">
            <img
              key={action}
              src={petSprite(action)}
              alt="零柒"
              data-pet-action={action}
              // 你走开久了 → 只把宠物自己降饱和（陪伴不是管教，页面不动）
              style={dimmed ? { filter: 'saturate(0.25)' } : undefined}
              className={
                'h-14 w-14 object-contain drop-shadow-md transition-[filter] duration-700 md:h-[88px] md:w-[88px]' +
                (squash ? ' pet-squash' : '')
              }
              onError={(e) => {
                e.currentTarget.src = '/pet-avatar.png'
              }}
            />
          </div>
          {/* 它身上带着的那件东西（P4）：屋里**最近到手**的一件，或刚交出去的成品。
              不看状态、不看今天——攒下来的东西不该因为今天没干活就被摘掉。 */}
          {room?.carried && (
            <span
              data-pet-item={room.carried.id}
              title={`${room.carried.label} · ${room.carried.detail}`}
              className="absolute -bottom-0.5 -right-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 bg-white text-sm shadow-sm dark:border-neutral-700 dark:bg-neutral-800"
            >
              {room.carried.icon}
            </span>
          )}
        </button>
      </div>

      {/* 置顶小窗（P5 · Document PiP）：同一份状态、同一个气泡，只是搬到了一个
          **总在最前**的系统小窗里。样式是 copyStyles 搬过去的，暗色随主页面。 */}
      {pipWin &&
        createPortal(
          <div className="flex h-screen flex-col items-center justify-center gap-2 bg-neutral-50 px-3 py-2 dark:bg-neutral-900">
            {bubble ? (
              <p className="pet-bubble max-w-[200px] rounded-lg rounded-br-sm border border-neutral-200 bg-white px-3 py-2 text-xs leading-relaxed text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
                {bubble}
              </p>
            ) : null}
            <div className="pet-idle">
              <img
                src={petSprite(action)}
                alt="零柒"
                className={'h-24 w-24 object-contain drop-shadow-md' + (squash ? ' pet-squash' : '')}
                style={dimmed ? { filter: 'saturate(0.25)' } : undefined}
                onError={(e) => {
                  e.currentTarget.src = '/pet-avatar.png'
                }}
              />
            </div>
            {state?.line ? (
              <p className="max-w-[200px] text-center text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                {state.line}
              </p>
            ) : null}
            <button
              onClick={() => {
                pipWin.close()
                setPipWin(null)
              }}
              className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs text-neutral-500 transition-colors hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:text-neutral-400"
            >
              收回
            </button>
          </div>,
          pipWin.document.body
        )}
    </>
  )
}
