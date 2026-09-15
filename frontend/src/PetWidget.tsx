import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import {
  api,
  type CardStats,
  type PetGrowth,
  type PetPlugin,
  type PetRoom,
  type PetState,
  type PetStateMode,
  type ScheduledTask,
  type TutorMastery,
  type TutorStuckRow,
} from './api'
import { receiptLabel, streamPetChat, toolCallLabel, type PetToolReceipt } from './petChat'
import { makeSpeech, useVoiceInput } from './voice'

// Animation states come from the Codex pet atlas (awesome-codex-pet v1):
// 9 states, each shipped as an animated webp under /pet/<state>.webp.
// The browser plays them natively, so switching state is just swapping src.
export type PetAction =
  | 'idle'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'running-right'
  | 'running-left'
  | 'review'

// 九个动画的运行时清单。服务端可能（日后）加新模式，也可能发来一个手滑的字符串；
// 落到界面上就是一个破图。这里当一道闸：不认识的一律退回 idle。
const PET_ACTIONS: PetAction[] = [
  'idle',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'running-right',
  'running-left',
  'review',
]

function asPetAction(a: string | undefined | null): PetAction {
  return a && (PET_ACTIONS as string[]).includes(a) ? (a as PetAction) : 'idle'
}

// 面板里给「此刻」一个说法。与后端 `pet_state._line()` 分工是刻意的：
// 那边是零柒的**台词**（会说话的只有它，没话说就闭嘴），这里是界面的**事实**——
// 面板是你主动打开看细节的地方，所以 `idle` 也得有字。
const MODE_LABEL: Record<PetStateMode, string> = {
  idle: '待机',
  focusing: '专注中',
  working: '陪你干活',
  learning: '陪你学',
  reviewing: '陪你过卡',
  celebrating: '刚交出成品',
  busy: '有活在跑',
  idling: '你走开了一会儿',
  pupil: '在听你讲',
  resting: '你走开挺久了',
  tired: '有点蔫',
  sleepy: '深夜',
}

// 「你人不在」的那两个模式 → 宠物区降饱和。**只降宠物自己，不动页面**：
// 陪伴不该变成管教，何况你很可能只是切去别的窗口干正事。
const DIM_MODES: PetStateMode[] = ['idling', 'resting']

// 右下角留白 = Tailwind 的 bottom-5/right-5（1.25rem = 20px）。让位计算要用到它，
// 改了 class 就得同步改这里。
const PET_CORNER = 20
// 页面上「宠物必须让开」的东西都标这个属性（目前只有对话页的输入行）。
const PET_CLEAR_SELECTOR = '[data-pet-clear]'

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

interface PetEvent {
  id: number
  kind: string
  text: string
  detail: string
  created_at: string
}

interface ChatMsg {
  role: 'user' | 'pet'
  text: string
  /** 这一轮零柒**真的做了什么**（P3）。空 = 它只是回了句话。 */
  tools?: PetToolReceipt[]
}

function timeLabel(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

// 心情 1–5 的表情。index 0 = 1 分。面板里点一下就记下今天的心情。
const MOOD_FACES = ['😞', '😕', '😐', '🙂', '😄']

/** 主动提醒：宠物跨模块看到的「你欠的账」，挑最急的一件先开口。
 *
 *  和 feed（任务/摘要/备份的系统事件）分工：feed 是「系统发生了什么」，
 *  nudge 是「**你**有什么没处理」——等你点头的工作流、跑挂的任务、攒着的卡点、
 *  到期没过的卡。安静是默认：一件都没有就一个字都不冒。
 *  同一件事一天只念一次（localStorage 按日期记账），别变成唠叨。
 */
interface Nudge {
  key: string
  text: string
  to: string
  toLabel: string
}

const nudgeStorageKey = (k: string) =>
  `pet:nudged:${new Date().toISOString().slice(0, 10)}:${k}`

function wasNudged(key: string): boolean {
  try {
    return localStorage.getItem(nudgeStorageKey(key)) === '1'
  } catch {
    return false
  }
}

function markNudged(key: string): void {
  try {
    localStorage.setItem(nudgeStorageKey(key), '1')
  } catch {
    /* 无痕模式下记不了就不记，顶多今天多念一遍 */
  }
}

/** 顺序即优先级：等你点头 > 跑挂了 > 卡点 > 到期卡。每个请求各自兜底，挂了当没有。 */
async function gatherNudges(): Promise<Nudge[]> {
  const [tasks, stuck, stats] = await Promise.all([
    api.listTasks().catch((): ScheduledTask[] => []),
    api.tutorStuck().catch((): { stuck: TutorStuckRow[] } => ({ stuck: [] })),
    api.cardStats().catch((): CardStats | null => null),
  ])
  const out: Nudge[] = []
  for (const t of tasks) {
    if (t.awaiting_run_id != null)
      out.push({
        key: `approve-${t.id}`,
        text: `「${t.name}」跑完一步了，等你点头才继续。`,
        to: `/work?tab=engine&task=${t.id}`,
        toLabel: '去放行',
      })
  }
  for (const t of tasks) {
    if (t.enabled && t.awaiting_run_id == null && t.last_status === 'error')
      out.push({
        key: `failed-${t.id}-${t.last_run ?? ''}`,
        text: `「${t.name}」上次跑挂了，失败原因我给你留着。`,
        to: `/work?tab=engine&task=${t.id}`,
        toLabel: '去看看',
      })
  }
  const open = stuck.stuck.filter((s) => !s.resolved_at)
  if (open.length > 0)
    out.push({
      key: 'stuck',
      text:
        open.length === 1
          ? `「${open[0].concept}」还卡着，要不要现在把它说通？`
          : `攒了 ${open.length} 个卡点没解，清一个是一个。`,
      to: '/tutor',
      toLabel: '去清卡点',
    })
  if (stats && stats.due_now > 0)
    out.push({
      key: 'due',
      text: `今天还有 ${stats.due_now} 张卡没过，趁脑子还在。`,
      to: '/review',
      toLabel: '去复习',
    })
  return out
}

/** 面板底部的一格插件。三种面板（计数 / 计时 / 心情）各是一行动作。 */
function PluginRow({
  p,
  onCommand,
}: {
  p: PetPlugin
  onCommand: (name: string, command: string, args?: Record<string, unknown>) => void
}) {
  const row = 'flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300'
  const btn =
    'rounded-md border border-neutral-300 px-2 py-0.5 text-[11px] transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800'

  if (p.panel.kind === 'counter') {
    return (
      <div className={row}>
        <span>💧 {p.label}</span>
        <span className="text-neutral-400 dark:text-neutral-500">
          {p.panel.value ?? 0}/{p.panel.target ?? 0} {p.panel.unit ?? ''}
        </span>
        <div className="flex-1" />
        <button className={btn} onClick={() => onCommand(p.name, 'drink')}>
          +1 杯
        </button>
      </div>
    )
  }

  if (p.panel.kind === 'mood') {
    const v = p.panel.value ?? 0
    return (
      <div className={row}>
        <span>🙂 {p.label}</span>
        <span className="text-neutral-400 dark:text-neutral-500">
          {v ? `今天 ${v}/${p.panel.scale ?? 5}` : '今天还没记'}
        </span>
        <div className="flex-1" />
        <div className="flex gap-0.5">
          {MOOD_FACES.map((face, i) => (
            <button
              key={face}
              title={`${i + 1} 分`}
              onClick={() => onCommand(p.name, 'set', { value: i + 1 })}
              className={
                'rounded px-0.5 text-base leading-none transition-opacity ' +
                (v === i + 1 ? '' : 'opacity-35 hover:opacity-100')
              }
            >
              {face}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={row}>
      <span>⏱ {p.label}</span>
      <span className="text-neutral-400 dark:text-neutral-500">
        {p.panel.running
          ? `剩余 ${Math.ceil((p.panel.remaining ?? 0) / 60)} 分`
          : `${p.panel.minutes ?? p.panel.default_minutes ?? 25} 分`}
      </span>
      <div className="flex-1" />
      <button
        className={btn}
        onClick={() => onCommand(p.name, p.panel.running ? 'stop' : 'start')}
      >
        {p.panel.running ? '停' : '开始'}
      </button>
    </div>
  )
}

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
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [events, setEvents] = useState<PetEvent[]>([])
  const [growth, setGrowth] = useState<PetGrowth | null>(null)
  const [mastery, setMastery] = useState<TutorMastery | null>(null)
  const [room, setRoom] = useState<PetRoom | null>(null)
  const [plugins, setPlugins] = useState<PetPlugin[]>([])
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // 工具正在跑时的一句话：模型调完工具还要再走一轮才开口，那段空白得有个交代
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

  // 此刻摆哪个姿势：一次性覆盖 > 正在想 > 状态机。
  const action: PetAction = flash ?? (thinking ? 'review' : asPetAction(state?.action))
  const dimmed = state != null && DIM_MODES.includes(state.mode)

  // 宠物是 fixed 悬浮层，页面排版不知道它占着右下角。对话页的输入行正好在那儿——
  // 窄屏（实测窗口 <1240px）上「发送」会被压住，Playwright 点击直接报
  // `img[alt="零柒"]` 拦截。与其让每个页面自己留白躲它，不如让宠物**自己让开**：
  // 量一量有没有撞上标了 `[data-pet-clear]` 的东西，撞了就整块上移。
  const [dodge, setDodge] = useState(0)

  useEffect(() => {
    const measure = () => {
      const el = panelRef.current
      if (!el) return
      // 用 offset* 而不是 getBoundingClientRect：位移不能反馈进下一次测量，
      // 否则每次 setDodge 都把结果再推一遍，收不住。
      const w = el.offsetWidth
      const h = el.offsetHeight
      const right = window.innerWidth - PET_CORNER
      const bottom = window.innerHeight - PET_CORNER
      const left = right - w
      const top = bottom - h
      let lift = 0
      document.querySelectorAll(PET_CLEAR_SELECTOR).forEach((target) => {
        const r = target.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) return  // 还没排版出来
        if (right > r.left && left < r.right && bottom > r.top && top < r.bottom) {
          lift = Math.max(lift, bottom - r.top + 8)
        }
      })
      setDodge(lift)
    }
    measure()
    window.addEventListener('resize', measure)
    // 面板展开 / 气泡冒出来都会改变占地，撞没撞上要重算。jsdom 没有
    // ResizeObserver，测试环境下跳过（那边本来也量不出布局）。
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (ro && panelRef.current) ro.observe(panelRef.current)
    // 首屏输入行是异步量出来的，补一次；路由换了也要重算
    const late = window.setTimeout(measure, 400)
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
      window.clearTimeout(late)
    }
  }, [open, bubble, nudge, location.pathname])

  useEffect(() => {
    openRef.current = open
  }, [open])

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

  // 路由换了立刻重算（学/工作/复习是三种不同的状态），其余时候 15 秒一回。
  useEffect(() => {
    let alive = true
    const tick = () => {
      const idleSec = (Date.now() - lastInput.current) / 1000
      void api
        .petState(idleSec, location.pathname)
        .then((s) => {
          if (alive) setState(s)
        })
        .catch(() => {
          /* 拿不到就沿用上一次的姿势，别闪 */
        })
    }
    tick()
    const t = setInterval(tick, 15000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [location.pathname])

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
    } catch {
      /* 无痕模式 */
    }
    // 卸载时把嘴闭上：不然离开这一页它还在念
    return () => {
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  // play a one-shot action, then fall back to whatever the state machine says
  const playAction = useCallback((a: PetAction, ms: number) => {
    setFlash(a)
    if (actionTimer.current) clearTimeout(actionTimer.current)
    actionTimer.current = setTimeout(() => setFlash(null), ms)
  }, [])

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
        const [f, g, p, m, rm] = await Promise.all([
          fetch('/api/pet/feed?limit=30').then((r) => r.json()),
          api.petGrowth().catch(() => null),
          api.petPlugins().then((r) => r.plugins).catch(() => []),
          api.tutorMastery().catch(() => null),
          api.petRoom().catch(() => null),
        ])
        const evs: PetEvent[] = f.events ?? []
        setEvents([...evs].reverse())
        if (evs.length) lastIdRef.current = Math.max(...evs.map((e) => e.id))
        setGrowth(g)
        setPlugins(p)
        setMastery(m)
        setRoom(rm)
      } catch {
        /* offline — the pet just sits quietly */
      }
    })()
  }, [])

  // poll for new events → bubble (the pet "speaks first")
  useEffect(() => {
    // 成长是累计量，慢慢变——每次轮询顺带刷新，等级/EXP/最近搞懂跟上就好。
    // 小屋同频：**它身上带着的那件东西**是同一份真值里最新的一件。
    const growthTimer = setInterval(() => {
      void api.petGrowth().then(setGrowth).catch(() => {})
      void api.tutorMastery().then(setMastery).catch(() => {})
      void api.petRoom().then(setRoom).catch(() => {})
    }, 60000)
    return () => clearInterval(growthTimer)
  }, [])

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

  // poll for new events → bubble (the pet "speaks first")
  useEffect(() => {
    const t = setInterval(() => {
      void (async () => {
        try {
          const r = await fetch(`/api/pet/feed?since_id=${lastIdRef.current}&limit=20`)
          if (!r.ok) return
          const data = await r.json()
          const fresh: PetEvent[] = data.events ?? []
          if (!fresh.length) return
          setEvents((prev) => {
            const ids = new Set(prev.map((e) => e.id))
            const add = fresh.filter((e) => !ids.has(e.id))
            return add.length ? [...prev, ...add.reverse()] : prev
          })
          for (const e of fresh) lastIdRef.current = Math.max(lastIdRef.current, e.id)
          // react to what happened: failures slump, everything else waves hello
          if (fresh[0]) {
            const isFail = fresh.some((e) => e.kind === 'task_failed')
            playAction(isFail ? 'failed' : 'waving', 6000)
          }
          if (!openRef.current && fresh[0]) {
            setNudge(null) // 轮到系统事件说话，主动提醒先让位
            setBubble(fresh[0].text)
            if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
            bubbleTimer.current = setTimeout(() => setBubble(null), 6000)
          }
        } catch {
          /* retry next tick */
        }
      })()
    }, 15000)
    return () => clearInterval(t)
  }, [])

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

  return (
    <>
      <style>{`
        @keyframes pet-idle {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-4px) scale(1.03); }
        }
        @keyframes pet-bubble-in {
          from { opacity: 0; transform: translateY(6px) scale(0.9); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .pet-idle { animation: pet-idle 3.2s ease-in-out infinite; }
        .pet-bubble { animation: pet-bubble-in 0.22s ease-out; }
      `}</style>

      {/* 分栏（SplitPane）已移除，不再需要躲开 `--aside-w`——宠物就固定在右下角。 */}
      <div
        ref={panelRef}
        data-pet-root
        // pointer-events-none 在外层：这个 flex 盒子的宽度由最宽的子元素决定
        // （气泡能到 280px），不关掉的话，离精灵很远的地方点下去也会被它吃掉。
        // 真正要能点的三块（气泡 / 面板 / 精灵本体）各自 pointer-events-auto。
        className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end transition-transform duration-200"
        style={dodge ? { transform: `translateY(-${dodge}px)` } : undefined}
      >
        {/* speech bubble above the sprite：主动提醒（带去处）优先，系统气泡让位 */}
        {nudge && !open ? (
          <div className="pet-bubble pointer-events-auto mb-2 max-w-[280px] rounded-2xl rounded-br-sm border border-violet-200 bg-white px-3.5 py-2.5 text-left text-sm leading-relaxed text-neutral-800 shadow-lg shadow-violet-900/10 dark:border-violet-500/40 dark:bg-neutral-800 dark:text-neutral-100">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1">{nudge.text}</span>
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
                className="rounded-full border border-violet-300 px-2.5 py-0.5 text-[11px] text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-500/50 dark:text-violet-300 dark:hover:bg-violet-500/10"
              >
                {nudge.toLabel} →
              </button>
            </div>
          </div>
        ) : bubble && !open ? (
          <button
            onClick={() => setOpen(true)}
            className="pet-bubble pointer-events-auto mb-2 max-w-[260px] rounded-2xl rounded-br-sm border border-neutral-200 bg-white px-3.5 py-2.5 text-left text-sm leading-relaxed text-neutral-800 shadow-lg shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          >
            {bubble}
          </button>
        ) : null}

        {/* expanded panel */}
        {open && (
          <div className="pet-bubble pointer-events-auto mb-2 flex h-[380px] w-[320px] flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl shadow-neutral-900/20 dark:border-neutral-700 dark:bg-neutral-900">
            <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">零柒</span>
              {growth && (
                <Link
                  to="/growth"
                  onClick={() => setOpen(false)}
                  title="看成长"
                  className="text-[10px] text-neutral-400 transition-colors hover:text-violet-500 dark:text-neutral-500"
                >
                  Lv.{growth.level} {growth.title} · EXP {growth.exp}
                  {growth.next_title && ` · 正在靠近「${growth.next_title}」`}
                </Link>
              )}
              <div className="flex-1" />
              <button
                onClick={toggleSpeak}
                title={speakOn ? '朗读：开（点一下关掉）' : '朗读：关'}
                className={`text-[10px] transition-colors ${
                  speakOn ? 'text-violet-500' : 'text-neutral-400 dark:text-neutral-500'
                } hover:text-violet-500`}
              >
                {speaking ? '🔊' : speakOn ? '🔈' : '🔇'}
              </button>
              <Link
                to="/companion"
                onClick={() => setOpen(false)}
                title="整页聊天 / 教它 / 成长 / 小屋 / 有声"
                className="text-[10px] text-neutral-400 transition-colors hover:text-violet-500 dark:text-neutral-500"
              >
                陪伴页 →
              </Link>
              <button
                onClick={() => setOpen(false)}
                className="rounded-md px-1.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
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
              <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-1.5 text-[10px] text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
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
                <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-neutral-400 dark:text-neutral-500">
                  {growth.parts.map((p) => (
                    <span key={p.key}>
                      {p.label} +{p.exp}
                    </span>
                  ))}
                </div>
              )}
              {mastery && mastery.events.length > 0 && (
                <div className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                  最近搞懂：
                  {mastery.events.slice(0, 3).map((e) => e.concept).join('、')}
                  {mastery.mastered > 3 ? ` 等 ${mastery.mastered} 个` : ''}
                  <Link
                    to="/tutor"
                    onClick={() => setOpen(false)}
                    className="ml-1 text-violet-500 hover:underline"
                  >
                    看学习地图
                  </Link>
                </div>
              )}
              {room?.carried && (
                <div className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                  它最近叼回来：{room.carried.icon} {room.carried.label}
                  <Link
                    to="/companion?tab=room"
                    onClick={() => setOpen(false)}
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
                <div key={`e${e.id}`} className="max-w-[92%] rounded-lg rounded-bl-sm bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
                  <div className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-200">{e.text}</div>
                  <div className="mt-0.5 text-[10px] text-neutral-400 dark:text-neutral-500">{timeLabel(e.created_at)}</div>
                </div>
              ))}
              {chat.map((m, i) =>
                m.role === 'user' ? (
                  <div key={`u${i}`} className="ml-auto max-w-[92%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-violet-600 px-3 py-2 text-white">
                    {m.text}
                  </div>
                ) : (
                  <div
                    key={`p${i}`}
                    className="max-w-[92%] rounded-lg rounded-bl-sm bg-neutral-100 px-3 py-2 dark:bg-neutral-800"
                  >
                    {/* 它真的做了什么。写在话**前面**：先有动作，再有解释。 */}
                    {m.tools && m.tools.length > 0 && (
                      <ul className="mb-1 flex flex-wrap gap-1">
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
                    {m.text ? (
                      <span className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-200">
                        {m.text}
                      </span>
                    ) : null}
                    {!m.text && (
                      <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                        {toolBusy ?? (
                          <span className="inline-block animate-pulse text-violet-400">▊</span>
                        )}
                      </span>
                    )}
                  </div>
                ),
              )}
              {error && <div className="rounded-lg bg-red-100 px-3 py-2 text-xs text-red-600 dark:bg-red-950/60 dark:text-red-300">{error}</div>}
            </div>

            {plugins.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
                {plugins.map((p) => (
                  <PluginRow
                    key={p.name}
                    p={p}
                    onCommand={(name, command, args) => void runPlugin(name, command, args)}
                  />
                ))}
              </div>
            )}

            {/* 快捷对话条：还没开聊的时候，一键起头——开口的门槛越低，陪伴越真 */}
            {chat.length === 0 && (
              <div className="flex flex-wrap gap-1.5 border-t border-neutral-200 px-3 pt-2 dark:border-neutral-800">
                {(
                  [
                    ['排一下今天', '帮我看看现在都欠着什么，排个先后。'],
                    ['陪我聊两句', '陪我聊两句，随便什么都行。'],
                    ['总结今天', '总结一下我今天都干了什么。'],
                  ] as const
                ).map(([label, q]) => (
                  <button
                    key={label}
                    onClick={() => void send(q)}
                    disabled={busy}
                    className="rounded-full border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-violet-500/50"
                  >
                    {label}
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
                      ? 'border-red-400 bg-red-50 text-red-500 dark:border-red-500/50 dark:bg-red-500/10'
                      : 'border-neutral-300 text-neutral-400 hover:border-violet-300 hover:text-violet-600 dark:border-neutral-700 dark:hover:border-violet-500/50'
                  }`}
                >
                  {voice.transcribing ? (
                    '⏳'
                  ) : voice.recording ? (
                    <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
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
                  onClick={() => void send()}
                  disabled={busy || !input.trim()}
                  className="rounded-lg bg-violet-600 px-3 text-sm text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        )}

        {/* the avatar itself — animated webp per state, PNG fallback on error */}
        <button
          onClick={() => setOpen((v) => !v)}
          title={state ? `零柒 · ${MODE_LABEL[state.mode]}` : '零柒'}
          className="pointer-events-auto relative flex h-24 w-24 items-center justify-center transition-transform hover:scale-105 active:scale-95"
        >
          <div className="pet-idle flex items-center justify-center">
            <img
              key={action}
              src={`/pet/${action}.webp`}
              alt="零柒"
              data-pet-action={action}
              // 你走开久了 → 只把宠物自己降饱和（陪伴不是管教，页面不动）
              style={dimmed ? { filter: 'saturate(0.25)' } : undefined}
              className="h-[88px] w-[88px] object-contain drop-shadow-md transition-[filter] duration-700"
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
    </>
  )
}
